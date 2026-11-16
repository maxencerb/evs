/**
 * tsc's diagnostics for a source text, for the tests that pin what a type error says and where
 * it points: the text is what a user reads, so it is asserted as printed.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

/** One diagnostic of the checked source: its message (the chain flattened, one link per line),
 *  its code, and the 1-based line and column it points at. */
export interface TscDiagnostic {
  readonly message: string;
  readonly code: number;
  readonly line: number;
  readonly column: number;
}

/**
 * tsc's diagnostics for `source`, a module compiled in memory under `src/` with the package's
 * own compiler options (so it imports the library as `./index.js`).
 */
export function tscDiagnostics(source: string): TscDiagnostic[] {
  const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const config = ts.getParsedCommandLineOfConfigFile(join(pkgDir, 'tsconfig.json'), undefined, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    },
  });
  if (config === undefined) throw new Error('could not read packages/evs/tsconfig.json');
  const options: ts.CompilerOptions = { ...config.options, noEmit: true };
  const fixturePath = ts.sys.resolvePath(join(pkgDir, 'src', '__tsc-errors.fixture.ts'));
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
  return ts.getPreEmitDiagnostics(program, program.getSourceFile(fixturePath)).map((d) => {
    const at =
      d.file === undefined || d.start === undefined
        ? { line: -1, character: -1 }
        : d.file.getLineAndCharacterOfPosition(d.start);
    return {
      message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
      code: d.code,
      line: at.line + 1,
      column: at.character + 1,
    };
  });
}

/** The messages of {@link tscDiagnostics}. */
export function tscErrors(source: string): string[] {
  return tscDiagnostics(source).map((d) => d.message);
}
