/**
 * The handlers of `matchScriptError`, as an app writes them: one per declared error, with the
 * arguments inferred, plus `_`. A handler under any other key would never run (Panic,
 * Error(string) and the two evs runtime errors reach `_`), so it is a type error.
 */
import { evscript, matchScriptError, namedArg, t, type ScriptErrorHandlers } from '@maxencerb/evs';
import { matchScriptError as matchFromRuntime } from '@maxencerb/evs/runtime';

import { expectType, type Same } from './assert.js';

const TooSmall = t.error('TooSmall', [namedArg('amount', t.uint256)]);
const NotOwner = t.error('NotOwner');

const guard = evscript(
  { name: 'guard', args: [t.uint256], errors: [TooSmall, NotOwner] },
  (s, amount) => {
    s.if(amount.lt(10n), () => {
      s.throw(TooSmall, { amount });
    });
    return s.return({ amount });
  },
);

declare const caught: unknown;

// the arguments of a declared handler and the arms of `_` are inferred
const message = matchScriptError(guard, caught, {
  TooSmall: ({ amount }, error) => {
    expectType<Same<typeof amount, bigint>>();
    expectType<Same<typeof error.name, 'TooSmall'>>();
    return 'too small' as const;
  },
  NotOwner: (args) => {
    expectType<Same<keyof typeof args, never>>();
    return 1n;
  },
  _: (other) => {
    expectType<
      Same<
        typeof other.name,
        'EvsInvalidCalldata' | 'EvsDecodeError' | 'Panic' | 'Error' | 'unknown' | 'empty'
      >
    >();
    return null;
  },
});
expectType<Same<typeof message, 'too small' | bigint | null>>();

// a missing declared handler
// @ts-expect-error -- NotOwner has no handler
matchScriptError(guard, caught, {
  TooSmall: () => 0,
  _: () => 0,
});

// a handler named like an arm that reaches `_`
matchScriptError(guard, caught, {
  TooSmall: () => 0,
  NotOwner: () => 0,
  // @ts-expect-error -- Panic reaches `_`
  Panic: (panic: unknown) => panic,
  _: () => 0,
});
matchScriptError(guard, caught, {
  TooSmall: () => 0,
  NotOwner: () => 0,
  // @ts-expect-error -- Error(string) reaches `_`
  Error: () => 0,
  _: () => 0,
});
matchScriptError(guard, caught, {
  TooSmall: () => 0,
  NotOwner: () => 0,
  // @ts-expect-error -- the evs runtime errors reach `_`
  EvsDecodeError: () => 0,
  _: () => 0,
});
matchScriptError(guard, caught, {
  TooSmall: () => 0,
  NotOwner: () => 0,
  // @ts-expect-error -- the evs runtime errors reach `_`
  EvsInvalidCalldata: () => 0,
  _: () => 0,
});

// a misspelled error name
matchScriptError(guard, caught, {
  TooSmall: () => 0,
  NotOwner: () => 0,
  // @ts-expect-error -- not an error of this script
  TooSmal: () => 0,
  _: () => 0,
});

// the runtime entry exports the same function
matchFromRuntime(guard, caught, {
  TooSmall: () => 0,
  NotOwner: () => 0,
  // @ts-expect-error -- Panic reaches `_`
  Panic: () => 0,
  _: () => 0,
});

// a table typed ahead of the call
const handlers: ScriptErrorHandlers<typeof guard.abi, string> = {
  TooSmall: ({ amount }) => `too small: ${amount}`,
  NotOwner: () => 'not the owner',
  _: (other) => other.name,
};
expectType<Same<ReturnType<typeof run>, string>>();
function run() {
  return matchScriptError(guard, caught, handlers);
}
