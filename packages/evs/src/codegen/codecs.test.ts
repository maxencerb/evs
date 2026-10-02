/**
 * Shared codec subroutines (issue #95, `codegen/codecs.ts`): keys, the census and the cost
 * model, the byte identity of programs that share nothing, the drift guard, the registers, and
 * the structure of the emitted bodies. Execution against the interpreter lives in
 * `src/differential/shared-codecs.test.ts`.
 */

/* oxlint-disable typescript/no-unsafe-type-assertion -- a loose corpus: script types and values are
   built from tables at run time */

import { encodeFunctionData, parseAbi } from 'viem';
import { describe, expect, test, vi } from 'vite-plus/test';

import { plannerAgainstReference } from '../../test/harness/codec-plan.js';
import type { AnyScript } from '../../test/harness/differential.js';
import { execRuntime } from '../../test/harness/evm.js';
import { layoutOfType } from '../abi/layout.js';
import { assemble, AsmWriter, type AsmNode } from '../asm/assembler.js';
import type { EvmVersion } from '../asm/ops.js';
import { stackHeights } from '../asm/verify.js';
import { evscript } from '../builder/script.js';
import { compile, type CompiledEvsScript } from '../compile.js';
import { bytesToHex } from '../core/bytes.js';
import { EvsCompileError, EvsInternalError } from '../core/errors.js';
import { namedArg, t, typeToAbiParam, type EvsType } from '../core/types.js';
import { eliminateDeadCode } from '../ir/dce.js';
import type { ScriptIr } from '../ir/nodes.js';
import { effectiveDecodeBudget } from './abi.js';
import { emitDecodeReturnOutput } from './call/static-call.js';
import { decRetKey, encKey, encodeMemberKind, layoutKey, RETURNS_SITE } from './codec-keys.js';
import { planCodecs, setCodecPlanStrict, setCodecPlanTransform, type CodecPlan } from './codecs.js';
import { layoutFrames } from './frame.js';
import { walkEmittedStmts } from './lower.js';
import { evsPeephole } from './peephole.js';
import { lowerProgram } from './program.js';
import { createSharedTails } from './tails.js';

/** The unspied `AsmWriter.prototype.rollback` (the rollback regression test wraps it). */
// oxlint-disable-next-line typescript/unbound-method -- re-applied to its writer with Reflect.apply
const rollbackImpl = AsmWriter.prototype.rollback;

const abi = parseAbi([
  'struct W8 { uint64 f0; address f1; int32 f2; uint64 f3; address f4; int32 f5; uint64 f6; address f7; string label; }',
  'struct S3 { uint64 a; address b; int32 c; }',
  'struct S2 { uint64 a; address b; }',
  'function get(W8 x) view returns (W8)',
  'function getMany(W8[] x) view returns (W8[])',
  'function getS3(S3 x) view returns (S3)',
  'function getS2(S2 x) view returns (S2)',
  'function word(uint256 i) view returns (uint256)',
  'struct N0 { uint64 leaf; string name; }',
  'struct N1 { uint128 a; string s; uint8[] xs; N0 inner; }',
  'struct N2 { uint128 a; string s; uint8[] xs; N1 inner; }',
  'struct N3 { uint128 a; string s; uint8[] xs; N2 inner; }',
  'struct P { uint64 a; string s; }',
  'function getNested(N3 x) view returns (N3)',
  'function getU(uint64[3] x) view returns (uint64[3])',
  'function getPairs(P[2] x) view returns (P[2])',
  'function sink(W8 x) view returns (uint256)',
  'function sinkMany(W8[] x) view returns (uint256)',
  'function sinkNested(N3 x) view returns (uint256)',
  'function make(uint256 i) view returns (W8)',
  'function w8() view returns (W8)',
  'struct RbE { uint8 c; uint16[][] d; }',
  'struct Rb { uint8 a; RbE[] b; }',
  'struct Rb1 { uint8 a; Rb inner; }',
  'struct Rb2 { uint8 a; Rb1 inner; }',
  'struct Rb3 { uint8 a; Rb2 inner; }',
  'struct Rb4 { uint8 a; Rb3 inner; }',
  'function rb() view returns (Rb)',
  'function rb4() view returns (Rb4)',
  'function w8s() view returns (W8[])',
  'function n3() view returns (N3)',
  'function makeMany(uint256 i) view returns (W8[])',
  'function makeNested(uint256 i) view returns (N3)',
  'function pair() view returns (uint256, W8)',
  'function trio() view returns (W8, string[], string[])',
  'function trio2() view returns ((uint64 a, string[] b), string[], string[])',
  'function solo2() view returns ((uint64 a, string[] b))',
  'function mut(W8 x) returns (W8)',
]);

const W8 = t.struct({
  f0: t.uint64,
  f1: t.address,
  f2: t.int32,
  f3: t.uint64,
  f4: t.address,
  f5: t.int32,
  f6: t.uint64,
  f7: t.address,
  label: t.string,
});
const S3 = t.struct({ a: t.uint64, b: t.address, c: t.int32 });
const nestedType = (d: number): EvsType =>
  d === 0
    ? t.struct({ leaf: t.uint64, name: t.string })
    : t.struct({
        a: t.uint128,
        s: t.string,
        xs: t.array(t.uint8),
        inner: nestedType(d - 1) as never,
      });
const N3 = nestedType(3);
const P2 = t.array(t.struct({ a: t.uint64, s: t.string }), 2);
const S2 = t.struct({ a: t.uint64, b: t.address });

const keyOf = (ty: EvsType): string => {
  const l = layoutOfType(ty);
  const kind = encodeMemberKind(l);
  if (kind === null) throw new Error('not a composite member');
  return encKey(kind, l);
};

/** `n` chained `fn(T) returns (T)` reads of the script arg, the last one returned. */
const chain = (name: string, ty: any, fn: string, n: number) =>
  evscript({ name, args: [t.address, ty] }, (s: any, a: any, x: any) => {
    let last = x;
    for (let i = 0; i < n; i++) last = s.read({ address: a, abi, functionName: fn, args: [last] });
    return s.return({ last });
  });

const irOf = (script: { ir: ScriptIr }): ScriptIr => eliminateDeadCode(script.ir);

/** `compile`, typed for the loose scripts of this file. */
const build = (
  script: AnyScript,
  opts: { evmVersion?: EvmVersion; optimize?: boolean } = {},
): CompiledEvsScript => compile(script, opts);

