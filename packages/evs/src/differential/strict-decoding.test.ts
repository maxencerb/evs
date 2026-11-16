/**
 * Differential suite — strict decoding: a word the script did not compute is refused when it is
 * out of range for its ABI type, and a call through a function without outputs is refused when
 * its target has no code. Both as solc 0.8.30 does.
 *
 * - **Out-of-range words.** One clean payload per shape and one payload per narrow word of it
 *   with that word pushed out of range (`bool` above 1, `uintN` / `address` with a bit above the
 *   width, `intN` not sign-extended, `bytesN` with a low byte set). The shapes put a word at every
 *   position a decoder reads one: a top-level output (alone and in a run of words), a member of a
 *   static and of a dynamic struct, of a nested struct, an element of `T[]`, of `T[N]`, of a
 *   struct array, of a nested array (stack and heap-frame paths), a narrow array inside a struct.
 *   - a call's returndata, all six verbs: strict → `EvsDecodeError(site)`; try → `success =
 *     false` and zero values; interp == bytecode (plain and optimized) byte-for-byte;
 *   - a `revertReturns` payload: the same decode, the same refusal;
 *   - the script's own arguments (raw calldata, bytecode only: `interpret()` takes typed values
 *     and refuses an out-of-range one before it runs) → `EvsInvalidCalldata()`.
 * - **solc agreement.** `StrictDecodeReference` (solc 0.8.30) decodes the same bytes with solc's
 *   own ABI decoder, as returndata of a high-level call and as its own arguments: it accepts
 *   every clean payload and reverts on every dirty one, exactly where evs does.
 * - **No code.** A call through a function without outputs, all six verbs: the target is checked
 *   before the call. With code the call runs; without it, strict → `EvsDecodeError(site)`, try →
 *   `success = false`, and no value is sent. solc's high-level call reverts on the same target.
 */

/* oxlint-disable typescript/no-unsafe-type-assertion, typescript/no-unnecessary-type-assertion -- a loose
   corpus: ABIs, verb surfaces and values are built at run time from tables */

import {
  type Abi,
  type AbiParameter,
  decodeAbiParameters,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  toFunctionSelector,
  type Hex,
} from 'viem';
import { describe, expect, test } from 'vite-plus/test';

import { Malformed, NoOutputs, StrictDecodeReference } from '../../test/generated/index.js';
import {
  expectAgreement,
  EVM_VERSIONS,
  type AnyScript,
  type CalleeTable,
  type Outcome,
} from '../../test/harness/differential.js';
import { execRuntime } from '../../test/harness/evm.js';
import { concatHex, word } from '../../test/harness/fixtures.js';
import { payloadsOf, STRICT_SHAPES as SHAPES } from '../../test/harness/strict-decoding.js';
import { evscript } from '../builder/script.js';
import { compile, type CompiledEvsScript } from '../compile.js';
import { abiParamToType, t, type Expr, type NamedType } from '../core/types.js';
import { interpret } from '../ir/interp.js';

type Verb = 'read' | 'tryRead' | 'call' | 'tryCall' | 'simulate' | 'trySimulate';
const VERBS: readonly Verb[] = ['read', 'tryRead', 'call', 'tryCall', 'simulate', 'trySimulate'];
const isTry = (v: Verb): boolean => v.startsWith('try');
const isView = (v: Verb): boolean => v === 'read' || v === 'tryRead';

/** The loose verb surface the corpus drives (precise inference is pinned by the type tests). */
type LooseVerbs = Record<Verb, (opts: Record<string, unknown>) => unknown>;

const DECODE_ERROR = '0x20cf27b7'; // EvsDecodeError(uint256)
const INVALID_CALLDATA = '0xf43fed56'; // EvsInvalidCalldata()

/** Deterministic lowercase addresses (the harness table keys must be lowercase). */
const addr = (n: number): Hex =>
  `0x7300000000000000000000000000000000${n.toString(16).padStart(6, '0')}`;

function getterAbi(outputs: readonly AbiParameter[], verb: Verb): Abi {
  return [
    {
      type: 'function',
      name: 'g',
      stateMutability: isView(verb) ? 'view' : 'nonpayable',
      inputs: [],
      outputs: [...outputs],
    },
  ];
}

