/**
 * Differential suite — the anti-miscompilation core. Shared runner + callee table + fixture
 * constants; the corpus itself lives in `src/differential/*.test.ts`, one file per family so
 * vitest spreads the slices over its workers.
 *
 * For a corpus of builder scripts covering every op family, control flow, calls with mocks,
 * tryCall, and dynamic returns, `interpret(script.ir, args, mockChain)` must agree
 * BYTE-FOR-BYTE with `execRuntime(compile(script).runtimeBytecode, calldata, fixture)` on
 * both returndata and revert payloads (Panic codes, EvsDecodeError site ids, bubbled callee
 * reverts, tryCall zeroing). The mock chain and the harness fixtures are generated from the
 * same callee table so both sides see identical callee behavior; the `Reverter` case uses
 * the REAL solc artifact on the EVM side against independently ABI-encoded payloads on the
 * interpreter side.
 */

import type { Abi, Address } from 'abitype';
import { encodeErrorResult, encodeFunctionData, toFunctionSelector } from 'viem';
import { expect } from 'vite-plus/test';

import { assemble, AsmWriter, type LabelId } from '../../src/asm/assembler.js';
import type { EvmVersion } from '../../src/asm/ops.js';
import { lowerProgram } from '../../src/codegen/program.js';
import { compile, type CompiledEvsScript } from '../../src/compile.js';
import type { Hex } from '../../src/core/types.js';
import { eliminateDeadCode } from '../../src/ir/dce.js';
import { interpret, type MockChain } from '../../src/ir/interp.js';
import { serializeIr, type ScriptIr } from '../../src/ir/nodes.js';
import { validateIr } from '../../src/ir/validate.js';
import { execRuntime, hexToBytes, type EvmFixture } from './evm.js';
import { returner, reverter, RUNTIME_ECHO } from './fixtures.js';

// ---------------------------------------------------------------------------
// shared callee table → (MockChain, EvmFixture) — the same table feeds both legs
// ---------------------------------------------------------------------------

export type CalleeCase = { selector: Hex; kind: 'return' | 'revert'; data: Hex };
export type CalleeBehavior =
  | { kind: 'return' | 'revert'; data: Hex } // fixed payload, any calldata
  | { kind: 'dispatch'; cases: readonly CalleeCase[] } // route on selector
  | { kind: 'echo' } // returns calldata verbatim
  | { kind: 'bytecode'; runtime: Hex; respond: (calldata: Hex) => { success: boolean; data: Hex } };
/** Keys MUST be lowercase 0x addresses (the interpreter reports `to` lowercased). */
export type CalleeTable = Readonly<Record<string, CalleeBehavior>>;

export function chainOf(table: CalleeTable): MockChain {
  return {
    staticcall({ to, data }) {
      const entry = table[to.toLowerCase()];
      // unmocked account: a real STATICCALL to code-less address SUCCEEDS with empty returndata
      if (entry === undefined) return { success: true, data: '0x' };
      switch (entry.kind) {
        case 'return':
          return { success: true, data: entry.data };
        case 'revert':
          return { success: false, data: entry.data };
        case 'echo':
          return { success: true, data };
        case 'dispatch': {
          const sel = data.slice(0, 10).toLowerCase();
          const hit = entry.cases.find((c) => c.selector.toLowerCase() === sel);
          if (hit === undefined) return { success: false, data: '0x' };
          return { success: hit.kind === 'return', data: hit.data };
        }
        default:
          return entry.respond(data);
      }
    },
  };
}

export function fixtureOf(table: CalleeTable): EvmFixture {
  const contracts: Record<Address, Hex> = {};
  const runtimeOf = (entry: CalleeBehavior): Hex => {
    switch (entry.kind) {
      case 'return':
        return returner(entry.data);
      case 'revert':
        return reverter(entry.data);
      case 'echo':
        return RUNTIME_ECHO;
      case 'dispatch':
        return dispatcherMock(entry.cases);
      default:
        return entry.runtime;
    }
  };
  for (const [address, entry] of Object.entries(table)) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- table keys are addresses
    contracts[address as Address] = runtimeOf(entry);
  }
  return { contracts };
}

