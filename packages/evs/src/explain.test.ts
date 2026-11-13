/**
 * Unit tests — `explain.ts`: the fork-gated opcode scan behind the empty-revert explanation.
 * (`explainRevert` itself is covered through the artifact in `compile.test.ts`, against the
 * classifier in `abi/revert.test.ts`, and through a precompiled script in `precompiled.test.ts`.)
 *
 * The scan reads the bytecode alone, ending at the assembler's `INVALID` guard, so the context
 * needs no source map. The reference here is the source map's way of saying the same thing: the
 * disassembly up to the first `data_*` label.
 */

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
    expect(compiled.explainRevert('0x').message).toMatch(/failed without a reason \(out of gas\)$/);
  });
});
