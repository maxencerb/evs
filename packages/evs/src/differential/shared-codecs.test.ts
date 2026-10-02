/**
 * Differential suite — shared codec subroutines (issue #95).
 *
 * A tuple or composite-array codec used at several sites of one program is emitted once as a
 * shared subroutine (`codegen/codecs.ts`). This slice drives shared bodies from every kind of
 * site — call args and outputs of every verb, the return record, `s.encode` / `s.keccak256` /
 * memref `.eq()`, `s.throw` — and checks, on every fork and on the `optimize: true` twin, that the
 * bytecode agrees byte-for-byte with the interpreter AND with its inline twin (the same program
 * lowered with sharing off), and that sharing actually happened.
 */

import { encodeFunctionData, type Hex, parseAbi } from 'viem';
import { describe, expect, test } from 'vite-plus/test';

import {
  expectAgreement,
  fixtureOf,
  EVM_VERSIONS,
  type AnyScript,
  type CalleeTable,
} from '../../test/harness/differential.js';
import { execRuntime } from '../../test/harness/evm.js';
import { assemble } from '../asm/assembler.js';
import type { EvmVersion } from '../asm/ops.js';
import { evscript } from '../builder/script.js';
import { evsPeephole } from '../codegen/peephole.js';
import { lowerProgram } from '../codegen/program.js';
import { compile, type CompiledEvsScript } from '../compile.js';
import { bytesToHex } from '../core/bytes.js';
import { namedArg, t } from '../core/types.js';
import { eliminateDeadCode } from '../ir/dce.js';

/** Returns its calldata minus the selector: `f(T) returns (T)` echoes its argument. */
const ECHO_ARGS_RUNTIME: Hex = '0x600436038060045f375ff3';
const ECHO_ARGS = '0xe000000000000000000000000000000000000095';
const echoTable: CalleeTable = {
  [ECHO_ARGS]: {
    kind: 'bytecode',
    runtime: ECHO_ARGS_RUNTIME,
    respond: (calldata) => ({ success: true, data: `0x${calldata.slice(10)}` }),
  },
};