/** Selector-routing mock runtime, assembled with the project's own (verified) assembler. */
export function dispatcherMock(cases: readonly CalleeCase[]): Hex {
  const w = new AsmWriter();
  w.push(0);
  w.op('CALLDATALOAD');
  w.push(0xe0);
  w.op('SHR'); // [sel]
  const caseLabels: LabelId[] = cases.map((_, i) => w.newLabel(`case_${i}`));
  cases.forEach((c, i) => {
    w.op('DUP1');
    w.pushBytes(hexToBytes(c.selector));
    w.op('EQ');
    w.pushLabel(caseLabels[i] ?? 0);
    w.op('JUMPI');
  });
  w.push(0);
  w.push(0);
  w.op('REVERT'); // unknown selector
  const payloads: { label: LabelId; bytes: Uint8Array }[] = [];
  cases.forEach((c, i) => {
    w.label(caseLabels[i] ?? 0, 1); // [sel]
    const bytes = hexToBytes(c.data);
    if (bytes.length === 0) {
      w.push(0);
      w.push(0);
    } else {
      const dl = w.newLabel(`payload_${i}`);
      payloads.push({ label: dl, bytes });
      w.push(bytes.length); // [len, sel]
      w.op('DUP1'); // [len, len, sel]
      w.pushLabel(dl); // [off, len, len, sel]
      w.push(0); // [0, off, len, len, sel]
      w.op('CODECOPY'); // [len, sel]
      w.push(0); // [0, len, sel]
    }
    w.op(c.kind === 'return' ? 'RETURN' : 'REVERT');
  });
  for (const p of payloads) {
    w.dataLabel(p.label);
    w.data(p.bytes);
  }
  const { bytecode } = assemble(w.nodes(), { evmVersion: 'cancun' });
  let hex = '';
  for (const b of bytecode) hex += b.toString(16).padStart(2, '0');
  return `0x${hex}`;
}

// ---------------------------------------------------------------------------
// the differential runner
// ---------------------------------------------------------------------------

export interface AnyScript {
  readonly name: string;
  readonly ir: ScriptIr;
  readonly abi: readonly unknown[];
}

export type Outcome = { kind: 'return' | 'revert'; data: Hex };

/** The distinct source locations a source map carries (order-free). */
export function mappedLocs(map: CompiledEvsScript['sourceMap']): string[] {
  const keys = map.segments.map((seg) =>
    seg.loc === null ? 'null' : `${seg.loc.file}:${seg.loc.line}:${seg.loc.column}`,
  );
  return [...new Set(keys)].toSorted();
}

/**
 * Compiles twice — the default output AND its `optimize: true` twin (the built-in passes: the
 * liveness-based frame allocator, issue #41, and the peephole pass, issue #39) — checks the
 * always-on DCE pass (issue #40: `interpret(ir) == interpret(dce(ir))`, output validity,
 * idempotence), then for every arg set asserts byte-exact agreement between the reference
 * interpreter and BOTH compiled runtimes on the harness EVM. The optimized twin must also
 * never be larger, never use a larger frame, never cost more gas, and carry exactly the same
 * mapped source locations.
 * Returns the (agreed) outcomes so callers can pin expectations for specific cases.
 */
export async function expectAgreement(
  script: AnyScript,
  argSets: readonly (readonly unknown[])[],
  table: CalleeTable = {},
  evmVersion: EvmVersion = 'cancun',
): Promise<Outcome[]> {
  // compile() lowers dce(ir) (issue #40): the corpus therefore also gates the DCE pass —
  // interpret(ir) == interpret(dce(ir)) == bytecode(dce(ir)) — plus idempotence and validity.
  const compiled: CompiledEvsScript = compile(script, { evmVersion });
  const dced = eliminateDeadCode(script.ir);
  expect(() => validateIr(dced), `${script.name}: dce output validates`).not.toThrow();
  expect(serializeIr(eliminateDeadCode(dced)), `${script.name}: dce idempotence`).toBe(
    serializeIr(dced),
  );
  const optimized: CompiledEvsScript = compile(script, { evmVersion, optimize: true });
  const twinLabel = `${script.name} [${evmVersion}] optimized twin`;
  expect(optimized.runtimeBytecode.length, `${twinLabel}: size`).toBeLessThanOrEqual(
    compiled.runtimeBytecode.length,
  );
  expect(mappedLocs(optimized.sourceMap), `${twinLabel}: mapped locations`).toEqual(
    mappedLocs(compiled.sourceMap),
  );
  const frameEndOf = (optimize: boolean): number =>
    lowerProgram(script.ir, { evmVersion, locations: true, optimize }).frameEnd;
  expect(frameEndOf(true), `${twinLabel}: frame`).toBeLessThanOrEqual(frameEndOf(false));
  const fixture = fixtureOf(table);
  const chain = chainOf(table);
  const outcomes: Outcome[] = [];
  for (const args of argSets) {
    const label = `${script.name}(${args.map(String).join(', ')}) [${evmVersion}]`;
    const calldata = encodeFunctionData({ abi: compiled.abi, functionName: script.name, args });
    const fromInterp = interpret(script.ir, args, chain).outcome;
    const fromDce = interpret(dced, args, chain).outcome;
    expect(fromDce.kind, `${label}: dce interp outcome`).toBe(fromInterp.kind);
    expect(fromDce.data, `${label}: dce interp payload`).toBe(fromInterp.data);
    // oxlint-disable-next-line no-await-in-loop -- sequential by design: deterministic per-case labels
    const fromEvm = await execRuntime(compiled.runtimeBytecode, calldata, fixture);
    expect(fromEvm.success, `${label}: interp outcome is '${fromInterp.kind}'`).toBe(
      fromInterp.kind === 'return',
    );
    expect(fromEvm.data, `${label}: payload`).toBe(fromInterp.data);
    // decode/panic reverts must never be exceptional halts (no all-gas consumption)
    expect(fromEvm.gasUsed, `${label}: gas sanity`).toBeLessThan(25_000_000n);
    // the optimized twin: same outcome, same payload, never more gas
    // oxlint-disable-next-line no-await-in-loop -- see above
    const fromOptimized = await execRuntime(optimized.runtimeBytecode, calldata, fixture);
    expect(fromOptimized.success, `${label} (optimized): outcome`).toBe(
      fromInterp.kind === 'return',
    );
    expect(fromOptimized.data, `${label} (optimized): payload`).toBe(fromInterp.data);
    expect(fromOptimized.gasUsed, `${label} (optimized): gas`).toBeLessThanOrEqual(fromEvm.gasUsed);
    outcomes.push({ kind: fromInterp.kind, data: fromInterp.data });
  }
  return outcomes;
}

