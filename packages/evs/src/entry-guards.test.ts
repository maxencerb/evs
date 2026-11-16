/* oxlint-disable typescript/no-unsafe-type-assertion --
 * these tests pass each function a value its parameter type rejects (`as never`): the runtime
 * check is what is under test. */
/* oxlint-disable vitest/expect-expect --
 * most tests assert through the expectTypeError() helper (class + code + message); the rule only
 * recognizes direct expect* calls. */
/**
 * What `compile()`, `interpret()` and `eliminateDeadCode()` answer to an input the caller got
 * wrong: a coded error that names it, never a raw `TypeError` nor an `EvsInternalError` asking
 * for a bug report.
 */
import { parseAbi } from 'viem';
import { describe, expect, test } from 'vite-plus/test';

import { evscript } from './builder/script.js';
import { compile } from './compile.js';
import { EvsError, EvsTypeError, type EvsErrorCode } from './core/errors.js';
import { t } from './core/types.js';
import { hydrate } from './hydrate.js';
import { eliminateDeadCode } from './ir/dce.js';
import { interpret, type MockChain } from './ir/interp.js';
import { serializeIr } from './ir/nodes.js';

const TARGET = '0x0000000000000000000000000000000000000011';
const abi = parseAbi([
  'function total() view returns (uint256)',
  'function poke(uint256 x) returns (uint256)',
]);
const WORD = `0x${'00'.repeat(31)}07` as const;

/** A pattern that matches `text` and nothing else. */
function exactly(text: string): RegExp {
  return new RegExp(`^${text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)}$`);
}

/** `fn` throws an `EvsTypeError` with this code and this message (whole when a string). */
function expectTypeError(fn: () => unknown, code: EvsErrorCode, message: string | RegExp): void {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(EvsTypeError);
  const e = thrown as EvsError;
  expect(e.code).toBe(code);
  expect(e.message).toMatch(typeof message === 'string' ? exactly(message) : message);
}

const plain = evscript({ name: 'plain', args: [t.uint256] }, (s, x) => s.return({ x }));

/** One `s.read`, behind a branch the default argument does not take. */
const reads = evscript({ name: 'reads', args: [t.address, t.bool] }, (s, token, wanted) => {
  const total = s.let(t.uint256, 0n);
  s.if(wanted, () => {
    total.set(s.read({ address: token, abi, functionName: 'total' }));
  });
  return s.return({ total: total.get() });
});

/** One `s.call`, and no read. */
const pokes = evscript({ name: 'pokes', args: [t.address] }, (s, token) =>
  s.return({ r: s.call({ address: token, abi, functionName: 'poke', args: [1n] }) }),
);

describe('compile: a script that takes the reserved simulate selector', () => {
  const reserved = (simulate: boolean) =>
    evscript({ name: '__evs_simulate', args: [t.address, t.bytes] }, (s, token, data) =>
      s.return({
        r: simulate
          ? s.simulate({ address: token, abi, functionName: 'poke', args: [data.length()] })
          : data.length(),
      }),
    );

  test('is a coded error that names the script and the fix', () => {
    expectTypeError(
      () => compile(reserved(true)),
      'ABI_SHAPE',
      'script "__evs_simulate(address,bytes)" has the 4-byte selector 0xbbde5aa3, which a script that uses s.simulate / s.trySimulate reserves for its internal entry point — rename the script or change its args',
    );
  });

  test('compiles when it simulates nothing: the selector is only reserved then', () => {
    expect(compile(reserved(false)).runtimeBytecode).toMatch(/^0x/);
  });
});

