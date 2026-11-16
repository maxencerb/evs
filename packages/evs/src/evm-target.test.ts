/**
 * Unit tests — `evm-target.ts`: `explainUnsupportedOpcode` over the node texts seen for a script
 * compiled for a fork the chain does not have (geth's `invalid opcode`, revm's `NotActivated`),
 * and the opcode facts its scan restates from `asm/ops.ts`. The scan itself is checked
 * against the source map in `explain.test.ts`; the failure on a real node, in both modes, is in
 * `test/integration/evm-target.test.ts`.
 */

import { BaseError, InvalidInputRpcError, RpcRequestError } from 'viem';
import { describe, expect, test } from 'vite-plus/test';

import { EVM_VERSIONS, immediateWidth, OPS } from './asm/ops.js';
import { evscript } from './builder/script.js';
import { compile } from './compile.js';
import { EvsTypeError } from './core/errors.js';
import { t, type Hex } from './core/types.js';
import { explainDeploylessError } from './deployless.js';
import { explainUnsupportedOpcode, FORK_GATED_OPCODES, forkOpcodesOf } from './evm-target.js';
import { hydrate } from './hydrate.js';
import { decodeScriptError } from './viem.js';

/** Copies memory and pushes zero: `MCOPY` and `PUSH0` on cancun, `PUSH0` alone on shanghai. */
const echo = evscript({ name: 'echo', args: [t.string, t.bytes] }, (s, text, raw) =>
  s.return({ text, raw, hash: s.keccak256(raw) }),
);
const cancun = compile(echo);
const shanghai = compile(echo, { evmVersion: 'shanghai' });
const paris = compile(echo, { evmVersion: 'paris' });

/** The chain viem builds for a node's JSON-RPC error: geth answers these with -32000, which viem
 *  shows as "Missing or invalid parameters." with the node's text in `details`. */
const rpcError = (message: string): BaseError => {
  const rpc = new InvalidInputRpcError(
    new RpcRequestError({ body: {}, error: { code: -32_000, message }, url: 'http://node' }),
  );
  return new BaseError(rpc.shortMessage, { cause: rpc });
};

describe('the scan', () => {
  test('FORK_GATED_OPCODES restates every row of OPS newer than the floor, newest first', () => {
    // above index 0: `paris` is the floor every target has, and `frontier` ranks below it
    const rank = (since: string): number => (EVM_VERSIONS as readonly string[]).indexOf(since);
    const gated = Object.entries(OPS)
      .map(([mnemonic, { code, since }]) => ({ mnemonic, code, since }))
      .filter((opcode) => rank(opcode.since) > 0)
      .toSorted((a, b) => rank(b.since) - rank(a.since));
    expect(FORK_GATED_OPCODES).toEqual(gated);
    expect(gated.map((opcode) => opcode.mnemonic)).toEqual(['MCOPY', 'PUSH0']);
  });

  test('walks by the opcode table: PUSH immediates, and INVALID as the end of the code', () => {
    // a PUSHn whose immediate is the two gated opcodes, for every n: only a walk that skips
    // exactly n bytes sees neither
    for (let code = 0; code <= 0xff; code++) {
      const width = immediateWidth(code);
      if (width === 0) continue;
      const immediate = '5e5f'.repeat(16).slice(0, width * 2);
      const runtime: Hex = `0x${code.toString(16)}${immediate}00`;
      expect(forkOpcodesOf(runtime), `PUSH${width}`).toEqual([]);
      expect(forkOpcodesOf(`${runtime}5e`).map((o) => o.mnemonic)).toEqual(['MCOPY']);
    }
    const guard = OPS.INVALID.code.toString(16);
    expect(forkOpcodesOf(`0x00${guard}5e5f`)).toEqual([]);
    expect(forkOpcodesOf(`0x5f${guard}5e`).map((o) => o.mnemonic)).toEqual(['PUSH0']);
  });

  test('lists the newest fork first', () => {
    expect(forkOpcodesOf(cancun.runtimeBytecode).map((o) => o.mnemonic)).toEqual([
      'MCOPY',
      'PUSH0',
    ]);
    expect(forkOpcodesOf(shanghai.runtimeBytecode).map((o) => o.mnemonic)).toEqual(['PUSH0']);
    expect(forkOpcodesOf(paris.runtimeBytecode)).toEqual([]);
  });
});

