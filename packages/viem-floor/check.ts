/**
 * Runs the error decoders of `@maxencerb/evs` on the errors of the oldest viem its peer range
 * admits (the lower bound of `peerDependencies.viem` in packages/evs/package.json).
 *
 *   node packages/viem-floor/check.ts      (after `vp run build`; `vp run test:viem-floor`)
 *
 * This package depends on exactly that viem. For every answer of the table in
 * packages/evs/test/harness/rpc-errors.ts, a local mock JSON-RPC server gives the answer to this
 * viem's own `readContract` (both execution modes) and `call`, and `decodeScriptError` /
 * `matchScriptError` read the error it throws. The error objects are therefore the ones an app
 * on the floor version catches, and they differ from the current ones: before viem 2.47.5 a
 * `ContractFunctionRevertedError` has no `cause`, so the RPC error is not in the tree.
 *
 * Covered: the error decoders, which take nothing from the app's viem but the errors it throws.
 *
 * Not covered: the rest of the library at the floor. The workspace links the library, so its
 * own `import … from 'viem'` (ABI encoding and decoding, keccak256, the types) resolves to the
 * viem pinned in the catalog, not to this package's. Only what this file itself asks of viem
 * (`createPublicClient`, `http`, `readContract`, `call`, and their types on `toViem()`) runs
 * and typechecks at the floor.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { createPublicClient, http } from 'viem';

import {
  compile,
  decodeScriptError,
  evscript,
  matchScriptError,
  namedArg,
  t,
} from '@maxencerb/evs';

import {
  BOOM_ARGS,
  BOOM_DATA,
  RPC_ERROR_SHAPES,
  startMockRpc,
  type Outcome,
  type RpcAnswer,
} from '../evs/test/harness/rpc-errors.ts';

const require = createRequire(import.meta.url);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

/** The member `key` of a parsed package.json, or of one of its fields. */
function field(manifest: unknown, key: string): unknown {
  return isRecord(manifest) ? manifest[key] : undefined;
}

/** The viem this package resolves, and the floor the library declares. */
function versions(): { installed: string; floor: string } {
  const viemManifest: unknown = require('viem/package.json');
  const installed = field(viemManifest, 'version');
  const library: unknown = JSON.parse(
    readFileSync(new URL('../evs/package.json', import.meta.url), 'utf8'),
  );
  const range = field(field(library, 'peerDependencies'), 'viem');
  const floor =
    typeof range === 'string' ? /^>=(\d+\.\d+\.\d+)(?: |$)/.exec(range)?.[1] : undefined;
  if (typeof installed !== 'string' || floor === undefined) {
    throw new Error(
      `cannot read the viem versions (installed: ${String(installed)}, peer range: ${String(range)})`,
    );
  }
  return { installed, floor };
}

const Boom = t.error('Boom', [namedArg('code', t.uint256), namedArg('who', t.address)]);
const guard = compile(
  evscript({ name: 'guard', args: [t.uint256, t.uint256], errors: [Boom] }, (s, x, y) => {
    s.if(x.eq(0n), () => {
      s.throw(Boom, BOOM_ARGS);
    });
    return s.return({ sum: x.add(y) });
  }),
);

/** What the two decoders make of `caught`, in the words of the table. */
function observe(caught: unknown): string {
  const decoded = decodeScriptError(guard, caught);
  let matched: string;
  try {
    matched = matchScriptError(guard, caught, {
      Boom: ({ code, who }) => `Boom(${code}, ${who})`,
      _: (other) => `_ got ${other.name}`,
    });
  } catch (error) {
    matched = error === caught ? 'rethrown' : `threw ${String(error)}`;
  }
  return `${decoded === undefined ? 'not a revert' : decoded.name} / ${matched}`;
}

function expectedFor(outcome: Outcome): string {
  if (outcome === 'not a revert') return `${outcome} / rethrown`;
  if (outcome === 'Boom') return `${outcome} / Boom(${BOOM_ARGS.code}, ${BOOM_ARGS.who})`;
  return `${outcome} / _ got ${outcome}`;
}