/** `f(address)`: one call of `verb` over `g() returns (outputs)`, the result returned. */
function callScript(outputs: readonly AbiParameter[], verb: Verb, extra: object = {}): AnyScript {
  const abi = getterAbi(outputs, verb);
  return evscript({ name: 'f', args: [t.address] }, (s, target) => {
    const r = (s as unknown as LooseVerbs)[verb]({
      address: target,
      abi,
      functionName: 'g',
      ...extra,
    });
    const fields = (v: unknown): Record<string, Expr> =>
      Array.isArray(v)
        ? Object.fromEntries(v.map((x, i) => [`v${i}`, x as Expr]))
        : v === undefined
          ? {}
          : { v: v as Expr };
    // `ok`: the try form's success flag; a strict form that returns at all ran its call
    const tr = r as { success: Expr<'bool'>; value?: unknown };
    const ok: Expr<'bool'> = isTry(verb) ? tr.success : s.lit(t.bool, true);
    return s.return({ ok, ...fields(isTry(verb) ? tr.value : r) });
  });
}

/** How a site refuses a payload: a try form returns `ok = false`, a strict one reverts
 *  `EvsDecodeError`. `refusalOf` reads an outcome in the shape `refusal` predicts. */
const refusal = (verb: Verb): unknown =>
  isTry(verb) ? { ok: false } : { kind: 'revert', selector: DECODE_ERROR };
const refusalOf = (script: AnyScript, verb: Verb, o: Outcome | undefined): unknown =>
  isTry(verb)
    ? { ok: decodeOut(script, o)['ok'] }
    : { kind: o?.kind, selector: o?.data.slice(0, 10) };

