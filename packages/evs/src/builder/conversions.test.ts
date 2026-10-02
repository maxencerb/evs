/* oxlint-disable typescript/no-unsafe-type-assertion --
 * the rejection cases deliberately defeat the type surface (`as never`) to prove the RUNTIME
 * checks catch the same misuses. */
/* oxlint-disable vitest/expect-expect --
 * the rejection tests assert through the expectTypeError() helper (class + code + message). */
/**
 * Builder unit tests — recording of the address / fixed-bytes / string-bytes conversions and
 * byte access: result types, the IR each one records, literal folding, and the recording-time
 * rejections. The field report's three repros are replayed first, spelled with the new surface
 * (their runtime semantics are pinned by `differential/casts-and-bytes.test.ts` and the solc
 * oracle in `test/integration/casts.test.ts`).
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, test } from 'vite-plus/test';

import { compile } from '../compile.js';
import { EvsTypeError } from '../core/errors.js';
import { t, type EvsType, type Expr } from '../core/types.js';
import { validateIr } from '../ir/validate.js';
import { evscript } from './script.js';

/** Records a one-arg script returning `op(x)`; the out value's type. */
function resultType(arg: EvsType, op: (x: never) => unknown): EvsType | undefined {
  const script = evscript({ name: 'f', args: [arg] }, (s, x) =>
    s.return({ v: op(x as never) as never }),
  );
  expect(() => validateIr(script.ir)).not.toThrow();
  return script.ir.returns[0]?.type;
}

/**
 * tsc's diagnostics for `source`, a module compiled in memory under `src/` with the package's
 * own compiler options (each message flattened, its chain on the following lines).
 */
function tscErrors(source: string): string[] {
  const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const config = ts.getParsedCommandLineOfConfigFile(join(pkgDir, 'tsconfig.json'), undefined, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    },
  });
  if (config === undefined) throw new Error('could not read packages/evs/tsconfig.json');
  const options: ts.CompilerOptions = { ...config.options, noEmit: true };
  const fixturePath = ts.sys.resolvePath(join(pkgDir, 'src', '__to-uint-hint.fixture.ts'));
  const base = ts.createCompilerHost(options);
  const host: ts.CompilerHost = {
    ...base,
    fileExists: (f) => f === fixturePath || base.fileExists(f),
    readFile: (f) => (f === fixturePath ? source : base.readFile(f)),
    getSourceFile: (f, lang, ...rest) =>
      f === fixturePath
        ? ts.createSourceFile(f, source, lang)
        : base.getSourceFile(f, lang, ...rest),
  };
  const program = ts.createProgram([fixturePath], options, host);
  return ts
    .getPreEmitDiagnostics(program, program.getSourceFile(fixturePath))
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

function expectTypeError(fn: () => unknown, msg: RegExp): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(EvsTypeError);
  expect((caught as EvsTypeError).code).toBe('TYPE_MISMATCH');
  expect((caught as EvsTypeError).message).toMatch(msg);
}

// ---------------------------------------------------------------------------
// the field report's repros, with the new spelling
// ---------------------------------------------------------------------------