const planOf = (script: { ir: ScriptIr }, evmVersion: EvmVersion = 'cancun'): CodecPlan => {
  const ir = irOf(script);
  return planCodecs(ir, {
    evmVersion,
    optimize: false,
    frameEnd: layoutFrames(ir, { optimize: false }).frameEnd,
  });
};

/** Runtime bytes of `script` (default) and of its inline twin (sharing off). */
function sizes(
  script: AnyScript,
  evmVersion: EvmVersion,
  optimize: boolean,
): { shared: number; inline: number } {
  const lowered = lowerProgram(irOf(script), { evmVersion, optimize, shareCodecs: false });
  const inline = assemble(lowered.nodes, {
    evmVersion,
    ...(optimize ? { peephole: evsPeephole } : {}),
  }).bytecode.length;
  const compiled: CompiledEvsScript = compile(script, { evmVersion, optimize });
  const shared = (compiled.runtimeBytecode.length - 2) / 2;
  return { shared, inline };
}

describe('codec keys', () => {
  test('encoder keys erase word types and names; decoder keys keep the types', () => {
    const a = t.struct({ x: t.uint64, y: t.address });
    const b = t.struct({ p: t.uint256, q: t.int32 });
    expect(keyOf(a)).toBe(keyOf(b));
    expect(keyOf(a)).toBe('enc|ST|(w,w)');
    expect(decRetKey(layoutOfType(a), 0, 'off')).not.toBe(decRetKey(layoutOfType(b), 0, 'off'));
    expect(layoutKey(layoutOfType(W8), false)).toBe(
      '(uint64,address,int32,uint64,address,int32,uint64,address,string)',
    );
    // static vs dynamic tuple, T[N] vs T[], string vs bytes (encoders erase it too)
    expect(keyOf(t.struct({ s: t.string }))).toBe('enc|DT|(b)');
    expect(keyOf(t.struct({ s: t.bytes }))).toBe('enc|DT|(b)');
    expect(keyOf('uint64[3]')).toBe('enc|SA|w[3]');
    expect(keyOf('string[2]')).toBe('enc|RA|b[2]');
    expect(keyOf(t.array(S3))).toBe('enc|RA|(w,w,w)[]');
    expect(keyOf(t.array(S3, 2))).toBe('enc|SA|(w,w,w)[2]');
    expect(decRetKey(layoutOfType(W8), 32, 'once')).toBe(
      'dec|ret|(uint64,address,int32,uint64,address,int32,uint64,address,string)|32|once',
    );
  });

  test('encodeMemberKind leaves words and leaf dynamic values inline', () => {
    for (const leaf of ['uint256', 'string', 'bytes', 'uint256[]', 'address[]'] as const) {
      expect(encodeMemberKind(layoutOfType(leaf)), `${leaf} stays inline`).toBeNull();
    }
    expect(encodeMemberKind(layoutOfType(W8))).toBe('DT');
    expect(encodeMemberKind(layoutOfType(S3))).toBe('ST');
    expect(encodeMemberKind(layoutOfType('uint256[2][]'))).toBe('RA');
    expect(encodeMemberKind(layoutOfType('uint256[2][3]'))).toBe('SA');
  });
});

describe('census and cost model', () => {
  const W8_KEY = keyOf(W8);

  test('the return record and a call arg are two uses of one key', () => {
    const plan = planOf(chain('one', W8, 'get', 1));
    const key = plan.keys.get(W8_KEY);
    expect(key?.groups.get(RETURNS_SITE)).toBe(1);
    expect([...(key?.groups.values() ?? [])].reduce((a, b) => a + b, 0)).toBe(2);
    expect(plan.words).toBe(3); // a dynamic tuple encoder: RET, BASE, SRC
  });

  test('s.encode, s.keccak256, memref .eq() and s.throw payloads are uses', () => {
    const Bad = t.error('Bad', [namedArg('w', W8)]);
    const script = evscript(
      { name: 'uses', args: [W8, W8, t.uint256], errors: [Bad] },
      (s: any, x: any, y: any, k: any) => {
        const enc = s.encode(x);
        const h = s.keccak256(y);
        const same = x.expr().eq(y.expr());
        s.if(k.gt(3n), () => s.throw(Bad, { w: x }));
        return s.return({ enc, h, same });
      },
    );
    const groups = planOf(script).keys.get(W8_KEY)?.groups;
    // encode (1) + keccak (1) + eq (one encode per side: two statements) + throw (1)
    expect([...(groups?.values() ?? [])].reduce((a, b) => a + b, 0)).toBe(5);
    expect(groups?.has(RETURNS_SITE)).toBe(false);
  });

  test('a fn called twice counts its uses once; an uncalled fn counts none', () => {
    const script = evscript({ name: 'fns', args: [t.address, W8] }, (s: any, a: any, x: any) => {
      const read = (at: any, v: any) =>
        s.read({ address: at, abi, functionName: 'get', args: [v] });
      const echo = s.fn('echo', [t.address, W8], read);
      s.fn('unused', [t.address, W8], read);
      const once = echo(a, x);
      const twice = echo(a, once);
      return s.return({ twice });
    });
    const groups = planOf(script).keys.get(W8_KEY)?.groups;
    expect([...(groups?.values() ?? [])].reduce((a, b) => a + b, 0)).toBe(2); // the fn's read + return
  });

  test('a lone use never shares, and its program is node-identical to the inline lowering', () => {
    const lone = evscript({ name: 'lone', args: [W8] }, (s: any, x: any) =>
      s.return({ enc: s.encode(x) }),
    );
    const word = evscript(
      { name: 'word', args: [t.address, t.uint256] },
      (s: any, a: any, i: any) =>
        s.return({ v: s.read({ address: a, abi, functionName: 'word', args: [i] }) }),
    );
    for (const script of [lone, word]) {
      expect(planOf(script).keys.size).toBe(0);
      for (const evmVersion of ['paris', 'cancun'] as const) {
        for (const optimize of [false, true]) {
          const shared = lowerProgram(irOf(script), { evmVersion, optimize });
          const twin = lowerProgram(irOf(script), { evmVersion, optimize, shareCodecs: false });
          expect(shared.nodes).toEqual(twin.nodes);
          expect(shared.frameEnd).toBe(twin.frameEnd);
        }
      }
    }
  });

  test('a small static struct at two uses stays inline; the wide struct shares', () => {
    expect(planOf(chain('s3', S3, 'getS3', 1)).keys.size).toBe(0);
    expect(planOf(chain('w8', W8, 'get', 1)).keys.has(W8_KEY)).toBe(true);
  });

  test('the per-use floor keeps a tiny static struct encoder inline at many uses', () => {
    const script = chain('s2x8', S2, 'getS2', 7); // 7 call args + the return record
    expect(planOf(script).keys.has(keyOf(S2))).toBe(false);
  });

  test('across the PUSH1 / PUSH2 frame-end boundary a shared program is never larger', () => {
    // the prologue pushes `frameEnd + 32·words`: padding the frame walks it over 0x100
    let crossed = 0;
    for (let pad = 0; pad <= 6; pad++) {
      const script = evscript(
        { name: 'pad', args: [W8, ...Array.from({ length: pad }, () => t.uint256)] },
        (s: any, x: any) => s.return({ a: x, b: x }),
      );
      for (const optimize of [false, true]) {
        const lowered = lowerProgram(irOf(script), { evmVersion: 'cancun', optimize });
        const inlineEnd = lowerProgram(irOf(script), {
          evmVersion: 'cancun',
          optimize,
          shareCodecs: false,
        }).frameEnd;
        if (inlineEnd < 0x100 && lowered.frameEnd >= 0x100) crossed += 1;
        const { shared, inline } = sizes(script, 'cancun', optimize);
        expect(shared, `pad ${pad}, optimize ${optimize}`).toBeLessThanOrEqual(inline);
      }
    }
    expect(crossed).toBeGreaterThan(0); // some case pays the wider push
  });

  test('a costly key shares only outside loops; a cheap one shares inside them too', () => {
    const loopy = (name: string, ty: any, fn: string, cold: number) =>
      evscript({ name, args: [t.address, ty] }, (s: any, a: any, x: any) => {
        const acc = s.let(ty, x);
        s.for({ type: t.uint256, from: 0n, until: 3n }, () => {
          acc.set(s.read({ address: a, abi, functionName: fn, args: [acc.get()] }));
        });
        let last = acc.get();
        for (let i = 0; i < cold; i++) {
          last = s.read({ address: a, abi, functionName: fn, args: [last] });
        }
        return s.return({ last });
      });
    const W8s = t.array(W8);
    const manyKey = keyOf(W8s);
    // W8[] (RA, costly): the loop use is excluded; the return record alone does not share
    expect(planOf(loopy('arr0', W8s, 'getMany', 0)).keys.has(manyKey)).toBe(false);
    // with two cold uses the cold ones share and the loop use keeps its inline code
    const plan = planOf(loopy('arr1', W8s, 'getMany', 1));
    expect(plan.keys.get(manyKey)?.groups.size).toBe(2);
    // W8 (DT, cheap): the loop use shares too
    const cheap = planOf(loopy('w80', W8, 'get', 0)).keys.get(W8_KEY)?.groups;
    expect(cheap?.size).toBe(2);
  });
});

