/**
 * Generates the playground's build-time assets (all gitignored):
 *
 * - `public/playground/evs.js`   — browser ESM bundle of the workspace `@maxencerb/evs`,
 *   with `evscript()` wrapped so every `script.compile()` records its `runtimeBytecode`
 *   on `globalThis.__EVS_PLAYGROUND__` (feeds the bytecode seam in the UI).
 * - `public/playground/viem.js`  — browser ESM bundle re-exporting viem, with `http()`
 *   defaulting to the playground's RPC-URL field when called without a URL.
 * - `src/generated/playground-dts.json` — Monaco extraLib payload: the real `.d.ts` of
 *   `@maxencerb/evs` and `abitype`, plus a generated slim `viem` shim (real inference
 *   through abitype generics; the full viem types are 15 MB and stay out of the browser).
 *
 * Run via `bun scripts/gen-playground.ts` (wired into this package's dev/build scripts).
 * Requires the library built first (`bun run build` at the repo root), same as the
 * snippet gate.
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const docsRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(docsRoot, '../..');
const evsRoot = join(repoRoot, 'packages/evs');
const outPublic = join(docsRoot, 'public/playground');
const outGenerated = join(docsRoot, 'src/generated');

// ---------------------------------------------------------------------------
// 1. Runtime bundles (Bun.build → browser ESM)
// ---------------------------------------------------------------------------

const entryDir = join(docsRoot, 'scripts/.playground-entries');
await mkdir(entryDir, { recursive: true });
await mkdir(outPublic, { recursive: true });
await mkdir(outGenerated, { recursive: true });

const evsEntry = join(entryDir, 'evs-entry.ts');
// Pure re-export — the harness reads compiled artifacts off the user module's
// exports (script objects are frozen, so no instrumentation is possible here).
await writeFile(evsEntry, `export * from '@maxencerb/evs';\n`);

const viemEntry = join(entryDir, 'viem-entry.ts');
await writeFile(
  viemEntry,
  `export * from 'viem';
import { http as _http } from 'viem';

// In the playground, http() with no URL uses the RPC field in the toolbar.
export const http = ((url?: string, config?: Parameters<typeof _http>[1]) =>
  _http(
    url ?? ((globalThis as Record<string, unknown>).__EVS_PLAYGROUND_RPC__ as string | undefined),
    config,
  )) as typeof _http;
`,
);

const build = await Bun.build({
  entrypoints: [evsEntry, viemEntry],
  outdir: outPublic,
  target: 'browser',
  format: 'esm',
  minify: true,
  naming: '[name].[ext]',
});
if (!build.success) {
  for (const log of build.logs) console.error(log);
  throw new Error('playground runtime bundle failed');
}
const bundleNames: Record<string, string> = { 'evs-entry': 'evs.js', 'viem-entry': 'viem.js' };
for (const artifact of build.outputs) {
  const base = artifact.path.split('/').pop()?.replace(/\.js$/, '') ?? '';
  const wanted = bundleNames[base];
  if (wanted) {
    await writeFile(join(outPublic, wanted), await readFile(artifact.path));
  }
}

// ---------------------------------------------------------------------------
// 2. Monaco type payload
// ---------------------------------------------------------------------------

async function collectDts(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.d.ts'))
    .map((e) => join(e.parentPath, e.name));
}

const files: Record<string, string> = {};

// @maxencerb/evs — the real built declarations.
for (const file of await collectDts(join(evsRoot, 'dist'))) {
  const rel = relative(evsRoot, file);
  files[`file:///node_modules/@maxencerb/evs/${rel}`] = await readFile(file, 'utf8');
}
files['file:///node_modules/@maxencerb/evs/package.json'] = JSON.stringify({
  name: '@maxencerb/evs',
  type: 'module',
  types: './dist/index.d.ts',
});

// abitype — the real declarations (evs's public types reference it, and the viem
// shim's readContract inference is built on it).
const abitypeRoot = dirname(Bun.resolveSync('abitype/package.json', evsRoot));
for (const file of await collectDts(join(abitypeRoot, 'dist/types'))) {
  const rel = relative(abitypeRoot, file);
  files[`file:///node_modules/abitype/${rel}`] = await readFile(file, 'utf8');
}
files['file:///node_modules/abitype/package.json'] = JSON.stringify({
  name: 'abitype',
  type: 'module',
  types: './dist/types/exports/index.d.ts',
});

// viem shim — hand-typed subset with real inference. erc20Abi's declaration is
// lifted verbatim from the installed viem's own d.ts so the literal type (readonly
// modifiers included — inference needs them) exactly matches runtime.
const viemRoot = dirname(Bun.resolveSync('viem/package.json', docsRoot));
const abisDts = await readFile(join(viemRoot, '_types/constants/abis.d.ts'), 'utf8');
const abiMatch = abisDts.match(/export declare const erc20Abi: (readonly \[\{[\s\S]*?\n\}\]);/);
if (!abiMatch?.[1]) throw new Error('could not extract erc20Abi declaration from viem');
const abiLiteral = abiMatch[1];
files['file:///node_modules/viem/index.d.ts'] = `/**
 * Playground shim for 'viem' — editor types only. At runtime your script gets the
 * real viem. This shim types the subset the playground examples use; readContract
 * inference is real (built on abitype), so results are fully typed.
 */
