/**
 * The playground run path: TypeScript worker emit → import rewrite to a global
 * module registry (see rewrite.ts) → self-contained blob-module import with
 * console capture and RPC instrumentation. Mirrored headlessly by
 * `scripts/check-playground-examples.ts`.
 */

import type * as monaco from 'monaco-editor';
import {
  getTypeScriptWorker,
  type TsDiagnosticMessageChain,
} from 'monaco-editor/language/typescript/monaco.contribution.js';

import { MODULE_URLS, REGISTRY_KEY, rewriteImports } from './rewrite.ts';

/**
 * Import the runtime bundles as ordinary same-origin modules and park them on
 * the global registry the rewritten user code destructures from. Doing this
 * outside the blob graph means a failing fetch names the actual URL instead of
 * the browser's opaque "failed to fetch blob:" (which is all we got when a
 * static import inside the blob module failed in production).
 */
async function loadRuntimeModules(): Promise<void> {
  const host = globalThis as Record<string, unknown>;
  if (host[REGISTRY_KEY]) return;
  const registry: Record<string, unknown> = {};
  for (const [specifier, path] of Object.entries(MODULE_URLS)) {
    const url = `${location.origin}${path}`;
    try {
      registry[specifier] = await import(/* @vite-ignore */ url);
    } catch (thrown) {
      throw new Error(
        `Could not load the '${specifier}' runtime bundle (${url}): ${
          thrown instanceof Error ? thrown.message : String(thrown)
        } — try a hard reload; if it persists the deployment is missing /playground assets.`,
      );
    }
  }
  host[REGISTRY_KEY] = registry;
}

export interface ConsoleLine {
  level: 'log' | 'warn' | 'error';
  text: string;
}

export interface CompiledArtifact {
  name: string;
  bytes: number;
  runtimeBytecode: string;
}

export interface RunOutcome {
  ok: boolean;
  /** Present when the script has type errors — the run is not attempted. */
  diagnostics?: string[];
  error?: string | undefined;
  logs: ConsoleLine[];
  compiled: CompiledArtifact[];
  rpc: { requests: number; ms: number };
  totalMs: number;
}

/** Console-style value formatting: bigints as `123n`, hex strings untouched. */
export function formatValue(value: unknown, depth = 0): string {
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'string') return depth === 0 ? value : JSON.stringify(value);
  if (value === null || typeof value !== 'object') return String(value);
  if (depth > 3) return Array.isArray(value) ? '[…]' : '{…}';
  if (Array.isArray(value)) {
    return `[${value.map((v) => formatValue(v, depth + 1)).join(', ')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return '{}';
  return `{ ${entries.map(([k, v]) => `${k}: ${formatValue(v, depth + 1)}`).join(', ')} }`;
}

function flattenMessage(message: string | TsDiagnosticMessageChain): string {
  if (typeof message === 'string') return message;
  return flattenMessage(message.messageText);
}

/** Duck-type the user module's exports for compiled evs scripts (compile is pure). */
function collectCompiled(moduleExports: Record<string, unknown>): CompiledArtifact[] {
  const artifacts: CompiledArtifact[] = [];
  for (const value of Object.values(moduleExports)) {
    const candidate = value as { compile?: () => unknown } | null;
    if (!candidate || typeof candidate.compile !== 'function') continue;
    try {
      const compiled = candidate.compile() as {
        runtimeBytecode?: string;
        abi?: readonly { type: string; name?: string }[];
      };
      if (typeof compiled?.runtimeBytecode !== 'string') continue;
      const fn = compiled.abi?.find((entry) => entry.type === 'function');
      artifacts.push({
        name: fn?.name ?? 'script',
        bytes: (compiled.runtimeBytecode.length - 2) / 2,
        runtimeBytecode: compiled.runtimeBytecode,
      });
    } catch {
      // A throwing compile() surfaced during execution already; skip for the seam.
    }
  }
  return artifacts;
}

export async function runScript(
  model: monaco.editor.ITextModel,
  rpcUrl: string,
): Promise<RunOutcome> {
  const start = performance.now();
  const uri = model.uri.toString();
  const workerFactory = await getTypeScriptWorker();
  const worker = await workerFactory(model.uri);

  const [syntactic, semantic] = await Promise.all([
    worker.getSyntacticDiagnostics(uri),
    worker.getSemanticDiagnostics(uri),
  ]);
  const diagnostics = [...syntactic, ...semantic].map((d) => {
    const position = d.start === undefined ? null : model.getPositionAt(d.start);
    const where = position ? `${position.lineNumber}:${position.column} ` : '';
    return `${where}${flattenMessage(d.messageText)}`;
  });
  if (diagnostics.length > 0) {
    return {
      ok: false,
      diagnostics,
      logs: [],
      compiled: [],
      rpc: { requests: 0, ms: 0 },
      totalMs: performance.now() - start,
    };
  }

  const emit = await worker.getEmitOutput(uri);
  const js = emit.outputFiles[0]?.text;
  if (!js) {
    return {
      ok: false,
      error: 'TypeScript emitted no output.',
      logs: [],
      compiled: [],
      rpc: { requests: 0, ms: 0 },
      totalMs: performance.now() - start,
    };
  }

  const logs: ConsoleLine[] = [];
  const rpc = { requests: 0, ms: 0 };
  let error: string | undefined;
  let compiled: CompiledArtifact[] = [];

  (globalThis as Record<string, unknown>).__EVS_PLAYGROUND_RPC__ = rpcUrl;

  const capture =
    (level: ConsoleLine['level'], original: (...args: unknown[]) => void) =>
    (...args: unknown[]) => {
      logs.push({ level, text: args.map((a) => formatValue(a)).join(' ') });
      original(...args);
    };
  const originalConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  const originalFetch = globalThis.fetch;

  console.log = capture('log', originalConsole.log);
  console.info = capture('log', originalConsole.info);
  console.warn = capture('warn', originalConsole.warn);
  console.error = capture('error', originalConsole.error);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestStart = performance.now();
    try {
      return await originalFetch(input, init);
    } finally {
      rpc.requests += 1;
      rpc.ms += performance.now() - requestStart;
    }
  }) as typeof fetch;

  let blobUrl: string | undefined;
  try {
    await loadRuntimeModules();
    const rewritten = rewriteImports(js);
    blobUrl = URL.createObjectURL(new Blob([rewritten], { type: 'text/javascript' }));
    const moduleExports = (await Promise.race([
      import(/* @vite-ignore */ blobUrl),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Run timed out after 60s.')), 60_000),
      ),
    ])) as Record<string, unknown>;
    compiled = collectCompiled(moduleExports);
  } catch (thrown) {
    error =
      thrown instanceof Error
        ? ((thrown as { shortMessage?: string }).shortMessage ?? thrown.message)
        : String(thrown);
  } finally {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    Object.assign(console, originalConsole);
    globalThis.fetch = originalFetch;
  }

  return {
    ok: error === undefined,
    error,
    logs,
    compiled,
    rpc,
    totalMs: performance.now() - start,
  };
}
