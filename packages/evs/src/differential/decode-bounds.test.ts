/**
 * Differential suite — decode bounds on hostile data (the 0.2.0 pre-release codec review).
 *
 * - **Huge in-range lengths.** A length word the source cannot back (2^16 … 2^64−1, all under the
 *   u64 guard) must fail the body bounds check BEFORE the array decoders allocate anything: try
 *   verbs return `success = false` + the zero value, strict verbs revert `EvsDecodeError(site)`,
 *   script args revert `EvsInvalidCalldata` — never an out-of-gas halt from a pointer block or a
 *   heap decode frame sized by the bogus length. Both decoder paths (stack fast path and
 *   heap-frame path) and every verb, on every fork.
 * - **Short nested heads.** A nested dynamic tuple's whole head must fit (`ptr + headBytes ≤
 *   end`, the interpreter's `decodeBlock` guard), as a member, an array element, a top-level
 *   output and a script arg.
 * - **Deep nesting.** Struct / array chains at the deepest shape that fits the stack window
 *   decode byte-exact; one level deeper is a coded `UNSUPPORTED_V0` compile error, never an
 *   INTERNAL asm-verifier crash.
 * - **Aliased tails.** Two outputs whose offsets share the same bytes: normalizing a narrow
 *   word array must not rewrite the bytes another decoded value reads.
 *
 * interp == bytecode (plain and optimized) byte-for-byte, and == viem where viem decodes.
 */

/* oxlint-disable typescript/no-unsafe-type-assertion, typescript/no-unnecessary-type-assertion -- a loose
   corpus: ABIs, verb surfaces and values are built at run time from tables */

import type { Abi, AbiParameter } from 'abitype';
import {
  decodeFunctionData,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  toFunctionSelector,
  type Hex,
} from 'viem';
import { describe, expect, test } from 'vite-plus/test';

import {
  expectAgreement,
  EVM_VERSIONS,
  type AnyScript,
  type CalleeTable,
  type Outcome,
} from '../../test/harness/differential.js';
import { execRuntime } from '../../test/harness/evm.js';
import { concatHex, word } from '../../test/harness/fixtures.js';
import { evscript } from '../builder/script.js';
import { compile } from '../compile.js';
import { EvsError } from '../core/errors.js';
import { t, typeToAbiParam, type EvsType, type Expr } from '../core/types.js';

type Verb = 'read' | 'tryRead' | 'simulate' | 'trySimulate';
const VERBS: readonly Verb[] = ['read', 'tryRead', 'simulate', 'trySimulate'];
const isTry = (v: Verb): boolean => v === 'tryRead' || v === 'trySimulate';

/** The loose verb surface the corpus drives (precise inference is pinned by the type tests). */
type LooseVerbs = Record<
  Verb,
  (opts: { address: Expr<'address'>; abi: Abi; functionName: 'g' }) => unknown
>;

const DECODE_ERROR = '0x20cf27b7'; // EvsDecodeError(uint256)
const INVALID_CALLDATA = '0xf43fed56'; // EvsInvalidCalldata()
const HUGE = [1n << 16n, 1n << 20n, 1n << 32n, (1n << 64n) - 1n] as const;

/** Deterministic lowercase callee addresses (the harness table keys must be lowercase). */
const addr = (n: number): Hex =>
  `0x7100000000000000000000000000000000${n.toString(16).padStart(6, '0')}`;

const words = (...ws: readonly bigint[]): Hex => concatHex(...ws.map((x) => word(x)));

/** viem encode over the loose corpus values. */
const encodeLoose = (params: readonly AbiParameter[], vals: readonly unknown[]): Hex =>
  encodeAbiParameters(params, vals as never);

function getterAbi(outputs: readonly AbiParameter[], verb: Verb): Abi {
  return [
    {
      type: 'function',
      name: 'g',
      stateMutability: verb === 'read' || verb === 'tryRead' ? 'view' : 'nonpayable',
      inputs: [],
      outputs: [...outputs],
    },
  ];
}