import type {
  Abi,
  AbiParameterToPrimitiveType,
  AbiParametersToPrimitiveTypes,
  AbiStateMutability,
  ExtractAbiFunction,
  ExtractAbiFunctionNames,
} from 'abitype';

export type Address = \`0x\${string}\`;
export type Hex = \`0x\${string}\`;

// Referenced by @maxencerb/evs's own declarations — same shape as viem's.
export type ContractFunctionName<
  abi extends Abi | readonly unknown[] = Abi,
  mutability extends AbiStateMutability = AbiStateMutability,
> = ExtractAbiFunctionNames<
  abi extends Abi ? abi : Abi,
  mutability
> extends infer functionName extends string
  ? [functionName] extends [never]
    ? string
    : functionName
  : string;

export type StateMapping = readonly { slot: Hex; value: Hex }[];
export type StateOverride = readonly {
  address: Address;
  balance?: bigint | undefined;
  nonce?: number | undefined;
  code?: Hex | undefined;
  state?: StateMapping | undefined;
  stateDiff?: StateMapping | undefined;
}[];

/** The standard ERC-20 ABI, exactly as shipped by viem. */
export declare const erc20Abi: ${abiLiteral};

export declare function parseEther(value: string): bigint;
export declare function parseUnits(value: string, decimals: number): bigint;
export declare function formatEther(value: bigint): string;
export declare function formatUnits(value: bigint, decimals: number): string;
export declare function isAddress(value: string): value is Address;
export declare function getAddress(value: string): Address;

export interface Transport {
  readonly __brand: 'Transport';
}

/**
 * In the playground, \`http()\` with no URL uses the RPC field in the toolbar.
 * Pass an explicit URL to override it.
 */
export declare function http(url?: string): Transport;

type ReadResult<
  abi extends Abi,
  name extends ExtractAbiFunctionNames<abi, 'pure' | 'view'>,
  outputs extends readonly unknown[] = ExtractAbiFunction<abi, name>['outputs'],
> = outputs extends readonly [infer single]
  ? AbiParameterToPrimitiveType<single & Record<string, unknown>, 'outputs'>
  : AbiParametersToPrimitiveTypes<ExtractAbiFunction<abi, name>['outputs'], 'outputs'>;

export interface PublicClient {
  readContract<
    const abi extends Abi,
    name extends ExtractAbiFunctionNames<abi, 'pure' | 'view'>,
  >(parameters: {
    abi: abi;
    functionName: name;
    args?: AbiParametersToPrimitiveTypes<ExtractAbiFunction<abi, name>['inputs'], 'inputs'>;
    address?: Address;
    code?: Hex;
    stateOverride?: readonly { address: Address; code: Hex }[];
    blockNumber?: bigint;
  }): Promise<ReadResult<abi, name>>;
  getBlockNumber(): Promise<bigint>;
  getBalance(parameters: { address: Address }): Promise<bigint>;
}

export declare function createPublicClient(options: {
  transport: Transport;
  chain?: unknown;
}): PublicClient;
`;
files['file:///node_modules/viem/package.json'] = JSON.stringify({
  name: 'viem',
  type: 'module',
  types: './index.d.ts',
});

await writeFile(join(outGenerated, 'playground-dts.json'), JSON.stringify({ files }));

const evsSize = ((await readFile(join(outPublic, 'evs.js'))).byteLength / 1024).toFixed(0);
const viemSize = ((await readFile(join(outPublic, 'viem.js'))).byteLength / 1024).toFixed(0);
const dtsSize = (JSON.stringify({ files }).length / 1024).toFixed(0);
console.log(
  `playground assets: evs.js ${evsSize}K, viem.js ${viemSize}K, dts payload ${dtsSize}K (${Object.keys(files).length} files)`,
);
