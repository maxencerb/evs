/**
 * testing.md §4.3: checked arithmetic vs solc — the reference contract differential.
 *
 * For every EvsReference function (op × width class), the deployed solc 0.8.30 contract and
 * the equivalent evs script are driven with the same seeded boundary corpus; success values
 * must match and revert payloads must be BYTE-IDENTICAL (Panic(code) encoding).
 */

import { decodeFunctionResult, encodeFunctionData, type Abi, type Hex } from 'viem';
import { beforeAll, describe, expect, test } from 'vitest';

import { arg, evscript, type EvsType } from '../../src/index.js';
import { EvsReference } from '../generated/index.js';
import { publicClient } from '../harness/anvil.js';
import { deploy, extractRevertData, lcg } from './helpers.js';

type Op = 'add' | 'sub' | 'mul' | 'div' | 'mod';

interface Case {
  fn: string;
  op: Op;
  signed: boolean;
  bits: bigint;
}

const CASES: Case[] = (EvsReference.abi as Abi)
  .flatMap((entry) => (entry.type === 'function' ? [entry.name] : []))
  .flatMap((name) => {
    const m = /^(add|sub|mul|div|mod)(U|I)(\d+)$/.exec(name);
    if (m === null) return [];
    const [, op, ui, bits] = m;
    if (op === undefined || ui === undefined || bits === undefined) return [];
    return [{ fn: name, op: op as Op, signed: ui === 'I', bits: BigInt(bits) }];
  });

function operandCorpus(c: Case): [bigint, bigint][] {
  const max = c.signed ? (1n << (c.bits - 1n)) - 1n : (1n << c.bits) - 1n;
  const min = c.signed ? -(1n << (c.bits - 1n)) : 0n;
  const rand = lcg(0xe5e5_0001n + c.bits * 31n + BigInt(c.op.charCodeAt(0)));
  const inRange = () => min + (rand() % (max - min + 1n));
  const pairs: [bigint, bigint][] = [
    [0n, 0n],
    [0n, 1n],
    [1n, max],
    [max, 1n],
    [max, max],
    [max - 1n, 1n],
    [1n, 0n], // div/mod by zero → Panic(0x12) on both sides
    [max, 0n],
    [inRange(), inRange()],
    [inRange(), inRange()],
  ];
  if (c.signed) {
    pairs.push([min, -1n], [-1n, min], [min, 1n], [-1n, -1n], [min, min]);
  }
  // The testing.md §4.3 named wrap-back cases, on their specific width classes:
  if (!c.signed && c.bits === 192n && c.op === 'mul') pairs.push([1n << 191n, (1n << 65n) + 1n]);
  if (c.signed && c.bits === 256n && c.op === 'div') pairs.push([-(1n << 255n), -1n]);
  if (c.signed && c.bits === 8n && c.op === 'div') pairs.push([-128n, -1n]);
  return pairs;
}

let reference: `0x${string}`;

beforeAll(async () => {
  reference = await deploy(EvsReference.abi, EvsReference.bytecode);
});

/** eth_call → { ok: true, data } | { ok: false, revert } with raw bytes either way. */
async function rawCall(params: {
  to: `0x${string}`;
  data: Hex;
  stateOverride?: { address: `0x${string}`; code: Hex }[];
}): Promise<{ ok: boolean; bytes: Hex }> {
  try {
    const { data } = await publicClient.call(
      params.stateOverride === undefined
        ? { to: params.to, data: params.data }
        : { to: params.to, data: params.data, stateOverride: params.stateOverride },
    );
    return { ok: true, bytes: data ?? '0x' };
  } catch (err) {
    return { ok: false, bytes: extractRevertData(err) };
  }
}

describe('checked math: evs vs solc 0.8.30 (EvsReference)', () => {
  test('the generated op × width matrix is present', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(20);
  });

  test.each(CASES)('$fn', async (c) => {
    const ty = `${c.signed ? 'int' : 'uint'}${c.bits}` as EvsType;
    // Width is dynamic over the matrix, so the script is built with widened types on
    // purpose (graceful-widening path, api.md §3); runtime IR validation sees the real type.
    const script = evscript(
      { name: c.fn, args: [arg('a', ty as 'uint256'), arg('b', ty as 'uint256')] },
      (s) => s.return({ r: s[c.op](s.args.a, s.args.b) }),
    );
    const compiled = script.compile();
    const overrideParams = compiled.toViem({ mode: 'stateOverride' });

    for (const [a, b] of operandCorpus(c)) {
      // abi widened to `Abi`: the matrix is driven by runtime strings, not literals.
      const solc = await rawCall({
        to: reference,
        data: encodeFunctionData({
          abi: EvsReference.abi as Abi,
          functionName: c.fn,
          args: [a, b], // viem widens intN≤48 to number at the type level; runtime takes bigint
        }),
      });
      const evs = await rawCall({
        to: overrideParams.address,
        stateOverride: overrideParams.stateOverride,
        data: encodeFunctionData({
          abi: compiled.abi as Abi,
          functionName: c.fn,
          args: [a, b],
        }),
      });

      const ctx = `${c.fn}(${a}, ${b})`;
      expect(evs.ok, `${ctx}: success/revert disagreement (solc ok=${solc.ok})`).toBe(solc.ok);
      if (solc.ok) {
        const solcValue = decodeFunctionResult({
          abi: EvsReference.abi as Abi,
          functionName: c.fn,
          data: solc.bytes,
        });
        const evsValue = decodeFunctionResult({
          abi: compiled.abi as Abi,
          functionName: c.fn,
          data: evs.bytes,
        }) as { r: bigint | number };
        expect(BigInt(evsValue.r), `${ctx}: value mismatch`).toBe(BigInt(solcValue as never));
      } else {
        expect(evs.bytes, `${ctx}: Panic payload mismatch`).toBe(solc.bytes);
      }
    }
  });
});
