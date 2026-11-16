/* oxlint-disable typescript/no-unsafe-type-assertion --
 * these tests defeat the type surface (`as never`) to prove the recorder refuses what the types
 * refuse; every assertion below is a seeded violation. */
/* oxlint-disable vitest/expect-expect --
 * the refusals assert through the expectRefusal() helper (class + code + message); the rule
 * only recognizes direct expect* calls. */
/**
 * Call parameter tests, the recorder's side of `call-params.test-d.ts`: a call the types refuse
 * (`args` left out, `struct: true` on an unnamed output) is refused at recording too, and an ABI
 * entry with no `stateMutability` is read by its `constant` / `payable` flags.
 */
import { encodeFunctionData, parseAbi } from 'viem';
import { describe, expect, test } from 'vite-plus/test';

import { EvsError, EvsTypeError, type EvsErrorCode } from '../core/errors.js';
import { t, type Expr } from '../core/types.js';
import type { Stmt } from '../ir/nodes.js';
import { evscript, type ScriptBuilder } from './script.js';

const abi = parseAbi([
  'function decimals() view returns (uint8)',
  'function balanceOf(address owner) view returns (uint256)',
  'function rate(uint256 id) view returns (uint256)',
  'function rate(uint256 id, uint256 at) view returns (uint256)',
  'function total() view returns (uint256)',
  'function total(address asset) view returns (uint256 amount, uint256 shares)',
  'function poke()',
  'function deposit(uint256 amount) returns (uint256 shares)',
  'function getConfig(uint8 id) view returns ((uint16 ltv, uint16 liquidationThreshold))',
  'function nothing() view',
  'function burn(uint256 amount) returns (uint256)',
]);

/** Records a script whose body is one call on `target`, and returns what the body threw. */
function refusal(body: (s: ScriptBuilder, target: Expr<'address'>) => unknown): EvsError {
  let thrown: unknown;
  try {
    evscript({ name: 'probe', args: [t.address] }, (s, target) => {
      body(s, target);
      return s.return({ ok: s.lit(t.bool, true) });
    });
  } catch (e) {
    thrown = e;
  }
  if (!(thrown instanceof EvsError)) {
    throw new Error(`expected the recorder to refuse the call, got ${String(thrown)}`);
  }
  return thrown;
}

function expectRefusal(
  body: (s: ScriptBuilder, target: Expr<'address'>) => unknown,
  code: EvsErrorCode,
  message: string | RegExp,
): void {
  const e = refusal(body);
  expect(e).toBeInstanceOf(EvsTypeError);
  expect(e.code).toBe(code);
  expect(e.message).toMatch(message);
}

const VERBS = ['read', 'tryRead', 'call', 'tryCall', 'simulate', 'trySimulate'] as const;

/** Calls one of the six verbs with params its types need not accept. */
function callVerb(s: ScriptBuilder, verb: (typeof VERBS)[number], params: object): unknown {
  return (s as unknown as Record<string, (p: object) => unknown>)[verb]?.(params);
}

/** The `call` statements a body records, in order. */
function callsOf(body: (s: ScriptBuilder, target: Expr<'address'>) => unknown): Stmt[] {
  const script = evscript({ name: 'probe', args: [t.address] }, (s, target) => {
    body(s, target);
    return s.return({ ok: s.lit(t.bool, true) });
  });
  return script.ir.body.filter((st) => st.k === 'call');
}