/** `f(address)`: one call of `verb` over `g() returns (outputs)`, the result returned. */
function callScript(outputs: readonly AbiParameter[], verb: Verb) {
  const abi = getterAbi(outputs, verb);
  return evscript({ name: 'f', args: [t.address] }, (s, target) => {
    const r = (s as unknown as LooseVerbs)[verb]({ address: target, abi, functionName: 'g' });
    // several outputs come back as a JS array of handles: return them as `v0, v1, …`
    const fields = (v: unknown): Record<string, Expr> =>
      Array.isArray(v)
        ? Object.fromEntries(v.map((x, i) => [`v${i}`, x as Expr]))
        : // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- loose corpus value
          { v: v as Expr };
    if (isTry(verb)) {
      const tr = r as { success: Expr<'bool'>; value: unknown };
      return s.return({ ok: tr.success, ...fields(tr.value) });
    }
    return s.return(fields(r));
  });
}

const decodeOut = (script: AnyScript, o: Outcome | undefined): unknown => {
  if (o?.kind !== 'return') throw new Error(`expected a normal return, got ${o?.kind}: ${o?.data}`);
  return decodeFunctionResult({
    abi: script.abi as Abi,
    functionName: script.name,
    data: o?.data ?? '0x',
  });
};

/** The agreed outcome of a MALFORMED payload, in the shape {@link failureWant} predicts. */
function failureOf(script: AnyScript, verb: Verb, o: Outcome | undefined): unknown {
  return isTry(verb) ? decodeOut(script, o) : { kind: o?.kind, selector: o?.data.slice(0, 10) };
}

/** try → `success = false` + the zero value; strict → an `EvsDecodeError(site)` revert. */
function failureWant(verb: Verb, zero: unknown): unknown {
  return isTry(verb) ? { ok: false, v: zero } : { kind: 'revert', selector: DECODE_ERROR };
}

// ---------------------------------------------------------------------------
// huge in-range length words — both decoder paths, every verb, every fork
// ---------------------------------------------------------------------------

interface Shape {
  readonly label: string;
  readonly path: 'stack' | 'heap' | 'leaf';
  readonly output: AbiParameter;
  readonly value: unknown;
  readonly zero: unknown;
}

const cell = [
  { name: 'id', type: 'uint256' },
  { name: 'name', type: 'string' },
] as const;

const SHAPES: readonly Shape[] = [
  {
    label: 'uint256[]',
    path: 'leaf',
    output: { name: 'r', type: 'uint256[]' },
    value: [1n, 2n],
    zero: [],
  },
  {
    label: 'uint8[]',
    path: 'leaf',
    output: { name: 'r', type: 'uint8[]' },
    value: [1, 255],
    zero: [],
  },
  {
    label: 'string[]',
    path: 'stack',
    output: { name: 'r', type: 'string[]' },
    value: ['a', ''],
    zero: [],
  },
  {
    label: 'bytes[]',
    path: 'stack',
    output: { name: 'r', type: 'bytes[]' },
    value: ['0xbeef'],
    zero: [],
  },
  {
    label: 'uint256[][]',
    path: 'stack',
    output: { name: 'r', type: 'uint256[][]' },
    value: [[1n], [], [2n, 3n]],
    zero: [],
  },
  {
    label: 'tuple(uint256,string)[]',
    path: 'stack',
    output: { name: 'r', type: 'tuple[]', components: cell },
    value: [{ id: 7n, name: 'seven' }],
    zero: [],
  },
  {
    label: 'uint256[2][]',
    path: 'heap',
    output: { name: 'r', type: 'uint256[2][]' },
    value: [[1n, 2n]],
    zero: [],
  },
  {
    label: 'string[2][]',
    path: 'heap',
    output: { name: 'r', type: 'string[2][]' },
    value: [['a', 'b']],
    zero: [],
  },
  {
    label: 'uint256[][][]',
    path: 'heap',
    output: { name: 'r', type: 'uint256[][][]' },
    value: [[[1n], []], []],
    zero: [],
  },
  {
    label: 'tuple(uint256,string)[][]',
    path: 'heap',
    output: { name: 'r', type: 'tuple[][]', components: cell },
    value: [[{ id: 1n, name: 'x' }], []],
    zero: [],
  },
  {
    label: 'uint256[][2]',
    path: 'heap',
    output: { name: 'r', type: 'uint256[][2]' },
    value: [[1n], []],
    zero: [[], []],
  },
  {
    label: 'tuple(uint256,string)[][2]',
    path: 'heap',
    output: { name: 'r', type: 'tuple[][2]', components: cell },
    value: [[{ id: 1n, name: 'x' }], []],
    zero: [[], []],
  },
  {
    label: 'tuple(uint256 id, string[] tags)',
    path: 'stack',
    output: {
      name: 'r',
      type: 'tuple',
      components: [
        { name: 'id', type: 'uint256' },
        { name: 'tags', type: 'string[]' },
      ],
    },
    value: { id: 1n, tags: ['t'] },
    zero: { id: 0n, tags: [] },
  },
];

