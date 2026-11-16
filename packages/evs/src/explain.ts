/**
 * `explain.ts` — `explainRevert`: a revert payload, explained against the script that produced
 * it.
 *
 * It presents the shared revert classifier (`abi/revert.ts`, also behind `decodeScriptError`):
 * `Panic(uint256)` with the sites whose `panicCodes` include the code, `EvsDecodeError(uint256
 * site)` (exact site), `EvsInvalidCalldata()`, declared errors, and — for payloads only a callee
 * can produce (`Error(string)`, foreign selectors, the empty revert) — the strict call sites that
 * bubble them.
 *
 * Compiler-free: everything it reads is in `ExplainContext`, which is plain data. A compiled
 * script calls it directly (`compile.ts`); a precompiled script loads this module and its debug
 * data on demand (`precompiled.ts`), so neither ships with the scripts that never revert.
 */

import { canonicalTypeSignature, describePanic } from './abi/artifact.js';
import { classifyRevert, errorTableOf } from './abi/revert.js';
import type { EvmVersion } from './asm/forks.js';
import { siteById, type SourceMap } from './asm/sourcemap.js';
import { bytesToHex, hexToBytes, isHexString } from './core/bytes.js';
import { EvsTypeError } from './core/errors.js';
import type { Hex } from './core/types.js';
import { describeForkOpcodes, forkOpcodesOf } from './evm-target.js';
import { walkStmts, type ScriptIr, type SiteId, type Stmt } from './ir/nodes.js';

export interface RevertExplanation {
  kind:
    | 'panic'
    | 'evs-decode'
    | 'evs-invalid-calldata'
    | 'error-string'
    | 'script-error' // a DECLARED custom error thrown by s.throw (issue #15)
    | 'custom'
    | 'empty';
  message: string;
  panicCode?: bigint;
  errorName?: string; // script-error only: the declared error's name
  errorArgs?: Readonly<Record<string, unknown>>; // script-error only: name-keyed decoded args
  site?: { id: SiteId; detail: string };
  // 'panic': the sites whose template can raise that code. 'error-string' / 'custom' / 'empty'
  // (and a 'script-error' whose args do not decode): the strict call sites that bubble a callee
  // revert verbatim (the only places such a payload can enter the script). Absent otherwise.
  candidateSites?: readonly { id: SiteId; detail: string }[];
  raw: Hex;
}

/** Everything `explainRevert` reads from a script. All of it survives a JSON round trip. */
export interface ExplainContext {
  readonly ir: ScriptIr; // the recorded IR
  readonly sites: SourceMap['sites']; // the EMITTED sites (after DCE, uncalled fns dropped)
  readonly abi: readonly unknown[];
  readonly runtimeBytecode: Hex;
  readonly evmVersion: EvmVersion;
}

type SiteRef = { id: SiteId; detail: string };

function toSiteRef(site: SourceMap['sites'][number]): SiteRef {
  return { id: site.id, detail: site.detail };
}

/**
 * The emitted call sites that forward a callee's revert payload verbatim: strict `s.read` /
 * `s.call` / `s.simulate` sites. `try*` sites swallow the revert, and a `revertReturns` site
 * decodes it as its value (a normal return is its failure, reported as `EvsDecodeError`), so
 * neither can bubble anything.
 */
function bubblingSites(ctx: ExplainContext): SiteRef[] {
  return strictCallSites(ctx, (s) => s.revertReturns === undefined).map(toSiteRef);
}

/**
 * The strict `s.call` sites that send a `value` (`sendsValue`) and bubble an empty CALL failure:
 * an unfunded script fails their CALL before the target runs, with no returndata. (`s.simulate`
 * and `revertReturns` sites report that failure as `EvsDecodeError(site)` instead.)
 */
function unfundedValueSites(ctx: ExplainContext): SiteRef[] {
  return strictCallSites(ctx, (s) => s.kind === 'call' && s.revertReturns === undefined)
    .filter((site) => site.sendsValue === true)
    .map(toSiteRef);
}

/**
 * Whether an unfunded script turns site `id`'s failed CALL into `EvsDecodeError(id)`: a strict
 * `s.simulate` (the self-call hop carries the value and fails, so nothing decodes) or a
 * `revertReturns` site (the empty revert data cannot decode) that sends a `value`. A plain strict
 * `s.call` bubbles that failure as an empty revert instead (`unfundedValueSites`).
 */
function unfundedDecodeSite(ctx: ExplainContext, id: SiteId): boolean {
  return strictCallSites(ctx, (s) => s.kind === 'simulate' || s.revertReturns !== undefined).some(
    (site) => site.id === id && site.sendsValue === true,
  );
}

