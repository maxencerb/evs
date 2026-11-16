/**
 * What a type checker says about an `async` or generator body given to a loop: the
 * `SyncCallback` message, whatever the range or the array. tsc runs on a source text here,
 * because the text is what a user reads.
 *
 * When no overload matches, TypeScript 7, `bun check` and tsrs print the last overload's error
 * alone, where the tsc of this package lists every overload's: the last one it lists is what
 * they print, so the last overload of `s.for` and of `s.forEach` takes every range and array.
 */
import { describe, expect, test } from 'vite-plus/test';

import { tscDiagnostics } from '../../test/harness/tsc-errors.js';

const PROMISE =
  "'evs: the callback returns a Promise (an async function). The builder runs it once, synchronously, so nothing after its first await is recorded: await your data before evscript() and use a plain function'";
const ITERATOR =
  "'evs: the callback returns an iterator (a generator function). The builder runs it once, synchronously, and a generator body does not run when called: use a plain function'";

/** One call per line: the call text, and the key its error names. */
const CALLS: readonly (readonly [call: string, key: string])[] = [
  ['s.for({ from: 0n, until: 3n }, async () => {})', PROMISE],
  ['s.for({ type: t.uint8, from: 0, until: 3 }, async () => {})', PROMISE],
  ['s.for({ from: 0n, until: 3n }, function* () {})', ITERATOR],
  ['s.forEach(xs, async () => {})', PROMISE],
  ['s.forEach(ps, async (p) => { p.amount.get(); })', PROMISE],
  ['s.forEach(ps, function* () {})', ITERATOR],
];

const HEADER = `
  import { evscript, t } from './index.js';
  const P = t.struct({ owner: t.address, amount: t.uint256 });
  evscript({ name: 'loops', args: [t.array(t.uint256), t.array(P)] }, (s, xs, ps) => {
`;
const FOOTER = `
    return s.return({ n: s.lit(t.uint256, 1n) });
  });
`;
const HEADER_LINES = HEADER.split('\n').length - 1;

describe('an async or generator loop body: the error names the problem', () => {
  const source = `${HEADER}${CALLS.map(([call]) => `${call};`).join('\n')}${FOOTER}`;
  let cached: ReturnType<typeof tscDiagnostics> | undefined;
  const diagnostics = () => (cached ??= tscDiagnostics(source));
  const errorOf = (call: string) => {
    const line = HEADER_LINES + 1 + CALLS.findIndex(([c]) => c === call);
    const errors = diagnostics().filter((d) => d.line === line);
    expect(errors).toHaveLength(1);
    return errors[0];
  };

  test('every call is one error, and nothing else is', () => {
    expect(diagnostics().map((d) => d.line)).toEqual(
      CALLS.map((_, index) => HEADER_LINES + 1 + index),
    );
  }, 60_000);

  test.each(CALLS)("%s: the last overload's error names the problem", (call, key) => {
    const error = errorOf(call);
    expect(error?.code).toBe(2769);
    // each overload's part is its signature, then its error: the signature holds the key too
    const errors = error?.message.split(' gave the following error.') ?? [];
    expect(errors.length).toBeGreaterThan(2);
    expect(errors.at(-1)).toContain(key);
  });
});
