/**
 * The gate of the mainnet-fork suite (`test/integration/fork.test.ts`): the RPC URL to fork,
 * or `undefined` when the suite is off.
 *
 * `ANVIL_FORK_URL` is the only switch. A generic variable such as `RPC_URL` is exported in many
 * shells for other tools, and must not pull a suite that needs the network (and a mainnet node)
 * into `vp run test:integration`.
 */
export function forkUrlOf(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const url = env['ANVIL_FORK_URL'];
  // an empty value counts as unset: CI expands a missing secret to '' (the fork-tests job fails
  // up front on that, see ci.yml), and `ANVIL_FORK_URL=` in a shell must skip, not start anvil
  // with an empty --fork-url
  return url === '' ? undefined : url;
}