/** The emitted sites of the strict `call` statements `keep` selects. */
function strictCallSites(
  ctx: ExplainContext,
  keep: (s: Extract<Stmt, { k: 'call' }>) => boolean,
): SourceMap['sites'] {
  const ids = new Set<SiteId>();
  const look = (s: Stmt): void => {
    if (s.k === 'call' && s.mode === 'strict' && keep(s)) ids.add(s.site);
  };
  walkStmts(ctx.ir.body, look);
  for (const fn of ctx.ir.fns) walkStmts(fn.body, look);
  return ctx.sites.filter((s) => ids.has(s.id));
}

/** How to fund a script that sends `value` (the deployless one cannot be funded). */
const FUND_THE_SCRIPT =
  "fund the script with a `balance` in its toViem({ mode: 'stateOverride' }) entry (or run it " +
  'in sender mode); the default deployless mode cannot fund it';

/** The sites by detail and id: all of them, or the first `limit` and how many follow. */
function listSites(sites: readonly SiteRef[], limit = sites.length): string {
  const shown = sites.slice(0, limit).map((s) => `${s.detail} (site ${s.id})`);
  const rest = sites.length - shown.length;
  return rest > 0
    ? `${shown.join('; ')}; and ${rest} more (candidateSites lists them all)`
    : shown.join('; ');
}

/** "bubbled verbatim from a callee through …" naming the strict call sites (non-empty), at most
 *  `limit` of them. */
function throughCallSites(sites: readonly SiteRef[], limit?: number): string {
  const where =
    sites.length === 1 ? 'the strict call site' : `one of the ${sites.length} strict call sites`;
  return `bubbled verbatim from a callee through ${where}: ${listSites(sites, limit)}`;
}

const NOT_FROM_THIS_ARTIFACT =
  'this script has no strict call site that bubbles a callee revert, so the payload did not ' +
  'come from this artifact';

/** The " — <where it came from>" clause for a payload only a callee can have produced. */
function bubbledFrom(sites: readonly SiteRef[]): string {
  return ` — ${sites.length > 0 ? throughCallSites(sites) : NOT_FROM_THIS_ARTIFACT}`;
}

const CALLEE_FORGERY_HEDGE =
  ' — note: the script has strict call sites that bubble callee reverts, and a callee may have ' +
  'reverted with this selector verbatim (bubbled byte-exactly), in which case the failure ' +
  'originated off-script';

/**
 * The evs error selectors (`EvsDecodeError`, `EvsInvalidCalldata`) and declared script errors
 * are public — a callee can revert with them verbatim, and a strict call site bubbles the payload
 * byte-exactly, so for a script WITH a bubbling site an attribution to the script is a strong
 * hint, never proof. Without one (no sub-calls, or only `try*` / `revertReturns` sites) nothing
 * can be bubbled, so there the attribution is authoritative and carries no hedge.
 */
function forgeryHedge(ctx: ExplainContext): string {
  return bubblingSites(ctx).length > 0 ? CALLEE_FORGERY_HEDGE : '';
}

/** Explains the revert payload `data` of the script `ctx` describes. */
export function explainRevert(data: Hex, ctx: ExplainContext): RevertExplanation {
  const raw = bytesToHex(decodeHex(data));
  const byteLength = (raw.length - 2) / 2;
  const c = classifyRevert(raw, errorTableOf(ctx.abi));
  switch (c.kind) {
    case 'empty':
      return explainEmpty(raw, ctx);
    case 'short': {
      const candidateSites = bubblingSites(ctx);
      return {
        kind: 'custom',
        message:
          `malformed revert payload (${byteLength} bytes — shorter than a 4-byte selector)` +
          bubbledFrom(candidateSites),
        candidateSites,
        raw,
      };
    }
    case 'panic':
      return explainPanic(raw, c.code, ctx);
    case 'error-string': {
      const candidateSites = bubblingSites(ctx);
      return {
        kind: 'error-string',
        message: `callee revert Error(${JSON.stringify(c.reason)})${bubbledFrom(candidateSites)}`,
        candidateSites,
        raw,
      };
    }
    case 'abi-error':
      if (c.args !== null && c.entry.name === 'EvsDecodeError') {
        return explainDecodeError(raw, c.args['site'], ctx);
      }
      if (c.args !== null && c.entry.name === 'EvsInvalidCalldata') {
        return explainInvalidCalldata(raw, ctx);
      }
      if (c.entry.name !== 'EvsDecodeError' && c.entry.name !== 'EvsInvalidCalldata') {
        return explainScriptError(raw, c.entry.name, c.selector, c.args, ctx);
      }
      // an evs built-in selector whose payload does not decode: not something evs emits
      return explainCustom(raw, c.selector, byteLength, ctx);
    default: // 'unknown'
      return explainCustom(raw, c.selector, byteLength, ctx);
  }
}