describe('interpret: a value that is no script', () => {
  const compiled = compile(plain);
  const precompiled = compiled.toPrecompiled();
  const NO_IR =
    'interpret: expected a script (an evscript() result or its artifact) or a ScriptIr, got a precompiled script, which holds no IR — pass the evscript() result or its compiled artifact';

  test.each([
    ['a precompiled script', precompiled],
    ['a hydrated script', hydrate(precompiled.toJSON())],
    ['the JSON data of a precompiled script', precompiled.toJSON()],
  ])('%s is refused: it holds no IR', (_name, value) => {
    expectTypeError(
      () => interpret(value as never, [1n] as never, {} as never),
      'TYPE_MISMATCH',
      NO_IR,
    );
  });

  test.each([
    [
      'an empty object',
      {},
      'an object without the tables of an IR (args, values, cells, fns, body, returns)',
    ],
    ['null', null, 'null'],
    ['undefined', undefined, 'undefined'],
    ['a string', serializeIr(plain.ir), 'a string'],
    ['an array', [plain.ir], 'an array'],
  ])('%s is refused', (_name, value, got) => {
    expectTypeError(
      () => interpret(value as never, [1n] as never, {} as never),
      'TYPE_MISMATCH',
      `interpret: expected a script (an evscript() result or its artifact) or a ScriptIr, got ${got}`,
    );
  });

  test('a script, its compiled artifact and its bare IR still run', () => {
    for (const target of [plain, compiled, plain.ir]) {
      expect(interpret(target as never, [3n] as never, {} as never).outcome).toMatchObject({
        kind: 'return',
        values: { x: 3n },
      });
    }
  });
});

describe('interpret: a chain that cannot answer the script', () => {
  const HOW =
    ' — pass a MockChain as the third argument: { staticcall(req) { return { success, data }; } }, with call(req) and account(address) as options';

  test('no staticcall is refused before the script runs, even behind an untaken branch', () => {
    expectTypeError(
      () => interpret(reads, [TARGET, false], {} as never),
      'TYPE_MISMATCH',
      `interpret: chain.staticcall must be a function (script "reads" calls total()), got undefined${HOW}`,
    );
    expectTypeError(
      () => interpret(reads, [TARGET, false], { staticcall: 'nope' } as never),
      'TYPE_MISMATCH',
      `interpret: chain.staticcall must be a function (script "reads" calls total()), got a string${HOW}`,
    );
  });

  test('a missing chain is refused when the script makes a call', () => {
    for (const chain of [undefined, null]) {
      expectTypeError(
        () => interpret(reads, [TARGET, true], chain as never),
        'TYPE_MISMATCH',
        `interpret: script "reads" calls total(), and the chain is ${String(chain)}${HOW}`,
      );
    }
  });

  test('call and account are functions when given', () => {
    const staticcall: MockChain['staticcall'] = () => ({ success: true, data: WORD });
    expectTypeError(
      () => interpret(plain, [1n], { staticcall, call: true } as never),
      'TYPE_MISMATCH',
      `interpret: chain.call must be a function when given, got a boolean${HOW}`,
    );
    expectTypeError(
      () => interpret(plain, [1n], { staticcall, account: {} } as never),
      'TYPE_MISMATCH',
      `interpret: chain.account must be a function when given, got an object${HOW}`,
    );
  });

  test('a script that needs no oracle runs without one', () => {
    for (const chain of [undefined, {}]) {
      expect(interpret(plain, [5n], chain as never).outcome).toMatchObject({
        kind: 'return',
        values: { x: 5n },
      });
    }
  });

  test('a chain with call alone answers a script whose only sites are s.call', () => {
    const chain = { call: () => ({ success: true, data: WORD }) };
    expect(interpret(pokes, [TARGET], chain as never).outcome).toMatchObject({
      kind: 'return',
      values: { r: 7n },
    });
    expectTypeError(
      () => interpret(pokes, [TARGET], {} as never),
      'TYPE_MISMATCH',
      `interpret: chain.staticcall must be a function (script "pokes" calls poke()), got undefined${HOW}`,
    );
  });
});

describe('eliminateDeadCode: a value that is no IR', () => {
  const compiled = compile(plain);

  test.each([
    ['a script', plain],
    ['a compiled artifact', compiled],
  ])('%s is refused, with what to pass', (_name, value) => {
    expectTypeError(
      () => eliminateDeadCode(value as never),
      'TYPE_MISMATCH',
      'eliminateDeadCode: expected a ScriptIr, got a script or a compiled artifact, which holds its IR under `ir` — pass that',
    );
  });

  test.each([
    [
      'a precompiled script',
      compiled.toPrecompiled(),
      /got a precompiled script, which holds no IR/,
    ],
    ['undefined', undefined, /got undefined$/],
    ['an empty object', {}, /got an object without the tables of an IR/],
  ])('%s is refused', (_name, value, message) => {
    expectTypeError(() => eliminateDeadCode(value as never), 'TYPE_MISMATCH', message);
  });

  test('the IR of a script is taken as before', () => {
    expect(eliminateDeadCode(plain.ir)).toBe(plain.ir);
  });
});
