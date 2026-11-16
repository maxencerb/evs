/**
 * The anvil helper against the real anvil: it serves on the URL it returns, two of them never
 * share a port, and a process that stopped its anvil exits when its work is done.
 */

import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { expect, test } from 'vite-plus/test';

import { spawnAnvil, type Anvil } from '../harness/anvil-process.ts';

async function chainIdOf(anvil: Anvil): Promise<unknown> {
  const response = await fetch(anvil.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
  });
  const answer = (await response.json()) as { result?: unknown };
  return answer.result;
}

test('an anvil serves on its URL until it is stopped; two anvils get two ports', async () => {
  const [first, second] = await Promise.all([
    spawnAnvil({ args: { chainId: 31337 } }),
    spawnAnvil({ args: { chainId: 31338 } }),
  ]);
  try {
    expect(first.url).not.toBe(second.url);
    expect(await chainIdOf(first)).toBe('0x7a69');
    expect(await chainIdOf(second)).toBe('0x7a6a');
  } finally {
    await Promise.all([first.stop(), second.stop()]);
  }
  await expect(chainIdOf(first)).rejects.toThrow('fetch failed');
});

test('a process that stopped its anvil exits when its work is done', async () => {
  const helper = fileURLToPath(new URL('../harness/anvil-process.ts', import.meta.url));
  // what an example does, and what a global teardown does before the test run exits; nothing
  // ends the process but the event loop running out of work
  const script = [
    `const { spawnAnvil } = await import(${JSON.stringify(helper)});`,
    'const anvil = await spawnAnvil();',
    'await anvil.stop();',
    'const stoppedAt = performance.now();',
    "process.on('exit', () => console.log(Math.round(performance.now() - stoppedAt)));",
  ].join('\n');
  const idleMs = await new Promise<number>((resolve, reject) => {
    execFile(
      process.execPath,
      ['--input-type=module', '--eval', script],
      { timeout: 20_000 },
      (error, stdout) => (error === null ? resolve(Number(stdout)) : reject(error)),
    );
  });
  // a kill arms a 5-second timer in prool's process layer: left armed, it is what the process
  // waits for, and the idle time is 5000 ms to the millisecond
  expect(idleMs).toBeLessThan(2_500);
});
