/**
 * Unit tests — `viem.ts`: init wrapper bytes goldens (cancun/shanghai/paris), wrapper
 * EXECUTION semantics on the harness (the wrapper RETURNs the runtime byte-exactly), the
 * silent-failure fence (field naming), both toViem helper shapes, and the error decoders: on
 * raw revert bytes, on hand-built error trees, and on the errors viem's own `readContract` and
 * `call` throw for each answer of `test/harness/rpc-errors.ts` (a local mock JSON-RPC server).
 */

import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  encodeErrorResult,
  http,
  type PublicClient,
} from 'viem';
import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test';

import { execRuntime } from '../test/harness/evm.js';
import { RUNTIME_42, RUNTIME_WHOAMI } from '../test/harness/fixtures.js';
import {
  BOOM_ARGS,
  BOOM_DATA,
  RPC_ERROR_SHAPES,
  startMockRpc,
  type MockRpc,
  type Outcome,
} from '../test/harness/rpc-errors.js';
import { evscript } from './builder/script.js';
import { compile } from './compile.js';
import { EvsCompileError, EvsTypeError } from './core/errors.js';
import { namedArg, t, type Hex } from './core/types.js';
import {
  decodeScriptError,
  DEFAULT_SCRIPT_ADDRESS,
  INIT_CODE_PREFIX_SHANGHAI,
  toCreationBytecode,
  matchScriptError,
  toViemDeployless,
  toViemStateOverride,
} from './viem.js';

const ERC20ISH_ABI = [
  {
    type: 'function',
    name: 'main',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: 'result', type: 'tuple', components: [{ name: 'x', type: 'uint256' }] }],
  },
] as const;

describe('init wrapper bytes (golden)', () => {
  test('INIT_CODE_PREFIX_SHANGHAI is the 10-byte template with RRRR zeroed', () => {
    expect(INIT_CODE_PREFIX_SHANGHAI).toBe('0x61000080600a5f395ff3');
  });

  test('cancun/shanghai: 61 RRRR 80 600A 5F 39 5F F3 ++ runtime', () => {
    // RUNTIME_42 is 10 bytes → RRRR = 0x000a
    const expected: Hex = `0x61000a80600a5f395ff3${RUNTIME_42.slice(2)}`;
    expect(toCreationBytecode(RUNTIME_42, 'cancun')).toBe(expected);
    expect(toCreationBytecode(RUNTIME_42, 'shanghai')).toBe(expected);
  });

  test('paris: 5F → 3D (RETURNDATASIZE-as-zero)', () => {
    expect(toCreationBytecode(RUNTIME_42, 'paris')).toBe(
      `0x61000a80600a3d393df3${RUNTIME_42.slice(2)}`,
    );
  });

  test('RRRR is the big-endian runtime byte length', () => {
    const runtime: Hex = `0x${'00'.repeat(0x1234)}`;
    expect(toCreationBytecode(runtime, 'cancun').slice(0, 22)).toBe('0x61123480600a5f395ff3');
  });

  test('wrapper executes: running the init code RETURNs the runtime byte-exactly', async () => {
    // execRuntime plants the given bytes as code and CALLs them — an init frame's RETURN
    // payload is exactly what a creation eth_call would deploy/return.
    const cases = (['cancun', 'paris'] as const).flatMap((evmVersion) =>
      [RUNTIME_42, RUNTIME_WHOAMI].map((runtime) => ({ evmVersion, runtime })),
    );
    await Promise.all(
      cases.map(async ({ evmVersion, runtime }) => {
        const res = await execRuntime(toCreationBytecode(runtime, evmVersion), '0x');
        expect(res.success).toBe(true);
        expect(res.data).toBe(runtime);
      }),
    );
  });

  test('empty runtime round-trips through the zero-length template', async () => {
    expect(toCreationBytecode('0x', 'shanghai')).toBe(INIT_CODE_PREFIX_SHANGHAI);
    const res = await execRuntime(INIT_CODE_PREFIX_SHANGHAI, '0x');
    expect(res.success).toBe(true);
    expect(res.data).toBe('0x');
  });

  test('rejects malformed hex and PUSH2-range overflow', () => {
    expect(() => toCreationBytecode('0x123', 'cancun')).toThrowError(EvsTypeError);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- runtime gate under test
    expect(() => toCreationBytecode('nope' as Hex, 'cancun')).toThrowError(EvsTypeError);
    expect(() => toCreationBytecode(`0x${'00'.repeat(0x10000)}`, 'cancun')).toThrowError(
      EvsCompileError,
    );
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- runtime gate under test
    expect(() => toCreationBytecode(RUNTIME_42, 'frontier' as 'paris')).toThrowError(
      EvsCompileError,
    );
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- runtime gate under test
    expect(() => toCreationBytecode(RUNTIME_42, 'frontier' as 'paris')).toThrowError(/evmVersion/);
  });
});