const abi = parseAbi([
  'struct W8 { uint64 f0; address f1; int32 f2; uint64 f3; address f4; int32 f5; uint64 f6; address f7; string label; }',
  'struct Alt { uint256 a; int32 b; bytes32 c; uint128 d; int8 e; bytes4 f; bool g; uint8 h; string label; }',
  'struct S3 { uint64 a; address b; int32 c; }',
  'struct Holder { W8[] rows; uint256 n; }',
  'struct P { uint64 a; string s; }',
  'function get(W8 x) view returns (W8)',
  'function getAlt(Alt x) view returns (Alt)',
  'function getMany(W8[] x) view returns (W8[])',
  'function getS3(S3 x) view returns (S3)',
  'function getU(uint64[3] x) view returns (uint64[3])',
  'function getPairs(P[2] x) view returns (P[2])',
  'function getNames(string[2] x) view returns (string[2])',
  'function getHolder(Holder x) view returns (Holder)',
  'function mix(W8 a, S3 b, W8 c) view returns (W8, S3, W8)',
  'function tagged(string tag, W8 x) view returns (string, W8)',
  'function both(W8 x, W8[] xs) view returns (W8, W8[])',
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
const Alt = t.struct({
  a: t.uint256,
  b: t.int32,
  c: t.bytes32,
  d: t.uint128,
  e: t.int8,
  f: t.bytes4,
  g: t.bool,
  h: t.uint8,
  label: t.string,
});
const S3 = t.struct({ a: t.uint64, b: t.address, c: t.int32 });
const Holder = t.struct({ rows: t.array(W8), n: t.uint256 });

const w8 = (i: number): any => ({
  f0: BigInt(i),
  f1: `0x${'0a'.repeat(19)}${i.toString(16).padStart(2, '0')}`,
  f2: -i,
  f3: (1n << 64n) - 1n - BigInt(i),
  f4: `0x${'b0'.repeat(20)}`,
  f5: 2 ** 31 - 1 - i,
  f6: 3n,
  f7: `0x${'c1'.repeat(20)}`,
  label: `row ${i} ${'x'.repeat(i * 7)}`,
});
const alt = (i: number): any => ({
  a: (1n << 255n) + BigInt(i),
  b: -(2 ** 31) + i,
  c: `0x${'ab'.repeat(31)}${i.toString(16).padStart(2, '0')}`,
  d: (1n << 127n) + BigInt(i),
  e: -128 + i,
  f: '0xdeadbeef',
  g: i % 2 === 0,
  h: 255 - i,
  label: `alt ${i}`,
});
const s3 = (i: number): any => ({ a: BigInt(i), b: `0x${'d2'.repeat(20)}`, c: -7 * i });

/** The bytecode of `script` lowered with codec sharing off (its inline twin). */
function inlineTwin(script: AnyScript, evmVersion: EvmVersion, optimize: boolean): Hex {
  const lowered = lowerProgram(eliminateDeadCode(script.ir), {
    evmVersion,
    optimize,
    shareCodecs: false,
  });
  const peephole = optimize ? evsPeephole : undefined;
  return bytesToHex(
    assemble(lowered.nodes, { evmVersion, ...(peephole === undefined ? {} : { peephole }) })
      .bytecode,
  );
}

/**
 * `expectAgreement` (interp == bytecode == optimized twin, every arg set), plus, for the default
 * output and its optimized twin: the program carries the shared bodies `shared` (by label), it
 * is smaller than its inline twin, and the twin returns or reverts with the same bytes on every
 * arg set. Returns the bytes sharing saved on the default output.
 */
async function expectShared(
  script: AnyScript,
  argSets: readonly (readonly unknown[])[],
  evmVersion: EvmVersion,
  shared: readonly string[],
  table: CalleeTable = echoTable,
): Promise<number> {
  await expectAgreement(script, argSets, table, evmVersion);
  const fixture = fixtureOf(table);
  let saved = 0;
  for (const optimize of [false, true]) {
    const compiled: CompiledEvsScript = compile(script, { evmVersion, optimize });
    const labels = compiled.sourceMap.labels.map((l) => l.name);
    for (const name of shared) expect(labels, `${script.name}: body ${name}`).toContain(name);
    const twin = inlineTwin(script, evmVersion, optimize);
    const grown = compiled.runtimeBytecode.length - twin.length;
    expect(grown, `${script.name}: smaller than inline`).toBeLessThan(0);
    if (!optimize) saved = -grown / 2;
    for (const args of argSets) {
      const calldata = encodeFunctionData({ abi: compiled.abi, functionName: script.name, args });
      // oxlint-disable-next-line no-await-in-loop -- sequential: deterministic labels
      const a = await execRuntime(compiled.runtimeBytecode, calldata, fixture);
      // oxlint-disable-next-line no-await-in-loop -- see above
      const b = await execRuntime(twin, calldata, fixture);
      expect({ success: a.success, data: a.data }, `${script.name} vs its inline twin`).toEqual({
        success: b.success,
        data: b.data,
      });
    }
  }
  return saved;
}

describe('shared encoders (issue #95)', () => {
  const chain = (name: string, ty: any, fn: string, verb: string, n: number) =>
    evscript({ name, args: [t.address, ty] }, (s: any, a: any, x: any) => {
      let last = x;
      for (let i = 0; i < n; i++) {
        last = s[verb]({ address: a, abi, functionName: fn, args: [last] });
      }
      return s.return({ last });
    });

  for (const evmVersion of EVM_VERSIONS) {
    test(`a struct chained through every strict verb [${evmVersion}]`, async () => {
      for (const verb of ['read', 'call', 'simulate']) {
        const fn = verb === 'read' ? 'get' : 'mut';
        expect(
          // oxlint-disable-next-line no-await-in-loop -- sequential by design
          await expectShared(
            chain(`chain_${verb}`, W8, fn, verb, 3),
            [[ECHO_ARGS, w8(1)]],
            evmVersion,
            ['enc_0'],
          ),
        ).toBeGreaterThan(0);
      }
    });

    test(`arrays and fixed arrays of every encoder kind [${evmVersion}]`, async () => {
      const cases: [string, unknown, string, unknown][] = [
        ['many', t.array(W8), 'getMany', [w8(1), w8(2), w8(3)]],
        ['fixedWords', 'uint64[3]', 'getU', [1n, 2n, (1n << 64n) - 1n]],
        [
          'pairs',
          t.array(t.struct({ a: t.uint64, s: t.string }), 2),
          'getPairs',
          [
            { a: 1n, s: 'one' },
            { a: 2n, s: `two ${'y'.repeat(40)}` },
          ],
        ],
        ['names', 'string[2]', 'getNames', ['', `n ${'z'.repeat(33)}`]],
        ['holder', Holder, 'getHolder', { rows: [w8(4), w8(5)], n: 9n }],
        ['static3', S3, 'getS3', s3(3)],
      ];
      for (const [name, ty, fn, value] of cases) {
        expect(
          // oxlint-disable-next-line no-await-in-loop -- sequential by design
          await expectShared(
            chain(`kind_${name}`, ty, fn, 'read', 4),
            [[ECHO_ARGS, value]],
            evmVersion,
            ['enc_0'],
          ),
        ).toBeGreaterThan(0);
      }
    });

    test(`one body across call args, the return record, encode, keccak and eq [${evmVersion}]`, async () => {
      const script = evscript(
        { name: 'entryPoints', args: [t.address, W8, W8] },
        (s: any, a: any, x: any, y: any) => {
          const r = s.read({ address: a, abi, functionName: 'get', args: [x] });
          const enc = s.encode(r);
          const h = s.keccak256(y);
          const same = r.expr().eq(x.expr());
          return s.return({ r, enc, h, same, y });
        },
      );
      expect(
        await expectShared(
          script,
          [
            [ECHO_ARGS, w8(1), w8(2)],
            [ECHO_ARGS, w8(3), w8(3)],
          ],
          evmVersion,
          ['enc_0'],
        ),
      ).toBeGreaterThan(0);
    });

    test(`s.throw with a shared struct payload [${evmVersion}]`, async () => {
      const Bad = t.error('Bad', [namedArg('w', W8), namedArg('code', t.uint256)]);
      const script = evscript(
        { name: 'throwShared', args: [t.address, W8, t.uint256], errors: [Bad] },
        (s: any, a: any, x: any, k: any) => {
          const r = s.read({ address: a, abi, functionName: 'get', args: [x] });
          s.if(k.gt(10n), () => s.throw(Bad, { w: r, code: k }));
          return s.return({ r });
        },
      );
      expect(
        await expectShared(
          script,
          [
            [ECHO_ARGS, w8(2), 3n],
            [ECHO_ARGS, w8(2), 11n],
          ],
          evmVersion,
          ['enc_0'],
        ),
      ).toBeGreaterThan(0);
      const compiled = compile(script, { evmVersion });
      const calldata = encodeFunctionData({
        abi: compiled.abi,
        functionName: 'throwShared',
        args: [ECHO_ARGS, w8(2), 11n],
      });
      const out = await execRuntime(compiled.runtimeBytecode, calldata, fixtureOf(echoTable));
      expect(out.success).toBe(false);
      expect(compiled.explainRevert(out.data).message).toContain('Bad');
    });

    test(`several shared members in one block, static after dynamic, a literal next to one [${evmVersion}]`, async () => {
      const script = evscript(
        { name: 'members', args: [t.address, W8, S3, W8] },
        (s: any, a: any, x: any, y: any, z: any) => {
          const [p, q, r] = s.read({ address: a, abi, functionName: 'mix', args: [x, y, z] });
          const [tag, w] = s.read({
            address: a,
            abi,
            functionName: 'tagged',
            args: [s.lit(t.string, `literal ${'q'.repeat(50)}`), p],
          });
          const [m0, m1, m2] = s.read({ address: a, abi, functionName: 'mix', args: [w, q, r] });
          return s.return({ tag, m0, m1, m2 });
        },
      );
      expect(
        await expectShared(script, [[ECHO_ARGS, w8(1), s3(2), w8(3)]], evmVersion, ['enc_0']),
      ).toBeGreaterThan(0);
    });

    test(`an inline struct array member next to a shared struct member [${evmVersion}]`, async () => {
      const script = evscript(
        { name: 'beside', args: [t.address, W8, t.array(W8)] },
        (s: any, a: any, x: any, xs: any) => {
          const [p, ps] = s.read({ address: a, abi, functionName: 'both', args: [x, xs] });
          const [q, qs] = s.read({ address: a, abi, functionName: 'both', args: [p, ps] });
          return s.return({ q, qs });
        },
      );
      expect(
        await expectShared(script, [[ECHO_ARGS, w8(1), [w8(2), w8(3)]]], evmVersion, ['enc_0']),
      ).toBeGreaterThan(0);
    });

    test(`two structs whose word types differ share one encoder body [${evmVersion}]`, async () => {
      const script = evscript(
        { name: 'erased', args: [t.address, W8, Alt] },
        (s: any, a: any, x: any, y: any) => {
          const p = s.read({ address: a, abi, functionName: 'get', args: [x] });
          const q = s.read({ address: a, abi, functionName: 'getAlt', args: [y] });
          return s.return({ p, q });
        },
      );
      expect(
        await expectShared(
          script,
          [
            [ECHO_ARGS, w8(7), alt(1)],
            [ECHO_ARGS, w8(0), alt(2)],
          ],
          evmVersion,
          ['enc_0'],
        ),
      ).toBeGreaterThan(0);
      const labels = compile(script, { evmVersion }).sourceMap.labels.map((l) => l.name);
      expect(labels.filter((n) => /^enc_\d+$/.test(n))).toEqual(['enc_0']);
    });
  }
});
