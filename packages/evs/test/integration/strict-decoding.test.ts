/**
 * Strict decoding on a real node, against a real Solidity caller (the anvil mirror of
 * `src/differential/strict-decoding.test.ts`).
 *
 * evs refuses a word that is out of range for its ABI type, and a call through a function without
 * outputs to an address without code, "as solc does". Here that claim is checked, not stated:
 * `StrictDecodeReference` (solc 0.8.30) decodes on the same node, with solc's own ABI decoder,
 * the bytes an evs script decodes, and each case asserts the two agree.
 *
 * - **Returndata.** `Malformed.echoRaw(bytes)` returns its argument verbatim. A script declares it
 *   with a shape's outputs; the reference calls it through an interface with the same outputs.
 *   Clean payload: both decode it to the same values. One narrow word out of range: `s.read`
 *   reverts `EvsDecodeError(site)`, `s.tryRead` reports `success = false`, and the Solidity caller
 *   reverts.
 * - **Arguments.** The same bytes as the script's own calldata and as the reference function's:
 *   `EvsInvalidCalldata()` on one side, a revert on the other, for the same payloads.
 * - **No code.** A function without outputs, all six verbs, at `NoOutputs` (the call runs) and at
 *   an address without code (strict → `EvsDecodeError(site)`, try → `success = false`), through
 *   viem's `readContract`; the Solidity caller reverts on the same address.
 *
 * Both execution modes (state override and deployless).
 */

import {
  type Abi,
  type AbiParameter,
  BaseError,
  ContractFunctionRevertedError,
  concat,
  decodeAbiParameters,
  decodeFunctionResult,
  encodeFunctionData,
  toFunctionSelector,
  type Hex,
} from 'viem';
import { beforeAll, describe, expect, test } from 'vite-plus/test';

import { abiParamToType } from '../../src/core/types.js';
import { evscript, t, type CompiledEvsScript, type Expr, type NamedType } from '../../src/index.js';
import { Malformed, NoOutputs, StrictDecodeReference } from '../generated/index.js';
import { publicClient } from '../harness/anvil.js';
import { payloadsOf, STRICT_SHAPES } from '../harness/strict-decoding.js';
import { callExpectRevert, deploy } from './helpers.js';

const INVALID_CALLDATA = '0xf43fed56'; // EvsInvalidCalldata()
/** An address nothing was ever deployed at. */
const NO_CODE = '0x00000000000000000000000000000000000e0a01';

let malformed: `0x${string}`;
let reference: `0x${string}`;
let noOutputs: `0x${string}`;
beforeAll(async () => {
  malformed = await deploy(Malformed.abi, Malformed.bytecode);
  reference = await deploy(StrictDecodeReference.abi, StrictDecodeReference.bytecode);
  noOutputs = await deploy(NoOutputs.abi, NoOutputs.bytecode);
});

const refAbi = StrictDecodeReference.abi as Abi;

type LooseRead = (opts: {
  address: Expr<'address'>;
  abi: Abi;
  functionName: 'echoRaw';
  args: readonly [Expr<'bytes'>];
}) => unknown;

/** `strict(target, payload)` / `attempt(target, payload)`: `echoRaw(payload)` decoded as
 *  `outputs`, the strict one returning the decoded values. */
function scripts(outputs: readonly AbiParameter[]) {
  const abi: Abi = [
    {
      type: 'function',
      name: 'echoRaw',
      stateMutability: 'view',
      inputs: [{ name: 'data', type: 'bytes' }],
      outputs: [...outputs],
    },
  ];
  const fields = (v: unknown): Record<string, Expr> =>
    Array.isArray(v)
      ? Object.fromEntries(v.map((x, i) => [`v${i}`, x as Expr]))
      : { v0: v as Expr };
  const strict = evscript({ name: 'strict', args: [t.address, t.bytes] }, (s, target, payload) =>
    s.return(
      fields(
        (s.read as unknown as LooseRead)({
          address: target,
          abi,
          functionName: 'echoRaw',
          args: [payload],
        }),
      ),
    ),
  ).compile() as unknown as CompiledEvsScript;
  const attempt = evscript(
    { name: 'attempt', args: [t.address, t.bytes] },
    (s, target, payload) => {
      const r = (s.tryRead as unknown as LooseRead)({
        address: target,
        abi,
        functionName: 'echoRaw',
        args: [payload],
      }) as { success: Expr<'bool'> };
      return s.return({ ok: r.success });
    },
  ).compile() as unknown as CompiledEvsScript;
  return { strict, attempt };
}