function explainCustom(
  raw: Hex,
  selector: Hex,
  byteLength: number,
  ctx: ExplainContext,
): RevertExplanation {
  const candidateSites = bubblingSites(ctx);
  return {
    kind: 'custom',
    message:
      `custom error ${selector} (${byteLength} byte payload) — decode it against the callee's ABI` +
      bubbledFrom(candidateSites),
    candidateSites,
    raw,
  };
}

function explainPanic(raw: Hex, code: bigint, ctx: ExplainContext): RevertExplanation {
  const { codeHex, meaning } = describePanic(code);
  // `panicCodes` is exact per site (codegen/sites.ts): only sites whose template can raise
  // THIS code are candidates; `detail` is display text and never matched on
  const candidateSites = ctx.sites
    .filter((s) => s.panicCodes?.some((p) => BigInt(p) === code) === true)
    .map(toSiteRef);
  const bubbling = bubblingSites(ctx);
  let where: string;
  if (candidateSites.length > 0) {
    where = ` — ${candidateSites.length} candidate site(s) in this script: ${listSites(candidateSites)}`;
    if (bubbling.length > 0) where += `; or ${throughCallSites(bubbling)}`;
  } else {
    where =
      ` — no site in this script can raise Panic(${codeHex}), so ` +
      (bubbling.length > 0 ? `it was ${throughCallSites(bubbling)}` : NOT_FROM_THIS_ARTIFACT);
  }
  return {
    kind: 'panic',
    message: `Panic(${codeHex}): ${meaning}${where}`,
    panicCode: code,
    candidateSites,
    raw,
  };
}

function explainDecodeError(raw: Hex, siteArg: unknown, ctx: ExplainContext): RevertExplanation {
  const id = typeof siteArg === 'bigint' ? siteArg : -1n;
  const hedge = forgeryHedge(ctx);
  if (raw.length !== 2 + 36 * 2) {
    return {
      kind: 'evs-decode',
      message:
        `returndata decode failed (EvsDecodeError site ${id}) — but the payload is ` +
        `${(raw.length - 2) / 2} bytes, not the 36 this compiler emits, so this script's own ` +
        `code cannot have produced it${hedge}`,
      raw,
    };
  }
  const idNum = id >= 0n && id <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(id) : -1;
  const site = idNum >= 0 ? siteById(ctx, idNum) : undefined;
  // only a 'decode'-kind site is a plausible script origin: the compiler emits
  // EvsDecodeError(site) exclusively from strict-call decode-fail stubs. Any other site id
  // (or an unknown one) cannot have been produced by this script's own code.
  if (site !== undefined && site.kind === 'decode') {
    const ref = toSiteRef(site);
    // a value-sending s.simulate / revertReturns site also lands here when the script cannot
    // pay: the CALL (for s.simulate, the self-call hop that carries the value) fails and nothing
    // decodes. A plain strict s.call bubbles an empty revert instead, never this error.
    const unfunded = unfundedDecodeSite(ctx, site.id)
      ? `, or the script's balance was below the \`value\` this site sends, so its CALL ` +
        `failed before the target ran — ${FUND_THE_SCRIPT}`
      : '';
    return {
      kind: 'evs-decode',
      message: `${ref.detail} failed (EvsDecodeError site ${ref.id})${unfunded}${hedge}`,
      site: ref,
      raw,
    };
  }
  if (site !== undefined) {
    return {
      kind: 'evs-decode',
      message:
        `returndata decode failed (EvsDecodeError site ${id}) — but site ${id} is not a ` +
        `returndata-decode site in this script, so this script's own code cannot have ` +
        `produced the payload${hedge}`,
      raw,
    };
  }
  return {
    kind: 'evs-decode',
    message: `returndata decode failed (EvsDecodeError site ${id}) — the site id is unknown to this artifact's source map${hedge}`,
    raw,
  };
}

function explainInvalidCalldata(raw: Hex, ctx: ExplainContext): RevertExplanation {
  const { ir } = ctx;
  const signature = `${ir.name}(${ir.args.map((a) => canonicalTypeSignature(a.type)).join(',')})`;
  const hedge = forgeryHedge(ctx);
  return {
    kind: 'evs-invalid-calldata',
    message:
      `calldata does not match ${signature} — the script reverted EvsInvalidCalldata() ` +
      `(wrong selector, truncated calldata, or malformed dynamic arguments)${hedge}`,
    raw,
  };
}

