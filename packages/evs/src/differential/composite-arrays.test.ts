/**
 * Differential suite — composite arrays: read path, return path, call-arg encode.
 *
 * One slice of the anti-miscompilation corpus: `interpret(script.ir)` must agree byte-for-byte
 * with the compiled bytecode on returndata and revert payloads, on the default output and its
 * `optimize: true` twin. Runner, callee table and fixture constants: `test/harness/differential.ts`.
 */

import type { Abi } from 'abitype';
import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, getAddress } from 'viem';
import { describe, expect, test } from 'vite-plus/test';

import {
  expectAgreement,
  POOL,
  SINK,
  EVM_VERSIONS,
  abiEchoMock,
} from '../../test/harness/differential.js';
import { evscript } from '../builder/script.js';
import { t, type Expr } from '../core/types.js';

// ---------------------------------------------------------------------------
// 12c. composite arrays — READ PATH (decode) byte-exactness.
//
// Each shape: s.call a composite-element array, read len + an element field (index/.at + .field),
// and return a DERIVED WORD (no composite-array encode — that is the next milestone). The mock
// callee returndata is viem's canonical encoding; `expectAgreement` asserts interp == in-process
// EVM runtime byte-for-byte, closing interp == EVM; the interp itself is proven == viem. Every
// shape runs across paris/shanghai/cancun.
// ---------------------------------------------------------------------------

