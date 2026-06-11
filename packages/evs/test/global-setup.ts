/**
 * M10 `test/global-setup.ts` — vitest globalSetup for the `integration` project.
 *
 * Contract: docs/design/module-interfaces.md §M10 + testing.md §3 (verbatim): a prool
 * proxy server multiplexing one anvil instance per vitest worker on port 8545
 * (`/<VITEST_POOL_ID>` routing, see `test/harness/anvil.ts`).
 */

import { Instance, Server } from 'prool';

export default async function setup(): Promise<() => Promise<void>> {
  const server = Server.create({
    instance: Instance.anvil({
      chainId: 31337,
      hardfork: 'Prague', // PINNED — anvil's default `latest` moves over time
      gasLimit: 100_000_000, // headroom over the 30M default for stress tests
    }),
    port: 8545,
  });
  const stop = await server.start();
  return async () => {
    await stop();
  };
}