describe('args left out of a call to a function that takes arguments', () => {
  test.each(VERBS)('s.%s refuses it', (verb) => {
    const functionName = verb === 'read' || verb === 'tryRead' ? 'balanceOf' : 'deposit';
    expectRefusal(
      (s, target) => callVerb(s, verb, { address: target, abi, functionName }),
      'TYPE_MISMATCH',
      `s.${verb}(): function "${functionName}" expects 1 argument(s), got 0`,
    );
  });

  test('args: undefined is a missing args', () => {
    expectRefusal(
      (s, target) =>
        s.read({ address: target, abi, functionName: 'balanceOf', args: undefined } as never),
      'TYPE_MISMATCH',
      'expects 1 argument(s), got 0',
    );
  });

  test('an overloaded name with no overload taking none', () => {
    expectRefusal(
      (s, target) => s.read({ address: target, abi, functionName: 'rate' } as never),
      'TYPE_MISMATCH',
      'no overload of "rate" takes 0 argument(s)',
    );
    expectRefusal(
      (s, target) => s.read({ address: target, abi, functionName: 'rate(uint256)' } as never),
      'TYPE_MISMATCH',
      'function "rate(uint256)" expects 1 argument(s), got 0',
    );
  });

  test('the revertReturns form', () => {
    expectRefusal(
      (s, target) =>
        s.call({
          address: target,
          abi,
          functionName: 'deposit',
          revertReturns: [t.uint256],
        } as never),
      'TYPE_MISMATCH',
      'function "deposit" expects 1 argument(s), got 0',
    );
  });

  test('a function that takes none records with args left out, or empty', () => {
    const [omitted, empty, overloaded, write] = callsOf((s, target) => {
      s.read({ address: target, abi, functionName: 'decimals' });
      s.read({ address: target, abi, functionName: 'decimals', args: [] });
      // total() is the overload a call without args resolves to
      s.read({ address: target, abi, functionName: 'total' });
      s.call({ address: target, abi, functionName: 'poke' });
    });
    expect(omitted).toMatchObject({ k: 'call', args: [], fnAbi: { name: 'decimals' } });
    expect(empty).toMatchObject({ k: 'call', args: [], fnAbi: { name: 'decimals' } });
    expect(overloaded).toMatchObject({
      k: 'call',
      args: [],
      fnAbi: { name: 'total', selector: '0x2ddbd13a' },
    });
    expect(write).toMatchObject({ k: 'call', args: [], kind: 'call', fnAbi: { name: 'poke' } });
  });
});

describe('struct: true on outputs that make no named Tuple', () => {
  test('an unnamed output', () => {
    expectRefusal(
      (s, target) =>
        s.read({
          address: target,
          abi,
          functionName: 'getConfig',
          args: [1],
          struct: true,
        } as never),
      'ABI_SHAPE',
      's.read({ struct: true }): output #0 of "getConfig" is unnamed',
    );
    expectRefusal(
      (s, target) =>
        s.trySimulate({
          address: target,
          abi,
          functionName: 'burn',
          args: [1n],
          struct: true,
        } as never),
      'ABI_SHAPE',
      's.trySimulate({ struct: true }): output #0 of "burn" is unnamed',
    );
  });

  test('no output', () => {
    expectRefusal(
      (s, target) =>
        s.read({ address: target, abi, functionName: 'nothing', struct: true } as never),
      'ABI_SHAPE',
      'function "nothing" has no outputs to build a struct from',
    );
  });

  test('the default result of a struct getter is the named Tuple', () => {
    const script = evscript({ name: 'config', args: [t.address, t.uint8] }, (s, pool, id) => {
      const config = s.read({ address: pool, abi, functionName: 'getConfig', args: [id] });
      return s.return({ threshold: config.liquidationThreshold.get() });
    });
    expect(script.ir.returns).toEqual([
      { name: 'threshold', type: 'uint16', value: expect.any(Number) },
    ]);
  });
});

