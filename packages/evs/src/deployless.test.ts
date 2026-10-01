/**
 * Unit tests — `deployless.ts`: the creation-data size helper (pinned byte-exactly against what
 * the installed viem builds), the compile-time result diagnostics (`DEPLOYLESS_RESULT_PREFIX`,
 * `DEPLOYLESS_RESULT_SIZE`; sizes cross-checked against real returndata on the harness), and
 * `explainDeploylessError` over the node texts the field test observed (geth and anvil/revm).
 * The on-chain boundaries themselves are pinned by `test/integration/deployless-limits.test.ts`.
 */

import {
  type Abi,
  BaseError,
  deploylessCallViaBytecodeBytecode,
  encodeDeployData,
  encodeFunctionData,
  InvalidParamsRpcError,
  parseAbi,
  RpcRequestError,
  size,
} from 'viem';
import { describe, expect, test } from 'vite-plus/test';

import { execRuntime } from '../test/harness/evm.js';
import { evscript } from './builder/script.js';
import { compile } from './compile.js';
import { EvsTypeError, type EvsDiagnostic } from './core/errors.js';
import { t, type Hex } from './core/types.js';
import {
  DEPLOYLESS_MAX_DATA_BYTES,
  DEPLOYLESS_MAX_RESULT_BYTES,
  deploylessDataSize,
  explainDeploylessError,
} from './deployless.js';

function diagnosticsOf(script: Parameters<typeof compile>[0]): EvsDiagnostic[] {
  const diags: EvsDiagnostic[] = [];
  compile(script, { onDiagnostic: (d) => diags.push(d) });
  return diags;
}

const codesOf = (script: Parameters<typeof compile>[0]): string[] =>
  diagnosticsOf(script)
    .map((d) => d.code)
    .filter((c) => c.startsWith('DEPLOYLESS_'));

describe('limits and deploylessDataSize', () => {
  test('the caps are EIP-170 and EIP-3860', () => {
    expect(DEPLOYLESS_MAX_RESULT_BYTES).toBe(24_576);
    expect(DEPLOYLESS_MAX_DATA_BYTES).toBe(49_152);
  });

  test("matches the size of viem's own deployless creation data, byte for byte", () => {
    const sum = compile(
      evscript({ name: 'sum', args: [t.array(t.uint256)] }, (s, xs) =>
        s.return({ n: xs.length() }),
      ),
    );
    for (const n of [0, 1, 7, 100, 1500]) {
      const calldata = encodeFunctionData({
        abi: sum.abi,
        functionName: 'sum',
        args: [Array.from({ length: n }, () => 1n)],
      });
      // exactly what viem's call action sends for `{ code, data }` (toDeploylessCallViaBytecodeData)
      const sent = encodeDeployData({
        abi: parseAbi(['constructor(bytes, bytes)']),
        bytecode: deploylessCallViaBytecodeBytecode,
        args: [sum.initBytecode, calldata],
      });
      expect(deploylessDataSize(sum, calldata)).toBe(size(sent));
    }
    // odd lengths pad to the next word, on both values
    const odd: Hex = '0x123456';
    const sent = encodeDeployData({
      abi: parseAbi(['constructor(bytes, bytes)']),
      bytecode: deploylessCallViaBytecodeBytecode,
      args: [odd, odd],
    });
    expect(deploylessDataSize({ initBytecode: odd }, odd)).toBe(size(sent));
  });

  test('rejects malformed hex with TYPE_MISMATCH', () => {
    expect(() => deploylessDataSize({ initBytecode: '0x1' }, '0x')).toThrow(EvsTypeError);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- untyped caller input
    expect(() => deploylessDataSize({ initBytecode: '0x' }, 'zz' as Hex)).toThrow(/calldata/);
  });
});

