/**
 * Unit tests — `explain.ts`: the empty-revert explanation, which is the one message that lists
 * causes instead of naming one. First the fork-gated opcode scan behind its first cause, then
 * the order and the length of the list. Then the causes an `EvsDecodeError(site)` is given, by
 * what its site decodes.
 * (`explainRevert` itself is covered through the artifact in `compile.test.ts`, against the
 * classifier in `abi/revert.test.ts`, and through a precompiled script in `precompiled.test.ts`.)
 *
 * The scan reads the bytecode alone, ending at the assembler's `INVALID` guard, so the context
 * needs no source map. The reference here is the source map's way of saying the same thing: the
 * disassembly up to the first `data_*` label.
 */

import { encodeErrorResult, erc20Abi, parseAbi } from 'viem';
import { describe, expect, test } from 'vite-plus/test';

import { evscript } from './builder/script.js';
import { compile, type CompiledEvsScript } from './compile.js';
import { t } from './core/types.js';

/** A string whose bytes are the fork-gated opcodes (`^` 0x5e MCOPY, `_` 0x5f PUSH0) and whose
 *  length keeps it in a data segment. */
const OPCODE_LOOKALIKES = '^_'.repeat(40);

const SCRIPTS = {
  noData: () =>
    evscript({ name: 'sum', args: [t.uint256, t.uint256] }, (s, a, b) =>
      s.return({ total: s.add(a, b) }),
    ),
  copies: () =>
    evscript({ name: 'echo', args: [t.string, t.bytes] }, (s, text, raw) =>
      s.return({ text, raw, hash: s.keccak256(raw) }),
    ),
  dataSegments: () =>
    evscript({ name: 'labels', args: [t.bool] }, (s, flag) =>
      s.return({
        label: s.select(flag, s.lit(t.string, OPCODE_LOOKALIKES), s.lit(t.string, 'no')),
        raw: s.lit(t.bytes, `0x${'fe5e5f'.repeat(30)}`),
      }),
    ),
} as const;

/** The opcodes the empty-revert message names (none when it only says "out of gas"). */
function namedOpcodes(compiled: CompiledEvsScript): string[] {
  const { message } = compiled.explainRevert('0x');
  const named = /the runtime uses (.+?) \(evmVersion '(\w+)'\)/.exec(message);
  if (named === null) return [];
  expect(named[2]).toBe(compiled.options.evmVersion);
  return (named[1] ?? '').split(' and ');
}

/** The same answer from the source map: what the code region, up to the data, disassembles to. */
function referenceOpcodes(compiled: CompiledEvsScript): string[] {
  const dataPcs = compiled.sourceMap.labels
    .filter((label) => label.name.startsWith('data_'))
    .map((label) => label.pc);
  const codeEnd = dataPcs.length > 0 ? Math.min(...dataPcs) : Number.POSITIVE_INFINITY;
  const used = new Set(
    compiled
      .disassemble()
      .lines.filter((line) => line.pc < codeEnd)
      .map((line) => line.mnemonic),
  );
  return ['MCOPY (cancun)', 'PUSH0 (shanghai)'].filter((op) => used.has(op.split(' ')[0] ?? ''));
}

