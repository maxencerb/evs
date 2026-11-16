/**
 * foundry.ts — the check that a Foundry tool can run, made before anything spawns one.
 *
 * A missing binary is the first thing a fresh machine meets, and neither Node nor prool says so
 * usefully: `execFileSync` throws a `spawnSync … ENOENT` error object, and a prool instance whose
 * binary cannot be spawned never settles its `start()`. This turns both into one line that
 * names the tool and says where Foundry comes from.
 *
 * Imported by relative path from outside this package too (the test harness of the library,
 * and through it the plugin's tests and the examples), and run by Node as is: erasable syntax
 * only, no dependency.
 */
import { execFile } from 'node:child_process';

export const FOUNDRY_URL = 'https://getfoundry.sh';

/**
 * A Foundry tool that cannot run. The message is the whole report, written for the person at
 * the terminal, so the stack is cut down to that line: a test runner prints it alone instead of
 * burying it under its own frames, and a script that owns the process prints it and exits.
 */
export class FoundryToolError extends Error {
  override name = 'FoundryToolError';

  constructor(message: string) {
    super(message);
    this.stack = `${this.name}: ${message}`;
  }
}

/** Resolves when `<tool> --version` runs; rejects with a {@link FoundryToolError} otherwise. */
export async function requireFoundryTool(tool: 'anvil' | 'forge'): Promise<void> {
  const failure = await new Promise<Error | null>((resolve) => {
    execFile(tool, ['--version'], (error) => resolve(error));
  });
  if (failure === null) return;
  const what =
    'code' in failure && failure.code === 'ENOENT'
      ? `${tool} was not found on the PATH`
      : `\`${tool} --version\` failed (${failure.message.trim().split('\n')[0]})`;
  throw new FoundryToolError(`${what}: install Foundry (${FOUNDRY_URL})`);
}
