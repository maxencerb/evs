/**
 * Unit tests — `deployless.ts`: the creation-data size helper (pinned byte-exactly against what
 * the installed viem builds), the compile-time result diagnostics (`DEPLOYLESS_RESULT_PREFIX`,
 * `DEPLOYLESS_RESULT_SIZE`; sizes cross-checked against real returndata on the harness), and
 * `explainDeploylessError` over the node texts the field test observed (geth and anvil/revm).
 * The on-chain boundaries themselves are pinned by `test/integration/deployless-limits.test.ts`.
 */

import {
  type Abi,
  BaseError,
  deploylessCallViaBytecodeBytecode,
  encodeDeployData,
  encodeFunctionData,
  InvalidInputRpcError,
  parseAbi,
  RpcRequestError,
  size,
  TransactionRejectedRpcError,
} from 'viem';
import { describe, expect, test } from 'vite-plus/test';

import { execRuntime } from '../test/harness/evm.js';
import { evscript } from './builder/script.js';
import { compile } from './compile.js';
import { EvsTypeError, type EvsDiagnostic } from './core/errors.js';
import { t, type Hex } from './core/types.js';
import {
  DEPLOYLESS_MAX_DATA_BYTES,
  DEPLOYLESS_MAX_RESULT_BYTES,
  deploylessDataSize,
  explainDeploylessError,
} from './deployless.js';
import { stmtDefs, walkStmts, type ScriptIr } from './ir/nodes.js';

type Script = Parameters<typeof compile>[0];

function diagnosticsOf(script: Script): EvsDiagnostic[] {
  const diags: EvsDiagnostic[] = [];
  compile(script, { onDiagnostic: (d) => diags.push(d) });
  return diags;
}

const Stats = t.struct({ n: t.uint256, owner: t.address });
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const codesOf = (script: Parameters<typeof compile>[0]): string[] =>
  diagnosticsOf(script)
    .map((d) => d.code)
    .filter((c) => c.startsWith('DEPLOYLESS_'));

describe('limits and deploylessDataSize', () => {
  test('the caps are EIP-170 and EIP-3860', () => {
    expect(DEPLOYLESS_MAX_RESULT_BYTES).toBe(24_576);
    expect(DEPLOYLESS_MAX_DATA_BYTES).toBe(49_152);
  });

  test("matches the size of viem's own deployless creation data, byte for byte", () => {
    const sum = compile(
      evscript({ name: 'sum', args: [t.array(t.uint256)] }, (s, xs) =>
        s.return({ n: xs.length() }),
      ),
    );
    for (const n of [0, 1, 7, 100, 1500]) {
      const calldata = encodeFunctionData({
        abi: sum.abi,
        functionName: 'sum',
        args: [Array.from({ length: n }, () => 1n)],
      });
      // exactly what viem's call action sends for `{ code, data }` (toDeploylessCallViaBytecodeData)
      const sent = encodeDeployData({
        abi: parseAbi(['constructor(bytes, bytes)']),
        bytecode: deploylessCallViaBytecodeBytecode,
        args: [sum.initBytecode, calldata],
      });
      expect(deploylessDataSize(sum, calldata)).toBe(size(sent));
    }
    // odd lengths pad to the next word, on both values
    const odd: Hex = '0x123456';
    const sent = encodeDeployData({
      abi: parseAbi(['constructor(bytes, bytes)']),
      bytecode: deploylessCallViaBytecodeBytecode,
      args: [odd, odd],
    });
    expect(deploylessDataSize({ initBytecode: odd }, odd)).toBe(size(sent));
  });

  test('rejects malformed hex with TYPE_MISMATCH', () => {
    expect(() => deploylessDataSize({ initBytecode: '0x1' }, '0x')).toThrow(EvsTypeError);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- untyped caller input
    expect(() => deploylessDataSize({ initBytecode: '0x' }, 'zz' as Hex)).toThrow(/calldata/);
  });
});