describe('the fork-gated opcodes of the empty-revert explanation', () => {
  const builds = (['paris', 'shanghai', 'cancun'] as const).flatMap((evmVersion) =>
    [false, true].map((optimize) => ({ evmVersion, optimize })),
  );

  test.each(Object.entries(SCRIPTS))('%s: the scan agrees with the source map', (_name, script) => {
    for (const options of builds) {
      const compiled = compile(script(), options);
      expect(
        namedOpcodes(compiled),
        `${options.evmVersion}, optimize: ${options.optimize}`,
      ).toEqual(referenceOpcodes(compiled));
    }
  });

  test('each fork names exactly the opcodes it introduced and the script uses', () => {
    expect(namedOpcodes(compile(SCRIPTS.copies(), { evmVersion: 'paris' }))).toEqual([]);
    expect(namedOpcodes(compile(SCRIPTS.copies(), { evmVersion: 'shanghai' }))).toEqual([
      'PUSH0 (shanghai)',
    ]);
    expect(namedOpcodes(compile(SCRIPTS.copies(), { evmVersion: 'cancun' }))).toEqual([
      'MCOPY (cancun)',
      'PUSH0 (shanghai)',
    ]);
  });

  test('data segments never count: their bytes are not opcodes', () => {
    const compiled = compile(SCRIPTS.dataSegments(), { evmVersion: 'paris' });
    // the data really holds the look-alike bytes, after the code
    expect(compiled.sourceMap.labels.some((label) => label.name.startsWith('data_'))).toBe(true);
    expect(compiled.runtimeBytecode).toContain('5e5f'.repeat(40));
    expect(compiled.runtimeBytecode).toContain('fe5e5f'.repeat(30));
    expect(namedOpcodes(compiled)).toEqual([]);
    expect(compiled.explainRevert('0x').message).not.toMatch(/opcode/);
  });
});