describe('emitted bodies', () => {
  test('one body per key, one return label per call, and every return lands at height 0', () => {
    for (const evmVersion of ['paris', 'shanghai', 'cancun'] as const) {
      for (const optimize of [false, true]) {
        const compiled = build(chain('three', W8, 'get', 3), { evmVersion, optimize });
        const names = compiled.sourceMap.labels.map((l) => l.name);
        expect(names.filter((n) => n === 'enc_0')).toHaveLength(1);
        expect(names.filter((n) => n.startsWith('enc_0_ret_'))).toHaveLength(4);
        const lowered = lowerProgram(irOf(chain('three', W8, 'get', 3)), { evmVersion, optimize });
        const nodes: readonly AsmNode[] = optimize ? evsPeephole(lowered.nodes) : lowered.nodes;
        const heights = stackHeights(nodes);
        const returns = nodes.flatMap((n, i) =>
          n.k === 'op' && n.op === 'JUMP' && n.note === 'enc_0: return' ? [heights[i]] : [],
        );
        // [ret] above the empty statement baseline: the return label is checked at 0
        expect(returns).toEqual([1]);
      }
    }
  });

  test('the codec registers sit right after the static frame', () => {
    const script = chain('regs', W8, 'get', 2);
    for (const optimize of [false, true]) {
      const ir = irOf(script);
      const frameEnd = layoutFrames(ir, { optimize }).frameEnd;
      expect(lowerProgram(ir, { evmVersion: 'cancun', optimize }).frameEnd).toBe(frameEnd + 96);
      expect(
        lowerProgram(ir, { evmVersion: 'cancun', optimize, shareCodecs: false }).frameEnd,
      ).toBe(frameEnd);
    }
    // an array encoder needs the return-address register only
    const arr = evscript({ name: 'regsArr', args: [t.array(W8)] }, (s: any, xs: any) =>
      s.return({ a: s.encode(xs), b: s.encode(xs) }),
    );
    const ir = irOf(arr);
    expect(lowerProgram(ir, { evmVersion: 'cancun' }).frameEnd).toBe(
      layoutFrames(ir, { optimize: false }).frameEnd + 32,
    );
  });

  test('a body shared by differently named structs carries neither struct’s names', () => {
    const Order = t.struct({
      maker: t.uint64,
      taker: t.address,
      size: t.int32,
      fee: t.uint64,
      owner: t.address,
      tick: t.int32,
      nonce: t.uint64,
      to: t.address,
      memo: t.string,
    });
    const script = evscript({ name: 'names', args: [W8, Order] }, (s: any, x: any, y: any) =>
      s.return({ ex: s.encode(x), ey: s.encode(y) }),
    );
    const compiled = build(script);
    const { labels, segments } = compiled.sourceMap;
    const start = labels.find((l) => l.name === 'enc_0')?.pc ?? -1;
    expect(start).toBeGreaterThan(0);
    const end = Math.min(
      ...labels.filter((l) => l.pc > start && !/^(arrenc|enc_0)/.test(l.name)).map((l) => l.pc),
      Number.POSITIVE_INFINITY,
    );
    const inBody = segments.filter((seg) => seg.pc >= start && seg.pc < end);
    expect(inBody.length).toBeGreaterThan(0);
    for (const seg of inBody) {
      expect(seg.note ?? '', 'body note').not.toMatch(/f0|label|maker|memo/);
    }
    // each call names its own value: the call arg, then the return record's member
    const calls = build(chain('notes', W8, 'get', 1)).sourceMap.segments.filter(
      (seg) => seg.note?.includes('(shared enc_0)') === true,
    );
    expect(calls.map((seg) => seg.note)).toEqual([
      'encode x (shared enc_0)',
      'encode last (shared enc_0)',
    ]);
  });
});