describe('huge in-range length words fail cleanly (review findings 1, 2, 3, 10)', () => {
  for (const shape of SHAPES) {
    const good = encodeLoose([shape.output], [shape.value]);
    const goodWords = good.slice(2).match(/.{64}/g) ?? [];
    for (const verb of VERBS) {
      for (const evmVersion of EVM_VERSIONS) {
        test(`${shape.label} [${shape.path}] × ${verb} [${evmVersion}]`, async () => {
          const script = callScript([shape.output], verb);
          const table: Record<string, CalleeTable[string]> = {};
          const GOOD = addr(1);
          table[GOOD] = { kind: 'return', data: good };
          // the canonical failure: the head offset is fine, the length word is huge and unbacked
          const failing: Hex[] = [];
          HUGE.forEach((h, k) => {
            const a = addr(0x100 + k);
            table[a] = { kind: 'return', data: words(0x20n, h) };
            failing.push(a);
            const b = addr(0x110 + k); // … with a little body after it
            table[b] = { kind: 'return', data: words(0x20n, h, 0x20n, 1n) };
            failing.push(b);
          });
          // every word of the good encoding set to every huge value (lengths and offsets at every
          // nesting level) — agreement only (some still decode, e.g. an element value). One fork
          // carries the full mutation corpus; the targeted cases above run everywhere.
          const agreementOnly: Hex[] = [];
          if (evmVersion === 'cancun') {
            goodWords.forEach((_, k) => {
              HUGE.forEach((h, m) => {
                const a = addr(0x1000 + 16 * k + m);
                const ws = [...goodWords];
                ws[k] = word(h).slice(2);
                table[a] = { kind: 'return', data: `0x${ws.join('')}` };
                agreementOnly.push(a);
              });
            });
          }
          const targets = [GOOD, ...failing, ...agreementOnly];
          const outcomes = await expectAgreement(
            script,
            targets.map((a) => [a]),
            table,
            evmVersion,
          );
          const expected = { v: shape.value };
          expect(decodeOut(script, outcomes[0])).toEqual(
            isTry(verb) ? { ok: true, v: shape.value } : expected,
          );
          for (let i = 1; i <= failing.length; i++) {
            expect(failureOf(script, verb, outcomes[i])).toEqual(failureWant(verb, shape.zero));
          }
        });
      }
    }
  }

  // review finding 2's exact payload: a contract whose `g()` returns `bytes` answering for one
  // declared to return a fixed array of dynamic arrays
  for (const shape of SHAPES.filter((s) => s.output.type.endsWith('[][2]'))) {
    for (const verb of VERBS) {
      test(`${shape.label} × ${verb}: abi.encode(bytes(0x6d4ce63c)) fails cleanly`, async () => {
        const script = callScript([shape.output], verb);
        const data = encodeAbiParameters([{ type: 'bytes' }], ['0x6d4ce63c']);
        const [o] = await expectAgreement(script, [[addr(1)]], {
          [addr(1)]: { kind: 'return', data },
        });
        expect(failureOf(script, verb, o)).toEqual(failureWant(verb, shape.zero));
      });
    }
  }
});