describe('an ABI entry without stateMutability', () => {
  // the shape solc gave before 0.4.16, as block explorers still serve it
  const legacyAbi = [
    {
      constant: true,
      inputs: [],
      name: 'totalSupply',
      outputs: [{ name: '', type: 'uint256' }],
      payable: false,
      type: 'function',
    },
    {
      constant: false,
      inputs: [
        { name: 'to', type: 'address' },
        { name: 'punkIndex', type: 'uint256' },
      ],
      name: 'transferPunk',
      outputs: [],
      payable: false,
      type: 'function',
    },
    {
      constant: false,
      inputs: [{ name: 'punkIndex', type: 'uint256' }],
      name: 'buyPunk',
      outputs: [],
      payable: true,
      type: 'function',
    },
    // neither flag: nonpayable
    { inputs: [], name: 'withdraw', outputs: [], type: 'function' },
  ];
  const WHO = '0x00000000000000000000000000000000000000aa';

  test('constant: true is a view function: s.read / s.tryRead take it', () => {
    const [strict, tried] = callsOf((s, target) => {
      s.read({ address: target, abi: legacyAbi, functionName: 'totalSupply' });
      s.tryRead({ address: target, abi: legacyAbi, functionName: 'totalSupply' });
    });
    // viem encodes the same call from the same entry
    const selector = encodeFunctionData({ abi: legacyAbi, functionName: 'totalSupply' });
    expect(strict).toMatchObject({ k: 'call', mode: 'strict', fnAbi: { selector } });
    expect(strict).not.toHaveProperty('kind');
    expect(tried).toMatchObject({ k: 'call', mode: 'try', fnAbi: { selector } });
  });

  test('it records what the same entry with stateMutability records', () => {
    const modern = legacyAbi.map((entry) => ({
      ...entry,
      stateMutability: entry.constant === true ? 'view' : 'nonpayable',
    }));
    const record = (abiOf: readonly unknown[]): Stmt[] =>
      callsOf((s, target) => {
        s.read({ address: target, abi: abiOf, functionName: 'totalSupply' });
        s.simulate({
          address: target,
          abi: abiOf,
          functionName: 'transferPunk',
          args: [WHO, 1n],
        });
      });
    expect(record(legacyAbi)).toEqual(record(modern));
  });

  test('constant: false is nonpayable: the CALL verbs take it', () => {
    const args = [WHO, 1n];
    const calls = callsOf((s, target) => {
      s.call({ address: target, abi: legacyAbi, functionName: 'transferPunk', args });
      s.tryCall({ address: target, abi: legacyAbi, functionName: 'transferPunk', args });
      s.simulate({ address: target, abi: legacyAbi, functionName: 'transferPunk', args });
      s.trySimulate({ address: target, abi: legacyAbi, functionName: 'transferPunk', args });
      s.call({ address: target, abi: legacyAbi, functionName: 'withdraw' });
    });
    expect(calls.map((st) => (st.k === 'call' ? st.kind : undefined))).toEqual([
      'call',
      'call',
      'simulate',
      'simulate',
      'call',
    ]);
  });

  test('the wrong verb is steered by the mutability the flags give', () => {
    expectRefusal(
      (s, target) => s.call({ address: target, abi: legacyAbi, functionName: 'totalSupply' }),
      'ABI_SHAPE',
      /function "totalSupply" is view\. s\.call\(\) runs under CALL .* use s\.read/,
    );
    expectRefusal(
      (s, target) =>
        s.read({
          address: target,
          abi: legacyAbi,
          functionName: 'transferPunk',
          args: [WHO, 1n],
        }),
      'ABI_SHAPE',
      /function "transferPunk" is nonpayable\. s\.read\(\) runs under STATICCALL/,
    );
    expectRefusal(
      (s, target) =>
        s.read({ address: target, abi: legacyAbi, functionName: 'buyPunk', args: [1n] }),
      'ABI_SHAPE',
      /function "buyPunk" is payable\. s\.read\(\) runs under STATICCALL/,
    );
  });

  test('payable: true takes a value, payable: false does not', () => {
    const [buy] = callsOf((s, target) => {
      s.call({
        address: target,
        abi: legacyAbi,
        functionName: 'buyPunk',
        args: [1n],
        value: 10n,
      });
    });
    expect(buy).toHaveProperty('value');
    expectRefusal(
      (s, target) =>
        s.call({
          address: target,
          abi: legacyAbi,
          functionName: 'transferPunk',
          args: [WHO, 1n],
          value: 10n,
        }),
      'TYPE_MISMATCH',
      '`value` is only accepted for a payable function — "transferPunk" is nonpayable',
    );
  });

  test('a stateMutability that is present wins over the flags', () => {
    const mixed = [
      {
        constant: true,
        inputs: [],
        name: 'claim',
        outputs: [],
        payable: false,
        stateMutability: 'nonpayable',
        type: 'function',
      },
    ];
    expect(
      callsOf((s, target) => s.call({ address: target, abi: mixed, functionName: 'claim' })),
    ).toHaveLength(1);
    expectRefusal(
      (s, target) => s.read({ address: target, abi: mixed, functionName: 'claim' }),
      'ABI_SHAPE',
      /function "claim" is nonpayable/,
    );
  });

  test('a stateMutability that is none of the four is named, by every verb', () => {
    for (const bad of ['constant', null, 1]) {
      const broken = [
        { inputs: [], name: 'f', outputs: [], stateMutability: bad, type: 'function' },
      ];
      for (const verb of VERBS) {
        const e = refusal((s, target) =>
          callVerb(s, verb, { address: target, abi: broken, functionName: 'f' }),
        );
        expect(e.code).toBe('ABI_SHAPE');
        expect(e.message).toBe(
          `s.${verb}(): function "f" has the stateMutability ${JSON.stringify(bad)} — an ABI function entry declares 'pure', 'view', 'nonpayable' or 'payable' (an entry with no stateMutability is read by its \`constant\` / \`payable\` flags)`,
        );
      }
    }
  });
});
