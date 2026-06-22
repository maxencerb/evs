/**
 * codegen.ts — forge artifacts → as-const TypeScript test fixtures.
 *
 * Runs `forge build`, then emits `{ abi, bytecode, deployedBytecode }` per contract as
 * literal-typed (`as const`) TS modules into `packages/evs/test/generated/`, plus an
 * `index.ts` barrel. JSON imports would widen the ABI types (prior-art §5 /
 * stack-testing §4) — `as const` emission keeps them literal for viem inference.
 *
 * Deterministic: ABI items and object keys are emitted in a stable order, so a file's
 * content changes only when the contracts change. Idempotent: unchanged files are not
 * rewritten; stale files are pruned (this script is the directory's only writer).
 *
 * Run with: `bun scripts/codegen.ts` (any cwd — paths resolve from this file).
 */
import { readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Minimal typed surface of the Bun globals used here. `bun-types` is deliberately not a
// workspace dependency; this script only ever runs under the bun runtime (`bun run codegen`).
interface BunShellPromise extends Promise<unknown> {
  cwd(dir: string): BunShellPromise;
}
interface BunFileLike {
  exists(): Promise<boolean>;
  text(): Promise<string>;
  json(): Promise<unknown>;
}
declare const Bun: {
  $(strings: TemplateStringsArray, ...expressions: readonly unknown[]): BunShellPromise;
  file(path: string): BunFileLike;
  write(path: string, content: string): Promise<number>;
};

const CONTRACTS = [
  'Composite',
  'EvsReference',
  'Malformed',
  'MockERC20',
  'MockUniV3Pool',
  'Reverter',
];

const contractsDir = fileURLToPath(new URL('..', import.meta.url));
const generatedDir = fileURLToPath(new URL('../../evs/test/generated/', import.meta.url));

type Json = string | number | boolean | null | readonly Json[] | { readonly [k: string]: Json };

function isRecord(value: unknown): value is { readonly [k: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Stable key order for ABI objects: well-known keys first, anything else alphabetical. */
const KEY_PRIORITY = [
  'type',
  'name',
  'inputs',
  'outputs',
  'stateMutability',
  'anonymous',
  'indexed',
  'internalType',
  'components',
];

function compareKeys(a: string, b: string): number {
  const ia = KEY_PRIORITY.indexOf(a);
  const ib = KEY_PRIORITY.indexOf(b);
  if (ia !== -1 && ib !== -1) return ia - ib;
  if (ia !== -1) return -1;
  if (ib !== -1) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Recursively rebuilds a JSON.parse result with deterministic object-key order. */
function canonicalize(value: unknown): Json {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map((item: unknown) => canonicalize(item));
  if (isRecord(value)) {
    const out: { [k: string]: Json } = {};
    for (const key of Object.keys(value).toSorted(compareKeys)) {
      const member = value[key];
      if (member !== undefined) out[key] = canonicalize(member);
    }
    return out;
  }
  throw new Error('codegen: non-JSON value in forge artifact');
}

/** Stable ABI item order: by type, then name, then input type list. */
function abiSortKey(item: unknown): string {
  if (!isRecord(item)) return '';
  const type = item['type'];
  const name = item['name'];
  const inputs = item['inputs'];
  const inputTypes = Array.isArray(inputs)
    ? inputs
        .map((p: unknown) => {
          if (!isRecord(p)) return '';
          const t = p['type'];
          return typeof t === 'string' ? t : '';
        })
        .join(',')
    : '';
  return `${typeof type === 'string' ? type : ''}|${
    typeof name === 'string' ? name : ''
  }|${inputTypes}`;
}

function indentLines(text: string, indent: string): string {
  return text
    .split('\n')
    .map((line, i) => (i === 0 ? line : indent + line))
    .join('\n');
}

interface ContractArtifact {
  readonly abi: readonly unknown[];
  readonly bytecode: string;
  readonly deployedBytecode: string;
}

function assertHex(value: unknown, what: string): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]*$/.test(value)) {
    throw new Error(`codegen: ${what} is not a 0x-hex string`);
  }
  return value;
}

async function readArtifact(name: string): Promise<ContractArtifact> {
  const path = `${contractsDir}out/${name}.sol/${name}.json`;
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`codegen: missing forge artifact ${path} — did forge build fail?`);
  }
  const raw: unknown = await file.json();
  if (!isRecord(raw)) throw new Error(`codegen: ${name}.json is not an object`);
  const abi = raw['abi'];
  if (!Array.isArray(abi)) throw new Error(`codegen: ${name}.json has no abi array`);
  const bytecode = raw['bytecode'];
  const deployedBytecode = raw['deployedBytecode'];
  return {
    abi,
    bytecode: assertHex(
      isRecord(bytecode) ? bytecode['object'] : undefined,
      `${name} bytecode.object`,
    ),
    deployedBytecode: assertHex(
      isRecord(deployedBytecode) ? deployedBytecode['object'] : undefined,
      `${name} deployedBytecode.object`,
    ),
  };
}