describe('plan drift', () => {
  // a plan that claims one more call at the return encode than the lowering makes
  const skew = (plan: CodecPlan): CodecPlan => ({
    ...plan,
    keys: new Map(
      [...plan.keys].map(([key, k]) => [
        key,
        { ...k, groups: new Map([...k.groups].map(([site, n]) => [site, n + 1])) },
      ]),
    ),
  });
  const script = chain('drift', W8, 'get', 2);

  test('strict (the test setup): a drift is an INTERNAL error', () => {
    setCodecPlanTransform(skew);
    try {
      expect(() => build(script)).toThrow(EvsInternalError);
      expect(() => build(script)).toThrow(/plan drift/);
    } finally {
      setCodecPlanTransform(null);
    }
  });

  test('production: build() falls back to the inline lowering', () => {
    setCodecPlanTransform(skew);
    setCodecPlanStrict(false);
    let fallback: string;
    try {
      fallback = build(script).runtimeBytecode;
    } finally {
      setCodecPlanStrict(true);
      setCodecPlanTransform(null);
    }
    const lowered = lowerProgram(irOf(script), { evmVersion: 'cancun', shareCodecs: false });
    const twin = assemble(lowered.nodes, { evmVersion: 'cancun' }).bytecode;
    expect((fallback.length - 2) / 2).toBe(twin.length);
    expect(build(script).runtimeBytecode.length).toBeLessThan(fallback.length);
  });

  test('a body using more register words than the plan reserves is an INTERNAL error', () => {
    // the W8 encoder spills RET, BASE and SRC: one reserved word would let it clobber the heap
    expect(planOf(script).words).toBe(3);
    setCodecPlanTransform((plan) => ({ ...plan, words: 1 }));
    setCodecPlanStrict(false); // not a drift: no fallback either way
    try {
      expect(() => build(script)).toThrow(EvsInternalError);
      expect(() => build(script)).toThrow(/uses 3 register word\(s\), the plan reserves 1/);
    } finally {
      setCodecPlanStrict(true);
      setCodecPlanTransform(null);
    }
  });
});

