/**
 * Shared codec subroutines (issue #95, `codegen/codecs.ts`): keys, the census and the cost
 * model, the byte identity of programs that share nothing, the drift guard, the registers, and
 * the structure of the emitted bodies. Execution against the interpreter lives in
 * `src/differential/shared-codecs.test.ts`.
 */

import { parseAbi } from 'viem';
import { describe, expect, test } from 'vite-plus/test';

import type { AnyScript } from '../../test/harness/differential.js';
import { layoutOfType } from '../abi/layout.js';
import { assemble, type AsmNode } from '../asm/assembler.js';
import type { EvmVersion } from '../asm/ops.js';
import { stackHeights } from '../asm/verify.js';
import { evscript } from '../builder/script.js';
import { compile, type CompiledEvsScript } from '../compile.js';
import { EvsInternalError } from '../core/errors.js';
import { namedArg, t, type EvsType } from '../core/types.js';
import { eliminateDeadCode } from '../ir/dce.js';
import type { ScriptIr } from '../ir/nodes.js';
import { decRetKey, encKey, encodeMemberKind, layoutKey, RETURNS_SITE } from './codec-keys.js';
import { planCodecs, setCodecPlanStrict, setCodecPlanTransform, type CodecPlan } from './codecs.js';
import { layoutFrames } from './frame.js';
import { evsPeephole } from './peephole.js';
import { lowerProgram } from './program.js';

const abi = parseAbi([
  'struct W8 { uint64 f0; address f1; int32 f2; uint64 f3; address f4; int32 f5; uint64 f6; address f7; string label; }',
  'struct S3 { uint64 a; address b; int32 c; }',
  'struct S2 { uint64 a; address b; }',
  'function get(W8 x) view returns (W8)',
  'function getMany(W8[] x) view returns (W8[])',
  'function getS3(S3 x) view returns (S3)',
  'function getS2(S2 x) view returns (S2)',
  'function word(uint256 i) view returns (uint256)',
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

  test('the per-use floor keeps a tiny static struct inline at many uses', () => {
    const script = chain('s2x8', S2, 'getS2', 7); // 7 call args + the return record
    expect(planOf(script).keys.size).toBe(0);
    const { shared, inline } = sizes(script, 'cancun', false);
    expect(shared).toBe(inline);
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
    const arr = chain('regsArr', t.array(W8), 'getMany', 2);
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
});