// ---------------------------------------------------------------------------
// script args: EvsInvalidCalldata, never an out-of-gas halt
// ---------------------------------------------------------------------------

const ARG_SHAPES: readonly {
  label: string;
  path: 'stack' | 'heap' | 'leaf';
  type: EvsType;
  value: unknown;
}[] = [
  { label: 'uint256[]', path: 'leaf', type: 'uint256[]', value: [1n, 2n] },
  { label: 'string[]', path: 'stack', type: 'string[]', value: ['a', 'bc'] },
  { label: 'uint256[][]', path: 'stack', type: 'uint256[][]', value: [[1n], []] },
  {
    label: 'tuple(uint256,string)[]',
    path: 'stack',
    type: t.array(t.struct({ id: t.uint256, name: t.string })),
    value: [{ id: 1n, name: 'x' }],
  },
  { label: 'uint256[2][]', path: 'heap', type: 'uint256[2][]', value: [[1n, 2n]] },
  { label: 'string[][]', path: 'heap', type: 'string[][]', value: [['a'], []] },
  { label: 'uint256[][][]', path: 'heap', type: 'uint256[][][]', value: [[[1n]], []] },
  {
    label: 'tuple(uint256,string)[][]',
    path: 'heap',
    type: t.array(t.array(t.struct({ id: t.uint256, name: t.string }))),
    value: [[{ id: 1n, name: 'x' }]],
  },
];

function argScript(type: EvsType) {
  return evscript({ name: 'y', args: [type] as never }, (s, a) => s.return({ a: a as never }));
}

const jsonOf = (v: unknown): string =>
  JSON.stringify(v, (_, x: unknown) => (typeof x === 'bigint' ? x.toString() : x));

/**
 * Raw-calldata run of a compiled script, compared with viem's own decode of the same bytes:
 * `'EvsInvalidCalldata'` (both reject), `'EvsInvalidCalldata (viem accepts)'`, `'accepted'` (both
 * accept and the script returns viem's decode), or a diagnostic for anything else (an
 * out-of-gas halt, another revert, bytecode accepting what viem rejects, a value mismatch).
 */
async function argVerdict(script: AnyScript, runtime: Hex, calldata: Hex): Promise<string> {
  const r = await execRuntime(runtime, calldata);
  if (r.gasUsed >= 25_000_000n) return `halt (gas ${r.gasUsed})`;
  let viemArgs: readonly unknown[] | undefined;
  try {
    viemArgs = decodeFunctionData({ abi: script.abi as Abi, data: calldata }).args;
  } catch {
    viemArgs = undefined;
  }
  if (!r.success) {
    if (r.data !== INVALID_CALLDATA) return `revert ${r.data}`;
    return viemArgs === undefined ? 'EvsInvalidCalldata' : 'EvsInvalidCalldata (viem accepts)';
  }
  if (viemArgs === undefined) return 'accepted (viem rejects)';
  const got = decodeOut(script, { kind: 'return', data: r.data });
  return jsonOf(got) === jsonOf({ a: viemArgs[0] })
    ? 'accepted'
    : `accepted (mismatch ${jsonOf(got)})`;
}

