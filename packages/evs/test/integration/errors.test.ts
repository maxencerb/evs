/**
 * Custom errors end-to-end on anvil (issue #15; testing.md §3):
 *
 * - a thrown declared error's raw revert data over a REAL eth_call is byte-exact
 *   `selector ‖ abi.encode(args)` (pinned against viem's own `encodeErrorResult`);
 * - viem's `readContract` decodes the revert NATIVELY from the artifact ABI (the errors ride
 *   in the ABI — no call wrappers);
 * - the caught viem error round-trips through `decodeScriptError` / `matchScriptError`,
 *   with the `_` default arm receiving non-declared reverts (a bubbled callee error).
 */

import {
  BaseError,
  ContractFunctionRevertedError,
  encodeErrorResult,
  encodeFunctionData,
} from 'viem';
import { beforeAll, describe, expect, test } from 'vitest';

import {
  compile,
  decodeScriptError,
  evscript,
  matchScriptError,
  namedArg,
  t,
} from '../../src/index.js';
import { Reverter } from '../generated/index.js';
import { publicClient } from '../harness/anvil.js';
import { callExpectRevert, deploy, extractRevertData } from './helpers.js';

const NoBalance = t.error('NoBalance', [
  namedArg('balance', t.uint256),
  namedArg('who', t.address),
]);
const NotOwner = t.error('NotOwner');

const WHO = '0xb000000000000000000000000000000000000002' as const;

function guardScript() {
  return evscript(
    {
      name: 'guard',
      args: [namedArg('x', t.uint256), namedArg('who', t.address)],
      errors: [NoBalance, NotOwner],
    },
    (s, x, who) => {
      s.if(x.lt(10n), () => {
        s.throw(NoBalance, { balance: x, who });
      });
      s.if(x.eq(999n), () => {
        s.throw(NotOwner);
      });
      return s.return({ doubled: x.mul(2n) });
    },
  );
}

// compiled at module scope so the literal ABI type (with the declared error entries) flows
// into the decode-utility assertions — a wide `CompiledEvsScript` annotation would erase it
const compiled = compile(guardScript());
let reverter: `0x${string}`;

beforeAll(async () => {
  reverter = await deploy(Reverter.abi, Reverter.bytecode);
});

describe('s.throw over a real eth_call (deployless)', () => {
  test('raw revert data is byte-exact selector ‖ abi.encode(args)', async () => {
    const raw = await callExpectRevert({
      code: compiled.initBytecode,
      data: encodeFunctionData({ abi: compiled.abi, functionName: 'guard', args: [5n, WHO] }),
    });
    expect(raw).toBe(
      encodeErrorResult({ abi: compiled.abi, errorName: 'NoBalance', args: [5n, WHO] }),
    );
  });

  test('zero-arg throw reverts with the bare selector', async () => {
    const raw = await callExpectRevert({
      code: compiled.initBytecode,
      data: encodeFunctionData({ abi: compiled.abi, functionName: 'guard', args: [999n, WHO] }),
    });
    expect(raw).toBe(encodeErrorResult({ abi: compiled.abi, errorName: 'NotOwner' }));
    expect(raw.length).toBe(2 + 8);
  });

  test('the success path still decodes through readContract', async () => {
    const result = await publicClient.readContract({
      ...compiled.toViem(),
      functionName: 'guard',
      args: [21n, WHO],
    });
    expect(result).toEqual({ doubled: 42n });
  });
});

describe('viem decodes the revert natively from the artifact ABI', () => {
  test('readContract throws a ContractFunctionRevertedError with errorName + args', async () => {
    let caught: unknown;
    try {
      await publicClient.readContract({
        ...compiled.toViem(),
        functionName: 'guard',
        args: [5n, WHO],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BaseError);
    const reverted = (caught as BaseError).walk((e) => e instanceof ContractFunctionRevertedError);
    expect(reverted).toBeInstanceOf(ContractFunctionRevertedError);
    const r = reverted as ContractFunctionRevertedError;
    expect(r.data?.errorName).toBe('NoBalance');
    expect(r.data?.args).toEqual([5n, WHO]);

    // the CAUGHT error (untouched) round-trips through the decode utilities
    expect(decodeScriptError(compiled, caught)).toEqual({
      name: 'NoBalance',
      args: { balance: 5n, who: WHO },
      raw: encodeErrorResult({ abi: compiled.abi, errorName: 'NoBalance', args: [5n, WHO] }),
    });
    const msg = matchScriptError(compiled, caught, {
      NoBalance: ({ balance, who }) => `short by ${balance} for ${who}`,
      NotOwner: () => 'not owner',
      _: (other) => `other: ${other.name}`,
    });
    expect(msg).toBe(`short by 5 for ${WHO}`);
  });

  test('explainRevert agrees with the on-chain payload', async () => {
    const raw = await callExpectRevert({
      code: compiled.initBytecode,
      data: encodeFunctionData({ abi: compiled.abi, functionName: 'guard', args: [0n, WHO] }),
    });
    const explained = compiled.explainRevert(raw);
    expect(explained.kind).toBe('script-error');
    expect(explained.errorName).toBe('NoBalance');
    expect(explained.errorArgs).toEqual({ balance: 0n, who: WHO });
  });
});

describe('non-declared reverts land in the `_` default arm', () => {
  test('a bubbled callee custom error is `unknown` (not a declared arm)', async () => {
    const bubbler = evscript(
      { name: 'bubble', args: [t.address], errors: [NotOwner] },
      (s, target) => {
        const v = s.read({ address: target, abi: Reverter.abi, functionName: 'revertCustomError' });
        return s.return({ v });
      },
    );
    const bubblerCompiled = compile(bubbler);
    // the expected bytes come from calling the Reverter directly — no fixture drift
    const direct = await callExpectRevert({
      to: reverter,
      data: encodeFunctionData({ abi: Reverter.abi, functionName: 'revertCustomError' }),
    });
    let caught: unknown;
    try {
      await publicClient.readContract({
        ...bubblerCompiled.toViem(),
        functionName: 'bubble',
        args: [reverter],
      });
    } catch (e) {
      caught = e;
    }
    expect(extractRevertData(caught)).toBe(direct);
    const arm = matchScriptError(bubblerCompiled, caught, {
      NotOwner: () => 'declared',
      _: (other) => other.name,
    });
    expect(arm).toBe('unknown');
  });

  test('a script Panic lands in `_` with the code + meaning', async () => {
    const panicky = evscript({ name: 'panicky', args: [t.uint256], errors: [NotOwner] }, (s, x) => {
      return s.return({ y: x.add(1n) });
    });
    const panickyCompiled = compile(panicky);
    let caught: unknown;
    try {
      await publicClient.readContract({
        ...panickyCompiled.toViem(),
        functionName: 'panicky',
        args: [2n ** 256n - 1n],
      });
    } catch (e) {
      caught = e;
    }
    const arm = matchScriptError(panickyCompiled, caught, {
      NotOwner: () => 'declared' as const,
      _: (other) =>
        other.name === 'Panic' ? `${other.name}:${other.code}:${other.meaning}` : other.name,
    });
    expect(arm).toBe('Panic:17:arithmetic overflow or underflow');
  });
});