describe('composite arrays (read path)', () => {
  // The differential harness drives loosely-typed builder scripts (the precise abitype inference of
  // composite-array call outputs is covered by the type tests); this loose handle shape lets the
  // read-path builder calls (`.length()`/`.at()`/`.field.get()`) type-check in the test corpus.
  // Every terminal read in these shapes resolves to a WORD, so the loose word handle is pinned to
  // `Expr<'uint256'>` (not the wide `Expr<EvsType>`): the `s.return({...})` struct that viem's
  // `decodeFunctionResult` re-infers is then a struct of words, not a ~400-member union ("too
  // complex to represent"). Intermediate handles are the loose array/tuple/bytes shapes the runtime
  // produces; only the word part feeds a return slot.
  // `ArrLike` (loose, no `this` constraints) is intersected BEFORE `Word` so its `length`/`at`
  // signatures win method resolution — the real `Expr` ops carry array-only `this` params that a
  // `uint256` word would fail (TS2684). The value is still an `Expr<'uint256'>` for return slots.
  type Word = Expr<'uint256'>;
  interface FieldLike {
    get(): ArrLike & Word;
  }
  interface ArrLike {
    length(): Word;
    at(i: bigint): ArrLike & Word;
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- loose builder handle for the corpus
  const asArr = (v: unknown): ArrLike => v as ArrLike;
  /** A named tuple field of an element handle (Tuple handles expose fields as own properties). */
  const fld = (el: unknown, name: string): FieldLike =>
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- runtime Tuple handle field access
    (el as Record<string, FieldLike>)[name]!;

  // (A) STATIC-element tuple array — Position[] (the static Position struct, no offsets).
  const posComponents = [
    { name: 'nonce', type: 'uint96' },
    { name: 'operator', type: 'address' },
    { name: 'liquidity', type: 'uint128' },
  ] as const;
  const positionsBatchAbi = [
    {
      type: 'function',
      name: 'positionsBatch',
      stateMutability: 'view',
      inputs: [{ name: 'n', type: 'uint256' }],
      outputs: [{ name: '', type: 'tuple[]', components: posComponents }],
    },
  ] as const satisfies Abi;
  const POSITIONS = [
    {
      nonce: 1n,
      operator: getAddress('0x00000000000000000000000000000000000000a1'),
      liquidity: 111n,
    },
    {
      nonce: 2n,
      operator: getAddress('0x00000000000000000000000000000000000000a2'),
      liquidity: 222n,
    },
    {
      nonce: 3n,
      operator: getAddress('0x00000000000000000000000000000000000000a3'),
      liquidity: 333n,
    },
  ] as const;
  const positionsReturndata = encodeAbiParameters(
    [{ type: 'tuple[]', components: posComponents }],
    [POSITIONS],
  );

  // (B) DYNAMIC-member tuple array — WithBytes[] (each element a dynamic tuple: uint256 + bytes).
  const withBytesComponents = [
    { name: 'id', type: 'uint256' },
    { name: 'blob', type: 'bytes' },
  ] as const;
  const withBytesBatchAbi = [
    {
      type: 'function',
      name: 'withBytesBatch',
      stateMutability: 'view',
      inputs: [{ name: 'n', type: 'uint256' }],
      outputs: [{ name: '', type: 'tuple[]', components: withBytesComponents }],
    },
  ] as const satisfies Abi;
  const WITH_BYTES = [
    { id: 10n, blob: '0xdeadbeef' },
    { id: 20n, blob: `0x${'cd'.repeat(40)}` },
    { id: 30n, blob: '0x' },
  ] as const;
  const withBytesReturndata = encodeAbiParameters(
    [{ type: 'tuple[]', components: withBytesComponents }],
    [WITH_BYTES],
  );

  // (C) ragged uint256[][] (nested word array).
  const matrixAbi = [
    {
      type: 'function',
      name: 'matrix',
      stateMutability: 'view',
      inputs: [{ name: 'n', type: 'uint256' }],
      outputs: [{ name: '', type: 'uint256[][]' }],
    },
  ] as const satisfies Abi;
  const MATRIX = [[1n], [2n, 3n], [], [4n, 5n, 6n, 7n]] as const;
  const matrixReturndata = encodeAbiParameters([{ type: 'uint256[][]' }], [MATRIX]);

  // (D) string[].
  const namesAbi = [
    {
      type: 'function',
      name: 'names',
      stateMutability: 'view',
      inputs: [{ name: 'n', type: 'uint256' }],
      outputs: [{ name: '', type: 'string[]' }],
    },
  ] as const satisfies Abi;
  const NAMES = ['alpha', '', 'a-much-longer-string-spanning-two-words!!', 'z'] as const;
  const namesReturndata = encodeAbiParameters([{ type: 'string[]' }], [NAMES]);

  for (const evmVersion of EVM_VERSIONS) {
    test(`(A) Position[] (static-elem): len + element field [${evmVersion}]`, async () => {
      const script = evscript({ name: 'rdPositions', args: [t.uint256] }, (s, n) => {
        const ps = asArr(
          s.read({
            address: POOL,
            abi: positionsBatchAbi,
            functionName: 'positionsBatch',
            args: [n],
          }),
        );
        // ps.at(1) → a Tuple handle (element); .liquidity.get() → a word.
        const p1 = ps.at(1n);
        return s.return({
          len: ps.length(),
          liq1: fld(p1, 'liquidity').get(),
          nonce1: fld(p1, 'nonce').get(),
        });
      });
      const [o] = await expectAgreement(
        script,
        [[3n]],
        { [POOL]: { kind: 'return', data: positionsReturndata } },
        evmVersion,
      );
      expect(o?.kind).toBe('return');
      const decoded = decodeFunctionResult({
        abi: script.abi,
        functionName: 'rdPositions',
        data: o?.data ?? '0x',
      });
      expect(decoded).toEqual({
        len: 3n,
        liq1: POSITIONS[1].liquidity,
        nonce1: POSITIONS[1].nonce,
      });
    });

    test(`(B) WithBytes[] (dynamic-member elem): len + blob length [${evmVersion}]`, async () => {
      const script = evscript({ name: 'rdWithBytes', args: [t.uint256] }, (s, n) => {
        const xs = asArr(
          s.read({
            address: POOL,
            abi: withBytesBatchAbi,
            functionName: 'withBytesBatch',
            args: [n],
          }),
        );
        const e1 = xs.at(1n);
        return s.return({
          len: xs.length(),
          id1: fld(e1, 'id').get(),
          blob1len: fld(e1, 'blob').get().length(),
        });
      });
      const [o] = await expectAgreement(
        script,
        [[3n]],
        { [POOL]: { kind: 'return', data: withBytesReturndata } },
        evmVersion,
      );
      expect(o?.kind).toBe('return');
      const decoded = decodeFunctionResult({
        abi: script.abi,
        functionName: 'rdWithBytes',
        data: o?.data ?? '0x',
      });
      expect(decoded).toEqual({
        len: 3n,
        id1: WITH_BYTES[1].id,
        blob1len: BigInt((WITH_BYTES[1].blob.length - 2) / 2),
      });
    });

    test(`(C) uint256[][] (ragged): outer len + a nested element [${evmVersion}]`, async () => {
      const script = evscript({ name: 'rdMatrix', args: [t.uint256] }, (s, n) => {
        const m = asArr(
          s.read({ address: POOL, abi: matrixAbi, functionName: 'matrix', args: [n] }),
        );
        // m.at(3) → an inner uint256[] Expr; .length() and .at(2) read into it.
        const row3 = m.at(3n);
        return s.return({
          rows: m.length(),
          row3len: row3.length(),
          row3at2: row3.at(2n),
          row1at0: m.at(1n).at(0n),
        });
      });
      const [o] = await expectAgreement(
        script,
        [[4n]],
        { [POOL]: { kind: 'return', data: matrixReturndata } },
        evmVersion,
      );
      expect(o?.kind).toBe('return');
      const decoded = decodeFunctionResult({
        abi: script.abi,
        functionName: 'rdMatrix',
        data: o?.data ?? '0x',
      });
      expect(decoded).toEqual({
        rows: BigInt(MATRIX.length),
        row3len: BigInt(MATRIX[3].length),
        row3at2: MATRIX[3][2],
        row1at0: MATRIX[1][0],
      });
    });

    test(`(D) string[]: outer len + an element length [${evmVersion}]`, async () => {
      const script = evscript({ name: 'rdNames', args: [t.uint256] }, (s, n) => {
        const ns = asArr(
          s.read({ address: POOL, abi: namesAbi, functionName: 'names', args: [n] }),
        );
        return s.return({
          count: ns.length(),
          name2len: ns.at(2n).length(),
          name0len: ns.at(0n).length(),
        });
      });
      const [o] = await expectAgreement(
        script,
        [[4n]],
        { [POOL]: { kind: 'return', data: namesReturndata } },
        evmVersion,
      );
      expect(o?.kind).toBe('return');
      const decoded = decodeFunctionResult({
        abi: script.abi,
        functionName: 'rdNames',
        data: o?.data ?? '0x',
      });
      expect(decoded).toEqual({
        count: BigInt(NAMES.length),
        name2len: BigInt(new TextEncoder().encode(NAMES[2]).length),
        name0len: BigInt(new TextEncoder().encode(NAMES[0]).length),
      });
    });
  }
});

// ---------------------------------------------------------------------------
// 12d. composite arrays — RETURN PATH (encode) byte-exactness.
//
// Each shape: s.call a composite-element array and s.return THE WHOLE ARRAY. `expectAgreement`
// asserts interp == compiled EVM byte-for-byte (the interp's `encodeArrayTail` is proven == viem),
// and each case additionally decodes the returned bytes through viem `decodeAbiParameters` and
// asserts a round-trip to the original value. Every shape runs across paris/shanghai/cancun (the
// pre-cancun `@memcpy` height contract is the load-bearing risk).
// ---------------------------------------------------------------------------

/** Loose returnable handle: a composite-array call output is an `Expr` at runtime (precise
 *  inference is pinned by the type tests). Shared by the composite-array return-path corpus. */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- loose returnable corpus handle
const asExpr = (v: unknown): Expr => v as Expr;

describe('composite arrays (return path)', () => {
  const posComponents = [
    { name: 'nonce', type: 'uint96' },
    { name: 'operator', type: 'address' },
    { name: 'liquidity', type: 'uint128' },
  ] as const;
  const positionsBatchAbi = [
    {
      type: 'function',
      name: 'positionsBatch',
      stateMutability: 'view',
      inputs: [{ name: 'n', type: 'uint256' }],
      outputs: [{ name: '', type: 'tuple[]', components: posComponents }],
    },
  ] as const satisfies Abi;
  const POSITIONS = [
    {
      nonce: 1n,
      operator: getAddress('0x00000000000000000000000000000000000000a1'),
      liquidity: 111n,
    },
    {
      nonce: 2n,
      operator: getAddress('0x00000000000000000000000000000000000000a2'),
      liquidity: 222n,
    },
    {
      nonce: 3n,
      operator: getAddress('0x00000000000000000000000000000000000000a3'),
      liquidity: 333n,
    },
  ] as const;
  const positionsReturndata = encodeAbiParameters(
    [{ type: 'tuple[]', components: posComponents }],
    [POSITIONS],
  );

  const withBytesComponents = [
    { name: 'id', type: 'uint256' },
    { name: 'blob', type: 'bytes' },
  ] as const;
  const withBytesBatchAbi = [
    {
      type: 'function',
      name: 'withBytesBatch',
      stateMutability: 'view',
      inputs: [{ name: 'n', type: 'uint256' }],
      outputs: [{ name: '', type: 'tuple[]', components: withBytesComponents }],
    },
  ] as const satisfies Abi;
  const WITH_BYTES = [
    { id: 10n, blob: '0xdeadbeef' },
    { id: 20n, blob: `0x${'cd'.repeat(40)}` },
    { id: 30n, blob: '0x' },
  ] as const;
  const withBytesReturndata = encodeAbiParameters(
    [{ type: 'tuple[]', components: withBytesComponents }],
    [WITH_BYTES],
  );

  const matrixAbi = [
    {
      type: 'function',
      name: 'matrix',
      stateMutability: 'view',
      inputs: [{ name: 'n', type: 'uint256' }],
      outputs: [{ name: '', type: 'uint256[][]' }],
    },
  ] as const satisfies Abi;
  const MATRIX = [[1n], [2n, 3n], [], [4n, 5n, 6n, 7n]] as const;
  const matrixReturndata = encodeAbiParameters([{ type: 'uint256[][]' }], [MATRIX]);

  const namesAbi = [
    {
      type: 'function',
      name: 'names',
      stateMutability: 'view',
      inputs: [{ name: 'n', type: 'uint256' }],
      outputs: [{ name: '', type: 'string[]' }],
    },
  ] as const satisfies Abi;
  const NAMES = ['alpha', '', 'a-much-longer-string-spanning-two-words!!', 'z'] as const;
  const namesReturndata = encodeAbiParameters([{ type: 'string[]' }], [NAMES]);

  for (const evmVersion of EVM_VERSIONS) {
    test(`(A) return whole Position[] (static-elem) [${evmVersion}]`, async () => {
      const script = evscript({ name: 'retPositions', args: [t.uint256] }, (s, n) => {
        const ps = s.read({
          address: POOL,
          abi: positionsBatchAbi,
          functionName: 'positionsBatch',
          args: [n],
        });
        return s.return({ ps: asExpr(ps) });
      });
      const [o] = await expectAgreement(
        script,
        [[3n]],
        { [POOL]: { kind: 'return', data: positionsReturndata } },
        evmVersion,
      );
      expect(o?.kind).toBe('return');
      const decoded = decodeFunctionResult({
        abi: script.abi,
        functionName: 'retPositions',
        data: o?.data ?? '0x',
      });
      expect(decoded).toEqual({ ps: POSITIONS });
    });

    test(`(B) return whole WithBytes[] (dynamic-member elem) [${evmVersion}]`, async () => {
      const script = evscript({ name: 'retWithBytes', args: [t.uint256] }, (s, n) => {
        const xs = s.read({
          address: POOL,
          abi: withBytesBatchAbi,
          functionName: 'withBytesBatch',
          args: [n],
        });
        return s.return({ xs: asExpr(xs) });
      });
      const [o] = await expectAgreement(
        script,
        [[3n]],
        { [POOL]: { kind: 'return', data: withBytesReturndata } },
        evmVersion,
      );
      expect(o?.kind).toBe('return');
      const decoded = decodeFunctionResult({
        abi: script.abi,
        functionName: 'retWithBytes',
        data: o?.data ?? '0x',
      });
      expect(decoded).toEqual({ xs: WITH_BYTES });
    });

    test(`(C) return whole uint256[][] (ragged) [${evmVersion}]`, async () => {
      const script = evscript({ name: 'retMatrix', args: [t.uint256] }, (s, n) => {
        const m = s.read({ address: POOL, abi: matrixAbi, functionName: 'matrix', args: [n] });
        return s.return({ m: asExpr(m) });
      });
      const [o] = await expectAgreement(
        script,
        [[4n]],
        { [POOL]: { kind: 'return', data: matrixReturndata } },
        evmVersion,
      );
      expect(o?.kind).toBe('return');
      const decoded = decodeFunctionResult({
        abi: script.abi,
        functionName: 'retMatrix',
        data: o?.data ?? '0x',
      });
      expect(decoded).toEqual({ m: MATRIX });
    });

    test(`(D) return whole string[] [${evmVersion}]`, async () => {
      const script = evscript({ name: 'retNames', args: [t.uint256] }, (s, n) => {
        const ns = s.read({ address: POOL, abi: namesAbi, functionName: 'names', args: [n] });
        return s.return({ ns: asExpr(ns) });
      });
      const [o] = await expectAgreement(
        script,
        [[4n]],
        { [POOL]: { kind: 'return', data: namesReturndata } },
        evmVersion,
      );
      expect(o?.kind).toBe('return');
      const decoded = decodeFunctionResult({
        abi: script.abi,
        functionName: 'retNames',
        data: o?.data ?? '0x',
      });
      expect(decoded).toEqual({ ns: NAMES });
    });
  }
});

// ---------------------------------------------------------------------------
// 12e. composite arrays — CALL-ARG encode + CONSTRUCT + LITERAL.
//
// (a) CALL-ARG: forward a decoded/constructed composite array as a sub-call ARG; assert the recorded
//     calldata is byte-identical to viem `encodeFunctionData` (interp == compiled EVM is the
//     `expectAgreement` gate; the calldata == viem check pins the wire bytes).
// (b) CONSTRUCT: `s.newArray` a tuple[]/uint256[][]/string[], `arrset` each element (Tuple handles /
//     literals), RETURN the whole array; assert byte-exact vs viem `encodeAbiParameters`.
// (c) LITERAL: a composite-array literal passed as an arg / returned.
// Every shape runs across paris/shanghai/cancun (the scratch-frame `@memcpy` height contract is the
// load-bearing risk for the dynamic-element encode loop).
// ---------------------------------------------------------------------------

describe('composite arrays (call-arg encode + construct + literal)', () => {
  // loose builder handles for the corpus (precise inference is pinned by the type tests); the
  // returnable `asExpr` is the module-level helper shared with the return-path corpus.
  interface MutLike {
    set(i: bigint, v: unknown): void;
    expr(): Expr;
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- loose MutArray handle for the corpus
  const asMut = (v: unknown): MutLike => v as MutLike;

  const posComponents = [
    { name: 'nonce', type: 'uint96' },
    { name: 'operator', type: 'address' },
    { name: 'liquidity', type: 'uint128' },
  ] as const;
  const Position = t.struct({
    nonce: t.uint96,
    operator: t.address,
    liquidity: t.uint128,
  });
  const POSITIONS = [
    {
      nonce: 1n,
      operator: getAddress('0x00000000000000000000000000000000000000a1'),
      liquidity: 111n,
    },
    {
      nonce: 2n,
      operator: getAddress('0x00000000000000000000000000000000000000a2'),
      liquidity: 222n,
    },
    {
      nonce: 7n,
      operator: getAddress('0x00000000000000000000000000000000000000a7'),
      liquidity: 700n,
    },
  ] as const;
  const positionsReturndata = encodeAbiParameters(
    [{ type: 'tuple[]', components: posComponents }],
    [POSITIONS],
  );

  // positionsBatch (source of a decoded tuple[]) + sumLiquidity (a tuple[]-taking view fn).
  const poolAbi = [
    {
      type: 'function',
      name: 'positionsBatch',
      stateMutability: 'view',
      inputs: [{ name: 'n', type: 'uint256' }],
      outputs: [{ name: '', type: 'tuple[]', components: posComponents }],
    },
    {
      type: 'function',
      name: 'sumLiquidity',
      stateMutability: 'view',
      inputs: [{ name: 'ps', type: 'tuple[]', components: posComponents }],
      outputs: [{ name: '', type: 'uint256' }],
    },
  ] as const satisfies Abi;

  // a `sink(tuple[] ps) returns (bytes)` echo: lets the script return the recorded sub-call calldata
  // (bytes), so interp's `respond` and the EVM `runtime` produce identical results (the
  // call-arg encode is what we assert byte-exact vs viem). Numeric `sumLiquidity` semantics are
  // covered by the real-solc integration test.
  const sinkPositionsAbi = [
    {
      type: 'function',
      name: 'sink',
      stateMutability: 'view',
      inputs: [{ name: 'ps', type: 'tuple[]', components: posComponents }],
      outputs: [{ name: '', type: 'bytes' }],
    },
  ] as const satisfies Abi;

  // echo-mock-taking ABIs for the word-array / string-array call args.
  const sinkMatrixAbi = [
    {
      type: 'function',
      name: 'sink',
      stateMutability: 'view',
      inputs: [{ name: 'm', type: 'uint256[][]' }],
      outputs: [{ name: '', type: 'bytes' }],
    },
  ] as const satisfies Abi;
  const sinkNamesAbi = [
    {
      type: 'function',
      name: 'sink',
      stateMutability: 'view',
      inputs: [{ name: 'ns', type: 'string[]' }],
      outputs: [{ name: '', type: 'bytes' }],
    },
  ] as const satisfies Abi;

  const MATRIX = [[1n], [2n, 3n], [], [4n, 5n, 6n, 7n]] as const;
  const NAMES = ['alpha', '', 'a-much-longer-string-spanning-two-words!!', 'z'] as const;

  for (const evmVersion of EVM_VERSIONS) {
    // (a1) CALL-ARG: forward a DECODED Position[] into sink(tuple[] ps); the echo callee returns the
    //      recorded calldata as bytes, which we assert == viem encodeFunctionData(sink, [POSITIONS]).
    test(`(a1) forward decoded Position[] as a call arg → calldata == viem [${evmVersion}]`, async () => {
      const script = evscript({ name: 'fwdPositions' }, (s) => {
        const ps = s.read({
          address: POOL,
          abi: poolAbi,
          functionName: 'positionsBatch',
          args: [3n],
        });
        const echoed = s.read({
          address: SINK,
          abi: sinkPositionsAbi,
          functionName: 'sink',
          args: [ps],
        });
        return s.return({ echoed: asExpr(echoed) });
      });
      const expectedCalldata = encodeFunctionData({
        abi: sinkPositionsAbi,
        functionName: 'sink',
        args: [POSITIONS],
      });
      const [o] = await expectAgreement(
        script,
        [[]],
        {
          [POOL]: { kind: 'return', data: positionsReturndata },
          [SINK]: {
            kind: 'bytecode',
            runtime: abiEchoMock(),
            respond: (calldata) => ({
              success: true,
              data: encodeAbiParameters([{ type: 'bytes' }], [calldata]),
            }),
          },
        },
        evmVersion,
      );
      expect(o?.kind).toBe('return');
      const decoded = decodeFunctionResult({
        abi: script.abi,
        functionName: 'fwdPositions',
        data: o?.data ?? '0x',
      });
      // the recorded sub-call calldata is byte-identical to viem's sink(POSITIONS) encoding.
      expect(decoded).toEqual({ echoed: expectedCalldata });
    });

    // (a2) CALL-ARG: forward a ragged uint256[][] literal to an echo sink; calldata == viem.
    test(`(a2) forward a uint256[][] literal as a call arg → calldata == viem [${evmVersion}]`, async () => {
      const script = evscript({ name: 'fwdMatrix' }, (s) => {
        const echoed = s.read({
          address: SINK,
          abi: sinkMatrixAbi,
          functionName: 'sink',
          args: [MATRIX],
        });
        return s.return({ echoed: asExpr(echoed) });
      });
      const expectedCalldata = encodeFunctionData({
        abi: sinkMatrixAbi,
        functionName: 'sink',
        args: [MATRIX],
      });
      const [o] = await expectAgreement(
        script,
        [[]],
        {
          [SINK]: {
            kind: 'bytecode',
            runtime: abiEchoMock(),
            respond: (calldata) => ({
              success: true,
              data: encodeAbiParameters([{ type: 'bytes' }], [calldata]),
            }),
          },
        },
        evmVersion,
      );
      expect(o?.kind).toBe('return');
      const decoded = decodeFunctionResult({
        abi: script.abi,
        functionName: 'fwdMatrix',
        data: o?.data ?? '0x',
      });
      expect(decoded).toEqual({ echoed: expectedCalldata });
    });

    // (a3) CALL-ARG: forward a string[] literal to an echo sink; calldata == viem.
    test(`(a3) forward a string[] literal as a call arg → calldata == viem [${evmVersion}]`, async () => {
      const script = evscript({ name: 'fwdNames' }, (s) => {
        const echoed = s.read({
          address: SINK,
          abi: sinkNamesAbi,
          functionName: 'sink',
          args: [NAMES],
        });
        return s.return({ echoed: asExpr(echoed) });
      });
      const expectedCalldata = encodeFunctionData({
        abi: sinkNamesAbi,
        functionName: 'sink',
        args: [NAMES],
      });
      const [o] = await expectAgreement(
        script,
        [[]],
        {
          [SINK]: {
            kind: 'bytecode',
            runtime: abiEchoMock(),
            respond: (calldata) => ({
              success: true,
              data: encodeAbiParameters([{ type: 'bytes' }], [calldata]),
            }),
          },
        },
        evmVersion,
      );
      expect(o?.kind).toBe('return');
      const decoded = decodeFunctionResult({
        abi: script.abi,
        functionName: 'fwdNames',
        data: o?.data ?? '0x',
      });
      expect(decoded).toEqual({ echoed: expectedCalldata });
    });

    // (b1) CONSTRUCT: s.newArray a tuple[], arrset Tuple handles, RETURN it → byte-exact vs viem.
    test(`(b1) construct a Position[] (s.newArray + arrset Tuple handles), return → byte-exact [${evmVersion}]`, async () => {
      const script = evscript({ name: 'mkPositions' }, (s) => {
        const arr = asMut(s.newArray(Position, BigInt(POSITIONS.length)));
        POSITIONS.forEach((p, i) => {
          const tup = s.tuple(Position, {
            nonce: p.nonce,
            operator: p.operator,
            liquidity: p.liquidity,
          });
          arr.set(BigInt(i), tup);
        });
        return s.return({ ps: arr.expr() });
      });
      const [o] = await expectAgreement(script, [[]], {}, evmVersion);
      expect(o?.kind).toBe('return');
      const decoded = decodeFunctionResult({
        abi: script.abi,
        functionName: 'mkPositions',
        data: o?.data ?? '0x',
      });
      expect(decoded).toEqual({ ps: POSITIONS });
      // and the returned bytes are byte-identical to viem's encoding of the script-return tuple (the
      // return record is encoded as a single top-level tuple `(tuple[] ps)`, so the wire form
      // is `[tuple offset 0x20][ps offset 0x20][tuple[] payload]`).
      expect(o?.data).toEqual(
        encodeAbiParameters(
          [
            {
              type: 'tuple',
              components: [{ name: 'ps', type: 'tuple[]', components: posComponents }],
            },
          ],
          [{ ps: POSITIONS }],
        ),
      );
    });

    // (b2) CONSTRUCT: s.newArray a uint256[][], arrset inner-array literals, return → byte-exact.
    test(`(b2) construct a uint256[][] (arrset inner-array literals), return → byte-exact [${evmVersion}]`, async () => {
      const script = evscript({ name: 'mkMatrix' }, (s) => {
        const arr = asMut(s.newArray('uint256[]', BigInt(MATRIX.length)));
        MATRIX.forEach((row, i) => arr.set(BigInt(i), row));
        return s.return({ m: arr.expr() });
      });
      const [o] = await expectAgreement(script, [[]], {}, evmVersion);
      expect(o?.kind).toBe('return');
      const decoded = decodeFunctionResult({
        abi: script.abi,
        functionName: 'mkMatrix',
        data: o?.data ?? '0x',
      });
      expect(decoded).toEqual({ m: MATRIX });
    });

    // (b3) CONSTRUCT: s.newArray a string[], arrset string literals, return → byte-exact.
    test(`(b3) construct a string[] (arrset string literals), return → byte-exact [${evmVersion}]`, async () => {
      const script = evscript({ name: 'mkNames' }, (s) => {
        const arr = asMut(s.newArray('string', BigInt(NAMES.length)));
        NAMES.forEach((nm, i) => arr.set(BigInt(i), nm));
        return s.return({ ns: arr.expr() });
      });
      const [o] = await expectAgreement(script, [[]], {}, evmVersion);
      expect(o?.kind).toBe('return');
      const decoded = decodeFunctionResult({
        abi: script.abi,
        functionName: 'mkNames',
        data: o?.data ?? '0x',
      });
      expect(decoded).toEqual({ ns: NAMES });
    });

    // (c) LITERAL: a composite-array LITERAL (uint256[][]) built at record time and returned directly
    //     → byte-exact vs viem.
    test(`(c) return a uint256[][] composite-array LITERAL → byte-exact [${evmVersion}]`, async () => {
      const script = evscript({ name: 'litMatrix' }, (s) => {
        const lit = s.lit('uint256[][]', MATRIX);
        return s.return({ m: asExpr(lit) });
      });
      const [o] = await expectAgreement(script, [[]], {}, evmVersion);
      expect(o?.kind).toBe('return');
      const decoded = decodeFunctionResult({
        abi: script.abi,
        functionName: 'litMatrix',
        data: o?.data ?? '0x',
      });
      expect(decoded).toEqual({ m: MATRIX });
    });
  }
});