describe('script args with huge in-range lengths revert EvsInvalidCalldata (review finding 3)', () => {
  for (const shape of ARG_SHAPES) {
    for (const evmVersion of EVM_VERSIONS) {
      test(`${shape.label} [${shape.path}] [${evmVersion}]`, async () => {
        const script = argScript(shape.type);
        const { runtimeBytecode } = compile(script, { evmVersion });
        const good = encodeFunctionData({
          abi: script.abi as Abi,
          functionName: 'y',
          args: [shape.value],
        });
        expect(await argVerdict(script, runtimeBytecode, good)).toBe('accepted');
        const selector = good.slice(0, 10) as Hex;
        for (const h of HUGE) {
          for (const tail of [words(0x20n, h), words(0x20n, h, 0x20n, 1n)]) {
            // oxlint-disable-next-line no-await-in-loop -- sequential: deterministic labels
            const verdict = await argVerdict(script, runtimeBytecode, concatHex(selector, tail));
            expect(verdict).toBe('EvsInvalidCalldata');
          }
        }
        // every word of the good calldata set to every huge value: rejected cleanly or decoded
        // exactly like viem (cancun only)
        const argWords = evmVersion === 'cancun' ? (good.slice(10).match(/.{64}/g) ?? []) : [];
        for (let k = 0; k < argWords.length; k++) {
          for (const h of HUGE) {
            const ws = [...argWords];
            ws[k] = word(h).slice(2);
            // oxlint-disable-next-line no-await-in-loop -- see above
            const verdict = await argVerdict(script, runtimeBytecode, `${selector}${ws.join('')}`);
            expect([
              'EvsInvalidCalldata',
              'EvsInvalidCalldata (viem accepts)',
              'accepted',
            ]).toContain(verdict);
          }
        }
      });
    }
  }
});

// ---------------------------------------------------------------------------
// nested dynamic tuples with short heads (review finding 4)
// ---------------------------------------------------------------------------

const ABS = [
  { name: 'a', type: 'uint256' },
  { name: 'b', type: 'uint256' },
  { name: 's', type: 'string' },
] as const;

const SHORT_HEADS: readonly { label: string; output: AbiParameter; data: Hex; zero: unknown }[] = [
  {
    label: 'top-level tuple(a,b,s): [0x20][0]',
    output: { name: 'r', type: 'tuple', components: ABS },
    data: words(0x20n, 0n),
    zero: { a: 0n, b: 0n, s: '' },
  },
  {
    label: 'tuple(a,b,s)[] element: [0x20][1][0x20][0]',
    output: { name: 'r', type: 'tuple[]', components: ABS },
    data: words(0x20n, 1n, 0x20n, 0n),
    zero: [],
  },
  {
    label: 'tuple(x, tuple(a,b,s)) member: [0x20][x][0x40][0]',
    output: {
      name: 'r',
      type: 'tuple',
      components: [
        { name: 'x', type: 'uint256' },
        { name: 'inner', type: 'tuple', components: ABS },
      ],
    },
    data: words(0x20n, 9n, 0x40n, 0n),
    zero: { x: 0n, inner: { a: 0n, b: 0n, s: '' } },
  },
  {
    label: 'tuple(a,b,s)[][] element (heap): [0x20][1][0x20][1][0x20][0]',
    output: { name: 'r', type: 'tuple[][]', components: ABS },
    data: words(0x20n, 1n, 0x20n, 1n, 0x20n, 0n),
    zero: [],
  },
  {
    label: 'tuple(a,b,s)[2] element (heap): [0x20][0x40][0x40][0]',
    output: { name: 'r', type: 'tuple[2]', components: ABS },
    data: words(0x20n, 0x40n, 0x40n, 0n),
    zero: [
      { a: 0n, b: 0n, s: '' },
      { a: 0n, b: 0n, s: '' },
    ],
  },
];

