/**
 * Unit tests — evs ships no abitype of its own: every abitype type (`Address`, `Abi`,
 * `AbiParameter`, …) comes through viem, a required peer that pins its own abitype. evs 0.2.0
 * depended on `abitype ^1.3.0` while viem pinned `1.2.3`, so npm and bun installed two copies and an app's abitype `Register` augmentation (a custom `addressType`,
 * the type configuration viem's docs point to) reached evs's copy only: evs's `Address` stopped
 * matching viem's. The manifest is pinned here; the type-level guarantee is checked by compiling
 * an app-shaped fixture with the augmentation, in a program of its own (a `Register`
 * augmentation is global, so it cannot sit in the shared `types` project).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { expect, test } from 'vite-plus/test';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');

test('the published manifest declares no abitype dependency of any kind', () => {
  const manifest: unknown = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  expect(manifest).toHaveProperty('peerDependencies.viem');
  for (const field of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    expect(manifest).not.toHaveProperty([field, 'abitype']);
  }
});

// The app side of the field report: `declare module 'abitype'` augments whatever `abitype` the
// app resolves. With evs shipping none, that is the single copy viem brings (npm and bun hoist
// it; a pnpm app declares it itself), so the fixture maps `abitype` to viem's copy.
const FIXTURE = `
import type { Address as ViemAddress } from 'viem';
import type { Address as EvsAddress, CompiledEvsScript } from './index.js';

declare module 'abitype' {
  interface Register {
    addressType: \`0x\${string}\` & { readonly __brand: 'checked' };
  }
}

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// the augmentation took effect (otherwise the checks below would pass vacuously)
export const augmented: Eq<ViemAddress, \`0x\${string}\`> = false;
// evs's Address is viem's, augmentation included: values flow both ways (with two copies, the
// one the augmentation missed is the wider type and rejects the other's values)
export const sameAddress: Eq<EvsAddress, ViemAddress> = true;
declare const fromViem: ViemAddress;
declare const fromEvs: EvsAddress;
export const intoEvs: EvsAddress = fromViem;
export const intoViem: ViemAddress = fromEvs;
// and it flows through evs's API: what toViem() hands back is a viem Address again
declare const compiled: CompiledEvsScript;
declare const sender: ViemAddress;
export const account: ViemAddress = compiled.toViem({ mode: 'stateOverride', sender }).account;
`;

test("an app's abitype Register augmentation reaches evs and viem alike", () => {
  const fixturePath = join(pkgDir, 'src', '__abitype-register.fixture.ts');
  const config = ts.getParsedCommandLineOfConfigFile(join(pkgDir, 'tsconfig.json'), undefined, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    },
  });
  if (config === undefined) throw new Error('could not read packages/evs/tsconfig.json');
  // `abitype` exactly as viem's own declarations resolve it
  const resolve = (name: string, from: string): string => {
    const { resolvedModule } = ts.resolveModuleName(name, from, config.options, ts.sys);
    if (resolvedModule === undefined) throw new Error(`cannot resolve ${name} from ${from}`);
    return resolvedModule.resolvedFileName;
  };
  const viemAbitype = resolve('abitype', resolve('viem', fixturePath));
  const options: ts.CompilerOptions = {
    ...config.options,
    noEmit: true,
    paths: { abitype: [viemAbitype] },
  };

  // the fixture exists only in memory; every other file comes from disk
  const base = ts.createCompilerHost(options);
  const host: ts.CompilerHost = {
    ...base,
    fileExists: (f) => f === fixturePath || base.fileExists(f),
    readFile: (f) => (f === fixturePath ? FIXTURE : base.readFile(f)),
    getSourceFile: (f, lang, ...rest) =>
      f === fixturePath
        ? ts.createSourceFile(f, FIXTURE, lang)
        : base.getSourceFile(f, lang, ...rest),
  };

  const program = ts.createProgram([fixturePath], options, host);
  const diagnostics = ts
    .getPreEmitDiagnostics(program, program.getSourceFile(fixturePath))
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
  expect(diagnostics).toEqual([]);
}, 60_000);
