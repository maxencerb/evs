/**
 * Premade playground scripts. Each is a complete program: it defines a script,
 * compiles it, runs it through viem against the RPC in the toolbar, and logs the
 * result — exactly what you'd run locally with `bun run`.
 *
 * Kept in sync with the runtime by `scripts/check-playground-examples.ts`, which
 * type-checks every example against the same d.ts payload Monaco loads and
 * executes it against the built runtime bundles.
 */

export interface PlaygroundExample {
  id: string;
  label: string;
  code: string;
}

const dependentReads = `import { evscript, t } from '@maxencerb/evs';
import { createPublicClient, http, erc20Abi } from 'viem';

// Two DEPENDENT reads in ONE eth_call: the second call's target IS the first
// call's result. A multicall can't batch this — it needs every address up front.
const poolAbi = [
  {
    type: 'function',
    name: 'token0',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

export const poolToken0 = evscript({ name: 'poolToken0', args: [t.address] }, (s, pool) => {
  const token0 = s.read({ address: pool, abi: poolAbi, functionName: 'token0' });
  const symbol = s.read({ address: token0, abi: erc20Abi, functionName: 'symbol' });
  return s.return({ token0, symbol });
});

const client = createPublicClient({ transport: http() });

const res = await client.readContract({
  ...poolToken0.compile().toViem(),
  functionName: 'poolToken0',
  args: ['0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'], // Uniswap V3 USDC/WETH 0.05%
});

console.log('token0:', res.token0);
console.log('symbol:', res.symbol);
`;

const batchBalances = `import { evscript, t } from '@maxencerb/evs';
import { createPublicClient, http, erc20Abi } from 'viem';

// balanceOf over ANY address list in one eth_call. tryRead means a non-token
// address yields 0 instead of reverting the whole batch.
export const balances = evscript(
  { name: 'balances', args: [t.array(t.address), t.address] },
  (s, tokens, owner) => {
    const n = tokens.length();
    const out = s.newArray(t.uint256, n); // zero-filled uint256[n]
    s.for({ type: t.uint256, from: 0n, until: n }, (i) => {
      const r = s.tryRead({
        address: tokens.at(i),
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [owner],
      });
      out.set(i, s.select(r.success, r.value, 0n));
    });
    return s.return({ balances: out.expr() });
  },
);

const tokens = [
  '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
  '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
  '0x6B175474E89094C44Da98b954EedeAC495271d0F', // DAI
  '0xD8Da6bF26964AF9d7Eed9e03E51415D2B0eF2141', // an EOA, not a token → 0, no revert
] as const;
const owner = '0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf'; // Polygon PoS bridge

const client = createPublicClient({ transport: http() });

const res = await client.readContract({
  ...balances.compile().toViem(),
  functionName: 'balances',
  args: [tokens, owner],
});

for (const [i, bal] of res.balances.entries()) {
  console.log(tokens[i], '→', bal);
}
`;

const structReads = `import { evscript, t } from '@maxencerb/evs';
import { createPublicClient, http } from 'viem';

// A function with several outputs reads back as a NAMED struct — slot0's five
// outputs become one typed tuple, returned alongside fee in the same call.
const poolAbi = [
  {
    type: 'function',
    name: 'slot0',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'tick', type: 'int24' },
      { name: 'observationIndex', type: 'uint16' },
      { name: 'observationCardinality', type: 'uint16' },
      { name: 'unlocked', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'fee',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint24' }],
  },
] as const;

export const poolState = evscript({ name: 'poolState', args: [t.address] }, (s, pool) => {
  // struct: true → one named Tuple handle over all five outputs
  const slot0 = s.read({ address: pool, abi: poolAbi, functionName: 'slot0', struct: true });
  const fee = s.read({ address: pool, abi: poolAbi, functionName: 'fee' });
  return s.return({ slot0, fee });
});

const client = createPublicClient({ transport: http() });

const res = await client.readContract({
  ...poolState.compile().toViem(),
  functionName: 'poolState',
  args: ['0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'], // Uniswap V3 USDC/WETH 0.05%
});

console.log('sqrtPriceX96:', res.slot0.sqrtPriceX96);
console.log('tick:', res.slot0.tick);
console.log('unlocked:', res.slot0.unlocked);
console.log('fee:', res.fee);
`;

const customErrors = `import { evscript, matchScriptError, namedArg, t } from '@maxencerb/evs';
import { createPublicClient, erc20Abi, http } from 'viem';

// Declare-and-throw custom errors: only errors listed on the def can be thrown
// (your editor rejects the rest), they ride in the compiled ABI so viem decodes
// them natively, and matchScriptError gives an EXHAUSTIVE switch on the catch side.
const InsufficientBalance = t.error('InsufficientBalance', [
  namedArg('balance', t.uint256),
  namedArg('required', t.uint256),
]);

export const requireBalance = evscript(
  { name: 'requireBalance', args: [t.address, t.address, t.uint256], errors: [InsufficientBalance] },
  (s, token, owner, required) => {
    const balance = s.read({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] });
    s.if(balance.lt(required), () => {
      s.throw(InsufficientBalance, { balance, required });
    });
    return s.return({ balance });
  },
);

const client = createPublicClient({ transport: http() });

try {
  const res = await client.readContract({
    ...requireBalance.compile().toViem(),
    functionName: 'requireBalance',
    args: [
      '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
      '0xD8Da6bF26964AF9d7Eed9e03E51415D2B0eF2141', // vitalik.eth
      1_000_000_000_000n * 10n ** 6n, // a trillion USDC — expect the throw
    ],
  });
  console.log('balance:', res.balance);
} catch (e) {
  const message = matchScriptError(requireBalance, e, {
    InsufficientBalance: ({ balance, required }) =>
      \`insufficient balance: have \${balance}, need \${required}\`,
    _: (other) => \`unexpected revert: \${other.name}\`,
  });
  console.log(message);
}
`;

export const examples: readonly PlaygroundExample[] = [
  { id: 'dependent-reads', label: 'dependent reads', code: dependentReads },
  { id: 'batch-balances', label: 'batch balances', code: batchBalances },
  { id: 'struct-reads', label: 'struct reads', code: structReads },
  { id: 'custom-errors', label: 'custom errors', code: customErrors },
];