describe('nested dynamic tuples: the whole head must fit (review finding 4)', () => {
  for (const c of SHORT_HEADS) {
    for (const verb of VERBS) {
      for (const evmVersion of EVM_VERSIONS) {
        test(`${c.label} × ${verb} [${evmVersion}]`, async () => {
          // sanity: the payload is malformed for viem too
          expect(() =>
            decodeFunctionResult({
              abi: getterAbi([c.output], verb),
              functionName: 'g',
              data: c.data,
            }),
          ).toThrow(/./);
          const script = callScript([c.output], verb);
          const [o] = await expectAgreement(
            script,
            [[addr(1)]],
            { [addr(1)]: { kind: 'return', data: c.data } },
            evmVersion,
          );
          expect(failureOf(script, verb, o)).toEqual(failureWant(verb, c.zero));
        });
      }
    }
  }

  const Abs = t.struct({ a: t.uint256, b: t.uint256, s: t.string });
  const ARGS: readonly { label: string; type: EvsType; args: Hex }[] = [
    { label: 'tuple(a,b,s) arg: [0x20][0]', type: Abs, args: words(0x20n, 0n) },
    {
      label: 'tuple(x, tuple(a,b,s)) arg: [0x20][x][0x40][0]',
      type: t.struct({ x: t.uint256, inner: Abs }),
      args: words(0x20n, 9n, 0x40n, 0n),
    },
    {
      label: 'tuple(a,b,s)[] arg: [0x20][1][0x20][0]',
      type: t.array(Abs),
      args: words(0x20n, 1n, 0x20n, 0n),
    },
    {
      label: 'tuple(a,b,s)[][] arg: [0x20][1][0x20][1][0x20][0]',
      type: t.array(t.array(Abs)),
      args: words(0x20n, 1n, 0x20n, 1n, 0x20n, 0n),
    },
  ];
  for (const c of ARGS) {
    for (const evmVersion of EVM_VERSIONS) {
      test(`${c.label} → EvsInvalidCalldata [${evmVersion}]`, async () => {
        const script = argScript(c.type);
        const { runtimeBytecode } = compile(script, { evmVersion });
        const selector = toFunctionSelector(
          (script.abi as Abi).find((x) => x.type === 'function') as never,
        );
        expect(await argVerdict(script, runtimeBytecode, concatHex(selector, c.args))).toBe(
          'EvsInvalidCalldata',
        );
      });
    }
  }
});

// ---------------------------------------------------------------------------
// deep struct / array nesting (review finding 5)
// ---------------------------------------------------------------------------

type Chain = { readonly type: EvsType; readonly value: unknown };

/** `S0 = {a: string, b: uint256[][]}`, `S(k+1) = {x: uint8, inner: wrap(Sk)}`. */
function chain(n: number, wrap: (s: EvsType) => EvsType, wrapV: (v: unknown) => unknown): Chain {
  let type = t.struct({ a: t.string, b: 'uint256[][]' }) as EvsType;
  let value: unknown = { a: 'leaf', b: [[1n], [], [2n, 3n]] };
  for (let i = 0; i < n; i++) {
    type = t.struct({ x: t.uint8, inner: wrap(type) as never }) as EvsType;
    value = { x: i + 1, inner: wrapV(value) };
  }
  return { type, value };
}

/** `S0 = {a: string}`, `S(k+1) = {x: uint8, inner: Sk}` — pure dynamic-struct nesting. */
function structs(n: number): Chain {
  let type = t.struct({ a: t.string }) as EvsType;
  let value: unknown = { a: 'deepest' };
  for (let i = 0; i < n; i++) {
    type = t.struct({ x: t.uint8, inner: type as never }) as EvsType;
    value = { x: i + 1, inner: value };
  }
  return { type, value };
}

const FAMILIES: readonly {
  label: string;
  make: (n: number) => Chain;
  /** Deepest `n` that compiles: as a script arg, and as a read / simulate output. */
  maxArg: number;
  maxRead: number;
  maxSimulate: number;
}[] = [
  { label: 'struct^n{string}', make: structs, maxArg: 11, maxRead: 10, maxSimulate: 9 },
  {
    label: '{u8, S[]}^n',
    make: (n) =>
      chain(
        n,
        (s) => t.array(s as never),
        (v) => [v, v],
      ),
    maxArg: 5,
    maxRead: 4,
    maxSimulate: 4,
  },
  {
    label: '{u8, S[][]}^n',
    make: (n) =>
      chain(
        n,
        (s) => t.array(t.array(s as never)),
        (v) => [[v], []],
      ),
    maxArg: 3,
    maxRead: 3,
    maxSimulate: 2,
  },
  {
    label: '{u8, S[2][]}^n',
    make: (n) =>
      chain(
        n,
        (s) => t.array(t.array(s as never, 2)),
        (v) => [[v, v]],
      ),
    maxArg: 3,
    maxRead: 3,
    maxSimulate: 2,
  },
  {
    label: '{u8, S[2]}^n',
    make: (n) =>
      chain(
        n,
        (s) => t.array(s as never, 2),
        (v) => [v, v],
      ),
    maxArg: 5,
    maxRead: 4,
    maxSimulate: 4,
  },
];

