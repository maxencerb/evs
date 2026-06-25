/**
 * E2 — Batch reads over a runtime `address[]` arg: the multicall replacement
 * (docs/design/api.md §11). A loop + tryCall over N tokens compiles to one script;
 * non-token addresses yield 0 instead of reverting the whole batch.
 *
 * Run: bun examples/token-balances/index.ts
 */

import { erc20Abi, parseEther, type Address } from 'viem';

import { evscript, t } from '@maxencerb/evs';
import { startAnvil } from '@maxencerb/evs-examples-shared/run-anvil';

import { MockERC20 } from '../../packages/evs/test/generated/index.js';

// `args: [t.array(t.address), t.address]` → the callback receives `(s, tokens, owner)`.
const balances = evscript(
  { name: 'balances', args: [t.array(t.address), t.address] },
  (s, tokens, owner) => {
    const n = tokens.length();
    const out = s.newArray(t.uint256, n); // zero-filled uint256[n]
    s.for({ type: t.uint256, from: 0n, until: n }, (i) => {
      const token = tokens.at(i); // bounds-checked
      const r = s.tryRead({
        address: token,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [owner],
      });
      out.set(i, s.select(r.success, r.value, 0n)); // non-token addresses → 0, no revert
    });
    return s.return({ balances: out.expr() });
  },
);

const chain = await startAnvil();
try {
  const tokens: Address[] = [];
  for (let i = 0; i < 5; i++) {
    const token = await chain.deploy(MockERC20.abi, MockERC20.bytecode, [
      `Token ${i}`,
      `T${i}`,
      18,
    ]);
    await chain.write({
      address: token,
      abi: MockERC20.abi,
      functionName: 'mint',
      args: [chain.account.address, parseEther(String((i + 1) * 10))],
    });
    tokens.push(token);
  }
  tokens.push(chain.account.address); // an EOA — tryCall defaults its balance to 0

  const res = await chain.client.readContract({
    ...balances.compile().toViem(),
    functionName: 'balances',
    args: [tokens, chain.account.address],
  });

  // res: { balances: readonly bigint[] }
  for (const [i, bal] of res.balances.entries()) {
    console.log(`${tokens[i]} → ${bal}`);
  }
} finally {
  await chain.stop();
}