describe('the causes of an empty revert, in the order the message lists them', () => {
  const TOKEN = '0x00000000000000000000000000000000000000aa';
  const VAULT = parseAbi(['function deposit() payable returns (uint256)']);

  /** `n` strict reads, so `n` call sites can bubble a callee's bare revert. */
  const reads = (n: number) =>
    evscript({ name: 'reads', args: [t.address] }, (s, token) => {
      const supplies = Array.from({ length: n }, () =>
        s.read({ address: token, abi: erc20Abi, functionName: 'totalSupply' }),
      );
      return s.return({ total: supplies.reduce((sum, supply) => sum.add(supply)) });
    });

  /** The numbered causes of the message, in order. */
  const causesOf = (message: string): string[] => {
    const list = message.split(' — possible causes: ')[1] ?? '';
    return list.split(/(?:^|; )\(\d+\) /).filter((cause) => cause !== '');
  };

  test('a build that uses fork-gated opcodes leads with them', () => {
    const { message } = compile(reads(1)).explainRevert('0x');
    expect(message).toMatch(/^empty revert payload \(no returndata\) — possible causes: \(1\) /);
    const causes = causesOf(message);
    expect(causes).toHaveLength(4);
    // one word-returning read copies no memory: PUSH0 is the only gated opcode in this runtime
    expect(causes[0]).toBe(
      'an opcode the node does not have at this block: the runtime uses PUSH0 (shanghai) ' +
        "(evmVersion 'cancun'), so for a block or chain before that fork, recompile with an " +
        "older evmVersion ('paris' runs everywhere)",
    );
    expect(causesOf(compile(SCRIPTS.copies()).explainRevert('0x').message)[0]).toContain(
      "the runtime uses MCOPY (cancun) and PUSH0 (shanghai) (evmVersion 'cancun')",
    );
    expect(causes[1]).toBe(
      'a bare revert() / require(false) bubbled verbatim from a callee through the strict call ' +
        'site: decoding totalSupply() returndata (site 0)',
    );
    expect(causes[2]).toBe('the call ran out of gas');
    expect(causes[3]).toMatch(/^in deployless mode \(the toViem\(\) default\)/);
  });

  test('a paris build has no opcode to suspect: the list starts with the callee', () => {
    const causes = causesOf(compile(reads(1), { evmVersion: 'paris' }).explainRevert('0x').message);
    expect(causes).toHaveLength(3);
    expect(causes[0]).toMatch(/^a bare revert\(\) \/ require\(false\) bubbled verbatim/);
    expect(causes.join(' ')).not.toMatch(/evmVersion|MCOPY|PUSH0/);
  });

  test('a deployless limit is always among the causes, with the mode that has none', () => {
    const noCalls = evscript({ name: 'sum', args: [t.uint256, t.uint256] }, (s, a, b) =>
      s.return({ total: s.add(a, b) }),
    );
    for (const script of [noCalls, reads(1)]) {
      for (const evmVersion of ['paris', 'cancun'] as const) {
        const causes = causesOf(compile(script, { evmVersion }).explainRevert('0x').message);
        expect(causes.at(-1)).toBe(
          'in deployless mode (the toViem() default), a result that is too large or starts ' +
            'with 0xEF, or a script and arguments that are too large together: some nodes ' +
            '(zkSync Era, Monad) report those limits as an empty revert — run the call again ' +
            "with toViem({ mode: 'stateOverride' }), which has none of them",
        );
      }
    }
  });

  test('an unfunded value call comes between the callee and out of gas', () => {
    const pay = evscript({ name: 'pay', args: [t.uint256] }, (s, amount) =>
      s.return({
        shares: s.call({ address: TOKEN, abi: VAULT, functionName: 'deposit', value: amount }),
      }),
    );
    const causes = causesOf(compile(pay, { evmVersion: 'paris' }).explainRevert('0x').message);
    expect(causes).toHaveLength(4);
    expect(causes[1]).toMatch(/^the script's balance was below the `value` sent by /);
    expect(causes[2]).toBe('the call ran out of gas');
  });

  test.each([1, 2, 3])('%i strict call sites are all named', (n) => {
    const explained = compile(reads(n)).explainRevert('0x');
    expect(explained.candidateSites).toHaveLength(n);
    expect(explained.message).not.toContain('more (candidateSites');
    for (const site of explained.candidateSites ?? []) {
      expect(explained.message).toContain(`${site.detail} (site ${site.id})`);
    }
  });

  test('past three, the message names the first three and counts the rest', () => {
    const explained = compile(reads(15)).explainRevert('0x');
    const sites = explained.candidateSites ?? [];
    expect(sites).toHaveLength(15);
    expect(explained.message).toContain('through one of the 15 strict call sites: ');
    expect(explained.message).toContain(
      sites
        .slice(0, 3)
        .map((site) => `${site.detail} (site ${site.id})`)
        .join('; ') + '; and 12 more (candidateSites lists them all); ',
    );
    expect(explained.message).not.toContain(`(site ${sites[3]?.id})`);
    // the causes after the list stay in reach: the message does not grow with the script
    expect(explained.message.length).toBe(compile(reads(40)).explainRevert('0x').message.length);
    expect(explained.message.length).toBeLessThan(900);
  });

  test("the cap is the empty explanation's alone: a callee payload still names every site", () => {
    const explained = compile(reads(15)).explainRevert('0xdeadbeef');
    for (const site of explained.candidateSites ?? []) {
      expect(explained.message).toContain(`(site ${site.id})`);
    }
  });
});

describe('the causes of an EvsDecodeError, by what its site decodes', () => {
  const abi = parseAbi([
    'function symbol() view returns (string)',
    'function checkSignatures(bytes32 hash) view',
    'function quote(uint256 amount)',
    'function deposit() payable',
  ]);
  /** The explanation of `EvsDecodeError(site)` at the script's one strict call site. */
  const explain = (
    compiled: CompiledEvsScript,
  ): { message: string; detail: string | undefined; id: number } => {
    const site = compiled.sourceMap.sites.find((x) => x.kind === 'decode');
    if (site === undefined) throw new Error('no decode site');
    const explained = compiled.explainRevert(
      encodeErrorResult({
        abi: compiled.abi,
        errorName: 'EvsDecodeError',
        args: [BigInt(site.id)],
      }),
    );
    expect(explained.kind).toBe('evs-decode');
    expect(explained.site?.id).toBe(site.id);
    return { message: explained.message, detail: explained.site?.detail, id: site.id };
  };
  const HEDGE =
    ' — note: the script has strict call sites that bubble callee reverts, and a callee may ' +
    'have reverted with this selector verbatim (bubbled byte-exactly), in which case the ' +
    'failure originated off-script';
  const UNDECODABLE =
    'an offset or a length points outside it, or a word is out of range for its type (a uint8 ' +
    'above 255, a bool above 1, an address with high bits set, an intN that is not sign-extended)';

  test('a function with outputs: the returndata does not decode, an out-of-range word included', () => {
    const script = evscript({ name: 'sym', args: [t.address] }, (s, token) =>
      s.return({ symbol: s.read({ address: token, abi, functionName: 'symbol' }) }),
    );
    const { message, detail, id } = explain(compile(script));
    expect(detail).toBe('decoding symbol() returndata');
    expect(message).toBe(
      `decoding symbol() returndata failed (EvsDecodeError site ${id}): the returndata does not ` +
        `decode as the outputs of symbol() — it is shorter than they need (a call to an address ` +
        `without code returns none), ${UNDECODABLE}${HEDGE}`,
    );
  });

  test.each(['read', 'call', 'simulate'] as const)(
    'a function without outputs (s.%s): the one cause is a target without code',
    (verb) => {
      const script = evscript({ name: 'valid', args: [t.address, t.bytes32] }, (s, safe, hash) => {
        if (verb === 'read') {
          s.read({ address: safe, abi, functionName: 'checkSignatures', args: [hash] });
        } else {
          s[verb]({ address: safe, abi, functionName: 'quote', args: [1n] });
        }
        return s.return({ valid: s.lit(t.bool, true) });
      });
      const name = verb === 'read' ? 'checkSignatures' : 'quote';
      const { message, id } = explain(compile(script));
      expect(message).toBe(
        `decoding ${verb === 'read' ? '' : `${verb} `}${name}() returndata failed ` +
          `(EvsDecodeError site ${id}): the target address has no code — ${name}() declares no ` +
          `outputs, so the script checks that its target has code before the call, as Solidity ` +
          `does${HEDGE}`,
      );
      expect(message).not.toContain('out of range');
    },
  );

  test('a simulate without outputs that sends value: no code, or an unfunded script', () => {
    const script = evscript({ name: 'pay', args: [t.address, t.uint256] }, (s, vault, amount) => {
      s.simulate({ address: vault, abi, functionName: 'deposit', value: amount });
      return s.return({ ok: s.lit(t.bool, true) });
    });
    const { message } = explain(compile(script));
    expect(message).toMatch(
      /^decoding simulate deposit\(\) returndata failed \(EvsDecodeError site \d+\): the target address has no code — .*as Solidity does; or the script's balance was below the `value` this site sends, so its CALL failed before the target ran — fund the script /,
    );
  });

  test('EvsInvalidCalldata counts an out-of-range argument word among its causes', () => {
    const script = evscript({ name: 'echo', args: [t.uint8] }, (s, x) => s.return({ x }));
    const compiled = compile(script);
    const explained = compiled.explainRevert(
      encodeErrorResult({ abi: compiled.abi, errorName: 'EvsInvalidCalldata' }),
    );
    expect(explained.kind).toBe('evs-invalid-calldata');
    expect(explained.message).toBe(
      'calldata does not match echo(uint8) — the script reverted EvsInvalidCalldata() (wrong ' +
        'selector, truncated calldata, malformed dynamic arguments, or an argument word out of ' +
        'range for its type)',
    );
  });

  test('a revertReturns site: the call returned, or the revert data does not decode', () => {
    const script = evscript({ name: 'q', args: [t.address] }, (s, quoter) => {
      const amount = s.call({
        address: quoter,
        abi,
        functionName: 'quote',
        args: [1n],
        revertReturns: [t.uint256],
      });
      return s.return({ amount });
    });
    const { message, id } = explain(compile(script));
    // such a site bubbles nothing, so nothing can forge the payload: no hedge
    expect(message).toBe(
      `decoding call quote() revert data failed (EvsDecodeError site ${id}): the call returned ` +
        `instead of reverting, or its revert data does not decode as the revertReturns types — ` +
        `it is shorter than they need, ${UNDECODABLE}`,
    );
  });
});