/** `<class>:<code>:<message matches>` of what `build` throws (`'no throw'` when it does not). */
function unsupportedOf(build: () => unknown): string {
  try {
    build();
  } catch (e) {
    const err = e instanceof EvsError ? e : null;
    return `${err?.name}:${err?.code}:${/nests structs and arrays too deeply/.test(String(err?.message))}`;
  }
  return 'no throw';
}
const UNSUPPORTED = 'EvsCompileError:UNSUPPORTED_V0:true';

describe('deep struct / array nesting (review finding 5)', () => {
  for (const f of FAMILIES) {
    const arg = f.make(f.maxArg);
    const out = (n: number): AbiParameter => typeToAbiParam('r', f.make(n).type) as AbiParameter;
    for (const evmVersion of EVM_VERSIONS) {
      test(`${f.label}: deepest script arg (n=${f.maxArg}) round-trips [${evmVersion}]`, async () => {
        const script = argScript(arg.type);
        const [o] = await expectAgreement(script, [[arg.value]], {}, evmVersion);
        expect(decodeOut(script, o)).toEqual({ a: arg.value });
      });

      for (const verb of VERBS) {
        const n = verb === 'read' || verb === 'tryRead' ? f.maxRead : f.maxSimulate;
        test(`${f.label}: deepest ${verb} output (n=${n}): good + truncations [${evmVersion}]`, async () => {
          const script = callScript([out(n)], verb);
          const value = f.make(n).value;
          const good = encodeLoose([out(n)], [value]);
          const nWords = (good.length - 2) / 64;
          const table: Record<string, CalleeTable[string]> = {
            [addr(1)]: { kind: 'return', data: good },
          };
          const targets: Hex[] = [addr(1)];
          // word-granular truncations (strict: EvsDecodeError, try: ok=false) — cancun only, at
          // most ~24 evenly spaced cut points (the doubled `S[2]` payloads are long)
          if (evmVersion === 'cancun') {
            const step = Math.max(1, Math.floor(nWords / 24));
            for (let k = 1; k < nWords; k += step) {
              const a = addr(0x100 + k);
              table[a] = { kind: 'return', data: `0x${good.slice(2, 2 + 64 * k)}` };
              targets.push(a);
            }
          }
          const outcomes = await expectAgreement(
            script,
            targets.map((a) => [a]),
            table,
            evmVersion,
          );
          expect(decodeOut(script, outcomes[0])).toEqual(
            isTry(verb) ? { ok: true, v: value } : { v: value },
          );
        }, 60_000);
      }
    }

    test(`${f.label}: one level deeper is UNSUPPORTED_V0, never INTERNAL`, () => {
      expect(unsupportedOf(() => compile(argScript(f.make(f.maxArg + 1).type)))).toBe(UNSUPPORTED);
      for (const verb of VERBS) {
        const n = (verb === 'read' || verb === 'tryRead' ? f.maxRead : f.maxSimulate) + 1;
        expect(unsupportedOf(() => compile(callScript([out(n)], verb)))).toBe(UNSUPPORTED);
      }
    });
  }

  test('s.tuple / s.newArray zero values of too-deep types are UNSUPPORTED_V0, never INTERNAL', () => {
    const deep = structs(13).type;
    expect(
      unsupportedOf(() =>
        compile(evscript({ name: 'z' }, (s) => s.return({ v: s.tuple(deep as never) }))),
      ),
    ).toBe(UNSUPPORTED);
    expect(
      unsupportedOf(() =>
        compile(
          evscript({ name: 'z' }, (s) =>
            s.return({ v: s.newArray(structs(10).type as never, 2n) }),
          ),
        ),
      ),
    ).toBe(UNSUPPORTED);
  });
});