describe('DEPLOYLESS_RESULT_PREFIX', () => {
  const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)']);
  const prefixOf = (script: Script): EvsDiagnostic[] =>
    diagnosticsOf(script).filter((d) => d.code === 'DEPLOYLESS_RESULT_PREFIX');
  /** The site of the statement that defines the script's first returned value. */
  const firstReturnSite = (script: { readonly ir: ScriptIr }): number | undefined => {
    const value = script.ir.returns[0]?.value;
    let site: number | undefined;
    walkStmts(script.ir.body, (s) => {
      if (value !== undefined && stmtDefs(s).includes(value)) site ??= s.site;
    });
    return site;
  };

  test.each([
    ['bytes32', t.bytes32],
    ['bytes4', t.bytes4],
  ] as const)(
    'a leading static %s always warns: a hash starts with 0xEF 1 time in 256',
    (name, type) => {
      const script = evscript({ name: 'echo', args: [type] }, (s, x) => s.return({ x }));
      const diags = prefixOf(script);
      expect(diags).toHaveLength(1);
      expect(diags[0]?.severity).toBe('warning');
      expect(diags[0]?.message).toContain(`\`x\` (${name})`);
      expect(diags[0]?.message).toContain(
        `a ${name} such as a hash starts with 0xEF 1 time in 256`,
      );
      expect(diags[0]?.message).toContain("toViem({ mode: 'stateOverride' })");
      // an argument has no defining statement, and the warning still has a key to filter on
      expect(diags[0]?.key).toBe('s.return(x)');
      expect(diags[0]?.site).toBeUndefined();
      expect(diags[0]?.sites).toBeUndefined();
    },
  );

  test('a hash warns with the statement that computes it, and the returned value as its key', () => {
    const script = evscript({ name: 'h', args: [t.bytes] }, (s, b) =>
      s.return({ h: s.keccak256(b) }),
    );
    const diags = prefixOf(script);
    expect(diags).toHaveLength(1);
    expect(diags[0]?.key).toBe('s.return(h)');
    expect(diags[0]?.site).toBe(firstReturnSite(script));
    expect(diags[0]?.site).toBeTypeOf('number');
    expect(diags[0]?.sites).toEqual([{ id: firstReturnSite(script), key: 'keccak256#0' }]);
  });

  test('the key is the path of the leading word, and no edit above the return moves it', () => {
    const Position = t.struct({ amounts: t.array(t.uint256, 2), owner: t.address });
    const build = (extra: boolean) =>
      evscript({ name: 'p', args: [Position] }, (s, pos) => {
        if (extra) s.let(t.uint256, 7n).get();
        return s.return({ pos });
      });
    const [before] = prefixOf(build(false));
    const [after] = prefixOf(build(true));
    expect(before?.key).toBe('s.return(pos.amounts[0])');
    expect(after?.key).toBe(before?.key);
    expect(before?.message).toContain('`pos.amounts[0]` (uint256)');

    // a statement-defined value: the site id moves with the edit, the key does not
    const sum = (extra: boolean) =>
      evscript({ name: 's', args: [t.uint256, t.uint256] }, (s, a, b) => {
        const acc = s.let(t.uint256, a);
        if (extra) acc.set(acc.get().wrappingAdd(1n));
        acc.set(acc.get().wrappingAdd(b));
        return s.return({ total: acc.get() });
      });
    const [plain] = prefixOf(sum(false));
    const [edited] = prefixOf(sum(true));
    expect(plain?.key).toBe('s.return(total)');
    expect(edited?.key).toBe('s.return(total)');
    expect(edited?.site).not.toBe(plain?.site);
    // the statement behind the value is named by its own key, which the same-label edit moves
    expect(plain?.sites?.map((site) => site.key)).toEqual(['cellget#1']);
    expect(edited?.sites?.map((site) => site.key)).toEqual(['cellget#2']);
  });

  test.each([
    ['uint256', t.uint256, 'a uint256 starts with 0xEF only from 0xEF·2^248 (about 1.08e77)'],
    ['int256', t.int256, 'an int256 starts with 0xEF only below -2^252 (about -7.2e75)'],
  ] as const)('a script argument of type %s warns: evs cannot bound it', (name, type, range) => {
    const script = evscript({ name: 'echo', args: [type] }, (s, x) => s.return({ x }));
    const diags = prefixOf(script);
    expect(diags).toHaveLength(1);
    expect(diags[0]?.message).toContain(`\`x\` (${name})`);
    expect(diags[0]?.message).toContain(range);
    expect(diags[0]?.message).not.toContain('1 time in 256');
    expect(diags[0]?.message).toContain(`evs cannot bound \`x\``);
    expect(diags[0]?.message).toContain('(it is a script argument)');
    // filtered like any other: nothing tells a user to rely on a site id
    expect(diags[0]?.message).toContain('filter this warning on its code and key, otherwise');
    expect(diags[0]?.message).not.toMatch(/\bsite\b/);
    expect(diags[0]?.key).toBe('s.return(x)');
    expect(diags[0]?.site).toBeUndefined();
  });

  // values whose magnitude evs bounds below 0xEF·2^248 (uint256) / above -2^252 (int256)
  test.each<[string, () => Script]>([
    [
      'a small literal',
      () => evscript({ name: 'a', args: [] }, (s) => s.return({ x: s.lit(t.uint256, 1n) })),
    ],
    [
      'the block number',
      () => evscript({ name: 'a', args: [] }, (s) => s.return({ n: s.env('blocknumber') })),
    ],
    [
      'the chain id and a timestamp',
      () =>
        evscript({ name: 'a', args: [] }, (s) =>
          s.return({ id: s.env('chainid'), ts: s.env('timestamp') }),
        ),
    ],
    [
      'an array length',
      () =>
        evscript({ name: 'a', args: [t.array(t.address)] }, (s, xs) =>
          s.return({ n: xs.length() }),
        ),
    ],
    [
      'a bytes length',
      () => evscript({ name: 'a', args: [t.bytes] }, (s, b) => s.return({ n: b.length() })),
    ],
    [
      'a widened uint8',
      () =>
        evscript({ name: 'a', args: [t.uint8] }, (s, x) => s.return({ x: x.toUint(t.uint256) })),
    ],
    [
      'a balance and a code size',
      () =>
        evscript({ name: 'a', args: [t.address] }, (s, who) =>
          s.return({ wei: s.balance(who), size: s.codeSize(who) }),
        ),
    ],
    [
      'a loop counter',
      () =>
        evscript({ name: 'a', args: [t.array(t.address)] }, (s, xs) => {
          const n = s.let(t.uint256, 0n);
          s.forEach(xs, (x) =>
            s.if(s.neq(x, s.lit(t.address, ZERO_ADDRESS)), () => n.set(n.get().add(1n))),
          );
          return s.return({ n: n.get() });
        }),
    ],
    [
      'a running sum of widened uint128 values',
      () =>
        evscript({ name: 'a', args: [t.array(t.uint128)] }, (s, xs) => {
          const total = s.let(t.uint256, 0n);
          s.forEach(xs, (x) => total.set(total.get().add(x.toUint(t.uint256))));
          return s.return({ total: total.get() });
        }),
    ],
    [
      'a call output divided by 2',
      () =>
        evscript({ name: 'a', args: [t.address, t.address] }, (s, token, who) =>
          s.return({
            half: s
              .read({ address: token, abi: ERC20, functionName: 'balanceOf', args: [who] })
              .div(2n),
          }),
        ),
    ],
    [
      'a signed value reduced by a literal modulus',
      () =>
        evscript({ name: 'a', args: [t.uint256] }, (s, n) =>
          s.return({ ppm: s.sub(0n, n.mod(1_000_000n).toInt(t.int256)) }),
        ),
    ],
    [
      'an s.fn result over a narrow argument',
      () =>
        evscript({ name: 'a', args: [t.uint64] }, (s, x) => {
          const next = s.fn('next', t.uint64, (v) => v.toUint(t.uint256).add(1n));
          return s.return({ next: next(x) });
        }),
    ],
    [
      'a struct literal led by a length',
      () =>
        evscript({ name: 'a', args: [t.array(t.address)] }, (s, xs) =>
          s.return({ stats: s.tuple(Stats, { n: xs.length(), owner: s.env('caller') }) }),
        ),
    ],
  ])('%s: no warning', (_name, build) => {
    expect(prefixOf(build())).toEqual([]);
  });

  // values that can reach that range, with the site of the first returned value
  test.each<[string, () => Script]>([
    [
      'a call output',
      () =>
        evscript({ name: 'a', args: [t.address, t.address] }, (s, token, who) =>
          s.return({
            balance: s.read({ address: token, abi: ERC20, functionName: 'balanceOf', args: [who] }),
          }),
        ),
    ],
    [
      'a running sum of call outputs',
      () =>
        evscript({ name: 'a', args: [t.address, t.array(t.address)] }, (s, token, holders) => {
          const total = s.let(t.uint256, 0n);
          s.forEach(holders, (h) =>
            total.set(
              total
                .get()
                .add(s.read({ address: token, abi: ERC20, functionName: 'balanceOf', args: [h] })),
            ),
          );
          return s.return({ total: total.get() });
        }),
    ],
    [
      'a hash reinterpreted as a uint256',
      () =>
        evscript({ name: 'a', args: [t.address] }, (s, who) =>
          s.return({ id: s.keccak256(who).asUint() }),
        ),
    ],
    [
      'a bitNot',
      () => evscript({ name: 'a', args: [] }, (s) => s.return({ x: s.bitNot(s.env('chainid')) })),
    ],
    [
      'a shift by a runtime amount',
      () =>
        evscript({ name: 'a', args: [t.uint8] }, (s, k) =>
          s.return({ x: s.shl(s.lit(t.uint256, 1n), k.toUint(t.uint256)) }),
        ),
    ],
    [
      'a wrapping subtraction',
      () =>
        evscript({ name: 'a', args: [] }, (s) =>
          s.return({ x: s.wrappingSub(s.env('timestamp'), 1n) }),
        ),
    ],
    [
      'a value doubled in a loop',
      () =>
        evscript({ name: 'a', args: [t.array(t.address)] }, (s, xs) => {
          const x = s.let(t.uint256, 1n);
          s.forEach(xs, () => x.set(x.get().add(x.get())));
          return s.return({ x: x.get() });
        }),
    ],
    [
      'a widened uint128 squared',
      () =>
        evscript({ name: 'a', args: [t.uint128] }, (s, p) => {
          const wide = p.toUint(t.uint256);
          return s.return({ sq: wide.mul(wide) });
        }),
    ],
    [
      'a negated call output as an int256',
      () =>
        evscript({ name: 'a', args: [t.address, t.address] }, (s, token, who) =>
          s.return({
            pnl: s.sub(
              0n,
              s
                .read({ address: token, abi: ERC20, functionName: 'balanceOf', args: [who] })
                .div(2n)
                .toInt(t.int256),
            ),
          }),
        ),
    ],
    [
      'a struct whose leading member is overwritten with a call output',
      () =>
        evscript({ name: 'a', args: [t.address, t.address] }, (s, token, who) => {
          const stats = s.tuple(Stats, { n: 0n, owner: who });
          stats.n.set(
            s.read({ address: token, abi: ERC20, functionName: 'balanceOf', args: [who] }),
          );
          return s.return({ stats });
        }),
    ],
    [
      'a struct member other than the first',
      () =>
        evscript({ name: 'a', args: [] }, (s) => {
          const pair = s.tuple(t.struct({ n: t.uint256, id: t.uint256 }), { n: 1n, id: 2n });
          return s.return({ id: pair.id.get() });
        }),
    ],
    [
      'a fixed array whose element 0 is set to a call output',
      () =>
        evscript({ name: 'a', args: [t.address, t.address] }, (s, token, who) => {
          const xs = s.newArray(t.uint256, 2, { fixed: true });
          xs.set(
            0n,
            s.read({ address: token, abi: ERC20, functionName: 'balanceOf', args: [who] }),
          );
          return s.return({ xs: xs.expr() });
        }),
    ],
    [
      'a select with a call output in its second branch',
      () =>
        evscript({ name: 'a', args: [t.bool, t.address, t.address] }, (s, flag, token, who) =>
          s.return({
            x: s.select(
              flag,
              s.lit(t.uint256, 1n),
              s.read({ address: token, abi: ERC20, functionName: 'balanceOf', args: [who] }),
            ),
          }),
        ),
    ],
    [
      'a mulDiv of two call outputs by 1',
      () =>
        evscript({ name: 'a', args: [t.address, t.address] }, (s, token, who) => {
          const bal = s.read({
            address: token,
            abi: ERC20,
            functionName: 'balanceOf',
            args: [who],
          });
          return s.return({ x: s.mulDiv(bal, bal, 1n) });
        }),
    ],
  ])('%s: warns', (_name, build) => {
    const script = build();
    const diags = prefixOf(script);
    expect(diags).toHaveLength(1);
    expect(diags[0]?.site).toBe(firstReturnSite(script));
    expect(diags[0]?.site).toBeTypeOf('number');
    expect(diags[0]?.message).toContain(
      '(it may come from a script argument, a call output, a hash or bit pattern, or arithmetic ' +
        'that can grow that large, such as a value that doubles in a loop)',
    );
    expect(diags[0]?.message).toContain('filter this warning on its code and key, otherwise');
    expect(diags[0]?.message).not.toMatch(/\bsite\b/);
    expect(diags[0]?.key).toMatch(/^s\.return\(\w+(\.\w+|\[0\])*\)$/);
    expect(diags[0]?.sites).toHaveLength(1);
    expect(diags[0]?.sites?.[0]?.id).toBe(diags[0]?.site);
  });

  // a returned literal is decided by its first byte: 0xEF fails every call, anything else none
  const literalScript = (type: 'uint256' | 'int256', value: bigint) =>
    evscript({ name: 'a', args: [] }, (s) =>
      s.return({ x: type === 'uint256' ? s.lit(t.uint256, value) : s.lit(t.int256, value) }),
    );

  test.each<[string, 'uint256' | 'int256', bigint]>([
    ['uint256 0xEF·2^248', 'uint256', 0xefn << 248n],
    ['uint256 0xF0·2^248 − 1', 'uint256', (0xf0n << 248n) - 1n],
    ['int256 −17·2^248', 'int256', -(17n << 248n)],
    ['int256 −2^252 − 1', 'int256', -(1n << 252n) - 1n],
  ])('a returned %s literal starts with 0xEF: warns that every call fails', (_n, type, value) => {
    const script = literalScript(type, value);
    const diags = prefixOf(script);
    expect(diags).toHaveLength(1);
    expect(diags[0]?.site).toBe(firstReturnSite(script));
    expect(diags[0]?.message).toContain(
      '`x` is a literal whose first byte is 0xEF, so every deployless call fails; use ' +
        "toViem({ mode: 'stateOverride' })",
    );
    expect(diags[0]?.message).not.toContain('acknowledge');
  });

  test.each<[string, 'uint256' | 'int256', bigint]>([
    ['uint256 2^255 (first byte 0x80)', 'uint256', 1n << 255n],
    ['uint256 0xF0·2^248', 'uint256', 0xf0n << 248n],
    ['int256 −2^252', 'int256', -(1n << 252n)],
    ['int256 −17·2^248 − 1', 'int256', -(17n << 248n) - 1n],
  ])('a returned %s literal does not start with 0xEF: no warning', (_n, type, value) => {
    expect(prefixOf(literalScript(type, value))).toEqual([]);
  });

  // a bytesN literal is a word like any other: left-aligned, so its first byte is its own
  test.each([
    ['bytes32', `0x12${'00'.repeat(31)}`],
    ['bytes32', `0xee${'ff'.repeat(31)}`],
    ['bytes4', '0x12345678'],
    ['bytes4', '0xf0000000'],
    ['bytes1', '0x00'],
  ] as const)('a returned %s literal %s does not start with 0xEF: no warning', (type, hex) => {
    const script = evscript({ name: 'a', args: [] }, (s) => s.return({ tag: s.lit(t[type], hex) }));
    expect(prefixOf(script)).toEqual([]);
  });

  test.each([
    ['bytes32', `0xef${'00'.repeat(31)}`],
    ['bytes4', '0xef345678'],
    ['bytes1', '0xef'],
  ] as const)('a returned %s literal %s starts with 0xEF: every call fails', (type, hex) => {
    const script = evscript({ name: 'a', args: [] }, (s) => s.return({ tag: s.lit(t[type], hex) }));
    const diags = prefixOf(script);
    expect(diags).toHaveLength(1);
    expect(diags[0]?.site).toBe(firstReturnSite(script));
    expect(diags[0]?.message).toContain(`\`tag\` (${type})`);
    expect(diags[0]?.message).toContain(
      '`tag` is a literal whose first byte is 0xEF, so every deployless call fails; use ' +
        "toViem({ mode: 'stateOverride' })",
    );
    expect(diags[0]?.message).not.toContain('1 time in 256');
  });

  test('a signed quotient that can reach 2^255 warns', async () => {
    // -2^254 / -1 = 2^254, shifted and or-ed up to a word that starts with 0xEF
    const script = evscript({ name: 'ef', args: [t.int256, t.int256, t.uint256] }, (s, x, m, y) => {
      const q = x.shr(1n).div(m);
      return s.return({ r: q.toUint(t.uint256).shl(1n).bitOr(y.shr(1n)) });
    });
    const diags = prefixOf(script);
    expect(diags).toHaveLength(1);
    expect(diags[0]?.message).toContain('evs cannot bound `r` below that');
    const compiled = compile(script);
    const out = await execRuntime(
      compiled.runtimeBytecode,
      encodeFunctionData({
        abi: compiled.abi,
        functionName: 'ef',
        args: [-(1n << 255n), -1n, 0xden << 248n],
      }),
    );
    expect(out.success).toBe(true);
    expect(out.data.slice(0, 4)).toBe('0xef');
  });

  test.each([
    ['uint248', t.uint248],
    ['int248', t.int248],
    ['int8', t.int8],
    ['address', t.address],
    ['bool', t.bool],
  ] as const)('a leading %s always starts with 0x00 or 0xFF — no warning', (_name, type) => {
    const script = evscript({ name: 'echo', args: [type, t.bytes32] }, (s, x, h) =>
      s.return({ x, h }),
    );
    expect(codesOf(script)).toEqual([]);
  });

  test('names the first leaf through static structs and fixed arrays', () => {
    const Pos = t.struct({ id: t.bytes32, owner: t.address });
    const nested = evscript({ name: 'nested', args: [Pos] }, (s, pos) => s.return({ pos }));
    expect(diagnosticsOf(nested)[0]?.message).toContain('`pos.id` (bytes32)');
    const fixed = evscript({ name: 'fixed', args: [t.array(t.uint256, 2)] }, (s, xs) =>
      s.return({ xs }),
    );
    expect(diagnosticsOf(fixed)[0]?.message).toContain('`xs[0]` (uint256)');
  });

  test('a dynamic member anywhere makes byte 0 an offset word — no warning', () => {
    const script = evscript({ name: 'mixed', args: [t.bytes32, t.string] }, (s, h, label) =>
      s.return({ h, label }),
    );
    expect(codesOf(script)).toEqual([]);
  });

  test('the leading leaf is what the encoded result starts with', async () => {
    const script = compile(
      evscript({ name: 'echo', args: [t.bytes32] }, (s, x) => s.return({ x })),
    );
    const word: Hex = `0xef${'00'.repeat(31)}`;
    const out = await execRuntime(
      script.runtimeBytecode,
      encodeFunctionData({ abi: script.abi, functionName: 'echo', args: [word] }),
    );
    expect(out.data.slice(0, 4)).toBe('0xef');
  });
});