describe('shared decoders', () => {
  /** `fns.length` reads `fns[i]()` of the target, the values returned. */
  const reads = (name: string, fns: readonly string[], verb = 'read') =>
    evscript({ name, args: [t.address] }, (s: any, a: any) => {
      const out: Record<string, unknown> = {};
      fns.forEach((fn, i) => {
        const r = s[verb]({ address: a, abi, functionName: fn });
        const v = verb.startsWith('try') ? r.value : r;
        // a multi-output read is a host array of handles: each one returned on its own
        if (Array.isArray(v)) v.forEach((x, j) => (out[`v${i}_${j}`] = x));
        else out[`v${i}`] = v;
      });
      return s.return(out);
    });
  const decKeys = (plan: CodecPlan): string[] =>
    [...plan.keys.keys()].filter((k) => k.startsWith('dec|'));

  test('a decoder key carries the head offset and the effective decode budget', () => {
    // `pair()` puts W8 at head offset 32: a different body from `make()`'s W8 at 0
    const offsets = decKeys(planOf(reads('offsets', ['pair', 'w8', 'pair', 'w8'])));
    expect(offsets).toHaveLength(2);
    expect(offsets.map((k) => k.split('|')[3])).toEqual(['32', '0']);
    // W8 cannot charge the budget: under `trio()`'s budgeted decode and `w8()`'s unbudgeted
    // one it is the same code, so one key
    expect(decKeys(planOf(reads('budgets', ['trio', 'w8', 'trio', 'w8'])))).toContain(
      decRetKey(layoutOfType(W8), 0, 'off'),
    );
    // a struct holding a string[] charges: budgeted and unbudgeted are two bodies
    const charged = decKeys(planOf(reads('charged', ['trio2', 'solo2', 'trio2', 'solo2'])));
    expect(charged.filter((k) => k.startsWith('dec|ret|(uint64,string[])'))).toEqual([
      'dec|ret|(uint64,string[])|0|once',
      'dec|ret|(uint64,string[])|0|off',
    ]);
  });

  test('a type that cannot charge decodes to the same nodes budgeted or not', () => {
    const strings = t.struct({ a: t.string, b: t.bytes, n: t.uint256 });
    for (const ty of [W8, S3, strings, 'string[2]', 'uint64[3]'] as const) {
      const l = layoutOfType(ty);
      expect(effectiveDecodeBudget(l, 'once'), `${layoutKey(l, false)} cannot charge`).toBe('off');
      const nodes = (budget: 'off' | 'once'): readonly AsmNode[] => {
        const w = new AsmWriter();
        createSharedTails(w, { evmVersion: 'cancun' });
        const fail = (): void => {
          w.push(0);
          w.op('POP');
          w.op('POP');
        };
        emitDecodeReturnOutput(w, ty, 0, fail, { budget, evmVersion: 'cancun' }, () => 'x');
        return w.nodes();
      };
      expect(nodes('once')).toEqual(nodes('off'));
    }
  });

  test('a decode too deep for the stack stays inline and reports its own site', () => {
    const structs = (n: number): EvsType => {
      let ty: EvsType = t.struct({ a: t.string });
      for (let i = 0; i < n; i++) ty = t.struct({ x: t.uint8, inner: ty as never });
      return ty;
    };
    const deepAbi = (n: number, mutability: 'view' | 'nonpayable') => [
      {
        type: 'function',
        name: 'g',
        stateMutability: mutability,
        inputs: [],
        outputs: [typeToAbiParam('r', structs(n))],
      },
    ];
    // one level deeper than what fits (decode-bounds: struct^10 reads, struct^9 simulates)
    for (const [verb, n] of [
      ['read', 11],
      ['simulate', 10],
    ] as const) {
      const script = evscript({ name: 'deep', args: [t.address] }, (s: any, a: any) => {
        const fnAbi = deepAbi(n, verb === 'read' ? 'view' : 'nonpayable');
        const p = s[verb]({ address: a, abi: fnAbi, functionName: 'g' });
        const q = s[verb]({ address: a, abi: fnAbi, functionName: 'g' });
        return s.return({ p: p.x.get(), q: q.x.get() });
      });
      const error = (() => {
        try {
          build(script);
        } catch (e) {
          return e;
        }
        return null;
      })();
      expect(error).toBeInstanceOf(EvsCompileError);
      expect((error as EvsCompileError).code).toBe('UNSUPPORTED_V0');
      expect((error as EvsCompileError).message).toMatch(/\(site \d+\) nests structs and arrays/);
      // and the deepest that fits does share at two sites
      const fits = evscript({ name: 'fits', args: [t.address] }, (s: any, a: any) => {
        const fnAbi = deepAbi(n - 1, verb === 'read' ? 'view' : 'nonpayable');
        const p = s[verb]({ address: a, abi: fnAbi, functionName: 'g' });
        const q = s[verb]({ address: a, abi: fnAbi, functionName: 'g' });
        return s.return({ p: p.x.get(), q: q.x.get() });
      });
      expect(decKeys(planOf(fits))).toHaveLength(1);
    }
  });

  test('regression: a body whose array decode rolls back its fast path assembles', () => {
    // pre-allocated funnel rungs: a rung allocated inside the rolled-back stack-path fragment
    // would be handed out again to the heap path's own labels ("label #n is defined twice")
    const Rb = t.struct({
      a: t.uint8,
      b: t.array(t.struct({ c: t.uint8, d: t.array(t.array(t.uint16)) })),
    });
    const rbAbi = [
      {
        type: 'function',
        name: 'g',
        stateMutability: 'view',
        inputs: [],
        outputs: [typeToAbiParam('', Rb)],
      },
    ];
    const deeper = t.struct({ a: t.uint8, inner: Rb });
    const deeperAbi = [
      {
        type: 'function',
        name: 'g',
        stateMutability: 'view',
        inputs: [],
        outputs: [typeToAbiParam('', deeper)],
      },
    ];
    const rolledBack = vi.spyOn(AsmWriter.prototype, 'rollback');
    const traceLimit = Error.stackTraceLimit;
    Error.stackTraceLimit = 200; // the body is deep below the rollback
    let inBody = 0;
    rolledBack.mockImplementation(function (this: AsmWriter, cp) {
      if (/emitDecoderBody/.test(new Error('probe').stack ?? '')) inBody += 1;
      // the real rollback (the spy replaced it on the prototype)
      return Reflect.apply(rollbackImpl, this, [cp]);
    });
    try {
      for (const fnAbi of [rbAbi, deeperAbi]) {
        for (const evmVersion of ['paris', 'cancun'] as const) {
          for (const optimize of [false, true]) {
            const script = evscript({ name: 'rb', args: [t.address] }, (s: any, a: any) => {
              const p = s.read({ address: a, abi: fnAbi, functionName: 'g' });
              const q = s.tryRead({ address: a, abi: fnAbi, functionName: 'g' });
              return s.return({ p, ok: q.success, q: q.value });
            });
            const labels = build(script, { evmVersion, optimize }).sourceMap.labels.map(
              (l) => l.name,
            );
            expect(labels).toContain('dec_0');
            // only placed rungs carry a name, each once
            const rungs = labels.filter((n) => /^dec_0_fail_\d+$/.test(n));
            expect(new Set(rungs).size).toBe(rungs.length);
            expect(rungs.length).toBeGreaterThan(0);
          }
        }
      }
    } finally {
      rolledBack.mockRestore();
      Error.stackTraceLimit = traceLimit;
    }
    expect(inBody).toBeGreaterThan(0);
  });

  test('a decoder body returns at height 2 ([block, buf]) and its sites check for 0', () => {
    const script = reads('heights', ['w8', 'w8', 'w8']);
    for (const evmVersion of ['paris', 'cancun'] as const) {
      for (const optimize of [false, true]) {
        const lowered = lowerProgram(irOf(script), { evmVersion, optimize });
        const nodes: readonly AsmNode[] = optimize ? evsPeephole(lowered.nodes) : lowered.nodes;
        const heights = stackHeights(nodes);
        const returns = nodes.flatMap((n, i) =>
          n.k === 'op' && n.op === 'JUMP' && n.note === 'dec_0: return' ? [heights[i]] : [],
        );
        // [ret, block, buf]: the success return and the funnel's [0, buf] return
        expect(returns).toEqual([3, 3]);
      }
    }
  });

  test('canFail guard: a plan that disagrees with its body is a drift', () => {
    const script = reads('canFail', ['w8', 'w8', 'w8']);
    const flip = (plan: CodecPlan): CodecPlan => ({
      ...plan,
      keys: new Map([...plan.keys].map(([key, k]) => [key, { ...k, canFail: !k.canFail }])),
    });
    setCodecPlanTransform(flip);
    try {
      expect(() => build(script)).toThrow(/plan drift: .*the body can fail, against its plan/);
      setCodecPlanStrict(false);
      const fallback = build(script).runtimeBytecode;
      const lowered = lowerProgram(irOf(script), { evmVersion: 'cancun', shareCodecs: false });
      expect((fallback.length - 2) / 2).toBe(
        assemble(lowered.nodes, { evmVersion: 'cancun' }).bytecode.length,
      );
    } finally {
      setCodecPlanStrict(true);
      setCodecPlanTransform(null);
    }
  });

  test('decode paths a shared body takes where its inline twin differs (pinned)', () => {
    const shapes: Record<string, string> = {
      W8: 'w8',
      'W8[]': 'w8s',
      N3: 'n3',
      '(uint8,(uint8,uint16[][])[])': 'rb',
      'the same under 4 struct levels': 'rb4',
    };
    const divergent: Record<string, { body: string[]; inline: string[] }> = {};
    const paths: Record<string, string> = {};
    const pathsIn = (compiled: CompiledEvsScript, from: string, until: RegExp): string[] => {
      const labels = compiled.sourceMap.labels.toSorted((x, y) => x.pc - y.pc);
      const start = labels.findIndex((l) => l.name === from);
      const end = labels.findIndex((l, i) => i > start && until.test(l.name));
      return labels
        .slice(start, end === -1 ? undefined : end)
        .map((l) => l.name)
        .filter((n) => n.startsWith('arrdec'));
    };
    for (const [label, fn] of Object.entries(shapes)) {
      const shared = build(reads(`shared_${fn}`, [fn, fn]));
      const single = build(reads(`single_${fn}`, [fn]));
      const body = pathsIn(
        shared,
        'dec_0',
        /^(dec_0_fail|dec_[1-9]|enc_|dfail_|decode_revert|badcd)/,
      );
      const inline = pathsIn(single, 'main', /^(fn_|dfail_|decode_revert|badcd|panic)/);
      expect(body.length, `${label}: the body decodes arrays`).toBe(inline.length);
      if (body.join() !== inline.join()) divergent[label] = { body, inline };
      paths[label] = body.join(' ');
    }
    // every shape takes the same array paths in its body as inline: none diverges today
    expect(divergent).toEqual({});
    expect(paths).toMatchInlineSnapshot(`
      {
        "(uint8,(uint8,uint16[][])[])": "arrdec arrdec_heap arrdec_heap arrdec_heap_done arrdec_heap_done arrdec_done",
        "N3": "",
        "W8": "",
        "W8[]": "arrdec arrdec_done",
        "the same under 4 struct levels": "arrdec_heap arrdec_heap arrdec_heap arrdec_heap_done arrdec_heap_done arrdec_heap_done",
      }
    `);
  });
});