/** A DECLARED custom error (issue #15). The callee-forgery hedge applies exactly as for the evs
 *  selectors: the selector is public. */
function explainScriptError(
  raw: Hex,
  name: string,
  selector: Hex,
  args: Readonly<Record<string, unknown>> | null,
  ctx: ExplainContext,
): RevertExplanation {
  if (args === null) {
    // s.throw always encodes its args well-formed: a malformed payload can only be a callee's
    const candidateSites = bubblingSites(ctx);
    return {
      kind: 'script-error',
      message:
        `declared error ${name} (selector ${selector}) with a MALFORMED argument ` +
        `payload (${(raw.length - 10) / 2} bytes) — the payload does not decode against its ` +
        `declared inputs, so this script's s.throw cannot have produced it` +
        bubbledFrom(candidateSites),
      errorName: name,
      candidateSites,
      raw,
    };
  }
  const hedge = forgeryHedge(ctx);
  const shown = Object.entries(args)
    .map(([k, v]) => `${k}: ${fmtErrorArg(v)}`)
    .join(', ');
  return {
    kind: 'script-error',
    message: `script error ${name}(${shown}) — thrown by s.throw${hedge}`,
    errorName: name,
    errorArgs: args,
    raw,
  };
}

/** How many strict call sites the empty-revert `message` names before it counts the rest: the
 *  other causes come after that list and have to stay readable. `candidateSites` holds them all. */
const EMPTY_MESSAGE_SITES = 3;

/**
 * The empty payload proves nothing about its origin, so the message lists every cause this
 * script allows, the one a user can settle fastest first:
 *
 * 1. an opcode the node does not have at the requested block (a fork-gated opcode run at a
 *    historical block, or on a chain that has not activated that fork), when the runtime uses
 *    one: every call of the script then fails this way, whatever its arguments;
 * 2. a callee's bare `revert()` / `require(false)` bubbled by a strict call site;
 * 3. a strict `s.call` that sends a `value` the script's balance cannot cover (the CALL fails
 *    before the target runs);
 * 4. out of gas;
 * 5. a deployless limit (`deployless.ts`) on a node that answers one with a plain revert instead
 *    of a creation error, where `explainDeploylessError` has no text to recognize.
 */
function explainEmpty(raw: Hex, ctx: ExplainContext): RevertExplanation {
  const candidateSites = bubblingSites(ctx);
  const causes: string[] = [];
  const opcodes = forkOpcodesOf(ctx.runtimeBytecode);
  if (opcodes.length > 0) {
    causes.push(
      `an opcode the node does not have at this block: ${describeForkOpcodes(opcodes)} ` +
        `(evmVersion '${ctx.evmVersion}'), so for a block or chain before that fork, recompile ` +
        `with an older evmVersion ('paris' runs everywhere)`,
    );
  }
  if (candidateSites.length > 0) {
    causes.push(
      `a bare revert() / require(false) ${throughCallSites(candidateSites, EMPTY_MESSAGE_SITES)}`,
    );
  }
  const valueSites = unfundedValueSites(ctx);
  if (valueSites.length > 0) {
    causes.push(
      `the script's balance was below the \`value\` sent by ${listSites(valueSites)}, so that ` +
        `CALL failed before the target ran — ${FUND_THE_SCRIPT}`,
    );
  }
  causes.push('the call ran out of gas');
  causes.push(
    `in deployless mode (the toViem() default), a result that is too large or starts with ` +
      `0xEF, or a script and arguments that are too large together: some nodes (zkSync Era, ` +
      `Monad) report those limits as an empty revert — run the call again with ` +
      `toViem({ mode: 'stateOverride' }), which has none of them`,
  );
  return {
    kind: 'empty',
    message:
      `empty revert payload (no returndata) — possible causes: ` +
      causes.map((cause, i) => `(${i + 1}) ${cause}`).join('; '),
    candidateSites,
    raw,
  };
}

/** Message rendering of one decoded error arg — bigints (top-level or nested in a decoded
 *  struct/array arg) stringify as `123n`. */
function fmtErrorArg(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? `${x}n` : x));
}

function decodeHex(hex: Hex): Uint8Array {
  if (!isHexString(hex)) {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `explainRevert: expected 0x-prefixed even-length hex data, got ${JSON.stringify(hex)}`,
    );
  }
  return hexToBytes(hex);
}