// ---------------------------------------------------------------------------
// aliased tails (review finding 17)
// ---------------------------------------------------------------------------

describe('aliased tails: normalizing a narrow word array never rewrites shared bytes (review finding 17)', () => {
  const AB = [
    { name: 'a', type: 'uint8[]' },
    { name: 'b', type: 'uint256[]' },
  ] as const;
  // both offsets point at the same [len=1][0x1ff] tail
  const flat = words(0x40n, 0x40n, 1n, 0x1ffn);
  const tupled = words(0x20n, 0x40n, 0x40n, 1n, 0x1ffn);
  // (string s, uint8[] a) sharing [len=1][0x41…01ff]: masking a's element in place would zero
  // s's only byte ('A')
  const SA = [
    { name: 's', type: 'string' },
    { name: 'a', type: 'uint8[]' },
  ] as const;
  const shared = concatHex(words(0x40n, 0x40n, 1n), `0x41${'00'.repeat(29)}01ff`);

  const CASES: readonly {
    label: string;
    outputs: readonly AbiParameter[];
    data: Hex;
    v: Readonly<Record<string, unknown>>;
  }[] = [
    { label: '(uint8[] a, uint256[] b)', outputs: AB, data: flat, v: { v0: [255], v1: [511n] } },
    {
      label: 'tuple(uint8[] a, uint256[] b)',
      outputs: [{ name: 'r', type: 'tuple', components: AB }],
      data: tupled,
      v: { v: { a: [255], b: [511n] } },
    },
    { label: '(string s, uint8[] a)', outputs: SA, data: shared, v: { v0: 'A', v1: [255] } },
  ];

  for (const c of CASES) {
    for (const verb of VERBS) {
      for (const evmVersion of EVM_VERSIONS) {
        test(`${c.label} × ${verb} [${evmVersion}]`, async () => {
          const script = callScript(c.outputs, verb);
          const [o] = await expectAgreement(
            script,
            [[addr(1)]],
            { [addr(1)]: { kind: 'return', data: c.data } },
            evmVersion,
          );
          expect(decodeOut(script, o)).toEqual(isTry(verb) ? { ok: true, ...c.v } : c.v);
        });
      }
    }
  }

  for (const evmVersion of EVM_VERSIONS) {
    test(`script args: tuple(uint8[] a, uint256[] b) and (uint8[] a, uint256[] b) with shared tails [${evmVersion}]`, async () => {
      const tupleScript = argScript(t.struct({ a: 'uint8[]', b: 'uint256[]' }));
      const tupleRun = await execRuntime(
        compile(tupleScript, { evmVersion }).runtimeBytecode,
        concatHex(toFunctionSelector('y((uint8[],uint256[]))'), tupled),
      );
      expect(tupleRun.success).toBe(true);
      expect(decodeOut(tupleScript, { kind: 'return', data: tupleRun.data })).toEqual({
        a: { a: [255], b: [511n] },
      });

      const flatScript = evscript({ name: 'y', args: ['uint8[]', 'uint256[]'] }, (s, a, b) =>
        s.return({ a, b }),
      );
      const flatRun = await execRuntime(
        compile(flatScript, { evmVersion }).runtimeBytecode,
        concatHex(toFunctionSelector('y(uint8[],uint256[])'), flat),
      );
      expect(flatRun.success).toBe(true);
      expect(decodeOut(flatScript, { kind: 'return', data: flatRun.data })).toEqual({
        a: [255],
        b: [511n],
      });
    });
  }
});