describe('field-report repros now record', () => {
  // every row is Solidity-legal; before, evs rejected all but the two controls
  const rows: [string, EvsType, (x: never) => unknown, EvsType][] = [
    ['bytes(s)[i]', t.string, (x: Expr<'string'>) => x.byteAt(0n), 'bytes1'],
    ['b[i]', t.bytes, (x: Expr<'bytes'>) => x.byteAt(0n), 'bytes1'],
    ['uint160(address)', t.address, (x: Expr<'address'>) => x.asUint160(), 'uint160'],
    [
      'uint256(uint160(address))',
      t.address,
      (x: Expr<'address'>) => x.asUint160().toUint(t.uint256),
      'uint256',
    ],
    ['uint32(bytes4)', t.bytes4, (x: Expr<'bytes4'>) => x.asUint(), 'uint32'],
    ['bytes8(uint64)', t.uint64, (x: Expr<'uint64'>) => x.asBytesN(), 'bytes8'],
    ['address(uint160)', t.uint160, (x: Expr<'uint160'>) => x.asAddress(), 'address'],
    ['string(bytes)', t.bytes, (x: Expr<'bytes'>) => x.asString(), 'string'],
    ['bytes(string)', t.string, (x: Expr<'string'>) => x.asBytes(), 'bytes'],
    ['bytes32 symbol → string', t.bytes32, (x: Expr<'bytes32'>) => x.asString(), 'string'],
    ['b[4:]', t.bytes, (x: Expr<'bytes'>) => x.slice(4n), 'bytes'],
    ['s[0:3]', t.string, (x: Expr<'string'>) => x.slice(0n, 3n), 'string'],
    // Solidity's address(bytes20) / bytes20(address): two steps through uint160
    ['address(bytes20)', t.bytes20, (x: Expr<'bytes20'>) => x.asUint().asAddress(), 'address'],
    ['bytes20(address)', t.address, (x: Expr<'address'>) => x.asUint160().asBytesN(), 'bytes20'],
    // controls (documented before, still accepted)
    ['uint256(bytes32)', t.bytes32, (x: Expr<'bytes32'>) => x.asUint256(), 'uint256'],
    ['address(uint256)', t.uint256, (x: Expr<'uint256'>) => x.asAddress(), 'address'],
  ];
  test.each(rows)('%s', (_label, arg, op, out) => {
    expect(resultType(arg, op)).toBe(out);
  });

  test('address ordering: a.lt(b), s.lt(a, b), token sort', () => {
    const script = evscript({ name: 'sort', args: [t.address, t.address] } as const, (s, a, b) => {
      const lt = a.lt(b);
      return s.return({ lt, viaS: s.lt(a, b), token0: s.select(lt, a, b) });
    });
    expect(script.ir.returns.map((r) => r.type)).toEqual(['bool', 'bool', 'address']);
    expect(
      script.ir.body.filter((st) => st.k === 'bin').map((st) => st.k === 'bin' && st.op),
    ).toEqual(['lt', 'lt']);
  });
});

// ---------------------------------------------------------------------------
// recorded IR
// ---------------------------------------------------------------------------