describe('explainUnsupportedOpcode', () => {
  test('the fixture chain is what viem shows for geth: nothing about an opcode', () => {
    const error = rpcError('invalid opcode: MCOPY');
    expect(error.shortMessage).toMatch(/^Missing or invalid parameters\./);
    // not a revert, and not a deployless limit: the two other helpers have nothing to say
    expect(decodeScriptError(cancun, error)).toBeUndefined();
    expect(explainDeploylessError(error)).toBeUndefined();
  });

  test('geth: invalid opcode: MCOPY → the newest target without MCOPY', () => {
    const e = explainUnsupportedOpcode(cancun, rpcError('invalid opcode: MCOPY'));
    expect(e).toStrictEqual({
      kind: 'unsupported-opcode',
      nodeMessage: 'invalid opcode: MCOPY',
      opcode: 'MCOPY',
      recompileWith: 'shanghai',
      message:
        'the node rejected an opcode of the script ("invalid opcode: MCOPY"): the runtime uses ' +
        'MCOPY (cancun) and PUSH0 (shanghai), and the chain does not have MCOPY at the block ' +
        'the call ran (the block is before that fork, or the chain never activated it) — ' +
        "recompile with evmVersion 'shanghai', the newest target without MCOPY ('paris' runs " +
        'everywhere)',
    });
  });

  test('geth: invalid opcode: PUSH0 → paris', () => {
    for (const script of [cancun, shanghai]) {
      const e = explainUnsupportedOpcode(script, rpcError('invalid opcode: PUSH0'));
      expect(e).toMatchObject({
        kind: 'unsupported-opcode',
        nodeMessage: 'invalid opcode: PUSH0',
        opcode: 'PUSH0',
        recompileWith: 'paris',
      });
      expect(e?.message).toContain('the chain does not have PUSH0 at the block the call ran');
      expect(e?.message).toMatch(/recompile with evmVersion 'paris', which runs everywhere$/);
    }
  });

  // a geth that does not know the opcode's name prints its byte
  test.each([
    ['invalid opcode: opcode 0x5e not defined', 'MCOPY', 'shanghai'],
    ['opcode 0x5e not defined', 'MCOPY', 'shanghai'],
    ['invalid opcode: opcode 0x5f not defined', 'PUSH0', 'paris'],
  ] as const)('geth: %s → %s', (text, opcode, recompileWith) => {
    expect(explainUnsupportedOpcode(cancun, rpcError(text))).toMatchObject({
      kind: 'unsupported-opcode',
      nodeMessage: text,
      opcode,
      recompileWith,
    });
  });

  // revm's error for an opcode that is not active in the running spec: it names none
  test.each(['EVM error NotActivated', 'EVM error: NotActivated'])(
    'anvil and reth: %s → the target older than every gated opcode in use',
    (text) => {
      const e = explainUnsupportedOpcode(cancun, rpcError(text));
      expect(e).toStrictEqual({
        kind: 'unsupported-opcode',
        nodeMessage: text,
        recompileWith: 'paris',
        message:
          `the node rejected an opcode of the script ("${text}"): the runtime uses MCOPY ` +
          '(cancun) and PUSH0 (shanghai), and the chain does not have one of them at the block ' +
          'the call ran (the block is before that fork, or the chain never activated it) — ' +
          "recompile with evmVersion 'paris', which runs everywhere",
      });
      expect(explainUnsupportedOpcode(shanghai, rpcError(text))).toMatchObject({
        recompileWith: 'paris',
      });
    },
  );

  test('a runtime that uses MCOPY alone needs no older target than shanghai', () => {
    // hand-written code: MCOPY, STOP (the compiler always pushes a zero somewhere)
    const e = explainUnsupportedOpcode({ runtimeBytecode: '0x5e00' }, 'EVM error NotActivated');
    expect(e?.recompileWith).toBe('shanghai');
    expect(e?.message).toMatch(
      /recompile with evmVersion 'shanghai', the newest target without MCOPY \('paris' runs everywhere\)$/,
    );
  });

  // no evmVersion removes these: INVALID, an opcode evs never emits, an unknown byte
  test.each([
    'invalid opcode: INVALID',
    'invalid opcode: SWAPN',
    'invalid opcode: opcode 0x28 not defined',
    'invalid opcode: opcode 0xc0 not defined',
  ])('an opcode the target does not decide is not explained: %s', (text) => {
    expect(explainUnsupportedOpcode(cancun, rpcError(text))).toBeUndefined();
  });

  test('nor is an opcode this runtime does not use: the script is not what failed', () => {
    expect(explainUnsupportedOpcode(shanghai, rpcError('invalid opcode: MCOPY'))).toBeUndefined();
    expect(explainUnsupportedOpcode(paris, rpcError('invalid opcode: PUSH0'))).toBeUndefined();
    // a paris build has nothing an older target would remove
    expect(explainUnsupportedOpcode(paris, rpcError('EVM error NotActivated'))).toBeUndefined();
  });

  test('anything else is not an unsupported opcode', () => {
    for (const input of [
      rpcError('execution reverted'),
      rpcError('out of gas'),
      rpcError('max code size exceeded'),
      new Error('fetch failed'),
      'Missing or invalid parameters.',
      undefined,
      42,
    ]) {
      expect(explainUnsupportedOpcode(cancun, input)).toBeUndefined();
    }
    const cyclic: { message: string; cause?: unknown } = { message: 'timeout' };
    cyclic.cause = cyclic;
    expect(explainUnsupportedOpcode(cancun, cyclic)).toBeUndefined();
  });

  test('a message string works too, and so does viem’s multi-line message', () => {
    expect(explainUnsupportedOpcode(cancun, 'invalid opcode: MCOPY')?.opcode).toBe('MCOPY');
    const e = explainUnsupportedOpcode(
      cancun,
      'Missing or invalid parameters.\n\nDetails: invalid opcode: MCOPY\nVersion: viem@2',
    );
    expect(e?.nodeMessage).toBe('Details: invalid opcode: MCOPY');
    expect(e?.recompileWith).toBe('shanghai');
  });

  test('reads the runtime of an artifact, a precompiled script or its data alike', async () => {
    const precompiled = cancun.toPrecompiled();
    const hydrated = hydrate(precompiled.toJSON());
    const error = rpcError('invalid opcode: MCOPY');
    const expected = explainUnsupportedOpcode(cancun, error);
    expect(explainUnsupportedOpcode(precompiled, error)).toStrictEqual(expected);
    expect(explainUnsupportedOpcode(precompiled.toJSON(), error)).toStrictEqual(expected);
    expect(explainUnsupportedOpcode(hydrated, error)).toStrictEqual(expected);
    // the deployless form of the same failure names the same opcodes
    const { message } = await precompiled.explainRevert('0x');
    expect(message).toContain('the runtime uses MCOPY (cancun) and PUSH0 (shanghai)');
  });

  test('rejects a script without a hex runtime with TYPE_MISMATCH', () => {
    const bad = (script: unknown): unknown => {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- untyped caller input
      return explainUnsupportedOpcode(script as { runtimeBytecode: Hex }, 'invalid opcode: MCOPY');
    };
    expect(() => bad({})).toThrow(EvsTypeError);
    expect(() => bad({ runtimeBytecode: '0x5' })).toThrow(/script\.runtimeBytecode/);
  });
});