const decodeOut = (script: AnyScript, o: Outcome | undefined): Record<string, unknown> => {
  if (o?.kind !== 'return') throw new Error(`expected a normal return, got ${o?.kind}: ${o?.data}`);
  return decodeFunctionResult({
    abi: script.abi as Abi,
    functionName: script.name,
    data: o.data,
  }) as Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// returndata: every shape, every verb
// ---------------------------------------------------------------------------

describe('a word of returndata out of range for its type', () => {
  for (const shape of SHAPES) {
    const { clean, dirty } = payloadsOf(shape);
    const table: Record<string, CalleeTable[string]> = {
      [addr(0)]: { kind: 'return', data: clean },
    };
    dirty.forEach(([, data], i) => {
      table[addr(1 + i)] = { kind: 'return', data };
    });
    const argSets = [[addr(0)], ...dirty.map((_, i) => [addr(1 + i)])];

    for (const verb of VERBS) {
      // every fork for the read verbs (the copy loops differ before cancun), cancun for the rest
      const forks = isView(verb) ? EVM_VERSIONS : (['cancun'] as const);
      for (const evmVersion of forks) {
        test(`${shape.label} × ${verb} [${evmVersion}]`, async () => {
          const script = callScript(shape.outputs, verb);
          const [ok, ...bad] = await expectAgreement(script, argSets, table, evmVersion);
          // the clean payload decodes
          expect(decodeOut(script, ok)['ok']).toBe(true);
          // each dirty one is refused, whichever word of the shape it is
          expect(
            bad.map((o, i) => ({ dirty: dirty[i]?.[0], got: refusalOf(script, verb, o) })),
          ).toEqual(dirty.map(([label]) => ({ dirty: label, got: refusal(verb) })));
        });
      }
    }
  }

  test('a try form zeroes every output of a refused decode, the in-range ones too', async () => {
    const shape = SHAPES.find((x) => x.label.startsWith('words around a string'));
    if (shape === undefined) throw new Error('shape missing');
    const { dirty } = payloadsOf(shape);
    const last = dirty.at(-1); // the int16 after the string: every earlier output decoded fine
    if (last === undefined) throw new Error('no dirty payload');
    const script = callScript(shape.outputs, 'tryRead');
    const [o] = await expectAgreement(script, [[addr(1)]], {
      [addr(1)]: { kind: 'return', data: last[1] },
    });
    expect(decodeOut(script, o)).toEqual({ ok: false, v0: 0, v1: 0n, v2: '', v3: false, v4: 0 });
  });

  test('revertReturns: a word of the revert payload out of range is the same decode failure', async () => {
    const quoteAbi = getterAbi([], 'call');
    const script = (mode: 'call' | 'tryCall'): AnyScript =>
      evscript({ name: 'f', args: [t.address] }, (s, target) => {
        const r = (s as unknown as LooseVerbs)[mode]({
          address: target,
          abi: quoteAbi,
          functionName: 'g',
          revertReturns: [t.uint8, t.bool],
        });
        if (mode === 'tryCall') {
          const tr = r as { success: Expr<'bool'>; value: readonly Expr[] };
          return s.return({ ok: tr.success, a: tr.value[0] as Expr, b: tr.value[1] as Expr });
        }
        const v = r as readonly Expr[];
        return s.return({ ok: s.lit(t.bool, true), a: v[0] as Expr, b: v[1] as Expr });
      });
    const table: CalleeTable = {
      [addr(0)]: { kind: 'revert', data: concatHex(word(255n), word(1n)) },
      [addr(1)]: { kind: 'revert', data: concatHex(word(256n), word(1n)) },
      [addr(2)]: { kind: 'revert', data: concatHex(word(255n), word(2n)) },
    };
    const argSets = [[addr(0)], [addr(1)], [addr(2)]];
    const strict = script('call');
    const [ok, ...bad] = await expectAgreement(strict, argSets, table);
    expect(decodeOut(strict, ok)).toEqual({ ok: true, a: 255, b: true });
    for (const o of bad) expect(o.data.slice(0, 10)).toBe(DECODE_ERROR);
    const attempt = script('tryCall');
    const [tryOk, ...tryBad] = await expectAgreement(attempt, argSets, table);
    expect(decodeOut(attempt, tryOk)).toEqual({ ok: true, a: 255, b: true });
    for (const o of tryBad) expect(decodeOut(attempt, o)).toEqual({ ok: false, a: 0, b: false });
  });
});

// ---------------------------------------------------------------------------
// the script's own arguments (raw calldata)
// ---------------------------------------------------------------------------

describe('an argument word out of range for its type reverts EvsInvalidCalldata()', () => {
  for (const shape of SHAPES) {
    for (const evmVersion of EVM_VERSIONS) {
      test(`${shape.label} [${evmVersion}]`, async () => {
        const types = shape.outputs.map((p) => abiParamToType(p as NamedType));
        const script = evscript({ name: 'y', args: types as never }, (s, ...args: Expr[]) =>
          s.return(Object.fromEntries(args.map((a, i) => [`a${i}`, a])) as never),
        );
        const { clean, dirty } = payloadsOf(shape);
        const selector = encodeFunctionData({
          abi: script.abi as Abi,
          functionName: 'y',
          args: shape.values as never,
        }).slice(0, 10) as Hex;
        for (const optimize of [false, true]) {
          const { runtimeBytecode } = compile(script, { evmVersion, optimize });
          // oxlint-disable-next-line no-await-in-loop -- sequential: deterministic labels
          const ok = await execRuntime(runtimeBytecode, concatHex(selector, clean));
          expect(ok.success).toBe(true);
          const echoed = decodeFunctionResult({
            abi: script.abi as Abi,
            functionName: 'y',
            data: ok.data,
          }) as Record<string, unknown>;
          expect(Object.values(echoed)).toEqual(decodeAbiParameters(shape.outputs, clean));
          for (const [label, data] of dirty) {
            // oxlint-disable-next-line no-await-in-loop -- sequential: deterministic labels
            const bad = await execRuntime(runtimeBytecode, concatHex(selector, data));
            // a revert with the named error, never a halt
            expect({ dirty: label, success: bad.success, data: bad.data }).toEqual({
              dirty: label,
              success: false,
              data: INVALID_CALLDATA,
            });
            expect(bad.gasUsed).toBeLessThan(1_000_000n);
          }
        }
      });
    }
  }

  test('interpret() takes typed values: an out-of-range one is refused before the script runs', () => {
    const script = evscript({ name: 'y', args: [t.uint8, t.int8] }, (s, a, b) =>
      s.return({ a, b }),
    );
    const chain = { staticcall: () => ({ success: true, data: '0x' as Hex }) };
    expect(() => interpret(script, [256, 0] as never, chain)).toThrow(/out of range/);
    expect(() => interpret(script, [0, -129] as never, chain)).toThrow(/out of range/);
  });
});

// ---------------------------------------------------------------------------
// solc agreement: the same bytes through solc 0.8.30's ABI decoder
// ---------------------------------------------------------------------------

describe('solc 0.8.30 refuses exactly the payloads evs refuses', () => {
  const REF = addr(0xf1);
  const ECHO = addr(0xf2);
  const fixture = {
    contracts: {
      [REF]: StrictDecodeReference.deployedBytecode,
      [ECHO]: Malformed.deployedBytecode,
    },
  };
  /** A call into the reference contract (planted at the harness script address). */
  const solc = async (data: Hex): Promise<{ success: boolean; data: Hex }> =>
    execRuntime(StrictDecodeReference.deployedBytecode, data, fixture);
  const refAbi = StrictDecodeReference.abi as Abi;

  for (const shape of SHAPES) {
    const names = shape.solc;
    if (names === undefined) continue;
    const { clean, dirty } = payloadsOf(shape);

    test(`${shape.label}: as the returndata of a high-level call`, async () => {
      const call = (payload: Hex): Hex =>
        encodeFunctionData({ abi: refAbi, functionName: names.ret, args: [ECHO, payload] });
      const ok = await solc(call(clean));
      expect(ok.success).toBe(true);
      // a static return is the payload itself; a dynamic one is re-encoded, so compare values
      const decoded = decodeFunctionResult({ abi: refAbi, functionName: names.ret, data: ok.data });
      // viem hands a single output back unwrapped
      const values = shape.outputs.length === 1 ? [decoded] : decoded;
      expect(encodeAbiParameters(shape.outputs, values as never)).toBe(clean);
      for (const [label, payload] of dirty) {
        // oxlint-disable-next-line no-await-in-loop -- sequential: deterministic labels
        const bad = await solc(call(payload));
        expect({ dirty: label, success: bad.success, data: bad.data }).toEqual({
          dirty: label,
          success: false,
          data: '0x', // solc's validator reverts without data
        });
      }
    });

    test(`${shape.label}: as the function's own arguments`, async () => {
      const selector = toFunctionSelector(
        (refAbi.find((x) => x.type === 'function' && x.name === names.arg) ?? {}) as never,
      );
      const ok = await solc(concatHex(selector, clean));
      expect(ok.success).toBe(true);
      for (const [label, payload] of dirty) {
        // oxlint-disable-next-line no-await-in-loop -- sequential: deterministic labels
        const bad = await solc(concatHex(selector, payload));
        expect({ dirty: label, success: bad.success, data: bad.data }).toEqual({
          dirty: label,
          success: false,
          data: '0x',
        });
      }
    });
  }

  test('a high-level call through a function without outputs reverts on an address without code', async () => {
    const call = (target: Hex): Hex =>
      encodeFunctionData({ abi: refAbi, functionName: 'check', args: [target, 1n] });
    const withCode = await execRuntime(StrictDecodeReference.deployedBytecode, call(addr(0xf3)), {
      contracts: { [addr(0xf3)]: NoOutputs.deployedBytecode },
    });
    expect(withCode.success).toBe(true);
    const noCode = await execRuntime(StrictDecodeReference.deployedBytecode, call(addr(0xf4)));
    expect({ success: noCode.success, data: noCode.data }).toEqual({ success: false, data: '0x' });
  });
});

// ---------------------------------------------------------------------------
// a function without outputs: the target must have code
// ---------------------------------------------------------------------------

describe('a call through a function without outputs checks that its target has code', () => {
  const WITH_CODE = addr(0xc0);
  const REVERTS = addr(0xc1);
  const NO_CODE = addr(0xc2);
  const IDENTITY = '0x0000000000000000000000000000000000000004'; // a precompile has no code
  const table: CalleeTable = {
    [WITH_CODE]: { kind: 'return', data: '0x' },
    [REVERTS]: { kind: 'revert', data: '0xdeadbeef' },
  };

  for (const verb of VERBS) {
    for (const evmVersion of EVM_VERSIONS) {
      test(`${verb} [${evmVersion}]`, async () => {
        const script = callScript([], verb);
        const [ran, reverted, noCode, precompile] = await expectAgreement(
          script,
          [[WITH_CODE], [REVERTS], [NO_CODE], [IDENTITY]],
          table,
          evmVersion,
        );
        // a try form always returns, so read its record; a strict form's outcome is the revert
        const seen = (o: Outcome | undefined): unknown => (isTry(verb) ? decodeOut(script, o) : o);
        // with code the call runs, and a callee revert is what it always was: a strict form
        // bubbles it verbatim, a try form reports it
        expect(decodeOut(script, ran)).toEqual({ ok: true });
        expect(seen(reverted)).toEqual(
          isTry(verb) ? { ok: false } : { kind: 'revert', data: '0xdeadbeef' },
        );
        // without code nothing is called: the site's own failure, at its own site id
        const compiled: CompiledEvsScript = compile(script);
        const site = compiled.sourceMap.sites.find((x) => x.kind === 'decode');
        const failure = isTry(verb)
          ? { ok: false }
          : { kind: 'revert', data: concatHex(DECODE_ERROR, word(BigInt(site?.id ?? -1))) };
        expect(seen(noCode)).toEqual(failure);
        expect(seen(precompile)).toEqual(failure);
      });
    }
  }

  test('a function WITH outputs is not checked: its empty returndata already fails the decode', () => {
    const extcodesize = (script: AnyScript): number => {
      const compiled: CompiledEvsScript = compile(script);
      return compiled.disassemble().lines.filter((l) => l.mnemonic === 'EXTCODESIZE').length;
    };
    expect(extcodesize(callScript([{ name: 'a', type: 'uint256' }], 'read'))).toBe(0);
    expect(extcodesize(callScript([], 'read'))).toBe(1);
  });

  test('revertReturns without outputs is not checked: a call that returns is already its failure', async () => {
    const script = evscript({ name: 'f', args: [t.address] }, (s, target) => {
      const r = s.tryCall({
        address: target,
        abi: getterAbi([], 'call') as never,
        functionName: 'g' as never,
        revertReturns: [t.uint256],
      } as never) as unknown as { success: Expr<'bool'> };
      return s.return({ ok: r.success });
    });
    expect(
      compile(script)
        .disassemble()
        .lines.filter((l) => l.mnemonic === 'EXTCODESIZE'),
    ).toHaveLength(0);
    const [o] = await expectAgreement(script, [[NO_CODE]], table);
    expect(decodeOut(script, o)).toEqual({ ok: false });
  });

  test('value is not sent to a target without code (s.call / s.tryCall / s.simulate)', async () => {
    // the script holds 5 wei and tries to send 3 through a payable function without outputs
    const payAbi: Abi = [
      { type: 'function', name: 'g', stateMutability: 'payable', inputs: [], outputs: [] },
    ];
    const SCRIPT = '0xcd360ffac9818c4396aa6f4807ebfa72c4b3f530';
    const balances = { [SCRIPT]: 5n };
    const attempt = evscript({ name: 'f', args: [t.address] }, (s, target) => {
      const r = s.tryCall({ address: target, abi: payAbi, functionName: 'g', value: 3n });
      return s.return({ ok: r.success, kept: s.balance(s.env('address')), got: s.balance(target) });
    });
    const [o] = await expectAgreement(attempt, [[NO_CODE]], table, 'cancun', { balances });
    expect(decodeOut(attempt, o)).toEqual({ ok: false, kept: 5n, got: 0n });

    for (const verb of ['call', 'simulate'] as const) {
      const strict = evscript({ name: 'f', args: [t.address] }, (s, target) => {
        s[verb]({ address: target, abi: payAbi, functionName: 'g', value: 3n });
        return s.return({ ok: s.lit(t.bool, true) });
      });
      // oxlint-disable-next-line no-await-in-loop -- sequential: deterministic labels
      const [failed] = await expectAgreement(strict, [[NO_CODE]], table, 'cancun', { balances });
      expect(failed?.kind).toBe('revert');
      expect(failed?.data.slice(0, 10)).toBe(DECODE_ERROR);
    }
  });
});
