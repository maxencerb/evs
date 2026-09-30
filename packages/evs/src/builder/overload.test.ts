/* oxlint-disable typescript/no-unsafe-type-assertion --
 * the `Loose` casts deliberately defeat the type surface to prove the RUNTIME resolution reports
 * the same misuses the types reject (ambiguous / unmatched args, a wrong-bucket signature). */
/**
 * Overload resolution (issue #4): an overloaded `functionName` resolves by the args' types at
 * record time, a canonical signature (`'get(uint256)'`) names one overload exactly, args that fit
 * several overloads throw `ABI_SHAPE`, args that fit none throw `TYPE_MISMATCH`, and overloads
 * outside the verb's mutability bucket never compete. Asserted on the recorded `call` stmt (its
 * selector and plain ABI), which is what codegen lowers.
 */
import type { Abi } from 'abitype';
import { toFunctionSelector } from 'viem';
import { describe, expect, test } from 'vite-plus/test';

import { EvsError, EvsTypeError } from '../core/errors.js';
import { t, type Expr } from '../core/types.js';
import { walkStmts, type ScriptIr } from '../ir/nodes.js';
import { evscript, type ScriptBuilder } from './script.js';

const ovAbi = [
  {
    type: 'function',
    name: 'get',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'get',
    stateMutability: 'view',
    inputs: [{ name: 'who', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'get',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'uint256' }],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    type: 'function',
    name: 'get',
    stateMutability: 'pure',
    inputs: [{ name: 'id', type: 'uint8' }],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'get',
    stateMutability: 'view',
    inputs: [
      {
        name: 'p',
        type: 'tuple',
        components: [
          { name: 'id', type: 'uint256' },
          { name: 'owner', type: 'address' },
        ],
      },
    ],
    outputs: [
      { name: 'a', type: 'uint256' },
      { name: 'b', type: 'address' },
    ],
  },
  {
    type: 'function',
    name: 'get',
    stateMutability: 'view',
    inputs: [{ name: 'ids', type: 'uint256[]' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'get',
    stateMutability: 'view',
    inputs: [
      { name: 'a', type: 'uint256' },
      { name: 'b', type: 'string' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'get',
    stateMutability: 'view',
    inputs: [
      { name: 'a', type: 'uint256' },
      { name: 'b', type: 'bool' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  // nonpayable overloads: compete only under s.call / s.simulate
  {
    type: 'function',
    name: 'get',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'h', type: 'bytes32' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'get',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'a', type: 'uint256' },
      { name: 'b', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'int256' }],
  },
] as const satisfies Abi;

const ALICE = '0x00000000000000000000000000000000000000a1';
const HASH = '0x00000000000000000000000000000000000000000000000000000000000000ff';

type Body = (
  s: ScriptBuilder,
  target: Expr<'address'>,
  id: Expr<'uint256'>,
  small: Expr<'uint8'>,
  who: Expr<'address'>,
) => unknown;

/** Records `body` in a throwaway script with (target, id, small, who) args; returns the IR. */
function record(body: Body): ScriptIr {
  const script = evscript(
    { name: 'ov', args: [t.address, t.uint256, t.uint8, t.address] },
    (s, target, id, small, who) => {
      body(s, target, id, small, who);
      return s.return({ ok: s.lit(t.bool, true) });
    },
  );
  return script.ir;
}

/** The selectors of every recorded `call` stmt, in order. */
function calledSelectors(ir: ScriptIr): string[] {
  const out: string[] = [];
  walkStmts(ir.body, (st) => {
    if (st.k === 'call') out.push(st.fnAbi.selector);
  });
  return out;
}

const sel = (sig: string): string => toFunctionSelector(`function ${sig}`);

function catchEvs(fn: () => unknown): EvsError {
  try {
    fn();
  } catch (e) {
    if (e instanceof EvsError) return e;
    throw e;
  }
  throw new Error('expected an EvsError');
}

// the untyped call surface: several tests pass args the static types reject on purpose
type Loose = (p: unknown) => unknown;

describe('resolution by argument types', () => {
  test('arity, then handle types, pick the overload', () => {
    const ir = record((s, target, id, small, who) => {
      s.read({ address: target, abi: ovAbi, functionName: 'get' });
      s.read({ address: target, abi: ovAbi, functionName: 'get', args: [id] });
      s.read({ address: target, abi: ovAbi, functionName: 'get', args: [small] });
      s.read({ address: target, abi: ovAbi, functionName: 'get', args: [who] });
      s.read({ address: target, abi: ovAbi, functionName: 'get', args: [id, 'x'] });
      s.read({ address: target, abi: ovAbi, functionName: 'get', args: [id, true] });
    });
    expect(calledSelectors(ir)).toEqual([
      sel('get()'),
      sel('get(uint256)'),
      sel('get(uint8)'),
      sel('get(address)'),
      sel('get(uint256,string)'),
      sel('get(uint256,bool)'),
    ]);
  });

  test('literals resolve by JS kind (hex string, struct record, array)', () => {
    const ir = record((s, target) => {
      s.read({ address: target, abi: ovAbi, functionName: 'get', args: [ALICE] });
      s.read({
        address: target,
        abi: ovAbi,
        functionName: 'get',
        args: [{ id: 1n, owner: ALICE }],
      });
      s.read({ address: target, abi: ovAbi, functionName: 'get', args: [[1n, 2n]] });
      // an empty array fits only the array overload (the tuple one wants a name-keyed record)
      (s.read as Loose)({ address: target, abi: ovAbi, functionName: 'get', args: [[]] });
    });
    expect(calledSelectors(ir)).toEqual([
      sel('get(address)'),
      sel('get((uint256,address))'),
      sel('get(uint256[])'),
      sel('get(uint256[])'),
    ]);
  });

  test('a Tuple handle selects the tuple overload; the result is typed from it', () => {
    let keys: string[] = [];
    const ir = record((s, target, id, _small, who) => {
      const p = s.tuple(t.struct({ id: t.uint256, owner: t.address }), { id, owner: who });
      const out = s.read({ address: target, abi: ovAbi, functionName: 'get', args: [p] });
      keys = Object.keys(out);
      expect(out).toHaveLength(2);
    });
    expect(keys).toEqual(['0', '1']);
    expect(calledSelectors(ir)).toEqual([sel('get((uint256,address))')]);
  });

  test('the recorded call carries the chosen overload (inputs + outputs)', () => {
    const ir = record((s, target, _id, small) => {
      s.read({ address: target, abi: ovAbi, functionName: 'get', args: [small] });
    });
    let fnAbi: unknown;
    walkStmts(ir.body, (st) => {
      if (st.k === 'call') fnAbi = st.fnAbi;
    });
    expect(fnAbi).toMatchObject({
      name: 'get',
      inputs: [{ type: 'uint8' }],
      outputs: [{ type: 'bytes32' }],
      selector: sel('get(uint8)'),
    });
  });

  test('a single arity match is taken as is — the coercion reports the precise mismatch', () => {
    const e = catchEvs(() =>
      record((s, target) => {
        (s.read as Loose)({ address: target, abi: ovAbi, functionName: 'get', args: [1n, 2n] });
      }),
    );
    // two 2-arg overloads (uint256,string)/(uint256,bool): 2n fits neither second param
    expect(e.code).toBe('TYPE_MISMATCH');
    expect(e.message).toMatch(/match none of the overloads of "get" taking 2 argument\(s\)/);
    expect(e.message).toMatch(/get\(uint256,string\), get\(uint256,bool\)/);
  });

  test('no overload of that arity → TYPE_MISMATCH listing the overloads', () => {
    const e = catchEvs(() =>
      record((s, target) => {
        (s.read as Loose)({ address: target, abi: ovAbi, functionName: 'get', args: [1, 2, 3] });
      }),
    );
    expect(e).toBeInstanceOf(EvsTypeError);
    expect(e.code).toBe('TYPE_MISMATCH');
    expect(e.message).toMatch(/no overload of "get" takes 3 argument\(s\)/);
    expect(e.message).toMatch(/get\(\), get\(address\), get\(uint256\)/);
  });
});

describe('ambiguity', () => {
  test.each([
    ['a bigint literal', [1n], /get\(uint256\), get\(uint8\)/],
    ['a number literal', [1], /get\(uint256\), get\(uint8\)/],
  ])('%s fitting several overloads → ABI_SHAPE', (_label, args, fits) => {
    const e = catchEvs(() =>
      record((s, target) => {
        (s.read as Loose)({ address: target, abi: ovAbi, functionName: 'get', args });
      }),
    );
    expect(e).toBeInstanceOf(EvsTypeError);
    expect(e.code).toBe('ABI_SHAPE');
    expect(e.message).toMatch(/call to overloaded function "get" is ambiguous/);
    expect(e.message).toMatch(fits);
    expect(e.message).toMatch(/s\.lit\(t\.uint8, 1\)|functionName: "get\(/);
  });

  test('a typed literal (s.lit) or a signature settles it', () => {
    const ir = record((s, target) => {
      s.read({ address: target, abi: ovAbi, functionName: 'get', args: [s.lit(t.uint8, 1)] });
      s.read({ address: target, abi: ovAbi, functionName: 'get(uint256)', args: [1n] });
      s.read({ address: target, abi: ovAbi, functionName: 'get(uint8)', args: [1] });
    });
    expect(calledSelectors(ir)).toEqual([
      sel('get(uint8)'),
      sel('get(uint256)'),
      sel('get(uint8)'),
    ]);
  });
});

describe('signature functionName', () => {
  test('selects the entry; whitespace is ignored; tuples use (type,…)', () => {
    const ir = record((s, target, id) => {
      (s.read as Loose)({
        address: target,
        abi: ovAbi,
        functionName: 'get(uint256, string)',
        args: [id, 'x'],
      });
      s.read({
        address: target,
        abi: ovAbi,
        functionName: 'get((uint256,address))',
        args: [{ id: 1n, owner: ALICE }],
      });
      s.read({ address: target, abi: ovAbi, functionName: 'get()' });
    });
    expect(calledSelectors(ir)).toEqual([
      sel('get(uint256,string)'),
      sel('get((uint256,address))'),
      sel('get()'),
    ]);
  });

  test("the signature's args are coerced against that overload only", () => {
    const e = catchEvs(() =>
      record((s, target) => {
        (s.read as Loose)({
          address: target,
          abi: ovAbi,
          functionName: 'get(uint256)',
          args: [ALICE],
        });
      }),
    );
    expect(e.code).toBe('TYPE_MISMATCH');
    expect(e.message).toMatch(/uint256 literal must be a number or bigint/);
  });

  test('an unknown signature → ABI_SHAPE listing the known ones', () => {
    const e = catchEvs(() =>
      record((s, target) => {
        (s.read as Loose)({ address: target, abi: ovAbi, functionName: 'get(uint)', args: [1n] });
      }),
    );
    expect(e.code).toBe('ABI_SHAPE');
    expect(e.message).toMatch(/no function with signature "get\(uint\)"/);
    expect(e.message).toMatch(/the ABI has get\(\), get\(address\)/);
    const e2 = catchEvs(() =>
      record((s, target) => {
        (s.read as Loose)({ address: target, abi: ovAbi, functionName: 'nope(uint256)' });
      }),
    );
    expect(e2.message).toMatch(/the ABI has no function named "nope"/);
  });

  test('a signature in the wrong mutability bucket gets the steering error', () => {
    const e = catchEvs(() =>
      record((s, target) => {
        (s.call as Loose)({ address: target, abi: ovAbi, functionName: 'get(uint8)', args: [1] });
      }),
    );
    expect(e.code).toBe('ABI_SHAPE');
    expect(e.message).toMatch(/function "get\(uint8\)" is pure/);
    expect(e.message).toMatch(/use s\.read/);
  });

  test('a non-overloaded function records identically by name or by signature', () => {
    const abi = [
      {
        type: 'function',
        name: 'solo',
        stateMutability: 'view',
        inputs: [{ name: 'x', type: 'uint256' }],
        outputs: [{ name: '', type: 'uint256' }],
      },
    ] as const satisfies Abi;
    const byName = record((s, target, id) => {
      s.read({ address: target, abi, functionName: 'solo', args: [id] });
    });
    const bySig = record((s, target, id) => {
      s.read({ address: target, abi, functionName: 'solo(uint256)', args: [id] });
    });
    expect(bySig).toEqual(byName);
  });
});

describe('mutability filtering', () => {
  test('only the verb bucket competes', () => {
    const ir = record((s, target, id) => {
      // a 0x string fits get(address) (view) AND get(bytes32) (nonpayable) by kind — but each
      // verb sees one bucket, so neither call is ambiguous
      s.read({ address: target, abi: ovAbi, functionName: 'get', args: [ALICE] });
      s.call({ address: target, abi: ovAbi, functionName: 'get', args: [HASH] });
      s.simulate({ address: target, abi: ovAbi, functionName: 'get', args: [1n, 2n] });
      s.tryCall({ address: target, abi: ovAbi, functionName: 'get', args: [id, id] });
    });
    expect(calledSelectors(ir)).toEqual([
      sel('get(address)'),
      sel('get(bytes32)'),
      sel('get(uint256,uint256)'),
      sel('get(uint256,uint256)'),
    ]);
  });

  test('a nonpayable overload is not a candidate under s.read', () => {
    // get(uint256,uint256) exists, but it is nonpayable: s.read only sees the view 2-arg overloads
    const e = catchEvs(() =>
      record((s, target, id) => {
        (s.read as Loose)({ address: target, abi: ovAbi, functionName: 'get', args: [id, id] });
      }),
    );
    expect(e.code).toBe('TYPE_MISMATCH');
    expect(e.message).toMatch(/get\(uint256,string\), get\(uint256,bool\)/);
    expect(e.message).not.toMatch(/get\(uint256,uint256\)/);
    // ...and under s.call the zero-arg view overload does not exist
    const e2 = catchEvs(() =>
      record((s, target) => {
        (s.call as Loose)({ address: target, abi: ovAbi, functionName: 'get' });
      }),
    );
    expect(e2.code).toBe('TYPE_MISMATCH');
    expect(e2.message).toMatch(
      /no overload of "get" takes 0 argument\(s\) \(overloads: get\(bytes32\), get\(uint256,uint256\)\)/,
    );
  });

  test('a duplicated ABI entry is one function, not an overload', () => {
    const entry = {
      type: 'function',
      name: 'dup',
      stateMutability: 'view',
      inputs: [{ name: 'x', type: 'uint256' }],
      outputs: [{ name: '', type: 'uint256' }],
    } as const;
    const ir = record((s, target) => {
      (s.read as Loose)({ address: target, abi: [entry, entry], functionName: 'dup', args: [1n] });
    });
    expect(calledSelectors(ir)).toEqual([sel('dup(uint256)')]);
  });
});