describe('growth for n sites (the issue #95 benchmark)', () => {
  const T = { W8, 'W8[]': t.array(W8), N3, S3, 'uint64[3]': 'uint64[3]', 'P[2]': P2 } as const;
  const GETTER: Record<keyof typeof T, string> = {
    W8: 'get',
    'W8[]': 'getMany',
    N3: 'getNested',
    S3: 'getS3',
    'uint64[3]': 'getU',
    'P[2]': 'getPairs',
  };
  const NS = [1, 2, 3, 4, 6, 8] as const;
  const sizeOf = (script: AnyScript, evmVersion: EvmVersion, optimize: boolean): number =>
    (build(script, { evmVersion, optimize }).runtimeBytecode.length - 2) / 2;

  test('chained reads: bytes per n, never larger than inline, saving grows with n', () => {
    const table: Record<string, number[]> = {};
    for (const [label, ty] of Object.entries(T)) {
      for (const evmVersion of ['cancun', 'paris'] as const) {
        for (const optimize of [false, true]) {
          const row = NS.map((n) => {
            const script = chain(`c${n}`, ty, GETTER[label as keyof typeof T], n);
            const { shared, inline } = sizes(script, evmVersion, optimize);
            expect(shared, `${label} n=${n} never larger`).toBeLessThanOrEqual(inline);
            return { shared, saved: inline - shared };
          });
          // the saving grows at every step once something shares
          const grows = row.every((r, i) => {
            const prev = row[i - 1];
            return prev === undefined || prev.saved === 0 || r.saved > prev.saved;
          });
          expect(grows, `${label}: the saving grows with n`).toBe(true);
          table[`${label} ${evmVersion}${optimize ? '+opt' : ''}`] = row.map((r) => r.shared);
        }
      }
    }
    // per-site ceilings (cancun): main grows ~734 / ~1462 / ~2400 bytes per W8 / W8[] / N3 site
    const perSite = (key: string): number[] => {
      const row = table[key] ?? [];
      return row
        .slice(2)
        .map((size, i) => (size - (row[i + 1] ?? 0)) / ((NS[i + 2] ?? 0) - (NS[i + 1] ?? 0)));
    };
    for (const step of perSite('W8 cancun')) expect(step).toBeLessThanOrEqual(130);
    for (const step of perSite('W8[] cancun')) expect(step).toBeLessThanOrEqual(200);
    for (const step of perSite('N3 cancun')) expect(step).toBeLessThanOrEqual(260);
    expect(table).toMatchInlineSnapshot(`
      {
        "N3 cancun": [
          3379,
          3562,
          3711,
          3860,
          4158,
          4456,
        ],
        "N3 cancun+opt": [
          3373,
          3551,
          3698,
          3845,
          4139,
          4433,
        ],
        "N3 paris": [
          3615,
          3796,
          3956,
          4116,
          4436,
          4756,
        ],
        "N3 paris+opt": [
          3609,
          3785,
          3943,
          4101,
          4417,
          4733,
        ],
        "P[2] cancun": [
          1301,
          1491,
          1639,
          1787,
          2083,
          2379,
        ],
        "P[2] cancun+opt": [
          1299,
          1484,
          1630,
          1776,
          2068,
          2360,
        ],
        "P[2] paris": [
          1398,
          1599,
          1758,
          1917,
          2235,
          2553,
        ],
        "P[2] paris+opt": [
          1396,
          1592,
          1749,
          1906,
          2220,
          2534,
        ],
        "S3 cancun": [
          482,
          640,
          783,
          848,
          1074,
          1300,
        ],
        "S3 cancun+opt": [
          482,
          638,
          777,
          837,
          1059,
          1281,
        ],
        "S3 paris": [
          507,
          674,
          826,
          900,
          1144,
          1388,
        ],
        "S3 paris+opt": [
          507,
          672,
          820,
          889,
          1129,
          1369,
        ],
        "W8 cancun": [
          1231,
          1388,
          1513,
          1638,
          1888,
          2138,
        ],
        "W8 cancun+opt": [
          1230,
          1383,
          1506,
          1629,
          1875,
          2121,
        ],
        "W8 paris": [
          1333,
          1491,
          1626,
          1761,
          2031,
          2301,
        ],
        "W8 paris+opt": [
          1331,
          1486,
          1619,
          1752,
          2018,
          2284,
        ],
        "W8[] cancun": [
          1710,
          1904,
          2052,
          2200,
          2496,
          2792,
        ],
        "W8[] cancun+opt": [
          1708,
          1894,
          2040,
          2186,
          2478,
          2770,
        ],
        "W8[] paris": [
          1812,
          2016,
          2175,
          2334,
          2652,
          2970,
        ],
        "W8[] paris+opt": [
          1810,
          2006,
          2163,
          2320,
          2634,
          2948,
        ],
        "uint64[3] cancun": [
          571,
          730,
          858,
          986,
          1242,
          1498,
        ],
        "uint64[3] cancun+opt": [
          568,
          723,
          849,
          975,
          1227,
          1479,
        ],
        "uint64[3] paris": [
          597,
          766,
          903,
          1040,
          1314,
          1588,
        ],
        "uint64[3] paris+opt": [
          593,
          759,
          894,
          1029,
          1299,
          1569,
        ],
      }
    `);
  });

  test('the planner shortcuts decide exactly as the exhaustive planner', () => {
    // (every compile under the strict test setup also checks this; here on the whole table)
    for (const [label, ty] of Object.entries(T)) {
      for (const evmVersion of ['cancun', 'shanghai', 'paris'] as const) {
        for (const optimize of [false, true]) {
          for (const n of NS) {
            const script = chain(`c${n}`, ty, GETTER[label as keyof typeof T], n);
            const { fast, reference } = plannerAgainstReference(script.ir, evmVersion, optimize);
            expect(fast, `${label} n=${n} ${evmVersion} optimize=${optimize}`).toEqual(reference);
          }
        }
      }
    }
    // a program with no tuple or array anywhere skips the census
    const words = evscript({ name: 'words', args: [t.address] }, (s: any, a: any) =>
      s.return({ v: s.read({ address: a, abi, functionName: 'word', args: [1n] }) }),
    );
    expect(plannerAgainstReference(words.ir, 'cancun', true).candidates).toBe(false);
  });

  test('encode-only and decode-only chains', () => {
    const encodeOnly = (fn: string, ty: EvsType, n: number) =>
      evscript({ name: 'enc', args: [t.address, ty as never] }, (s: any, a: any, x: any) => {
        let total = s.let(t.uint256, 0n);
        for (let i = 0; i < n; i++) {
          total.set(total.get().add(s.read({ address: a, abi, functionName: fn, args: [x] })));
        }
        return s.return({ total: total.get() });
      });
    const decodeOnly = (fn: string, n: number) =>
      evscript({ name: 'dec', args: [t.address] }, (s: any, a: any) => {
        let last;
        for (let i = 0; i < n; i++)
          last = s.read({ address: a, abi, functionName: fn, args: [BigInt(i)] });
        return s.return({ last });
      });
    const table: Record<string, number[]> = {};
    for (const [label, fn, ty] of [
      ['W8', 'sink', W8],
      ['W8[]', 'sinkMany', t.array(W8)],
      ['N3', 'sinkNested', N3],
    ] as const) {
      table[`encode ${label}`] = NS.map((n) => sizeOf(encodeOnly(fn, ty, n), 'cancun', false));
    }
    for (const [label, fn] of [
      ['W8', 'make'],
      ['W8[]', 'makeMany'],
      ['N3', 'makeNested'],
    ] as const) {
      table[`decode ${label}`] = NS.map((n) => sizeOf(decodeOnly(fn, n), 'cancun', false));
    }
    expect(table).toMatchInlineSnapshot(`
      {
        "decode N3": [
          2229,
          2377,
          2496,
          2634,
          2868,
          3102,
        ],
        "decode W8": [
          799,
          931,
          1036,
          1152,
          1358,
          1564,
        ],
        "decode W8[]": [
          1177,
          1337,
          1456,
          1574,
          1808,
          2042,
        ],
        "encode N3": [
          2312,
          2465,
          2606,
          2747,
          3029,
          3311,
        ],
        "encode W8": [
          959,
          1089,
          1220,
          1351,
          1613,
          1875,
        ],
        "encode W8[]": [
          1237,
          1395,
          1535,
          1675,
          1955,
          2235,
        ],
      }
    `);
  });
});