// ---------------------------------------------------------------------------
// shared constants
// ---------------------------------------------------------------------------

export const PANIC_ABI = [
  { type: 'error', name: 'Panic', inputs: [{ name: 'code', type: 'uint256' }] },
] as const;
export const ERROR_ABI = [
  { type: 'error', name: 'Error', inputs: [{ name: 'reason', type: 'string' }] },
] as const;
export const panicData = (code: bigint): Hex =>
  encodeErrorResult({ abi: PANIC_ABI, errorName: 'Panic', args: [code] });

export const TOKA = '0xa000000000000000000000000000000000000001';
export const TOKB = '0xb000000000000000000000000000000000000002';
export const POOL = '0xc000000000000000000000000000000000000003';
export const REVERTER = '0xd000000000000000000000000000000000000004';
export const ECHO = '0xe000000000000000000000000000000000000005';
export const DEAD = '0xdead00000000000000000000000000000000dead';
export const USER = '0x1000000000000000000000000000000000000001';
export const SINK = '0xf000000000000000000000000000000000000006';

export const erc20ishAbi = [
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'flag',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'tick',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'int24' }],
  },
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    type: 'function',
    name: 'list',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256[]' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'multi',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'a', type: 'uint160' },
      { name: 'b', type: 'int24' },
      { name: 'c', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'mix',
    stateMutability: 'view',
    inputs: [
      { name: 'v', type: 'uint256' },
      { name: 'who', type: 'address' },
      { name: 'payload', type: 'bytes' },
    ],
    outputs: [{ name: '', type: 'bytes' }],
  },
  {
    type: 'function',
    name: 'token0',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'token1',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'slot0',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'tick', type: 'int24' },
    ],
  },
] as const satisfies Abi;

export const sel = (signature: string): Hex => toFunctionSelector(signature);

export const EVM_VERSIONS = ['paris', 'shanghai', 'cancun'] as const;

// ---------------------------------------------------------------------------
// helper mocks
// ---------------------------------------------------------------------------

/** Runtime that returns `abi.encode(bytes(calldata))` — the sub-call-calldata oracle. */
export function abiEchoMock(): Hex {
  const w = new AsmWriter();
  w.push(0x20);
  w.push(0);
  w.op('MSTORE'); // mem[0] = 0x20 (head offset)
  w.op('CALLDATASIZE');
  w.push(0x20);
  w.op('MSTORE'); // mem[0x20] = len
  w.op('CALLDATASIZE');
  w.push(0);
  w.push(0x40);
  w.op('CALLDATACOPY'); // mem[0x40..] = calldata (fresh memory beyond is zero — padding)
  w.op('CALLDATASIZE');
  w.push(31);
  w.op('ADD');
  w.push(31);
  w.op('NOT');
  w.op('AND'); // ceil32(len)
  w.push(0x40);
  w.op('ADD');
  w.push(0);
  w.op('RETURN'); // return(0, 0x40 + ceil32(len))
  const { bytecode } = assemble(w.nodes(), { evmVersion: 'cancun' });
  let hex = '';
  for (const b of bytecode) hex += b.toString(16).padStart(2, '0');
  return `0x${hex}`;
}
