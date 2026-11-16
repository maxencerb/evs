/**
 * What every anvil start in the repository does when anvil is missing or does not come up: it
 * fails, in bounded time, with a message that says what to do. None of this needs Foundry: the
 * tests run with a `PATH` that holds no `anvil`, or a stand-in script.
 */

import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, describe, expect, test, vi } from 'vite-plus/test';

import { FoundryToolError } from '../../../contracts/scripts/foundry.ts';
import integrationSetup from '../global-setup.ts';
import { spawnAnvil } from './anvil-process.ts';
import { forkUrlOf } from './fork-url.ts';

const NOT_FOUND = 'anvil was not found on the PATH: install Foundry (https://getfoundry.sh)';

const scratch = mkdtempSync(join(tmpdir(), 'evs-anvil-process-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());

/** A directory to use as the whole `PATH`: empty, so no `anvil` is found. */
function pathWithoutAnvil(): string {
  return mkdtempSync(join(scratch, 'empty-'));
}

/**
 * A directory to use as the whole `PATH`, holding a stand-in `anvil`: it answers `--version`
 * like the real one, then writes its pid next to itself and runs `body`. It ends by turning
 * into a `sleep`, so the pid stays the one of the process the helper has to stop.
 */
function pathWithStandIn(body: string): { path: string; pid: () => number } {
  const path = mkdtempSync(join(scratch, 'stand-in-'));
  writeFileSync(
    join(path, 'anvil'),
    [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "anvil Version: stand-in"; exit 0; fi',
      'echo $$ > "${0%/*}/pid"',
      body,
      'exec /bin/sleep 600',
      '',
    ].join('\n'),
  );
  chmodSync(join(path, 'anvil'), 0o755);
  return { path, pid: () => Number(readFileSync(join(path, 'pid'), 'utf8')) };
}

/** Whether a process with this pid exists (signal 0 only probes). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('spawnAnvil', () => {
  test('without anvil on the PATH: fails at once and says to install Foundry', async () => {
    vi.stubEnv('PATH', pathWithoutAnvil());
    const failure = await spawnAnvil().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(FoundryToolError);
    expect(failure).toHaveProperty('message', NOT_FOUND);
    // the message is the report: no frames for a test runner to print under it
    expect(failure).toHaveProperty('stack', `FoundryToolError: ${NOT_FOUND}`);
  }, 5_000);

  test('an anvil that never listens: killed and reported when the start timeout ends', async () => {
    const standIn = pathWithStandIn('');
    vi.stubEnv('PATH', standIn.path);
    await expect(spawnAnvil({ startTimeoutMs: 300 })).rejects.toThrow(
      'anvil did not say which port it listens on within 300 ms (it printed nothing)',
    );
    expect(isAlive(standIn.pid())).toBe(false);
  }, 5_000);

  test('the timeout report quotes what anvil printed last', async () => {
    const standIn = pathWithStandIn('echo "Fetching the remote chain"');
    vi.stubEnv('PATH', standIn.path);
    await expect(spawnAnvil({ startTimeoutMs: 300 })).rejects.toThrow(
      'within 300 ms. Its last output:\nFetching the remote chain',
    );
    expect(isAlive(standIn.pid())).toBe(false);
  }, 5_000);

  test('an anvil that fails to start: its own error, and nothing left running', async () => {
    const standIn = pathWithStandIn('echo "Error: Address already in use (os error 48)" >&2');
    vi.stubEnv('PATH', standIn.path);
    await expect(spawnAnvil()).rejects.toThrow('Address already in use');
    expect(isAlive(standIn.pid())).toBe(false);
  }, 5_000);

  test('the URL holds the port anvil printed, and stop() ends the process', async () => {
    const standIn = pathWithStandIn('echo "Listening on 127.0.0.1:4242"');
    vi.stubEnv('PATH', standIn.path);
    const anvil = await spawnAnvil();
    expect(anvil.url).toBe('http://127.0.0.1:4242');
    expect(isAlive(standIn.pid())).toBe(true);
    await anvil.stop();
    expect(isAlive(standIn.pid())).toBe(false);
    // a second stop is the first one
    await anvil.stop();
  }, 5_000);
});

describe('every start site without anvil on the PATH', () => {
  test("the integration project's global setup fails before it starts anything", async () => {
    vi.stubEnv('PATH', pathWithoutAnvil());
    const provided: string[] = [];
    const project = { provide: (key: string) => void provided.push(key) };
    await expect(integrationSetup(project)).rejects.toThrow(NOT_FOUND);
    expect(provided).toStrictEqual([]);
  }, 5_000);

  test('an example prints the one line and exits with code 1', async () => {
    const launcher = fileURLToPath(
      new URL('../../../../examples/shared/run-anvil.ts', import.meta.url),
    );
    const script = `const { startAnvil } = await import(${JSON.stringify(launcher)}); await startAnvil();`;
    const result = await new Promise<{ code: unknown; stdout: string; stderr: string }>(
      (resolve) => {
        execFile(
          process.execPath,
          // no warning line of Node's own (type stripping, on the versions that still warn)
          ['--disable-warning=ExperimentalWarning', '--input-type=module', '--eval', script],
          // a start that hangs must fail this test, not the run
          { env: { ...process.env, PATH: pathWithoutAnvil() }, timeout: 20_000 },
          (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }),
        );
      },
    );
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: `${NOT_FOUND}\n` });
  }, 30_000);
});

describe('the fork suite gate', () => {
  test('ANVIL_FORK_URL switches it on', () => {
    expect(forkUrlOf({ ANVIL_FORK_URL: 'https://rpc.example' })).toBe('https://rpc.example');
  });

  test('an empty ANVIL_FORK_URL counts as unset', () => {
    expect(forkUrlOf({ ANVIL_FORK_URL: '' })).toBeUndefined();
    expect(forkUrlOf({})).toBeUndefined();
  });

  test('RPC_URL does not', () => {
    expect(forkUrlOf({ RPC_URL: 'https://rpc.example' })).toBeUndefined();
    expect(forkUrlOf({ ANVIL_FORK_URL: '', RPC_URL: 'https://rpc.example' })).toBeUndefined();
  });
});