describe('gas of shared calls (in-process EVM)', () => {
  /** Returns its calldata minus the selector: `f(T) returns (T)` echoes its argument. */
  const ECHO_ARGS = '0xe000000000000000000000000000000000000095';
  const fixture = { contracts: { [ECHO_ARGS]: '0x600436038060045f375ff3' } } as const;
  const w8 = (i: number) => ({
    f0: BigInt(i),
    f1: `0x${'0a'.repeat(20)}`,
    f2: -i,
    f3: 3n,
    f4: `0x${'0b'.repeat(20)}`,
    f5: i,
    f6: 9n,
    f7: `0x${'0c'.repeat(20)}`,
    label: `row ${i}`,
  });
  const nestedVal = (d: number): unknown =>
    d === 0
      ? { leaf: 7n, name: 'leaf-name' }
      : { a: BigInt(d), s: `level-${d}`, xs: [1, 2, 3].slice(0, d), inner: nestedVal(d - 1) };

  /** Execution gas of `script` and of its inline twin on `args`; both must return the same bytes. */
  async function gasDelta(script: AnyScript, args: readonly unknown[]): Promise<number> {
    const compiled = build(script);
    const lowered = lowerProgram(irOf(script), { evmVersion: 'cancun', shareCodecs: false });
    const twin = bytesToHex(assemble(lowered.nodes, { evmVersion: 'cancun' }).bytecode);
    const calldata = encodeFunctionData({ abi: compiled.abi, functionName: script.name, args });
    const a = await execRuntime(compiled.runtimeBytecode, calldata, fixture);
    const b = await execRuntime(twin, calldata, fixture);
    expect(a.success, `${script.name} succeeds`).toBe(true);
    expect(a.data).toBe(b.data);
    return Number(a.gasUsed - b.gasUsed);
  }

  test('straight-line chains: a few dozen gas per call at most, wide structs cheaper', async () => {
    const deltas: Record<string, number> = {};
    for (const [label, ty, fn, value] of [
      ['W8', W8, 'get', w8(1)],
      ['W8[]', t.array(W8), 'getMany', [w8(1), w8(2), w8(3)]],
      ['N3', N3, 'getNested', nestedVal(3)],
    ] as const) {
      for (const n of [2, 4]) {
        // oxlint-disable-next-line no-await-in-loop -- sequential by design
        const delta = await gasDelta(chain(`gas${n}`, ty, fn, n), [ECHO_ARGS, value]);
        // n encoder calls (+ the return record) and n decoder calls
        expect(delta, `${label} n=${n}`).toBeLessThanOrEqual(60 * (2 * n + 1));
        deltas[`${label} n=${n}`] = delta;
      }
    }
    expect(deltas['W8 n=2']).toBeLessThan(0);
    expect(deltas['W8 n=4']).toBeLessThan(0);
    // measured: the wide struct and the nested one are cheaper shared, the struct array pays
    // ~40 gas per call (203 / 5, 362 / 9: its array loops keep their own costs)
    expect(deltas).toMatchInlineSnapshot(`
      {
        "N3 n=2": -267,
        "N3 n=4": -483,
        "W8 n=2": -250,
        "W8 n=4": -433,
        "W8[] n=2": 203,
        "W8[] n=4": 362,
      }
    `);
  });

  test('a key that shares inside a loop costs no gas there; the others stay inline', async () => {
    const shapeOf = (k: number) => {
      const spec: Record<string, EvsType> = {};
      const components: { name: string; type: string }[] = [];
      const value: Record<string, unknown> = {};
      for (let i = 0; i < k; i++) {
        spec[`a${i}`] = t.uint64;
        components.push({ name: `a${i}`, type: 'uint64' });
        value[`a${i}`] = BigInt(i + 1);
      }
      spec['s'] = t.string;
      components.push({ name: 's', type: 'string' });
      value['s'] = 'hello';
      return { ty: t.struct(spec as never) as EvsType, components, value };
    };
    const shares: Record<string, string> = {};
    for (const k of [1, 3, 4, 6, 7, 9]) {
      const { ty, components, value } = shapeOf(k);
      const echoAbi = [
        {
          type: 'function',
          name: 'echo',
          stateMutability: 'view',
          inputs: [{ name: 'x', type: 'tuple', components }],
          outputs: [{ name: '', type: 'tuple', components }],
        },
      ];
      // one use in a 20-iteration loop (an arg and an output), one outside
      const script = evscript(
        { name: 'loop', args: [t.address, ty as never] },
        (s: any, a: any, x: any) => {
          const acc = s.let(ty, x);
          s.for({ type: t.uint256, from: 0n, until: 20n }, () => {
            acc.set(s.read({ address: a, abi: echoAbi, functionName: 'echo', args: [acc.get()] }));
          });
          const last = s.read({
            address: a,
            abi: echoAbi,
            functionName: 'echo',
            args: [acc.get()],
          });
          return s.return({ last });
        },
      );
      const hot = new Set<number>();
      walkEmittedStmts(irOf(script), (st, isHot) => {
        if (isHot && st.k === 'call') hot.add(st.site);
      });
      const loopShared = [...planOf(script).keys.values()].filter((key) =>
        [...key.groups.keys()].some((site) => hot.has(site)),
      );
      // oxlint-disable-next-line no-await-in-loop -- sequential by design
      const delta = await gasDelta(script, [ECHO_ARGS, value]);
      shares[`uint64×${k} + string`] =
        `${loopShared.map((key) => key.unit.dir).join('+') || 'inline'} ${delta}`;
      // a loop use only shares a key whose calls are cheaper than its inline code
      expect(loopShared.length === 0 || delta <= 0, `k=${k}: ${delta} gas`).toBe(true);
    }
    expect(shares).toMatchInlineSnapshot(`
      {
        "uint64×1 + string": "inline 69",
        "uint64×3 + string": "inline 10",
        "uint64×4 + string": "enc -339",
        "uint64×6 + string": "enc -998",
        "uint64×7 + string": "enc+dec -1495",
        "uint64×9 + string": "enc+dec -2491",
      }
    `);
  });

  test('a decoder behind a leading output repays its call from fewer base reads', async () => {
    // `echo2(uint256, T) returns (uint256, T)`: T sits at head offset 32, so every inline read of
    // its block base re-adds the offset — the shared body's cached base pays off from 5 reads
    const shares: Record<string, string> = {};
    for (const k of [1, 3, 4, 6]) {
      const spec: Record<string, EvsType> = {};
      const components: { name: string; type: string }[] = [];
      const value: Record<string, unknown> = {};
      for (let i = 0; i < k; i++) {
        spec[`a${i}`] = t.uint64;
        components.push({ name: `a${i}`, type: 'uint64' });
        value[`a${i}`] = BigInt(i + 1);
      }
      spec['s'] = t.string;
      components.push({ name: 's', type: 'string' });
      value['s'] = 'hello';
      const ty = t.struct(spec as never) as EvsType;
      const params = [
        { name: 'n', type: 'uint256' },
        { name: 'x', type: 'tuple', components },
      ];
      const echoAbi = [
        {
          type: 'function',
          name: 'echo2',
          stateMutability: 'view',
          inputs: params,
          outputs: params,
        },
      ];
      // one read in a 20-iteration loop, one outside; only the struct output is a codec unit
      const script = evscript(
        { name: 'loop2', args: [t.address, ty as never] },
        (s: any, a: any, x: any) => {
          const acc = s.let(ty, x);
          s.for({ type: t.uint256, from: 0n, until: 20n }, () => {
            const [, out] = s.read({
              address: a,
              abi: echoAbi,
              functionName: 'echo2',
              args: [7n, acc.get()],
            });
            acc.set(out);
          });
          const [n, last] = s.read({
            address: a,
            abi: echoAbi,
            functionName: 'echo2',
            args: [7n, acc.get()],
          });
          return s.return({ n, last });
        },
      );
      const hot = new Set<number>();
      walkEmittedStmts(irOf(script), (st, isHot) => {
        if (isHot && st.k === 'call') hot.add(st.site);
      });
      const loopShared = [...planOf(script).keys.values()].filter((key) =>
        [...key.groups.keys()].some((site) => hot.has(site)),
      );
      // oxlint-disable-next-line no-await-in-loop -- sequential by design
      const delta = await gasDelta(script, [ECHO_ARGS, value]);
      shares[`uint64×${k} + string`] =
        `${loopShared.map((key) => key.unit.dir).join('+') || 'inline'} ${delta}`;
      expect(loopShared.length === 0 || delta <= 0, `k=${k}: ${delta} gas`).toBe(true);
    }
    expect(shares).toMatchInlineSnapshot(`
      {
        "uint64×1 + string": "inline 45",
        "uint64×3 + string": "dec -163",
        "uint64×4 + string": "enc+dec -1419",
        "uint64×6 + string": "enc+dec -2930",
      }
    `);
  });

  test('costly keys used in a loop and once outside keep every use inline', () => {
    const cases = [
      ['W8[]', t.array(W8), 'getMany'],
      ['uint64[3]', 'uint64[3]', 'getU'],
      ['S3', S3, 'getS3'],
    ] as const;
    for (const [label, ty, fn] of cases) {
      const script = evscript(
        { name: 'costly', args: [t.address, ty as never] },
        (s: any, a: any, x: any) => {
          const acc = s.let(ty, x);
          s.for({ type: t.uint256, from: 0n, until: 100n }, () => {
            acc.set(s.read({ address: a, abi, functionName: fn, args: [acc.get()] }));
            acc.set(s.read({ address: a, abi, functionName: fn, args: [acc.get()] }));
          });
          return s.return({ last: acc.get() });
        },
      );
      const shared = lowerProgram(irOf(script), { evmVersion: 'cancun' });
      const twin = lowerProgram(irOf(script), { evmVersion: 'cancun', shareCodecs: false });
      expect(shared.nodes, `${label} stays inline`).toEqual(twin.nodes);
    }
  });

  test('the register words add a memory term paid once per run, however big the memory', async () => {
    // the same sharing program, then the same one allocating ~64 KiB at the end
    const big = (words: number) =>
      evscript({ name: 'mem', args: [t.address, W8] }, (s: any, a: any, x: any) => {
        const p = s.read({ address: a, abi, functionName: 'get', args: [x] });
        const q = s.read({ address: a, abi, functionName: 'get', args: [p] });
        const pad = s.newArray(t.uint256, BigInt(words));
        return s.return({ q, n: pad.length });
      });
    const small = await gasDelta(big(1), [ECHO_ARGS, w8(2)]);
    const large = await gasDelta(big(2048), [ECHO_ARGS, w8(2)]);
    // 3 register words at a peak of w words: 3·3 + (6w + 9)/512 gas — ~24 more at 64 KiB
    expect(large - small).toBeGreaterThanOrEqual(0);
    expect(large - small).toBeLessThanOrEqual(30);
  });
});
