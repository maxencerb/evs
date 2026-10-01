/**
 * Differential suite — the workaround recipes the arithmetic guide documents for operations evs
 * does not have yet (`guides/arithmetic.mdx`, "Not supported yet").
 *
 * One slice of the anti-miscompilation corpus: `interpret(script.ir)` must agree byte-for-byte
 * with the compiled bytecode (default output and its `optimize: true` twin), and on top of that
 * each recipe is pinned to an independent oracle — BigInt for the wrapping multiply, viem's
 * `getContractAddress` (and the live mainnet pool address) for the CREATE2 derivation — so a
 * documented recipe that stops computing what the guide says fails here. Keep the recipes below
 * identical to the guide's snippets.
 */

import {
  decodeFunctionResult,
  encodeAbiParameters,
  getAddress,
  getContractAddress,
  keccak256,
  type Address,
} from 'viem';
import { describe, expect, test } from 'vite-plus/test';

import { expectAgreement } from '../../test/harness/differential.js';
import { evscript } from '../builder/script.js';
import { t, type Expr } from '../core/types.js';

// ---------------------------------------------------------------------------
// wrapping multiplication from mulmod / addmod
// ---------------------------------------------------------------------------

const LOW_128 = (1n << 128n) - 1n;
const TWO_128 = 1n << 128n;
const MAX_UINT256 = (1n << 256n) - 1n;

/** a * b mod 2^256: Solidity's unchecked multiply, from full-precision mulmod / addmod. */
function wrappingMul(a: Expr<'uint256'>, b: Expr<'uint256'>): Expr<'uint256'> {
  const aLo = a.bitAnd(LOW_128);
  const aHi = a.shr(128n);
  const bLo = b.bitAnd(LOW_128);
  const bHi = b.shr(128n);
  // aLo * bLo < 2^256 − 1, so reducing it modulo 2^256 − 1 keeps the exact product
  const low = aLo.mulmod(bLo, MAX_UINT256);
  // only the low 128 bits of the cross terms survive the shift into the high half
  const cross = aLo.mulmod(bHi, TWO_128).addmod(aHi.mulmod(bLo, TWO_128), TWO_128);
  const high = low.shr(128n).addmod(cross, TWO_128);
  return high.shl(128n).bitOr(low.bitAnd(LOW_128));
}

describe('recipe: wrapping multiplication', () => {
  test('matches a * b mod 2^256 across the limb boundaries', async () => {
    const script = evscript({ name: 'wmul', args: [t.uint256, t.uint256] }, (s, a, b) =>
      s.return({ product: wrappingMul(a, b) }),
    );
    const edges = [0n, 1n, 3n, LOW_128, TWO_128, TWO_128 + 1n, 1n << 255n, MAX_UINT256];
    const pairs = edges.flatMap((a) => edges.map((b) => [a, b] as const));
    pairs.push([(1n << 230n) + 12_345n, (1n << 230n) + 12_345n], [MAX_UINT256 - 7n, 0xdeadbeefn]);
    const outcomes = await expectAgreement(script, pairs);
    outcomes.forEach((o, i) => {
      const [a, b] = pairs[i] ?? [0n, 0n];
      expect(o.kind).toBe('return');
      expect(
        decodeFunctionResult({ abi: script.abi, functionName: 'wmul', data: o.data }),
        `${a} * ${b}`,
      ).toEqual({ product: (a * b) & MAX_UINT256 });
    });
  });
});

// ---------------------------------------------------------------------------
// address ordering through uint160 + CREATE2 derivation
// ---------------------------------------------------------------------------

const FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
const POOL_INIT_CODE_HASH = '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54';

const poolAddress = evscript(
  { name: 'poolAddress', args: [t.uint160, t.uint160, t.uint24] }, // tokens passed as BigInt(address)
  (s, tokenA, tokenB, fee) => {
    const aFirst = tokenA.lt(tokenB); // Uniswap's token0 < token1 ordering
    const token0 = s.select(aFirst, tokenA, tokenB).toUint(t.uint256).asAddress();
    const token1 = s.select(aFirst, tokenB, tokenA).toUint(t.uint256).asAddress();
    const salt = s.keccak256(token0, token1, fee); // keccak256(abi.encode(token0, token1, fee))
    const hash = s.keccak256(
      s.encodePacked(
        s.lit(t.bytes1, '0xff'),
        s.lit(t.address, FACTORY),
        salt,
        s.lit(t.bytes32, POOL_INIT_CODE_HASH),
      ),
    );
    const pool = hash
      .asUint256()
      .bitAnd((1n << 160n) - 1n)
      .asAddress(); // the low 20 bytes
    return s.return({ token0, token1, pool });
  },
);

/** The CREATE2 pool address computed off-chain by viem, the oracle for the in-script recipe. */
function expectedPool(token0: Address, token1: Address, fee: number): Address {
  return getContractAddress({
    opcode: 'CREATE2',
    from: FACTORY,
    salt: keccak256(
      encodeAbiParameters(
        [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }],
        [token0, token1, fee],
      ),
    ),
    bytecodeHash: POOL_INIT_CODE_HASH,
  });
}

describe('recipe: address ordering via uint160 and CREATE2', () => {
  const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
  const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

  test('sorts the pair and derives the pool address, in either argument order', async () => {
    const argSets = [
      [BigInt(WETH), BigInt(USDC), 500], // unsorted: WETH > USDC numerically
      [BigInt(USDC), BigInt(WETH), 500],
      [BigInt(USDC), BigInt(WETH), 3000],
    ] as const;
    const outcomes = await expectAgreement(poolAddress, argSets);
    const decoded = outcomes.map((o) =>
      decodeFunctionResult({ abi: poolAddress.abi, functionName: 'poolAddress', data: o.data }),
    );
    for (const [i, out] of decoded.entries()) {
      const fee = argSets[i]?.[2] ?? 0;
      expect(out.token0).toBe(getAddress(USDC));
      expect(out.token1).toBe(getAddress(WETH));
      expect(out.pool).toBe(expectedPool(USDC, WETH, fee));
    }
    // the live mainnet USDC/WETH 0.05% pool
    expect(decoded[0]?.pool).toBe('0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640');
  });
});