function renderModule(name: string, artifact: ContractArtifact): string {
  const abi = canonicalize(
    artifact.abi.toSorted((a: unknown, b: unknown) => {
      const ka = abiSortKey(a);
      const kb = abiSortKey(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    }),
  );
  const abiText = indentLines(JSON.stringify(abi, null, 2), '  ');
  return [
    '// AUTO-GENERATED FILE — DO NOT EDIT.',
    '// Emitted by packages/contracts/scripts/codegen.ts (`bun run codegen`).',
    `// Source: packages/contracts/src/${name}.sol — solc 0.8.30, optimizer off, via_ir off.`,
    '',
    `export const ${name} = {`,
    `  abi: ${abiText},`,
    `  bytecode: ${JSON.stringify(artifact.bytecode)},`,
    `  deployedBytecode: ${JSON.stringify(artifact.deployedBytecode)},`,
    '} as const;',
    '',
  ].join('\n');
}

function renderBarrel(names: readonly string[]): string {
  return [
    '// AUTO-GENERATED FILE — DO NOT EDIT.',
    '// Emitted by packages/contracts/scripts/codegen.ts (`bun run codegen`).',
    '',
    ...names.toSorted().map((n) => `export { ${n} } from './${n}.js';`),
    '',
  ].join('\n');
}

/** Writes only when content differs; returns whether the file changed. */
async function writeIfChanged(path: string, content: string): Promise<boolean> {
  const file = Bun.file(path);
  if (await file.exists()) {
    const existing = await file.text();
    if (existing === content) return false;
  }
  await Bun.write(path, content);
  return true;
}

async function main(): Promise<void> {
  process.stdout.write('codegen: forge build…\n');
  await Bun.$`forge build`.cwd(contractsDir);

  const outputs = [
    ...(await Promise.all(
      CONTRACTS.map(async (name) => ({
        fileName: `${name}.ts`,
        content: renderModule(name, await readArtifact(name)),
      })),
    )),
    { fileName: 'index.ts', content: renderBarrel(CONTRACTS) },
  ];

  const written = await Promise.all(
    outputs.map(async ({ fileName, content }) => ({
      fileName,
      changed: await writeIfChanged(`${generatedDir}${fileName}`, content),
    })),
  );
  for (const { fileName, changed } of written.filter((w) => w.changed)) {
    process.stdout.write(`codegen: wrote test/generated/${fileName}\n`);
    void changed;
  }

  // Prune stale files (this script is the directory's only writer).
  const expected = new Set(outputs.map((o) => o.fileName));
  const entries = await readdir(generatedDir).catch((): string[] => []);
  const stale = entries.filter((entry) => !expected.has(entry));
  await Promise.all(stale.map((entry) => rm(`${generatedDir}${entry}`)));
  for (const entry of stale) {
    process.stdout.write(`codegen: pruned stale test/generated/${entry}\n`);
  }

  const changedCount = written.filter((w) => w.changed).length + stale.length;
  process.stdout.write(
    changedCount === 0
      ? 'codegen: up to date (no changes)\n'
      : `codegen: done (${changedCount} file${changedCount === 1 ? '' : 's'} updated)\n`,
  );
}

await main();