/** The node named `name` in the `cause` chain of `error`. */
function nodeNamed(error: unknown, name: string): Readonly<Record<string, unknown>> | undefined {
  const seen = new Set<unknown>();
  let current = error;
  while (isRecord(current) && !seen.has(current)) {
    seen.add(current);
    if (current['name'] === name) return current;
    current = current['cause'];
  }
  return undefined;
}

/** The error `call` rejects with. Every answer of the table is a failure for `readContract`. */
async function caughtFrom(call: () => Promise<unknown>): Promise<unknown> {
  try {
    await call();
  } catch (error) {
    return error;
  }
  throw new Error('the mock answer was taken for a result');
}

const WAYS = ['readContract, deployless', 'readContract, stateOverride', 'call'] as const;
type Way = (typeof WAYS)[number];

async function main(): Promise<number> {
  const { installed, floor } = versions();
  if (installed !== floor) {
    console.error(
      `FAIL  this package installs viem ${installed}, and packages/evs/package.json admits viem ` +
        `from ${floor}: set the \`floor\` catalog of pnpm-workspace.yaml to ${floor}, then \`vp install\`.`,
    );
    return 1;
  }

  const rpc = await startMockRpc();
  // no retry, and a timeout short enough for the answer that never comes
  const client = createPublicClient({ transport: http(rpc.url, { retryCount: 0, timeout: 150 }) });

  const ways: Readonly<Record<Way, () => Promise<unknown>>> = {
    'readContract, deployless': () =>
      client.readContract({ ...guard.toViem(), functionName: 'guard', args: [0n, 0n] }),
    'readContract, stateOverride': () =>
      client.readContract({
        ...guard.toViem({ mode: 'stateOverride' }),
        functionName: 'guard',
        args: [0n, 0n],
      }),
    call: () =>
      client.call({ to: guard.toViem({ mode: 'stateOverride' }).address, data: '0x12345678' }),
  };
  const answerTo = async (answer: RpcAnswer, way: Way): Promise<unknown> => {
    rpc.answer(answer);
    return caughtFrom(ways[way]);
  };

  let failures = 0;
  try {
    // Which tree this viem builds: with the RPC error under its ContractFunctionRevertedError
    // (2.47.5 and later) or without. It decides which column of the table applies.
    const reverted = nodeNamed(
      await answerTo(
        { error: { code: 3, message: 'execution reverted', data: BOOM_DATA } },
        'readContract, deployless',
      ),
      'ContractFunctionRevertedError',
    );
    if (reverted === undefined || reverted['raw'] !== BOOM_DATA) {
      console.error(
        `FAIL  viem ${installed} has no \`raw\` on its ContractFunctionRevertedError: the decoders cannot read a revert from it`,
      );
      return 1;
    }
    const keepsCause = reverted['cause'] !== undefined;
    console.log(
      `viem ${installed} (the floor of the peer range): its ContractFunctionRevertedError ` +
        `${keepsCause ? 'keeps' : 'has no'} cause\n`,
    );

    for (const shape of RPC_ERROR_SHAPES) {
      const atFloor = keepsCause ? shape.expected : (shape.expectedWithoutCause ?? shape.expected);
      const wrong: string[] = [];
      for (const way of WAYS) {
        // a result is no error for `call()`, and its tree always holds the RPC error
        if (way === 'call' && 'result' in shape.answer) continue;
        const expected = expectedFor(way === 'call' ? shape.expected : atFloor);
        const observed = observe(await answerTo(shape.answer, way));
        if (observed !== expected) wrong.push(`${way}: expected ${expected}, got ${observed}`);
      }
      if (wrong.length === 0) {
        console.log(`ok    ${shape.name}  →  ${atFloor}`);
        continue;
      }
      failures += 1;
      console.log(`FAIL  ${shape.name}\n${wrong.map((line) => `        ${line}`).join('\n')}`);
    }
  } finally {
    await rpc.close();
  }

  console.log(
    failures === 0
      ? `\n${RPC_ERROR_SHAPES.length} answers decoded as expected on viem ${installed}.`
      : `\n${failures} of ${RPC_ERROR_SHAPES.length} answers decoded wrongly on viem ${installed}.`,
  );
  return failures === 0 ? 0 : 1;
}

process.exitCode = await main();