describe('recorded IR', () => {
  test('conversions are one convert statement; byteAt an index; slice a slice', () => {
    const script = evscript(
      { name: 'ir', args: [t.address, t.bytes4, t.bytes, t.bytes32] },
      (s, a, b4, raw, b32) =>
        s.return({
          u: a.asUint160(),
          n: b4.asUint(),
          c: raw.byteAt(1n),
          part: raw.slice(1n, 2n),
          sym: b32.asString(),
        }),
    );
    expect(script.ir.body.map((st) => st.k)).toEqual([
      'convert',
      'convert',
      'const', // the index 1n (interned; reused by the slice's start)
      'index',
      'const', // 2n
      'slice',
      'convert',
    ]);
  });

  test('slice without an end records the receiver length as the end', () => {
    const script = evscript({ name: 'tail', args: [t.bytes] }, (s, raw) =>
      s.return({ rest: raw.slice(4n) }),
    );
    const [, len, slice] = script.ir.body;
    expect(len?.k).toBe('len');
    expect(slice?.k === 'slice' && len?.k === 'len' && slice.end === len.out).toBe(true);
  });

  test('word conversions of literals fold; memref ones record', () => {
    const script = evscript({ name: 'folds', args: [] }, (s) =>
      s.return({
        u: s.lit(t.bytes2, '0xbeef').asUint(),
        b: s.lit(t.uint8, 7n).asBytesN(),
        lt: s.lt(
          s.lit(t.address, '0x0000000000000000000000000000000000000001'),
          '0x0000000000000000000000000000000000000002',
        ),
        str: s.lit(t.bytes4, '0x41420000').asString(),
      }),
    );
    expect(script.ir.body.filter((st) => st.k === 'convert')).toHaveLength(1); // the string
    expect(script.ir.body.some((st) => st.k === 'bin')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// rejections
// ---------------------------------------------------------------------------

describe('recording-time rejections', () => {
  const rec = (arg: EvsType, op: (x: never) => unknown) => () => resultType(arg, op);

  test('ordering stays off bool / memrefs', () => {
    expectTypeError(
      rec(t.bool, (x: Expr<'uint8'>) => x.lt(1n)),
      /operands must be ordered \(uintN\/intN\/address\/bytesN\), got 'bool'/,
    );
    expectTypeError(
      rec(t.string, (x: Expr<'uint8'>) => x.gt(1n)),
      /must be ordered/,
    );
  });

  test('each as* conversion names its accepted sources', () => {
    expectTypeError(
      rec(t.uint256, (x: Expr<'address'>) => x.asUint160()),
      /\.asUint160\(\) takes Expr<'address'>, got 'uint256'/,
    );
    expectTypeError(
      rec(t.uint128, (x: Expr<'uint160'>) => x.asAddress()),
      /\.asAddress\(\) takes .*Expr<'uint160'>, got 'uint128'/,
    );
    expectTypeError(
      rec(t.uint32, (x: Expr<'bytes4'>) => x.asUint()),
      /\.asUint\(\) takes Expr<'bytesN'>, got 'uint32'/,
    );
    expectTypeError(
      rec(t.int32, (x: Expr<'uint32'>) => x.asBytesN()),
      /\.asBytesN\(\) takes Expr<'uintN'>, got 'int32'/,
    );
    expectTypeError(
      rec(t.bytes, (x: Expr<'string'>) => x.asBytes()),
      /\.asBytes\(\) takes Expr<'string'>, got 'bytes'/,
    );
    expectTypeError(
      rec(t.uint256, (x: Expr<'bytes'>) => x.asString()),
      /\.asString\(\) takes Expr<'bytes'> \/ Expr<'bytesN'>, got 'uint256'/,
    );
  });

  test('byteAt / slice are string/bytes-only; .at on a string points to byteAt', () => {
    expectTypeError(
      rec(t.array(t.uint8), (x: Expr<'bytes'>) => x.byteAt(0n)),
      /\.byteAt\(i\) requires an Expr of string\/bytes, got 'uint8\[\]' \(use \.at\(i\) on arrays\)/,
    );
    expectTypeError(
      rec(t.bytes32, (x: Expr<'bytes'>) => x.slice(0n, 1n)),
      /\.slice\(\) requires an Expr of string\/bytes, got 'bytes32'/,
    );
    expectTypeError(
      rec(t.string, (x: Expr<'uint8[]'>) => x.at(0n)),
      /got 'string' — read a byte with \.byteAt\(i\)/,
    );
  });

  test('toUint / toInt on an address or bytesN point at the same-width as* conversion', () => {
    expectTypeError(
      rec(t.address, (x: Expr<'uint256'>) => x.toUint(t.uint160)),
      /cannot convert from 'address' — the source must be numeric \(uintN\/intN\) — use \.asUint160\(\) first \(then \.toUint\(…\)\)/,
    );
    expectTypeError(
      rec(t.bytes4, (x: Expr<'uint256'>) => x.toInt(t.int64)),
      /cannot convert from 'bytes4' — .* — use \.asUint\(\) first \(same width, then \.toInt\(…\)\)/,
    );
    // no hint for a receiver with no integer counterpart
    expectTypeError(
      rec(t.bool, (x: Expr<'uint256'>) => x.toUint(t.uint8)),
      /cannot convert from 'bool' — the source must be numeric \(uintN\/intN\)$/,
    );
  });

  test('tsc rejects the same receivers with the recording-time message', () => {
    const errors = tscErrors(`
      import { evscript, t } from './index.js';
      evscript(
        { name: 'f', args: [t.address, t.bytes4, t.bool, t.string, t.array(t.uint8)] },
        (s, a, b4, flag, str, arr) => {
          a.toUint(t.uint160);
          b4.toInt(t.int64);
          flag.toUint(t.uint8);
          str.toInt(t.int8);
          arr.toUint(t.uint256);
          return s.return({ ok: flag });
        },
      );
    `);
    // the error's first line ends on the `this` type, which is the message itself
    expect(errors.map((e) => e.split('\n')[0])).toEqual([
      `The 'this' context of type 'Expr<"address">' is not assignable to method's 'this' of type '{ readonly [conversionHint]: ".toUint(): cannot convert from 'address' — the source must be numeric (uintN/intN) — use .asUint160() first (then .toUint(…))"; }'.`,
      `The 'this' context of type 'Expr<"bytes4">' is not assignable to method's 'this' of type '{ readonly [conversionHint]: ".toInt(): cannot convert from 'bytes4' — the source must be numeric (uintN/intN) — use .asUint() first (same width, then .toInt(…))"; }'.`,
      `The 'this' context of type 'Expr<"bool">' is not assignable to method's 'this' of type '{ readonly [conversionHint]: ".toUint(): cannot convert from 'bool' — the source must be numeric (uintN/intN)"; }'.`,
      `The 'this' context of type 'Expr<"string">' is not assignable to method's 'this' of type '{ readonly [conversionHint]: ".toInt(): cannot convert from 'string' — the source must be numeric (uintN/intN)"; }'.`,
      `The 'this' context of type 'Expr<"uint8[]">' is not assignable to method's 'this' of type '{ readonly [conversionHint]: ".toUint(): cannot convert from 'uint8[]' — the source must be numeric (uintN/intN)"; }'.`,
    ]);
    // ...and that message is, verbatim, the recording-time TYPE_MISMATCH's
    const hints = errors.map(
      (e) => /\[conversionHint\]: "(.*)"; \}'\.$/.exec(e.split('\n')[0] ?? '')?.[1],
    );
    const runtime = (
      [
        [t.address, (x: Expr<'uint8'>) => x.toUint(t.uint160)],
        [t.bytes4, (x: Expr<'uint8'>) => x.toInt(t.int64)],
        [t.bool, (x: Expr<'uint8'>) => x.toUint(t.uint8)],
        [t.string, (x: Expr<'uint8'>) => x.toInt(t.int8)],
        [t.array(t.uint8), (x: Expr<'uint8'>) => x.toUint(t.uint256)],
      ] as const
    ).map(([arg, op]) => {
      try {
        resultType(arg, op);
      } catch (e) {
        return (e as EvsTypeError).message;
      }
      return undefined;
    });
    expect(hints).toEqual(runtime);
  }, 60_000);

  test('byteAt / slice positions are uint256', () => {
    const withIndex = (op: (raw: Expr<'bytes'>, i: Expr<'uint8'>) => unknown) => () =>
      evscript({ name: 'f', args: [t.bytes, t.uint8] }, (s, raw, i) =>
        s.return({ v: op(raw, i) as never }),
      );
    expectTypeError(
      withIndex((raw, i) => raw.byteAt(i as never)),
      /\.byteAt\(\) index: expected 'uint256', got Expr<'uint8'>/,
    );
    expectTypeError(
      withIndex((raw, i) => raw.slice(0n, i as never)),
      /\.slice\(\) end: expected 'uint256', got Expr<'uint8'>/,
    );
  });
});

// ---------------------------------------------------------------------------
// diagnostics
// ---------------------------------------------------------------------------

describe('source-map sites', () => {
  test('byteAt and slice bounds sites are named apart from array index / write', () => {
    const script = evscript(
      { name: 'sites', args: [t.bytes, t.string, t.array(t.uint256)] },
      (s, raw, str, arr) =>
        s.return({
          b: raw.byteAt(0n),
          c: str.byteAt(1n),
          part: raw.slice(1n),
          x: arr.at(0n),
        }),
    );
    const details = compile(script)
      .sourceMap.sites.filter((site) => site.kind === 'panic')
      .map((site) => site.detail);
    // stable substrings only: the detail text also names operands / codes, which may grow
    const matching = (re: RegExp): string[] => details.filter((d) => re.test(d));
    expect(matching(/byteAt/)).toHaveLength(2);
    expect(matching(/byteAt.*\bbytes\b/)).toHaveLength(1);
    expect(matching(/byteAt.*\bstring\b/)).toHaveLength(1);
    expect(matching(/slice/)).toHaveLength(1);
    expect(matching(/array index/)).toHaveLength(1);
  });
});

describe('LOOP_ALLOCATION', () => {
  test('slice and bytesN → string allocate per iteration; reinterprets and byteAt do not', () => {
    const script = evscript({ name: 'loop', args: [t.bytes, t.bytes32] }, (s, raw, word) => {
      const acc = s.let(t.uint256, 0n);
      s.for({ type: t.uint256, from: 0n, until: raw.length() }, (i) => {
        acc.set(acc.get().add(raw.byteAt(i).asUint().toUint(t.uint256))); // no allocation
        acc.set(acc.get().add(raw.asString().asBytes().length())); // no allocation
        acc.set(acc.get().add(raw.slice(i).length())); // a fresh copy
        acc.set(acc.get().add(word.asString().length())); // a fresh string
      });
      return s.return({ acc: acc.get() });
    });
    const messages: string[] = [];
    compile(script, {
      onDiagnostic: (d) => {
        if (d.code === 'LOOP_ALLOCATION') messages.push(d.message);
      },
    });
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatch(/^\.slice\(…\) \(fresh copy\) allocates memory/);
    expect(messages[1]).toMatch(/^\.asString\(\) on a bytesN \(fresh string\) allocates memory/);
  });
});
