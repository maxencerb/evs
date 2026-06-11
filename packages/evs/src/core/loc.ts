/**
 * M1 `core/loc.ts` — lazy source-location capture.
 *
 * Contract: docs/design/module-interfaces.md §M1 (frozen).
 *
 * `captureLoc()` eagerly stores `new Error().stack` (capture is the cheap part) and parses it
 * lazily on first property access — the returned `SourceLoc` fields are getters. Frames whose
 * filename is inside @maxencerb/evs (dist or src, or an installed copy under node_modules) are
 * skipped so the reported location is the *user's* call site. Test/spec files are exempt from
 * the skip (they are consumers of the library even when they live inside `src/`).
 */

import type { SourceLoc } from './errors.js';

let captureEnabled = true;

/** Used by `evscript({ locations: false })`; scoped per recorder via the builder. */
export function setLocCapture(enabled: boolean): void {
  captureEnabled = enabled;
}

export function captureLoc(): SourceLoc | null {
  if (!captureEnabled) return null;
  const stack = captureRawStack();
  if (stack === null) return null;
  return lazyLoc(stack);
}

// ---------------------------------------------------------------------------
// capture
// ---------------------------------------------------------------------------

function captureRawStack(): string | null {
  const ErrCtor = Error;
  const prevLimit: unknown = ErrCtor.stackTraceLimit;
  let stack: string | undefined;
  try {
    if (typeof prevLimit === 'number') ErrCtor.stackTraceLimit = 64;
    stack = new ErrCtor().stack;
  } finally {
    if (typeof prevLimit === 'number') ErrCtor.stackTraceLimit = prevLimit;
  }
  if (typeof stack !== 'string' || stack.length === 0) return null;
  return stack;
}

// ---------------------------------------------------------------------------
// lazy resolution
// ---------------------------------------------------------------------------

const UNPARSEABLE: SourceLoc = Object.freeze({ file: '<unknown>', line: 0, column: 0 });

function lazyLoc(stack: string): SourceLoc {
  let resolved: SourceLoc | undefined;
  const resolve = (): SourceLoc => {
    if (resolved === undefined) resolved = parseStack(stack) ?? UNPARSEABLE;
    return resolved;
  };
  return {
    get file(): string {
      return resolve().file;
    },
    get line(): number {
      return resolve().line;
    },
    get column(): number {
      return resolve().column;
    },
  };
}

// ---------------------------------------------------------------------------
// stack parsing (V8/node/bun "at …" format and JSC "fn@file:line:col" format)
// ---------------------------------------------------------------------------

/** `… (file:line:col)` — V8 frames with a function name. */
const PAREN_RE = /\(([^()]+):(\d+):(\d+)\)\s*$/;
/** `at file:line:col` — V8 frames without a function name. */
const AT_RE = /^\s*at\s+(?:async\s+)?(.+?):(\d+):(\d+)\s*$/;
/** `fn@file:line:col` / `@file:line:col` — JSC (bun/safari) frames. */
const JSC_RE = /^\s*[^@]*@(.+?):(\d+):(\d+)\s*$/;

function parseStack(stack: string): SourceLoc | null {
  for (const line of stack.split('\n')) {
    const frame = parseFrameLine(line);
    if (frame === null) continue;
    const file = stripFileUrl(frame.file);
    if (!isUserFrame(file)) continue;
    return { file, line: frame.line, column: frame.column };
  }
  return null;
}

function parseFrameLine(line: string): SourceLoc | null {
  let m: RegExpExecArray | null = null;
  if (line.trimStart().startsWith('at ')) {
    m = PAREN_RE.exec(line) ?? AT_RE.exec(line);
  } else if (line.includes('@')) {
    m = JSC_RE.exec(line);
  }
  if (m === null) return null;
  const file = m[1];
  const lineNo = Number(m[2]);
  const columnNo = Number(m[3]);
  if (file === undefined || file.length === 0) return null;
  if (!Number.isSafeInteger(lineNo) || !Number.isSafeInteger(columnNo)) return null;
  return { file, line: lineNo, column: columnNo };
}

function stripFileUrl(p: string): string {
  if (!p.startsWith('file://')) return p;
  let stripped = p.slice('file://'.length);
  try {
    stripped = decodeURIComponent(stripped);
  } catch {
    // keep the raw form when percent-decoding fails
  }
  return stripped;
}

// ---------------------------------------------------------------------------
// frame filtering
// ---------------------------------------------------------------------------

function dirnameOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

/** `<pkg>/src/` and `<pkg>/dist/` derived from this very module's location. */
function ownSkipPrefixes(): readonly string[] {
  const selfFile = stripFileUrl(import.meta.url); // …/<pkg>/(src|dist)/core/loc.(ts|js)
  const moduleRoot = dirnameOf(dirnameOf(selfFile)); // …/<pkg>/(src|dist)
  const packageRoot = dirnameOf(moduleRoot); // …/<pkg>
  return [`${packageRoot}/src/`, `${packageRoot}/dist/`];
}

const SKIP_PREFIXES = ownSkipPrefixes();

const TEST_FILE_RE = /\.(?:test(?:-d)?|spec)\.[a-z]+/;

function isUserFrame(file: string): boolean {
  if (file.startsWith('node:')) return false;
  if (file === 'native' || file === '[native code]' || file === '<anonymous>') return false;
  // mangled eval frames ("eval at … (…)") leak parens into the captured path — never a real file
  if (file.includes('(')) return false;
  // an installed copy of the package (npm / pnpm store layouts)
  if (file.includes('node_modules/@maxencerb/evs/')) return false;
  if (file.includes('@maxencerb+evs')) return false;
  // in-repo frames under <pkg>/src or <pkg>/dist are library internals — except test files,
  // which are consumers of the library even though they live next to the sources
  if (TEST_FILE_RE.test(file)) return true;
  for (const prefix of SKIP_PREFIXES) {
    if (file.startsWith(prefix)) return false;
  }
  return true;
}