describe('DEPLOYLESS_RESULT_PREFIX', () => {
  test.each([
    ['bytes32', t.bytes32],
    ['bytes4', t.bytes4],
    ['uint256', t.uint256],
    ['int256', t.int256],
  ] as const)('a leading static %s can start with 0xEF', (name, type) => {
    const script = evscript({ name: 'echo', args: [type] }, (s, x) => s.return({ x }));
    const diags = diagnosticsOf(script).filter((d) => d.code === 'DEPLOYLESS_RESULT_PREFIX');
    expect(diags).toHaveLength(1);
    expect(diags[0]?.severity).toBe('warning');
    expect(diags[0]?.message).toContain(`\`x\` (${name})`);
    expect(diags[0]?.message).toContain('0xEF');
    expect(diags[0]?.message).toContain("toViem({ mode: 'stateOverride' })");
  });

  test.each([
    ['uint248', t.uint248],
    ['int248', t.int248],
    ['int8', t.int8],
    ['address', t.address],
    ['bool', t.bool],
  ] as const)('a leading %s always starts with 0x00 or 0xFF — no warning', (_name, type) => {
    const script = evscript({ name: 'echo', args: [type, t.bytes32] }, (s, x, h) =>
      s.return({ x, h }),
    );
    expect(codesOf(script)).toEqual([]);
  });

  test('names the first leaf through static structs and fixed arrays', () => {
    const Pos = t.struct({ id: t.bytes32, owner: t.address });
    const nested = evscript({ name: 'nested', args: [Pos] }, (s, pos) => s.return({ pos }));
    expect(diagnosticsOf(nested)[0]?.message).toContain('`pos.id` (bytes32)');
    const fixed = evscript({ name: 'fixed', args: [t.array(t.uint256, 2)] }, (s, xs) =>
      s.return({ xs }),
    );
    expect(diagnosticsOf(fixed)[0]?.message).toContain('`xs[0]` (uint256)');
  });

  test('a dynamic member anywhere makes byte 0 an offset word — no warning', () => {
    const script = evscript({ name: 'mixed', args: [t.bytes32, t.string] }, (s, h, label) =>
      s.return({ h, label }),
    );
    expect(codesOf(script)).toEqual([]);
  });

  test('the leading leaf is what the encoded result starts with', async () => {
    const script = compile(
      evscript({ name: 'echo', args: [t.bytes32] }, (s, x) => s.return({ x })),
    );
    const word: Hex = `0xef${'00'.repeat(31)}`;
    const out = await execRuntime(
      script.runtimeBytecode,
      encodeFunctionData({ abi: script.abi, functionName: 'echo', args: [word] }),
    );
    expect(out.data.slice(0, 4)).toBe('0xef');
  });
});

