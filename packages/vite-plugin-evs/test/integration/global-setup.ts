/**
 * vitest globalSetup for the `plugin-integration` project: one anvil for the run, on a port of
 * its own. The tests read its URL with `inject('anvilUrl')`.
 */

import type { TestProject } from 'vite-plus/test/node';

import { spawnAnvil } from '../../../evs/test/harness/anvil-process.ts';
import { requireLibraryBuild } from '../setup/library-build.ts';

declare module 'vite-plus/test' {
  interface ProvidedContext {
    /** The RPC URL of the run's anvil. */
    anvilUrl: string;
  }
}

export default async function setup(
  project: Pick<TestProject, 'provide'>,
): Promise<() => Promise<void>> {
  requireLibraryBuild();
  const anvil = await spawnAnvil({
    args: {
      chainId: 31337,
      hardfork: 'Prague', // pinned, like the library's integration tests
    },
  });
  project.provide('anvilUrl', anvil.url);
  return () => anvil.stop();
}
