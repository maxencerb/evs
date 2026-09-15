/**
 * Differential suite — composite types, composite regression (all three EVM versions).
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
  TOKA,
  TOKB,
  POOL,
  ECHO,
  USER,
  EVM_VERSIONS,
  abiEchoMock,
} from '../../test/harness/differential.js';
import { evscript } from '../builder/script.js';
import { t } from '../core/types.js';

// ---------------------------------------------------------------------------
// 12. composite types — tuple decode (struct output) + tuple construct/encode (issue #2)
// ---------------------------------------------------------------------------

describe('composite types', () => {
  // a five-field static struct, the Composite.Position shape (mirrors UniV3 positions()).
  const positionComponents = [
    { name: 'nonce', type: 'uint96' },
    { name: 'operator', type: 'address' },
    { name: 'liquidity', type: 'uint128' },
    { name: 'feeGrowthInside0', type: 'uint256' },
    { name: 'feeGrowthInside1', type: 'uint256' },
  ] as const;
  const positionAbi = [
    {
      type: 'function',
      name: 'positions',
      stateMutability: 'view',
      inputs: [{ name: 'tokenId', type: 'uint256' }],
      outputs: [{ name: '', type: 'tuple', components: positionComponents }],
    },
  ] as const satisfies Abi;
  const Position = t.struct({
    nonce: t.uint96,
    operator: t.address,
    liquidity: t.uint128,
    feeGrowthInside0: t.uint256,
    feeGrowthInside1: t.uint256,
  });
  const OPERATOR = getAddress('0x00000000000000000000000000000000000000aa');
  const POSITION = {
    nonce: 7n,
    operator: OPERATOR,
    liquidity: 123_456n,
    feeGrowthInside0: 1n << 200n,
    feeGrowthInside1: (1n << 255n) | 9n,
  } as const;
  // the mock callee returns viem's canonical tuple encoding — the differential oracle.
  const positionReturndata = encodeAbiParameters(
    [{ type: 'tuple', components: positionComponents }],
    [POSITION],
  );

  for (const evmVersion of ['paris', 'shanghai', 'cancun'] as const) {
    test(`decode a struct output and return a field [${evmVersion}]`, async () => {
      // (a) decode the Position output, read a static field after the head/tail decode.
      const script = evscript({ name: 'getLiq', args: [t.uint256] }, (s, tokenId) => {
        const pos = s.read({
          address: POOL,
          abi: positionAbi,
          functionName: 'positions',
          args: [tokenId],
        });
        return s.return({ liquidity: pos.liquidity.get(), operator: pos.operator.get() });
      });
      const [o] = await expectAgreement(
        script,
        [[1n]],
        { [POOL]: { kind: 'return', data: positionReturndata } },
        evmVersion,
      );
      expect(o?.kind).toBe('return');
      const decoded = decodeFunctionResult({
        abi: script.abi,
        functionName: 'getLiq',
        data: o?.data ?? '0x',
      });
      expect(decoded).toEqual({ liquidity: POSITION.liquidity, operator: POSITION.operator });
    });

    test(`decode a struct output and return the whole tuple [${evmVersion}]`, async () => {
      // (a′) re-encode the decoded tuple as a tuple OUTPUT — flat-block → ABI head/tail must
      // round-trip byte-exactly against viem's tuple codec.
      const script = evscript({ name: 'echoPos', args: [t.uint256] }, (s, tokenId) => {
        const pos = s.read({
          address: POOL,
          abi: positionAbi,
          functionName: 'positions',
          args: [tokenId],
        });
        return s.return({ pos: pos.expr() });
      });
      const [o] = await expectAgreement(
        script,
        [[1n]],
        { [POOL]: { kind: 'return', data: positionReturndata } },
        evmVersion,
      );
      const decoded = decodeFunctionResult({
        abi: script.abi,
        functionName: 'echoPos',
        data: o?.data ?? '0x',
      });
      expect(decoded).toEqual({ pos: POSITION });
    });

    test(`construct a tuple and return it [${evmVersion}]`, async () => {
      // (b) build a Position from scratch (alloc + zero-fill + MSTORE provided members), mutate
      // one field, then return the tuple — encode bytes must equal viem's.
      const script = evscript({ name: 'mkPos', args: [t.address, t.uint128] }, (s, owner, liq) => {
        const pos = s.tuple(Position, {
          nonce: 7n,
          operator: owner,
          liquidity: liq,
          feeGrowthInside0: 1n << 200n,
          // feeGrowthInside1 omitted → zero-filled
        });
        pos.feeGrowthInside1.set((1n << 255n) | 9n);
        return s.return({ pos: pos.expr() });
      });
      const [o] = await expectAgreement(
        script,
        [[POSITION.operator, POSITION.liquidity]],
        {},
        evmVersion,
      );
      expect(o?.kind).toBe('return');
      const decoded = decodeFunctionResult({
        abi: script.abi,
        functionName: 'mkPos',
        data: o?.data ?? '0x',
      });
      expect(decoded).toEqual({ pos: POSITION });
    });
  }
});

// ---------------------------------------------------------------------------
// 12b. composite regression — adversarial byte-exactness of the tuple codec/interp.
//
// Each shape compiles an evs script whose mock callee returndata is viem's canonical tuple
// encoding (encodeAbiParameters([{type:'tuple',components}],[obj])). `expectAgreement` already
// asserts interp == in-process EVM runtime BYTE-FOR-BYTE; we then decode the agreed returndata
// with viem to close the third leg (interp == EVM == viem). Every shape runs across
// paris/shanghai/cancun.
// ---------------------------------------------------------------------------

describe('composite regression', () => {
  // (1) ALL-STATIC struct — slot0Struct shape: uint160,int24,uint16,uint8,bool. A static tuple
  //     inlines headBytes(components) head words (no offset). Decode + return several fields.
  const slot0Components = [
    { name: 'sqrtPriceX96', type: 'uint160' },
    { name: 'tick', type: 'int24' },
    { name: 'observationIndex', type: 'uint16' },
    { name: 'feeProtocol', type: 'uint8' },
    { name: 'unlocked', type: 'bool' },
  ] as const;
  const slot0Abi = [
    {
      type: 'function',
      name: 'slot0Struct',
      stateMutability: 'view',
      inputs: [],
      outputs: [{ name: '', type: 'tuple', components: slot0Components }],
    },
  ] as const satisfies Abi;
  const SLOT0 = {
    sqrtPriceX96: 1n << 96n,
    tick: -887272,
    observationIndex: 3,
    feeProtocol: 4,
    unlocked: true,
  } as const;
  const slot0Returndata = encodeAbiParameters(
    [{ type: 'tuple', components: slot0Components }],
    [SLOT0],
  );

  for (const evmVersion of EVM_VERSIONS) {
    test(`(1) all-static struct: decode + return several fields [${evmVersion}]`, async () => {
      const script = evscript({ name: 'rdSlot0', args: [] }, (s) => {
        const slot0 = s.read({ address: POOL, abi: slot0Abi, functionName: 'slot0Struct' });
        return s.return({
          price: slot0.sqrtPriceX96.get(),
          tick: slot0.tick.get(),
          obs: slot0.observationIndex.get(),
          locked: s.not(slot0.unlocked.get()),
        });
      });
      const [o] = await expectAgreement(
        script,
        [[]],
        { [POOL]: { kind: 'return', data: slot0Returndata } },
        evmVersion,
      );
      expect(o?.kind).toBe('return');
      const decoded = decodeFunctionResult({
        abi: script.abi,
        functionName: 'rdSlot0',
        data: o?.data ?? '0x',
      });
      expect(decoded).toEqual({
        price: SLOT0.sqrtPriceX96,
        tick: SLOT0.tick,
        obs: SLOT0.observationIndex,
        locked: !SLOT0.unlocked,
      });
    });
  }

  // (2) struct with a DYNAMIC member — WithBytes{uint256 id, bytes data}. The tuple itself is
  //     ABI-dynamic; decode aliases the bytes member into the snapshot. Return both fields.
  const withBytesComponents = [
    { name: 'id', type: 'uint256' },
    { name: 'data', type: 'bytes' },
  ] as const;
  const withBytesAbi = [
    {
      type: 'function',
      name: 'getWithBytes',
      stateMutability: 'view',
      inputs: [],
      outputs: [{ name: '', type: 'tuple', components: withBytesComponents }],
    },
  ] as const satisfies Abi;
  const WITH_BYTES = { id: 0xc0ffeen, data: '0x6576732100' } as const;

  for (const evmVersion of EVM_VERSIONS) {
    test(`(2) struct with a dynamic member: return both fields [${evmVersion}]`, async () => {
      const withBytesReturndata = encodeAbiParameters(
        [{ type: 'tuple', components: withBytesComponents }],
        [WITH_BYTES],
      );
      const script = evscript({ name: 'rdWithBytes', args: [] }, (s) => {
        const wb = s.read({ address: POOL, abi: withBytesAbi, functionName: 'getWithBytes' });
        const data = wb.data.get();
        return s.return({ id: wb.id.get(), data, len: data.length() });
      });
      const [o] = await expectAgreement(
        script,
        [[]],
        { [POOL]: { kind: 'return', data: withBytesReturndata } },
        evmVersion,
      );
      expect(o?.kind).toBe('return');
      const decoded = decodeFunctionResult({
        abi: script.abi,
        functionName: 'rdWithBytes',
        data: o?.data ?? '0x',
      });
      expect(decoded).toEqual({ id: WITH_BYTES.id, data: WITH_BYTES.data, len: 5n });
    });
  }

  // (3) NESTED struct — Outer{Inner{bool a, bytes32 b}, uint256 x}. All-static nested tuple:
  //     the inner tuple inlines into the outer head. Read a DEEP field (outer.inner.b).
  const innerComponents = [
    { name: 'a', type: 'bool' },
    { name: 'b', type: 'bytes32' },
  ] as const;
  const outerComponents = [
    { name: 'inner', type: 'tuple', components: innerComponents },
    { name: 'x', type: 'uint256' },
  ] as const;
  const outerAbi = [
    {
      type: 'function',
      name: 'getOuter',
      stateMutability: 'view',
      inputs: [],
      outputs: [{ name: '', type: 'tuple', components: outerComponents }],
    },
  ] as const satisfies Abi;
  const INNER_B = `0x${'5e'.repeat(32)}` as const;
  const OUTER = { inner: { a: true, b: INNER_B }, x: 0xdeadbeefn } as const;

  for (const evmVersion of EVM_VERSIONS) {
    test(`(3) nested struct: read a deep field [${evmVersion}]`, async () => {
      const outerReturndata = encodeAbiParameters(
        [{ type: 'tuple', components: outerComponents }],
        [OUTER],
      );
      const script = evscript({ name: 'rdOuter', args: [] }, (s) => {
        const outer = s.read({ address: POOL, abi: outerAbi, functionName: 'getOuter' });
        const inner = outer.inner.get(); // follows the pointer to the inner Tuple handle
        return s.return({ a: inner.a.get(), b: inner.b.get(), x: outer.x.get() });
      });
      const [o] = await expectAgreement(
        script,
        [[]],
        { [POOL]: { kind: 'return', data: outerReturndata } },
        evmVersion,
      );
      expect(o?.kind).toBe('return');
      const decoded = decodeFunctionResult({
        abi: script.abi,
        functionName: 'rdOuter',
        data: o?.data ?? '0x',
      });
      expect(decoded).toEqual({ a: OUTER.inner.a, b: OUTER.inner.b, x: OUTER.x });
    });
  }

  // (4) CONSTRUCT a tuple via s.tuple with some fields omitted (default-zero) and some set, mutate
  //     one with .set(), then return it. Bytes must equal viem encode of the expected object.
  const WB_TYPE = t.struct({ id: t.uint256, data: t.bytes });

  for (const evmVersion of EVM_VERSIONS) {
    test(`(4) construct via s.tuple (omitted→zero) + .set(), return it [${evmVersion}]`, async () => {
      const script = evscript({ name: 'mkWithBytes', args: [t.bytes] }, (s, payload) => {
        const wb = s.tuple(WB_TYPE, {
          // id omitted → zero-filled
          data: payload,
        });
        wb.id.set(0xc0ffeen);
        return s.return({ wb: wb.expr() });
      });
      const [o] = await expectAgreement(script, [[WITH_BYTES.data]], {}, evmVersion);
      expect(o?.kind).toBe('return');
      const decoded = decodeFunctionResult({
        abi: script.abi,
        functionName: 'mkWithBytes',
        data: o?.data ?? '0x',
      });
      expect(decoded).toEqual({ wb: { id: WITH_BYTES.id, data: WITH_BYTES.data } });
    });
  }

  // (5) ENCODE a struct as a CALL ARGUMENT — quote(QuoteParams). Assert the sub-call calldata
  //     bytes == viem encodeFunctionData('quote',[paramsObj]). A mock callee records calldata by
  //     echoing it back ABI-wrapped as bytes; the script returns it verbatim.
  const quoteParamsComponents = [
    { name: 'tokenIn', type: 'address' },
    { name: 'tokenOut', type: 'address' },
    { name: 'fee', type: 'uint24' },
    { name: 'amountIn', type: 'uint256' },
  ] as const;
  const quoteAbi = [
    {
      type: 'function',
      name: 'quote',
      stateMutability: 'view',
      inputs: [{ name: 'p', type: 'tuple', components: quoteParamsComponents }],
      outputs: [{ name: '', type: 'bytes' }],
    },
  ] as const satisfies Abi;
  const QuoteParams = t.struct({
    tokenIn: t.address,
    tokenOut: t.address,
    fee: t.uint24,
    amountIn: t.uint256,
  });
  const QPARAMS = {
    tokenIn: getAddress(TOKA),
    tokenOut: getAddress(TOKB),
    fee: 3000,
    amountIn: 1_000_000_000_000_000_000n,
  } as const;

  for (const evmVersion of EVM_VERSIONS) {
    test(`(5) encode struct as a call ARGUMENT: calldata == viem [${evmVersion}]`, async () => {
      const script = evscript(
        { name: 'callQuote', args: [t.address, t.uint256] },
        (s, tin, amt) => {
          const params = s.tuple(QuoteParams, {
            tokenIn: tin,
            tokenOut: TOKB,
            fee: 3000n,
            amountIn: amt,
          });
          const out = s.read({
            address: ECHO,
            abi: quoteAbi,
            functionName: 'quote',
            args: [params],
          });
          return s.return({ calldata: out });
        },
      );
      const [o] = await expectAgreement(
        script,
        [[QPARAMS.tokenIn, QPARAMS.amountIn]],
        {
          [ECHO]: {
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
        functionName: 'callQuote',
        data: o?.data ?? '0x',
      });
      // the recorded sub-call calldata must be byte-identical to viem's encoding of quote(params)
      const expectedCalldata = encodeFunctionData({
        abi: quoteAbi,
        functionName: 'quote',
        args: [QPARAMS],
      });
      expect(decoded).toEqual({ calldata: expectedCalldata });
    });
  }

  // (6) a tuple whose members MIX static + dynamic so the head has both inline words AND offsets.
  //     Mixed{uint256 a, bytes b, address c, uint256[] d}: head = [word a][off b][word c][off d].
  //     Decode and return every field — exercises a non-trivial head/tail interleave on decode.
  const mixedComponents = [
    { name: 'a', type: 'uint256' },
    { name: 'b', type: 'bytes' },
    { name: 'c', type: 'address' },
    { name: 'd', type: 'uint256[]' },
  ] as const;
  const mixedAbi = [
    {
      type: 'function',
      name: 'getMixed',
      stateMutability: 'view',
      inputs: [],
      outputs: [{ name: '', type: 'tuple', components: mixedComponents }],
    },
  ] as const satisfies Abi;
  const MIXED = {
    a: (1n << 200n) | 7n,
    b: `0x${'ab'.repeat(40)}`,
    c: getAddress(USER),
    d: [11n, 22n, 33n],
  } as const;

  for (const evmVersion of EVM_VERSIONS) {
    test(`(6) mixed static+dynamic members (head has words and offsets) [${evmVersion}]`, async () => {
      const mixedReturndata = encodeAbiParameters(
        [{ type: 'tuple', components: mixedComponents }],
        [MIXED],
      );
      const script = evscript({ name: 'rdMixed', args: [] }, (s) => {
        const m = s.read({ address: POOL, abi: mixedAbi, functionName: 'getMixed' });
        const b = m.b.get();
        const d = m.d.get();
        return s.return({
          a: m.a.get(),
          b,
          c: m.c.get(),
          d,
          blen: b.length(),
          dlen: d.length(),
          d1: d.at(1n),
        });
      });
      const [o] = await expectAgreement(
        script,
        [[]],
        { [POOL]: { kind: 'return', data: mixedReturndata } },
        evmVersion,
      );
      expect(o?.kind).toBe('return');
      const decoded = decodeFunctionResult({
        abi: script.abi,
        functionName: 'rdMixed',
        data: o?.data ?? '0x',
      });
      expect(decoded).toEqual({
        a: MIXED.a,
        b: MIXED.b,
        c: MIXED.c,
        d: MIXED.d,
        blen: BigInt((MIXED.b.length - 2) / 2),
        dlen: BigInt(MIXED.d.length),
        d1: MIXED.d[1],
      });
    });
  }
});