describe('DEPLOYLESS_RESULT_SIZE', () => {
  const fixedWords = (n: number) =>
    evscript({ name: 'words', args: [t.array(t.address, n)] }, (s, xs) => s.return({ xs }));

  test('a static result over 24,576 bytes always fails deployless', () => {
    // address words start with 0x00, so the size warning is alone
    expect(codesOf(fixedWords(768))).toEqual([]); // 768 · 32 = 24,576 — fits exactly
    const diags = diagnosticsOf(fixedWords(769));
    expect(diags.map((d) => d.code)).toEqual(['DEPLOYLESS_RESULT_SIZE']);
    expect(diags[0]?.message).toContain('always 24608 bytes');
  });

  test('a dynamic result warns on its smallest encoding', () => {
    const script = evscript(
      { name: 'big', args: [t.string, t.array(t.address, 768)] },
      (s, label, xs) => s.return({ label, xs }),
    );
    const diag = diagnosticsOf(script).find((d) => d.code === 'DEPLOYLESS_RESULT_SIZE');
    // outer offset + label offset + 768 words + the empty label's length word
    expect(diag?.message).toContain(`at least ${32 + 32 + 768 * 32 + 32} bytes`);
  });

  test('the computed size is the real returndata size (static exact, dynamic minimum)', async () => {
    const xs = (n: number) =>
      Array.from({ length: n }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}` as const);
    const big = evscript(
      { name: 'big', args: [t.string, t.array(t.address, 768)] },
      (s, label, list) => s.return({ label, list }),
    );
    const runs = [
      {
        script: fixedWords(769),
        calldata: (abi: Abi) => encodeFunctionData({ abi, functionName: 'words', args: [xs(769)] }),
      },
      {
        script: big,
        calldata: (abi: Abi) =>
          encodeFunctionData({ abi, functionName: 'big', args: ['', xs(768)] }),
      },
    ];
    await Promise.all(
      runs.map(async ({ script, calldata }) => {
        const diags: EvsDiagnostic[] = [];
        const compiled = compile(script, { onDiagnostic: (d) => diags.push(d) });
        const out = await execRuntime(compiled.runtimeBytecode, calldata(compiled.abi));
        expect(out.success).toBe(true);
        const diag = diags.find((d) => d.code === 'DEPLOYLESS_RESULT_SIZE');
        expect(diag?.message).toContain(` ${size(out.data)} bytes`);
      }),
    );
  });
});

describe('explainDeploylessError', () => {
  /** The chain viem builds for a JSON-RPC error: BaseError → InvalidParamsRpcError → RpcRequestError. */
  const rpcError = (message: string, wrap = 'Missing or invalid parameters.'): BaseError =>
    new BaseError(wrap, {
      cause: new InvalidParamsRpcError(
        new RpcRequestError({ body: {}, error: { code: -32602, message }, url: 'http://node' }),
      ),
    });

  test('geth: max code size exceeded → result-too-large, with the reported size', () => {
    const e = explainDeploylessError(
      rpcError('max code size exceeded: code size 24608 limit 24576'),
    );
    expect(e).toMatchObject({
      kind: 'result-too-large',
      size: 24_608,
      limit: 24_576,
      nodeMessage: 'max code size exceeded: code size 24608 limit 24576',
    });
    expect(e?.message).toContain('EIP-170');
    expect(e?.message).toContain("toViem({ mode: 'stateOverride' })");
  });

  test('geth: invalid code: must not begin with 0xef → result-starts-with-ef', () => {
    const e = explainDeploylessError(rpcError('invalid code: must not begin with 0xef'));
    expect(e?.kind).toBe('result-starts-with-ef');
    expect(e?.size).toBeUndefined();
    expect(e?.message).toContain('EIP-3541');
  });

  test('geth: max initcode size exceeded → data-too-large', () => {
    const e = explainDeploylessError(
      rpcError(
        'err: max initcode size exceeded: code size 49166 limit 49152 (supplied gas 600000000)',
      ),
    );
    expect(e).toMatchObject({ kind: 'data-too-large', size: 49_166, limit: 49_152 });
    expect(e?.message).toContain('deploylessDataSize()');
  });

  test('anvil/revm: the EVM error names', () => {
    const wrap = 'Transaction creation failed.';
    expect(
      explainDeploylessError(rpcError('EVM error CreateContractStartingWithEF', wrap))?.kind,
    ).toBe('result-starts-with-ef');
    expect(
      explainDeploylessError(rpcError('EVM error CreateContractSizeLimit', wrap)),
    ).toMatchObject({
      kind: 'result-too-large',
      limit: 24_576,
      nodeMessage: 'EVM error CreateContractSizeLimit',
    });
    expect(explainDeploylessError(rpcError('max initcode size exceeded', wrap))?.kind).toBe(
      'data-too-large',
    );
  });

  test('a message string works too; anything else is not a deployless limit', () => {
    expect(explainDeploylessError('Details: max code size exceeded')?.kind).toBe(
      'result-too-large',
    );
    expect(explainDeploylessError(rpcError('execution reverted'))).toBeUndefined();
    expect(explainDeploylessError(new Error('fetch failed'))).toBeUndefined();
    expect(explainDeploylessError(undefined)).toBeUndefined();
    expect(explainDeploylessError(42)).toBeUndefined();
    const cyclic: { message: string; cause?: unknown } = { message: 'timeout' };
    cyclic.cause = cyclic;
    expect(explainDeploylessError(cyclic)).toBeUndefined();
  });
});
