/**
 * Starting and stopping anvil: the one place that does it, for the two integration global
 * setups, the fork suite and the examples (`examples/shared/run-anvil.ts`).
 *
 * prool spawns the process; this module adds what a caller would otherwise have to know about
 * it (see {@link spawnAnvil} and `stopInstance`).
 *
 * Node runs this file as is for the examples: erasable syntax only, `.ts` import specifiers, no
 * test-runner import.
 */

import { once } from 'node:events';

import type { Instance } from 'prool';

import { requireFoundryTool } from '../../../contracts/scripts/foundry.ts';

type AnvilInstance = ReturnType<typeof Instance.anvil>;

export interface SpawnAnvilOptions {
  /**
   * anvil's own options, under prool's names. Its address is not one of them: every anvil
   * listens on the IPv4 loopback, on a port the OS assigns.
   */
  args?: Omit<Instance.anvil.Parameters, 'binary' | 'host' | 'port'>;
  /** How long anvil may take to say that it listens. A fork reads its remote node first. */
  startTimeoutMs?: number;
}

/** A running anvil. */
export interface Anvil {
  /** Its JSON-RPC endpoint, `http://127.0.0.1:<port>`. */
  readonly url: string;
  /** Stops it. Resolves once the process is gone, and leaves nothing that keeps Node alive. */
  stop(): Promise<void>;
}

/**
 * The polling interval of a viem client that talks to an anvil. anvil automines, so a receipt
 * is there by the time the hash comes back; viem's default of 4 s turns every missed first poll
 * of a `waitFor*` into a 4 s stall.
 */
export const ANVIL_POLLING_INTERVAL = 50;

// Not `localhost`: it also resolves to ::1, where anvil does not listen (an attempt there can
// even self-connect on a recycled ephemeral port and read its own request back).
const HOST = '127.0.0.1';

// The whole line, newline included, so a chunk boundary inside the port never yields a shorter one.
const LISTENING = /Listening on 127\.0\.0\.1:(\d+)\r?\n/;

/**
 * The child process of an instance: `undefined` until prool has spawned one, and without a
 * `pid` when the spawn itself failed.
 */
function childOf(instance: AnvilInstance): AnvilInstance['_internal']['process'] | undefined {
  // oxlint-disable-next-line no-underscore-dangle -- prool's name for it, and its only way to the child
  return instance._internal.process;
}

function hasExited(child: { exitCode: number | null; signalCode: string | null }): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * Starts an anvil and resolves once it accepts requests.
 *
 * - **The binary is checked first.** prool never settles `start()` when `anvil` cannot be
 *   spawned, so without the check a machine without Foundry waits forever.
 * - **The start is bounded.** An anvil that neither listens nor fails within
 *   `startTimeoutMs` is killed and reported.
 * - **anvil binds the port.** It gets port 0 and prints the port the OS gave it, so nothing
 *   picks a "free" port that another process can take before anvil binds it.
 */
export async function spawnAnvil(options: SpawnAnvilOptions = {}): Promise<Anvil> {
  const { args = {}, startTimeoutMs = 15_000 } = options;
  await requireFoundryTool('anvil');

  // loaded on the first start: every integration test file imports this module for the polling
  // interval, and none of them starts an anvil
  const prool = await import('prool');
  const instance = prool.Instance.anvil({ ...args, host: HOST, port: 0 });
  let output = '';
  let resolvePort: (port: string) => void = () => {};
  const listening = new Promise<string>((resolve) => {
    resolvePort = resolve;
  });
  const onStdout = (text: string): void => {
    output += text;
    const port = LISTENING.exec(output)?.[1];
    if (port !== undefined) resolvePort(port);
  };
  instance.on('stdout', onStdout);

  const started = instance.start();
  // every outcome is read through the race below; this only keeps a start that fails after
  // the timeout from being reported as an unhandled rejection
  started.catch(() => {});

  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const last = instance.messages.get().join('').trim();
      reject(
        new Error(
          `anvil did not say which port it listens on within ${startTimeoutMs} ms` +
            (last === '' ? ' (it printed nothing)' : `. Its last output:\n${last}`),
        ),
      );
    }, startTimeoutMs);
  });

  let port: string;
  try {
    [, port] = await Promise.race([Promise.all([started, listening]), timedOut]);
  } catch (error) {
    await killUnstarted(instance);
    throw error;
  } finally {
    clearTimeout(timer);
    // anvil logs every request on stdout: nothing may keep collecting it
    instance.off('stdout', onStdout);
  }

  let stopped: Promise<void> | undefined;
  return {
    url: `http://${HOST}:${port}`,
    stop: () => (stopped ??= stopInstance(instance)),
  };
}

/** Kills the child of an instance whose start did not complete, and waits until it is gone. */
async function killUnstarted(instance: AnvilInstance): Promise<void> {
  const child = childOf(instance);
  if (child?.pid === undefined || hasExited(child)) return;
  const exited = once(child, 'exit');
  // not through `instance.stop()`, which refuses an instance that is still starting
  child.kill('SIGKILL');
  await exited;
}

/**
 * Stops a started instance so that the Node process can exit as soon as its work is done.
 *
 * prool's `stop()` removes every listener of the child before it kills it, the ones of execa
 * (which prool spawns through) included. execa arms a timer on `kill()` that force-kills a
 * child still alive 5 seconds later, and clears it when it sees the child exit: with its
 * listeners gone it never does, and the timer holds the event loop for the full 5 seconds.
 * So the child is killed and its exit awaited here, while execa still listens; prool's `stop()`
 * then finds a dead child and only updates the instance.
 */
async function stopInstance(instance: AnvilInstance): Promise<void> {
  const child = childOf(instance);
  if (child !== undefined && !hasExited(child)) {
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }
  await instance.stop();
}
