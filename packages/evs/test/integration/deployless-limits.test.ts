/**
 * Deployless-mode creation limits, pinned on a real node (anvil, revm):
 *   - EIP-170 on the result: a `uint256[]` result is `96 + 32·n` bytes, so 765 words fit and
 *     766 fail — the boundary `DEPLOYLESS_MAX_RESULT_BYTES` predicts;
 *   - EIP-3541 on the result: a leading `0xEE` word passes, a leading `0xEF` word fails, and the
 *     compile-time `DEPLOYLESS_RESULT_PREFIX` warning flags that shape;
 *   - EIP-3860 on viem's creation data: the last args size `deploylessDataSize` accepts passes,
 *     one more element fails;
 * and each failure is recognized by `explainDeploylessError` (the node texts are pinned too, as
 * the docs name them), while state-override mode runs the same call. The PoCs of the 0.2.0 field test, turned into canaries.
 */

import { encodeFunctionData, type Hex } from 'viem';
import { describe, expect, test } from 'vite-plus/test';

import {
  compile,
  DEPLOYLESS_MAX_DATA_BYTES,
  DEPLOYLESS_MAX_RESULT_BYTES,
  deploylessDataSize,
  evscript,
  explainDeploylessError,
  t,
  type EvsDiagnostic,
} from '../../src/index.js';
import { publicClient } from '../harness/anvil.js';

/** Runs `call` and returns what it threw (fails the test when it does not throw). */
async function failure(call: () => Promise<unknown>): Promise<unknown> {
  try {
    await call();
  } catch (e) {
    return e;
  }
  throw new Error('expected the deployless call to fail');
}

describe('EIP-170: the result is deposited as code', () => {
  const words = compile(
    evscript({ name: 'words', args: [t.uint256] }, (s, n) => {
      const out = s.newArray(t.uint256, n);
      return s.return({ out: out.expr() });
    }),
  );
  // outer offset + the tuple's offset to `out` + its length word, then one word per element
  const fits = (DEPLOYLESS_MAX_RESULT_BYTES - 96) / 32;

  test('765 words fit, 766 fail with result-too-large; stateOverride runs 766', async () => {
    expect(fits).toBe(765);
    const ok = await publicClient.readContract({
      ...words.toViem(),
      functionName: 'words',
      args: [BigInt(fits)],
    });
    expect(ok.out).toHaveLength(fits);

    const error = await failure(() =>
      publicClient.readContract({
        ...words.toViem(),
        functionName: 'words',
        args: [BigInt(fits + 1)],
      }),
    );
    expect(explainDeploylessError(error)).toMatchObject({
      kind: 'result-too-large',
      limit: DEPLOYLESS_MAX_RESULT_BYTES,
      nodeMessage: 'EVM error CreateContractSizeLimit',
    });

    const viaOverride = await publicClient.readContract({
      ...words.toViem({ mode: 'stateOverride' }),
      functionName: 'words',
      args: [BigInt(fits + 1)],
    });
    expect(viaOverride.out).toHaveLength(fits + 1);
  });
});

describe('EIP-3541: the result must not start with 0xEF', () => {
  const diagnostics: EvsDiagnostic[] = [];
  const echo = compile(
    evscript({ name: 'echo', args: [t.bytes32] }, (s, word) => s.return({ word })),
    { onDiagnostic: (d) => diagnostics.push(d) },
  );
  const ee: Hex = `0xee${'00'.repeat(31)}`;
  const ef: Hex = `0xef${'00'.repeat(31)}`;

  test('the shape is flagged at compile time', () => {
    expect(diagnostics.map((d) => d.code)).toEqual(['DEPLOYLESS_RESULT_PREFIX']);
  });

  test('0xEE passes, 0xEF fails with result-starts-with-ef; stateOverride returns it', async () => {
    const ok = await publicClient.readContract({
      ...echo.toViem(),
      functionName: 'echo',
      args: [ee],
    });
    expect(ok.word).toBe(ee);

    const error = await failure(() =>
      publicClient.readContract({ ...echo.toViem(), functionName: 'echo', args: [ef] }),
    );
    expect(explainDeploylessError(error)).toMatchObject({
      kind: 'result-starts-with-ef',
      nodeMessage: 'EVM error CreateContractStartingWithEF',
    });

    const viaOverride = await publicClient.readContract({
      ...echo.toViem({ mode: 'stateOverride' }),
      functionName: 'echo',
      args: [ef],
    });
    expect(viaOverride.word).toBe(ef);
  });

  test('a left-padded first value (the suggested reordering) clears it', async () => {
    const reordered: EvsDiagnostic[] = [];
    const tagged = compile(
      evscript({ name: 'tagged', args: [t.address, t.bytes32] }, (s, who, word) =>
        s.return({ who, word }),
      ),
      { onDiagnostic: (d) => reordered.push(d) },
    );
    expect(reordered).toEqual([]);
    const out = await publicClient.readContract({
      ...tagged.toViem(),
      functionName: 'tagged',
      args: ['0x00000000000000000000000000000000000000aa', ef],
    });
    expect(out.word).toBe(ef);
  });
});

describe('EIP-3860: viem creation data, args included', () => {
  const count = compile(
    evscript({ name: 'count', args: [t.array(t.uint256)] }, (s, xs) =>
      s.return({ n: xs.length() }),
    ),
  );
  const calldata = (n: number): Hex =>
    encodeFunctionData({
      abi: count.abi,
      functionName: 'count',
      args: [Array.from({ length: n }, () => 1n)],
    });
  // the largest element count whose creation data still fits — pure arithmetic, nothing sent
  let fits = 0;
  while (deploylessDataSize(count, calldata(fits + 1)) <= DEPLOYLESS_MAX_DATA_BYTES) fits++;

  test('the last fitting size passes, one more element fails with data-too-large', async () => {
    expect(deploylessDataSize(count, calldata(fits + 1))).toBe(
      deploylessDataSize(count, calldata(fits)) + 32,
    );
    const args = (n: number) => [Array.from({ length: n }, () => 1n)] as const;
    const ok = await publicClient.readContract({
      ...count.toViem(),
      functionName: 'count',
      args: args(fits),
    });
    expect(ok.n).toBe(BigInt(fits));

    const error = await failure(() =>
      publicClient.readContract({ ...count.toViem(), functionName: 'count', args: args(fits + 1) }),
    );
    expect(explainDeploylessError(error)).toMatchObject({
      kind: 'data-too-large',
      limit: DEPLOYLESS_MAX_DATA_BYTES,
      // anvil uses geth's wording here, not revm's `CreateInitCodeSizeLimit`
      nodeMessage: 'max initcode size exceeded',
    });

    const viaOverride = await publicClient.readContract({
      ...count.toViem({ mode: 'stateOverride' }),
      functionName: 'count',
      args: args(fits + 1),
    });
    expect(viaOverride.n).toBe(BigInt(fits + 1));
  });
});