describe('DEPLOYLESS_RESULT_SIZE', () => {
  const fixedWords = (n: number) =>
    evscript({ name: 'words', args: [t.array(t.address, n)] }, (s, xs) => s.return({ xs }));

  test('a static result over 24,576 bytes always fails deployless', () => {
    // address words start with 0x00, so the size warning is alone
    expect(codesOf(fixedWords(768))).toEqual([]); // 768 · 32 = 24,576 — fits exactly
    const diags = diagnosticsOf(fixedWords(769));
    expect(diags.map((d) => d.code)).toEqual(['DEPLOYLESS_RESULT_SIZE']);
    expect(diags[0]?.message).toContain('always 24608 bytes');
  });

  test('a dynamic result warns on its smallest encoding', () => {
    const script = evscript(
      { name: 'big', args: [t.string, t.array(t.address, 768)] },
      (s, label, xs) => s.return({ label, xs }),
    );
    const diag = diagnosticsOf(script).find((d) => d.code === 'DEPLOYLESS_RESULT_SIZE');
    // outer offset + label offset + 768 words + the empty label's length word
    expect(diag?.message).toContain(`at least ${32 + 32 + 768 * 32 + 32} bytes`);
  });

  test('the computed size is the real returndata size (static exact, dynamic minimum)', async () => {
    const xs = (n: number) =>
      Array.from({ length: n }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}` as const);
    const big = evscript(
      { name: 'big', args: [t.string, t.array(t.address, 768)] },
      (s, label, list) => s.return({ label, list }),
    );
    const runs = [
      {
        script: fixedWords(769),
        calldata: (abi: Abi) => encodeFunctionData({ abi, functionName: 'words', args: [xs(769)] }),
      },
      {
        script: big,
        calldata: (abi: Abi) =>
          encodeFunctionData({ abi, functionName: 'big', args: ['', xs(768)] }),
      },
    ];
    await Promise.all(
      runs.map(async ({ script, calldata }) => {
        const diags: EvsDiagnostic[] = [];
        const compiled = compile(script, { onDiagnostic: (d) => diags.push(d) });
        const out = await execRuntime(compiled.runtimeBytecode, calldata(compiled.abi));
        expect(out.success).toBe(true);
        const diag = diags.find((d) => d.code === 'DEPLOYLESS_RESULT_SIZE');
        expect(diag?.message).toContain(` ${size(out.data)} bytes`);
      }),
    );
  });
});

describe('explainDeploylessError', () => {
  /**
   * The chain viem builds for a node's JSON-RPC error: a wrapper carrying the RpcError's short
   * message (CallExecutionError in practice) → the RpcError class for the code → RpcRequestError
   * holding the node's text. geth answers with -32000, which viem maps to InvalidInputRpcError
   * ("Missing or invalid parameters."); anvil answers with -32003, mapped to
   * TransactionRejectedRpcError ("Transaction creation failed.") — both probed, anvil 1.8.3 in
   * `test/integration/deployless-limits.test.ts`.
   */
  const NODES = {
    geth: { Rpc: InvalidInputRpcError, code: -32_000 },
    anvil: { Rpc: TransactionRejectedRpcError, code: -32_003 },
  } as const;
  const rpcError = (message: string, node: keyof typeof NODES = 'geth'): BaseError => {
    const { Rpc, code } = NODES[node];
    const rpc = new Rpc(
      new RpcRequestError({ body: {}, error: { code, message }, url: 'http://node' }),
    );
    return new BaseError(rpc.shortMessage, { cause: rpc });
  };

  test('the fixture chains match what viem shows for each node', () => {
    expect(rpcError('x').shortMessage).toMatch(/^Missing or invalid parameters\./);
    expect(rpcError('x', 'anvil').shortMessage).toMatch(/^Transaction creation failed\./);
  });

  test('geth: max code size exceeded → result-too-large, with the reported size', () => {
    const e = explainDeploylessError(
      rpcError('max code size exceeded: code size 24608 limit 24576'),
    );
    expect(e).toMatchObject({
      kind: 'result-too-large',
      size: 24_608,
      limit: 24_576,
      nodeMessage: 'max code size exceeded: code size 24608 limit 24576',
    });
    expect(e?.message).toContain('EIP-170');
    expect(e?.message).toContain("toViem({ mode: 'stateOverride' })");
  });

  test('geth: invalid code: must not begin with 0xef → result-starts-with-ef', () => {
    const e = explainDeploylessError(rpcError('invalid code: must not begin with 0xef'));
    expect(e?.kind).toBe('result-starts-with-ef');
    expect(e?.size).toBeUndefined();
    expect(e?.message).toContain('EIP-3541');
  });

  test('geth: max initcode size exceeded → data-too-large', () => {
    const e = explainDeploylessError(
      rpcError(
        'err: max initcode size exceeded: code size 49166 limit 49152 (supplied gas 600000000)',
      ),
    );
    expect(e).toMatchObject({ kind: 'data-too-large', size: 49_166, limit: 49_152 });
    expect(e?.message).toContain('deploylessDataSize()');
  });

  test("anvil: revm's EVM error names, and geth's text for oversized initcode", () => {
    expect(
      explainDeploylessError(rpcError('EVM error CreateContractStartingWithEF', 'anvil'))?.kind,
    ).toBe('result-starts-with-ef');
    expect(
      explainDeploylessError(rpcError('EVM error CreateContractSizeLimit', 'anvil')),
    ).toMatchObject({
      kind: 'result-too-large',
      limit: 24_576,
      nodeMessage: 'EVM error CreateContractSizeLimit',
    });
    // anvil reports oversized initcode in geth's wording, not revm's name, and without sizes
    expect(explainDeploylessError(rpcError('max initcode size exceeded', 'anvil'))).toMatchObject({
      kind: 'data-too-large',
      limit: 49_152,
      nodeMessage: 'max initcode size exceeded',
    });
  });

  test("revm's own initcode error name (other revm-based nodes)", () => {
    expect(
      explainDeploylessError(rpcError('EVM error CreateInitCodeSizeLimit', 'anvil'))?.kind,
    ).toBe('data-too-large');
  });

  // the same provider answers a pinned block without the word "code"
  test.each([
    ['max code size exceeded: size 28160 limit 24576', 'result-too-large', 28_160, 24_576],
    ['max code size exceeded: size 24608 limit 24576', 'result-too-large', 24_608, 24_576],
    ['max initcode size exceeded: size 54094 limit 49152', 'data-too-large', 54_094, 49_152],
    ['max initcode size exceeded: size 49774 limit 49152', 'data-too-large', 49_774, 49_152],
  ] as const)(
    'geth at a pinned block: %s → %s, with the reported size',
    (text, kind, bytes, cap) => {
      const e = explainDeploylessError(rpcError(text));
      expect(e).toMatchObject({ kind, size: bytes, limit: cap, nodeMessage: text });
      expect(e?.message).toContain(`(${bytes} bytes)`);
    },
  );

  test('geth: the bare limit names, without sizes', () => {
    expect(explainDeploylessError(rpcError('max code size exceeded'))).toMatchObject({
      kind: 'result-too-large',
      limit: 24_576,
      nodeMessage: 'max code size exceeded',
    });
    expect(explainDeploylessError(rpcError('max code size exceeded'))?.size).toBeUndefined();
  });

  test('geth: contract creation code storage out of gas → result-deposit-out-of-gas', () => {
    const e = explainDeploylessError(rpcError('contract creation code storage out of gas'));
    expect(e).toMatchObject({
      kind: 'result-deposit-out-of-gas',
      nodeMessage: 'contract creation code storage out of gas',
    });
    expect(e?.size).toBeUndefined();
    expect(e?.limit).toBeUndefined();
    expect(e?.message).toContain('200 gas per byte');
    expect(e?.message).toContain("toViem({ mode: 'stateOverride' })");
  });

  // an out-of-gas in the script body reads the same: only the deposit's own text is a limit
  test.each([
    'out of gas',
    'EVM error OutOfGas',
    'out of gas: gas exhausted during memory expansion: 300000',
    'EVM error MemoryOOG',
  ])('a bare out-of-gas is not recognized: %s', (text) => {
    expect(explainDeploylessError(rpcError(text))).toBeUndefined();
    expect(explainDeploylessError(rpcError(text, 'anvil'))).toBeUndefined();
  });

  test('nethermind: transaction size over max init code size → data-too-large', () => {
    const text =
      'err: EIP-3860 - transaction size over max init code size (supplied gas 100000000)';
    const e = explainDeploylessError(rpcError(text));
    expect(e).toMatchObject({ kind: 'data-too-large', limit: 49_152, nodeMessage: text });
    expect(e?.size).toBeUndefined();
    expect(e?.message).toContain('deploylessDataSize()');
  });

  test('a bare "invalid code" → result-starts-with-ef', () => {
    const e = explainDeploylessError(rpcError('invalid code'));
    expect(e).toMatchObject({ kind: 'result-starts-with-ef', nodeMessage: 'invalid code' });
    // viem's own multi-line message, when only that reaches the caller
    expect(
      explainDeploylessError('Missing or invalid parameters.\n\nDetails: invalid code\nVersion: 2')
        ?.kind,
    ).toBe('result-starts-with-ef');
  });

  test.each([
    'invalid code hash',
    'invalid code: something else',
    'invalid codec',
    'the request has an invalid code',
    'invalid code point at index 3',
    'Missing or invalid parameters.',
  ])('"invalid code" inside another message is not a limit: %s', (text) => {
    expect(explainDeploylessError(rpcError(text))).toBeUndefined();
    expect(explainDeploylessError(text)).toBeUndefined();
  });

  test("revm's names with the colon newer nodes print", () => {
    expect(explainDeploylessError(rpcError('EVM error: CreateContractSizeLimit'))).toMatchObject({
      kind: 'result-too-large',
      nodeMessage: 'EVM error: CreateContractSizeLimit',
    });
    expect(explainDeploylessError(rpcError('EVM error: CreateContractStartingWithEF'))?.kind).toBe(
      'result-starts-with-ef',
    );
  });

  test('every kind points at state-override mode', () => {
    const texts = [
      'invalid code: must not begin with 0xef',
      'max code size exceeded: code size 24608 limit 24576',
      'max initcode size exceeded',
      'contract creation code storage out of gas',
    ];
    const explained = texts.map((text) => explainDeploylessError(rpcError(text)));
    expect(explained.map((e) => e?.kind)).toEqual([
      'result-starts-with-ef',
      'result-too-large',
      'data-too-large',
      'result-deposit-out-of-gas',
    ]);
    for (const e of explained) expect(e?.message).toContain("toViem({ mode: 'stateOverride' })");
  });

  test('a message string works too; anything else is not a deployless limit', () => {
    expect(explainDeploylessError('Details: max code size exceeded')?.kind).toBe(
      'result-too-large',
    );
    expect(explainDeploylessError(rpcError('execution reverted'))).toBeUndefined();
    expect(explainDeploylessError(new Error('fetch failed'))).toBeUndefined();
    expect(explainDeploylessError(undefined)).toBeUndefined();
    expect(explainDeploylessError(42)).toBeUndefined();
    const cyclic: { message: string; cause?: unknown } = { message: 'timeout' };
    cyclic.cause = cyclic;
    expect(explainDeploylessError(cyclic)).toBeUndefined();
  });
});