describe.each(['stateOverride', 'deployless'] as const)('strict decoding [%s]', (mode) => {
  /** The eth_call target for `data` under this mode. */
  function callParams(compiled: { toViem: CompiledEvsScript['toViem'] }, data: Hex) {
    if (mode === 'deployless') return { code: compiled.toViem().code, data };
    const p = compiled.toViem({ mode: 'stateOverride' });
    return { to: p.address, stateOverride: p.stateOverride, data };
  }
  /** `toViem()` under this mode, for `readContract`. */
  const viemOf = (compiled: CompiledEvsScript) =>
    mode === 'deployless' ? compiled.toViem() : compiled.toViem({ mode: 'stateOverride' });

  // -------------------------------------------------------------------------
  // returndata
  // -------------------------------------------------------------------------

  for (const shape of STRICT_SHAPES) {
    const names = shape.solc;
    if (names === undefined) continue;

    test(`returndata, ${shape.label}: evs and a Solidity caller refuse the same payloads`, async () => {
      const { clean, dirty } = payloadsOf(shape);
      const { strict, attempt } = scripts(shape.outputs);
      const strictData = (payload: Hex): Hex =>
        encodeFunctionData({
          abi: strict.abi as Abi,
          functionName: 'strict',
          args: [malformed, payload],
        });
      const attemptOk = async (payload: Hex): Promise<unknown> => {
        const abi = attempt.abi as Abi;
        const res = await publicClient.call(
          callParams(
            attempt,
            encodeFunctionData({ abi, functionName: 'attempt', args: [malformed, payload] }),
          ),
        );
        return decodeFunctionResult({ abi, functionName: 'attempt', data: res.data ?? '0x' });
      };
      const solcData = (payload: Hex): Hex =>
        encodeFunctionData({ abi: refAbi, functionName: names.ret, args: [malformed, payload] });

      // the clean payload: both decode it, to the same values
      const viaEvs = await publicClient.call(callParams(strict, strictData(clean)));
      const viaSolc = await publicClient.call({ to: reference, data: solcData(clean) });
      const evsValues = Object.values(
        decodeFunctionResult({
          abi: strict.abi as Abi,
          functionName: 'strict',
          data: viaEvs.data ?? '0x',
        }) as Record<string, unknown>,
      );
      const solcDecoded = decodeFunctionResult({
        abi: refAbi,
        functionName: names.ret,
        data: viaSolc.data ?? '0x',
      });
      expect(evsValues).toEqual(shape.outputs.length === 1 ? [solcDecoded] : solcDecoded);
      expect(evsValues).toEqual(decodeAbiParameters(shape.outputs, clean));
      expect(await attemptOk(clean)).toEqual({ ok: true });

      // one word out of range: both refuse it
      for (const [label, payload] of dirty) {
        const raw = await callExpectRevert(callParams(strict, strictData(payload)));
        const explained = strict.explainRevert(raw);
        expect(explained.message).toContain('a word is out of range for its type');
        expect({
          dirty: label,
          evsStrict: explained.kind,
          evsTry: await attemptOk(payload),
          solc: await callExpectRevert({ to: reference, data: solcData(payload) }),
        }).toEqual({
          dirty: label,
          evsStrict: 'evs-decode',
          evsTry: { ok: false },
          solc: '0x', // solc's decoder reverts without data
        });
      }
    });

    // -----------------------------------------------------------------------
    // arguments
    // -----------------------------------------------------------------------

    test(`arguments, ${shape.label}: evs and a Solidity function refuse the same calldata`, async () => {
      const { clean, dirty } = payloadsOf(shape);
      const types = shape.outputs.map((p) => abiParamToType(p as NamedType));
      const echo = evscript({ name: 'y', args: types as never }, (s, ...args: Expr[]) =>
        s.return(Object.fromEntries(args.map((a, i) => [`a${i}`, a])) as never),
      ).compile() as unknown as CompiledEvsScript;
      const evsSelector = toFunctionSelector(
        (echo.abi as Abi).find((x) => x.type === 'function') as never,
      );
      const solcSelector = toFunctionSelector(
        refAbi.find((x) => x.type === 'function' && x.name === names.arg) as never,
      );

      const viaEvs = await publicClient.call(callParams(echo, concat([evsSelector, clean])));
      expect(
        Object.values(
          decodeFunctionResult({
            abi: echo.abi as Abi,
            functionName: 'y',
            data: viaEvs.data ?? '0x',
          }) as Record<string, unknown>,
        ),
      ).toEqual(decodeAbiParameters(shape.outputs, clean));
      const viaSolc = await publicClient.call({
        to: reference,
        data: concat([solcSelector, clean]),
      });
      expect(viaSolc.data).toBeDefined();

      for (const [label, payload] of dirty) {
        const raw = await callExpectRevert(callParams(echo, concat([evsSelector, payload])));
        expect({
          dirty: label,
          evs: raw,
          explained: echo.explainRevert(raw).kind,
          solc: await callExpectRevert({ to: reference, data: concat([solcSelector, payload]) }),
        }).toEqual({
          dirty: label,
          evs: INVALID_CALLDATA,
          explained: 'evs-invalid-calldata',
          solc: '0x',
        });
      }
    });
  }

  // -------------------------------------------------------------------------
  // a function without outputs
  // -------------------------------------------------------------------------

  const strictCheck = evscript({ name: 'strict', args: [t.address] }, (s, target) => {
    s.read({ address: target, abi: NoOutputs.abi, functionName: 'check', args: [1n] });
    return s.return({ valid: s.lit(t.bool, true) });
  }).compile();
  const attemptCheck = evscript({ name: 'attempt', args: [t.address] }, (s, target) => {
    const r = s.tryRead({ address: target, abi: NoOutputs.abi, functionName: 'check', args: [1n] });
    return s.return({ valid: r.success, codeSize: s.codeSize(target) });
  }).compile();

  test('s.read / s.tryRead of a function without outputs: runs on code, fails without', async () => {
    // with code: the call runs
    expect(
      await publicClient.readContract({
        ...viemOf(strictCheck),
        functionName: 'strict',
        args: [noOutputs],
      } as never),
    ).toEqual({ valid: true });
    const ran = (await publicClient.readContract({
      ...viemOf(attemptCheck),
      functionName: 'attempt',
      args: [noOutputs],
    } as never)) as { valid: boolean; codeSize: bigint };
    expect(ran.valid).toBe(true);
    expect(ran.codeSize).toBeGreaterThan(0n);

    // without code: s.tryRead reports the failure, s.read reverts EvsDecodeError at its site
    expect(
      await publicClient.readContract({
        ...viemOf(attemptCheck),
        functionName: 'attempt',
        args: [NO_CODE],
      } as never),
    ).toEqual({ valid: false, codeSize: 0n });
    const thrown: unknown = await publicClient
      .readContract({ ...viemOf(strictCheck), functionName: 'strict', args: [NO_CODE] } as never)
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(thrown).toBeInstanceOf(BaseError);
    const reverted = (thrown as BaseError).walk((e) => e instanceof ContractFunctionRevertedError);
    expect((reverted as ContractFunctionRevertedError).data?.errorName).toBe('EvsDecodeError');
    const raw = await callExpectRevert(
      callParams(
        strictCheck,
        encodeFunctionData({ abi: strictCheck.abi, functionName: 'strict', args: [NO_CODE] }),
      ),
    );
    const explained = strictCheck.explainRevert(raw);
    expect(explained.kind).toBe('evs-decode');
    expect(explained.message).toContain('the target address has no code');

    // a Solidity caller: the same call runs on code and reverts without
    const solc = (target: Hex): Hex =>
      encodeFunctionData({ abi: refAbi, functionName: 'check', args: [target, 1n] });
    await publicClient.call({ to: reference, data: solc(noOutputs) });
    expect(await callExpectRevert({ to: reference, data: solc(NO_CODE) })).toBe('0x');
  });

  test.each(['call', 'simulate'] as const)(
    's.%s and its try form through a function without outputs: runs on code, fails without',
    async (verb) => {
      const tryVerb = verb === 'call' ? 'tryCall' : 'trySimulate';
      const strict = evscript({ name: 'strict', args: [t.address] }, (s, target) => {
        s[verb]({ address: target, abi: NoOutputs.abi, functionName: 'poke', args: [1n] });
        return s.return({ ran: s.lit(t.bool, true) });
      }).compile();
      const attempt = evscript({ name: 'attempt', args: [t.address] }, (s, target) => {
        const r = s[tryVerb]({
          address: target,
          abi: NoOutputs.abi,
          functionName: 'poke',
          args: [1n],
        });
        return s.return({ ran: r.success });
      }).compile();
      const call = async (
        compiled: CompiledEvsScript,
        fn: string,
        target: Hex,
      ): Promise<unknown> => {
        const abi = compiled.abi as Abi;
        const res = await publicClient.call(
          callParams(compiled, encodeFunctionData({ abi, functionName: fn, args: [target] })),
        );
        return decodeFunctionResult({ abi, functionName: fn, data: res.data ?? '0x' });
      };
      const strictCompiled = strict as unknown as CompiledEvsScript;
      const attemptCompiled = attempt as unknown as CompiledEvsScript;
      expect(await call(strictCompiled, 'strict', noOutputs)).toEqual({ ran: true });
      expect(await call(attemptCompiled, 'attempt', noOutputs)).toEqual({ ran: true });
      expect(await call(attemptCompiled, 'attempt', NO_CODE)).toEqual({ ran: false });
      const raw = await callExpectRevert(
        callParams(
          strictCompiled,
          encodeFunctionData({ abi: strict.abi, functionName: 'strict', args: [NO_CODE] }),
        ),
      );
      const explained = strict.explainRevert(raw);
      expect(explained.kind).toBe('evs-decode');
      expect(explained.message).toContain('the target address has no code');
    },
  );
});
