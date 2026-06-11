/**
 * The research fixtures `RUNTIME_42` and `RUNTIME_WHOAMI` (viem-integration App. A),
 * hand-assembled with the M4 writer/assembler and executed.
 *
 * NOTE: module-interfaces.md asks for execution "on the M10 harness"
 * (`test/harness/evm.ts`); that module is not implemented yet, so these tests execute the
 * assembled runtime directly on `@ethereumjs/evm` (the same engine the harness is pinned to).
 * Once M10 lands, the integration-tier suites cover the harness path.
 */

import { createEVM } from '@ethereumjs/evm';
import { describe, expect, test } from 'vitest';

import { AsmWriter, assemble } from './assembler.js';
import { disassemble } from './disasm.js';

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

type Evm = Awaited<ReturnType<typeof createEVM>>;
type RunCodeOpts = NonNullable<Parameters<Evm['runCode']>[0]>;
type EvmAddress = NonNullable<RunCodeOpts['to']>;

/** Minimal structural stand-in for @ethereumjs/util's Address (not a direct dependency). */
function mkAddress(addrHex: string): EvmAddress {
  const body = addrHex.replace(/^0x/, '');
  const addrBytes = new Uint8Array(20);
  for (let i = 0; i < 20; i++) {
    addrBytes[i] = Number.parseInt(body.slice(2 * i, 2 * i + 2), 16);
  }
  const address = {
    bytes: addrBytes,
    toString: () => `0x${body}`,
    toBytes: () => addrBytes,
    isZero: () => addrBytes.every((b) => b === 0),
    isPrecompileOrSystemAddress: () => false,
    equals: (other: { bytes: Uint8Array }) =>
      other.bytes.length === addrBytes.length && other.bytes.every((b, i) => b === addrBytes[i]),
  };
  // The Address class lives in @ethereumjs/util (not a dependency of evs) — a structural
  // stand-in is the only way to construct one here.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return address as unknown as EvmAddress;
}

async function exec(
  runtime: Uint8Array,
  opts?: { to?: EvmAddress; caller?: EvmAddress },
): Promise<{ data: string; failed: boolean }> {
  const evm = await createEVM();
  const runOpts: RunCodeOpts = { code: runtime, gasLimit: 1_000_000n };
  if (opts?.to !== undefined) runOpts.to = opts.to;
  if (opts?.caller !== undefined) runOpts.caller = opts.caller;
  const res = await evm.runCode(runOpts);
  return { data: hex(res.returnValue), failed: res.exceptionError !== undefined };
}

function assembleRuntime42(evmVersion: 'paris' | 'cancun'): Uint8Array {
  // PUSH1 0x2a PUSH1 0 MSTORE PUSH1 0x20 PUSH1 0 RETURN — returns uint256(42)
  const w = new AsmWriter();
  w.push(0x2an, { note: 'the answer' });
  w.push(0n);
  w.op('MSTORE');
  w.push(0x20n);
  w.push(0n);
  w.op('RETURN');
  return assemble(w.nodes(), { evmVersion }).bytecode;
}

function assembleRuntimeWhoami(evmVersion: 'paris' | 'cancun'): Uint8Array {
  // ADDRESS PUSH1 0 MSTORE CALLER PUSH1 0x20 MSTORE PUSH1 0x40 PUSH1 0 RETURN
  const w = new AsmWriter();
  w.op('ADDRESS');
  w.push(0n);
  w.op('MSTORE');
  w.op('CALLER');
  w.push(0x20n);
  w.op('MSTORE');
  w.push(0x40n);
  w.push(0n);
  w.op('RETURN');
  return assemble(w.nodes(), { evmVersion }).bytecode;
}

describe('RUNTIME_42 (viem-integration App. A)', () => {
  test('hand-assembly on paris reproduces the research bytes exactly', () => {
    expect(hex(assembleRuntime42('paris'))).toBe('602a60005260206000f3');
  });

  test('executes and returns uint256(42) — paris and cancun lowering agree', async () => {
    const results = await Promise.all(
      (['paris', 'cancun'] as const).map((evmVersion) => exec(assembleRuntime42(evmVersion))),
    );
    for (const { data, failed } of results) {
      expect(failed).toBe(false);
      expect(data).toBe(`${'00'.repeat(31)}2a`);
    }
  });

  test('disassembles back to the documented listing', () => {
    const d = disassemble('0x602a60005260206000f3');
    expect(
      d.lines.map((l) => `${l.mnemonic}${l.pushValue === undefined ? '' : ` ${l.pushValue}`}`),
    ).toEqual(['PUSH1 0x2a', 'PUSH1 0x00', 'MSTORE', 'PUSH1 0x20', 'PUSH1 0x00', 'RETURN']);
  });
});

describe('RUNTIME_WHOAMI (viem-integration App. A)', () => {
  test('hand-assembly on paris reproduces the research bytes exactly', () => {
    expect(hex(assembleRuntimeWhoami('paris'))).toBe('306000523360205260406000f3');
  });

  test('executes and returns (address(this), msg.sender)', async () => {
    const self = '1111111111111111111111111111111111111111';
    const caller = '2222222222222222222222222222222222222222';
    const results = await Promise.all(
      (['paris', 'cancun'] as const).map((evmVersion) =>
        exec(assembleRuntimeWhoami(evmVersion), {
          to: mkAddress(self),
          caller: mkAddress(caller),
        }),
      ),
    );
    for (const { data, failed } of results) {
      expect(failed).toBe(false);
      expect(data).toBe(`${'00'.repeat(12)}${self}${'00'.repeat(12)}${caller}`);
    }
  });
});
