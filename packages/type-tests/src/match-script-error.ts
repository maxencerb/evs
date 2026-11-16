/**
 * The handlers of `matchScriptError`, as an app writes them: one per declared error, an optional
 * one for a Panic, an `Error(string)` and the two evs runtime errors, plus `_`. Every argument is
 * inferred. A handler under any other key would never run, so it is a type error.
 */
import {
  evscript,
  matchScriptError,
  namedArg,
  t,
  type PanicKind,
  type ScriptErrorHandlers,
} from '@maxencerb/evs';
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

// a Panic and an Error(string) carry something, and their handler receives it first
const builtins = matchScriptError(guard, caught, {
  TooSmall: () => 'too small' as const,
  NotOwner: () => 'not owner' as const,
  Panic: ({ code, kind, meaning }, error) => {
    expectType<Same<typeof code, bigint>>();
    expectType<Same<typeof kind, PanicKind>>();
    expectType<Same<typeof meaning, string>>();
    expectType<Same<typeof error.name, 'Panic'>>();
    return kind === 'overflow' ? ('too large' as const) : ('panic' as const);
  },
  Error: ({ reason }, error) => {
    expectType<Same<typeof reason, string>>();
    expectType<Same<typeof error.name, 'Error'>>();
    return 'reverted' as const;
  },
  EvsDecodeError: ({ site }) => {
    expectType<Same<typeof site, bigint>>();
    return 'decode' as const;
  },
  EvsInvalidCalldata: (args) => {
    expectType<Same<keyof typeof args, never>>();
    return 'calldata' as const;
  },
  _: () => null,
});
expectType<
  Same<
    typeof builtins,
    'too small' | 'not owner' | 'too large' | 'panic' | 'reverted' | 'decode' | 'calldata' | null
  >
>();

// what a Panic handler receives first is the panic: it has no `reason`
matchScriptError(guard, caught, {
  TooSmall: () => 0,
  NotOwner: () => 0,
  // @ts-expect-error -- `reason` belongs to Error(string)
  Panic: (panic) => panic.reason,
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
const fromRuntime = matchFromRuntime(guard, caught, {
  TooSmall: () => 0,
  NotOwner: () => 0,
  Panic: ({ kind }) => kind,
  _: () => 0,
});
expectType<Same<typeof fromRuntime, number | PanicKind>>();

// a table typed ahead of the call
const handlers: ScriptErrorHandlers<typeof guard.abi, string> = {
  TooSmall: ({ amount }) => `too small: ${amount}`,
  NotOwner: () => 'not the owner',
  Panic: ({ meaning }) => meaning,
  _: (other) => other.name,
};
expectType<Same<ReturnType<typeof run>, string>>();
function run() {
  return matchScriptError(guard, caught, handlers);
}