describe('toViem shapes', () => {
  test('DEFAULT_SCRIPT_ADDRESS is the pinned vanity constant', () => {
    expect(DEFAULT_SCRIPT_ADDRESS).toBe('0xcD360FfAC9818c4396Aa6F4807EBfA72C4B3f530');
  });

  test('deployless: { abi, code } with code = the INIT bytecode (never the runtime)', () => {
    const initBytecode = toCreationBytecode(RUNTIME_42, 'cancun');
    const shape = toViemDeployless({ abi: ERC20ISH_ABI, initBytecode });
    expect(shape).toEqual({ abi: ERC20ISH_ABI, code: initBytecode });
    // the silent-failure fence: no field of the shape carries raw runtime bytecode
    expect(Object.values(shape)).not.toContain(RUNTIME_42);
  });

  test('sender mode (issue #36): the runtime is installed AT the sender and `account` is set', () => {
    const sender = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const;
    const shape = toViemStateOverride(
      { abi: ERC20ISH_ABI, runtimeBytecode: RUNTIME_42 },
      { sender },
    );
    expect(shape).toEqual({
      abi: ERC20ISH_ABI,
      address: sender,
      stateOverride: [{ address: sender, code: RUNTIME_42 }],
      account: sender,
    });
    // `address` may restate the sender (same knob) …
    expect(
      toViemStateOverride(
        { abi: ERC20ISH_ABI, runtimeBytecode: RUNTIME_42 },
        { sender, address: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8' }, // lowercase spelling
      ).account,
    ).toBe(sender);
    // … but a DIFFERENT address contradicts sender mode
    expect(() =>
      toViemStateOverride(
        { abi: ERC20ISH_ABI, runtimeBytecode: RUNTIME_42 },
        { sender, address: DEFAULT_SCRIPT_ADDRESS },
      ),
    ).toThrow(/sender.*address.*disagree/);
    // a malformed sender is rejected up front (it would otherwise fail deep inside viem)
    expect(() =>
      toViemStateOverride(
        { abi: ERC20ISH_ABI, runtimeBytecode: RUNTIME_42 },
        { sender: '0x1234' }, // deliberately malformed
      ),
    ).toThrow(/20-byte 0x address/);
    // no sender → the plain shape, with NO `account` key leaking in
    expect(
      toViemStateOverride({ abi: ERC20ISH_ABI, runtimeBytecode: RUNTIME_42 }),
    ).not.toHaveProperty('account');
  });
});

// ---------------------------------------------------------------------------
// decodeScriptError / matchScriptError (issue #15)
// ---------------------------------------------------------------------------

describe('decodeScriptError / matchScriptError (issue #15)', () => {
  const NoBalance = t.error('NoBalance', [namedArg('balance', t.uint256)]);
  const NotOwner = t.error('NotOwner');
  const script = evscript(
    { name: 'guard', args: [t.uint256], errors: [NoBalance, NotOwner] },
    (s, x) => {
      s.if(x.lt(10n), () => {
        s.throw(NoBalance, { balance: x });
      });
      return s.return({ x });
    },
  );

  const NO_BALANCE_DATA = encodeErrorResult({
    abi: script.abi,
    errorName: 'NoBalance',
    args: [5n],
  });
  const NOT_OWNER_DATA = encodeErrorResult({ abi: script.abi, errorName: 'NotOwner' });
  const PANIC_DATA = encodeErrorResult({
    abi: [{ type: 'error', name: 'Panic', inputs: [{ name: 'code', type: 'uint256' }] }] as const,
    errorName: 'Panic',
    args: [0x11n],
  });
  const ERROR_STRING_DATA = encodeErrorResult({
    abi: [{ type: 'error', name: 'Error', inputs: [{ name: 'reason', type: 'string' }] }] as const,
    errorName: 'Error',
    args: ['nope'],
  });

  test('raw hex: a declared error decodes to a name-keyed args record', () => {
    const d = decodeScriptError(script, NO_BALANCE_DATA);
    expect(d).toEqual({ name: 'NoBalance', args: { balance: 5n }, raw: NO_BALANCE_DATA });
  });

  test('raw hex: zero-arg declared error / Panic / Error / evs built-ins / unknown / empty', () => {
    expect(decodeScriptError(script, NOT_OWNER_DATA)).toEqual({
      name: 'NotOwner',
      args: {},
      raw: NOT_OWNER_DATA,
    });
    expect(decodeScriptError(script, PANIC_DATA)).toEqual({
      name: 'Panic',
      code: 0x11n,
      meaning: 'arithmetic overflow or underflow',
      raw: PANIC_DATA,
    });
    expect(decodeScriptError(script, ERROR_STRING_DATA)).toEqual({
      name: 'Error',
      reason: 'nope',
      raw: ERROR_STRING_DATA,
    });
    const decodeErr = encodeErrorResult({
      abi: script.abi,
      errorName: 'EvsDecodeError',
      args: [7n],
    });
    expect(decodeScriptError(script, decodeErr)).toEqual({
      name: 'EvsDecodeError',
      args: { site: 7n },
      raw: decodeErr,
    });
    expect(decodeScriptError(script, '0xdeadbeef')).toEqual({
      name: 'unknown',
      selector: '0xdeadbeef',
      raw: '0xdeadbeef',
    });
    expect(decodeScriptError(script, '0x')).toEqual({ name: 'empty', raw: '0x' });
  });

  test('a declared selector with a malformed payload yields the unknown arm (never lies)', () => {
    const truncated: Hex = `0x${NO_BALANCE_DATA.slice(2, 10)}ff`;
    const d = decodeScriptError(script, truncated);
    expect(d?.name).toBe('unknown');
  });

  test('a viem error tree (ContractFunctionRevertedError, wrapped) decodes', () => {
    const revertedErr = new ContractFunctionRevertedError({
      abi: script.abi,
      data: NO_BALANCE_DATA,
      functionName: 'guard',
    });
    expect(decodeScriptError(script, revertedErr)).toEqual({
      name: 'NoBalance',
      args: { balance: 5n },
      raw: NO_BALANCE_DATA,
    });
    // wrapped one level down (the readContract shape: ContractFunctionExecutionError → cause)
    const wrapped = new BaseError('call reverted', { cause: revertedErr });
    expect(decodeScriptError(script, wrapped)?.name).toBe('NoBalance');
  });

  test('an error tree from ANOTHER copy of viem (no shared class identity) decodes', () => {
    // Shapes only, no viem classes: what a second viem bundle / a pnpm-duplicated version
    // throws. The decoder must not depend on `instanceof` against evs's own viem.
    const foreignReverted = Object.assign(new Error('reverted'), {
      name: 'ContractFunctionRevertedError',
      raw: NO_BALANCE_DATA,
      data: { errorName: 'NoBalance', args: [5n] },
    });
    const foreignExecution = new Error('call reverted', { cause: foreignReverted });
    expect(decodeScriptError(script, foreignExecution)).toEqual({
      name: 'NoBalance',
      args: { balance: 5n },
      raw: NO_BALANCE_DATA,
    });

    // The RPC-level shape (`call()` / a node's error object): hex `data` on the inner error.
    const foreignRpc = Object.assign(new Error('RPC Request failed.'), {
      name: 'RpcRequestError',
      code: 3,
      data: NOT_OWNER_DATA,
    });
    const wrapped = new Error('execution reverted', { cause: foreignRpc });
    expect(decodeScriptError(script, wrapped)?.name).toBe('NotOwner');
    expect(
      matchScriptError(script, wrapped, {
        NoBalance: () => 'x',
        NotOwner: () => 'not owner',
        _: () => 'z',
      }),
    ).toBe('not owner');

    // A cyclic cause chain terminates.
    const cyclic = new Error('a') as Error & { cause?: unknown };
    cyclic.cause = cyclic;
    expect(decodeScriptError(script, cyclic)).toBeUndefined();
  });

  test('a non-revert error (transport failure) yields undefined', () => {
    expect(decodeScriptError(script, new BaseError('timeout'))).toBeUndefined();
    expect(decodeScriptError(script, new Error('boom'))).toBeUndefined();
    expect(decodeScriptError(script, 'not hex')).toBeUndefined();
    expect(decodeScriptError(script, undefined)).toBeUndefined();
  });

  test('matchScriptError dispatches declared errors with typed args, everything else to _', () => {
    const handle = (data: unknown): string =>
      matchScriptError(script, data, {
        NoBalance: ({ balance }) => `short by ${balance}`,
        NotOwner: () => 'not owner',
        _: (other) => `other: ${other.name}`,
      });
    expect(handle(NO_BALANCE_DATA)).toBe('short by 5');
    expect(handle(NOT_OWNER_DATA)).toBe('not owner');
    expect(handle(PANIC_DATA)).toBe('other: Panic');
    expect(handle('0xdeadbeef')).toBe('other: unknown');
    expect(handle('0x')).toBe('other: empty');
  });

  test('matchScriptError: an empty / unrecognized revert never reaches a declared handler (issue #62)', () => {
    // t.error rejects 'empty'/'unknown' now; a hand-built ABI still gets through, and the
    // built-in arms (no args) must fall through to `_`, not call the declared handler with {}
    const handBuilt = {
      abi: [
        { type: 'error', name: 'empty', inputs: [{ name: 'code', type: 'uint256' }] },
        { type: 'error', name: 'unknown', inputs: [{ name: 'code', type: 'uint256' }] },
      ],
    } as const;
    const handle = (data: unknown): string =>
      matchScriptError(handBuilt, data, {
        empty: (args) => `declared empty ${String(args.code)}`,
        unknown: (args) => `declared unknown ${String(args.code)}`,
        _: (other) => `default: ${other.name}`,
      });
    expect(handle('0x')).toBe('default: empty');
    expect(handle('0xdeadbeef')).toBe('default: unknown');
    // the declared arm (it carries args) still dispatches to its handler
    const declaredEmpty = encodeErrorResult({
      abi: handBuilt.abi,
      errorName: 'empty',
      args: [42n],
    });
    expect(handle(declaredEmpty)).toBe('declared empty 42');
  });

  test('hand-built ABI: a `__proto__` error input stays an own key; an inherited name is no handler', () => {
    // t.error rejects `__proto__`; a hand-built ABI still gets through, and the decoded record
    // must keep the member instead of having its prototype replaced
    const handBuilt = {
      abi: [
        {
          type: 'error',
          name: 'Bad',
          inputs: [
            { name: '__proto__', type: 'uint256' },
            { name: 'b', type: 'uint256' },
          ],
        },
        { type: 'error', name: 'toString', inputs: [{ name: 'code', type: 'uint256' }] },
      ],
    } as const;
    const bad = encodeErrorResult({ abi: handBuilt.abi, errorName: 'Bad', args: [42n, 7n] });
    const decoded = decodeScriptError(handBuilt, bad);
    const args: object = decoded !== undefined && 'args' in decoded ? decoded.args : {};
    expect(Object.keys(args)).toEqual(['__proto__', 'b']);
    expect(Object.getOwnPropertyDescriptor(args, '__proto__')?.value).toBe(42n);
    expect(Object.getPrototypeOf(args)).toBe(Object.prototype);
    // a table without an own `toString` handler (cast past the exhaustive type) falls to `_`
    // instead of calling Object.prototype.toString
    const toStr = encodeErrorResult({ abi: handBuilt.abi, errorName: 'toString', args: [1n] });
    const handlers = { _: (other: { name: string }) => `default: ${other.name}` };
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the omitted handler IS the test
    expect(matchScriptError(handBuilt, toStr, handlers as never)).toBe('default: toString');
  });

  test('matchScriptError rethrows when the input carries no revert data', () => {
    const original = new Error('socket hang up');
    expect(() =>
      matchScriptError(script, original, {
        NoBalance: () => 'x',
        NotOwner: () => 'y',
        _: () => 'z',
      }),
    ).toThrowError(original);
  });

  test('matchScriptError: only a declared error has a handler of its name', () => {
    // a table with handlers named like the other arms (cast past the type, which rejects these
    // keys): Panic, Error(string) and the two evs runtime errors still reach `_`
    const handlers = {
      NoBalance: () => 'NoBalance handler',
      NotOwner: () => 'NotOwner handler',
      Panic: () => 'Panic handler',
      Error: () => 'Error handler',
      EvsDecodeError: () => 'EvsDecodeError handler',
      EvsInvalidCalldata: () => 'EvsInvalidCalldata handler',
      _: (other: { name: string }) => `_ got ${other.name}`,
    };
    const handle = (data: Hex): string =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the extra keys ARE the test
      matchScriptError(script, data, handlers as never);
    expect(handle(NOT_OWNER_DATA)).toBe('NotOwner handler');
    expect(handle(PANIC_DATA)).toBe('_ got Panic');
    expect(handle(ERROR_STRING_DATA)).toBe('_ got Error');
    expect(
      handle(encodeErrorResult({ abi: script.abi, errorName: 'EvsDecodeError', args: [7n] })),
    ).toBe('_ got EvsDecodeError');
    expect(handle(encodeErrorResult({ abi: script.abi, errorName: 'EvsInvalidCalldata' }))).toBe(
      '_ got EvsInvalidCalldata',
    );
  });

  test('a ContractFunctionRevertedError without a cause (viem before 2.47.5) is read by its own fields', () => {
    // Shapes only: the unit tests run the workspace's viem, whose error keeps its cause. The
    // peer-floor check (packages/viem-floor) runs these through a viem that really drops it.
    const leaf = (fields: { raw?: unknown; reason?: string; data?: unknown }): Error =>
      new Error('The contract function "guard" reverted.', {
        cause: Object.assign(new Error('reverted'), {
          name: 'ContractFunctionRevertedError',
          ...fields,
        }),
      });
    expect(decodeScriptError(script, leaf({ raw: NO_BALANCE_DATA }))?.name).toBe('NoBalance');
    expect(decodeScriptError(script, leaf({ raw: '0x', reason: 'execution reverted' }))).toEqual({
      name: 'empty',
      raw: '0x',
    });
    // the node sent no `data` field: its message, kept as `reason`, is the only sign left
    expect(decodeScriptError(script, leaf({ reason: 'execution reverted' }))).toEqual({
      name: 'empty',
      raw: '0x',
    });
    expect(decodeScriptError(script, leaf({ reason: 'Internal error' }))).toBeUndefined();
    // a viem older than the peer range: the decoded error object and no `raw`. Not classified,
    // so `matchScriptError` rethrows it instead of calling `_` with an empty revert
    const tooOld = leaf({ data: { errorName: 'NoBalance', args: [5n] } });
    expect(decodeScriptError(script, tooOld)).toBeUndefined();
    expect(() =>
      matchScriptError(script, tooOld, {
        NoBalance: () => 'x',
        NotOwner: () => 'y',
        _: () => 'z',
      }),
    ).toThrowError(tooOld);
  });

  test('revert data is read from an RPC error only, and only next to a sign of a revert', () => {
    const rpcError = (fields: Record<string, unknown>): Error =>
      new Error('call failed', { cause: Object.assign(new Error('RPC Request failed.'), fields) });
    // a hex `data` proves nothing by itself
    expect(decodeScriptError(script, rpcError({ code: 0, data: NOT_OWNER_DATA }))).toBeUndefined();
    expect(decodeScriptError(script, rpcError({ data: NOT_OWNER_DATA }))).toBeUndefined();
    // code 3, or a message that says so, is a sign
    expect(decodeScriptError(script, rpcError({ code: 3, data: NOT_OWNER_DATA }))?.name).toBe(
      'NotOwner',
    );
    expect(
      decodeScriptError(
        script,
        rpcError({ code: -32000, message: 'execution reverted', data: NOT_OWNER_DATA }),
      )?.name,
    ).toBe('NotOwner');
    // the node's bare error object, as a caller of `fetch` holds it
    expect(
      decodeScriptError(script, { code: 3, message: 'execution reverted', data: NOT_OWNER_DATA })
        ?.name,
    ).toBe('NotOwner');
    // the internal-error code is a sign only with the bytes
    expect(decodeScriptError(script, rpcError({ code: -32603 }))).toBeUndefined();
    expect(
      decodeScriptError(script, rpcError({ code: -32603, data: { data: NOT_OWNER_DATA } }))?.name,
    ).toBe('NotOwner');
  });
});

// ---------------------------------------------------------------------------
// the decoders on the errors viem throws for what providers answer
// ---------------------------------------------------------------------------

describe('decodeScriptError / matchScriptError on provider answers, through viem', () => {
  const Boom = t.error('Boom', [namedArg('code', t.uint256), namedArg('who', t.address)]);
  const guard = compile(
    evscript({ name: 'guard', args: [t.uint256, t.uint256], errors: [Boom] }, (s, x, y) => {
      s.if(x.eq(0n), () => {
        s.throw(Boom, BOOM_ARGS);
      });
      return s.return({ sum: x.add(y) });
    }),
  );

  let rpc: MockRpc;
  let client: PublicClient;
  beforeAll(async () => {
    rpc = await startMockRpc();
    // no retry, and a timeout short enough for the answer that never comes
    client = createPublicClient({ transport: http(rpc.url, { retryCount: 0, timeout: 150 }) });
  });
  afterAll(async () => {
    await rpc.close();
  });

  /** What the two decoders make of `caught`, in the words of the table. */
  function observe(caught: unknown): { decoded: Outcome | undefined; matched: string } {
    const decoded = decodeScriptError(guard, caught);
    let matched: string;
    try {
      matched = matchScriptError(guard, caught, {
        Boom: ({ code, who }) => `Boom(${code}, ${who})`,
        _: (other) => `_ got ${other.name}`,
      });
    } catch (error) {
      matched = error === caught ? 'rethrown' : `threw ${String(error)}`;
    }
    return {
      decoded:
        decoded === undefined
          ? 'not a revert'
          : decoded.name === 'EvsDecodeError' || decoded.name === 'EvsInvalidCalldata'
            ? undefined
            : decoded.name,
      matched,
    };
  }

  function expectedFor(outcome: Outcome): { decoded: Outcome; matched: string } {
    if (outcome === 'not a revert') return { decoded: outcome, matched: 'rethrown' };
    if (outcome === 'Boom') {
      return { decoded: outcome, matched: `Boom(${BOOM_ARGS.code}, ${BOOM_ARGS.who})` };
    }
    return { decoded: outcome, matched: `_ got ${outcome}` };
  }

  const settle = async (call: Promise<unknown>): Promise<unknown> =>
    call.then(
      () => {
        throw new Error('the mock answer was taken for a result');
      },
      (error: unknown) => error,
    );

  describe.each(['deployless', 'stateOverride'] as const)('readContract, %s mode', (mode) => {
    test.each(RPC_ERROR_SHAPES)('$name → $expected', async ({ answer, expected }) => {
      rpc.answer(answer);
      const params = mode === 'deployless' ? guard.toViem() : guard.toViem({ mode });
      const caught = await settle(
        client.readContract({ ...params, functionName: 'guard', args: [0n, 0n] }),
      );
      expect(observe(caught)).toEqual(expectedFor(expected));
    });
  });

  // `call()` has no contract-level wrapper: the tree starts at CallExecutionError. A result is
  // no error there, so only the failing answers apply.
  const failing = RPC_ERROR_SHAPES.filter((shape) => !('result' in shape.answer));
  test.each(failing)('call(): $name → $expected', async ({ answer, expected }) => {
    rpc.answer(answer);
    const caught = await settle(client.call({ to: DEFAULT_SCRIPT_ADDRESS, data: '0x12345678' }));
    expect(observe(caught)).toEqual(expectedFor(expected));
  });

  test('a declared error decodes to its arguments, from the tree viem threw', async () => {
    rpc.answer({ error: { code: 3, message: 'execution reverted', data: BOOM_DATA } });
    const caught = await settle(
      client.readContract({ ...guard.toViem(), functionName: 'guard', args: [0n, 0n] }),
    );
    expect(decodeScriptError(guard, caught)).toEqual({
      name: 'Boom',
      args: BOOM_ARGS,
      raw: BOOM_DATA,
    });
  });
});
