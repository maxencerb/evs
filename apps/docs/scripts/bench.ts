/**
 * Regenerates the timings quoted in `src/content/docs/concepts/compilation.mdx` and
 * `concepts/overhead.mdx`: what recording and compiling a script cost, in a fresh process and
 * once warm, and how a compile splits over its passes.
 *
 *   pnpm --filter @maxencerb/evs run build     # the library must be built first
 *   pnpm --filter @maxencerb/evs-docs run bench
 *
 * It prints Markdown tables. It is not a gate: the numbers depend on the machine, so refresh
 * both pages together, from one run, and update the machine they name.
 *
 * The other figures on the Overhead page need tools this workspace does not install (esbuild,
 * wagmi, a browser, anvil); that page's "How this was measured" section gives the method.
 *
 * Every import is dynamic so that a cold sample can time the imports themselves.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const now = (): number => performance.now();

let mark = now();
const { erc20Abi, parseAbi } = await import('viem');
const importViem = now() - mark;

mark = now();
const { compile, evscript, t } = await import('@maxencerb/evs');
const importEvs = now() - mark;

// ---------------------------------------------------------------------------
// the four scripts (each entry records again on every call)
// ---------------------------------------------------------------------------

const poolAbi = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function slot0() view returns (uint160, int24, uint16, uint16, uint16, uint8, bool)',
]);

const UNROLLED = 100;

const scripts = {
  // concepts/how-it-works: one read
  supplyOf: () =>
    evscript({ name: 'supplyOf', args: [t.address] }, (s, token) => {
      const supply = s.read({ address: token, abi: erc20Abi, functionName: 'totalSupply' });
      return s.return({ supply });
    }),

  // examples/pool-metadata: eight reads, four of them on addresses read earlier
  poolMeta: () =>
    evscript({ name: 'poolMeta', args: [t.address, t.address] }, (s, pool, holder) => {
      const token0 = s.read({ address: pool, abi: poolAbi, functionName: 'token0' });
      const token1 = s.read({ address: pool, abi: poolAbi, functionName: 'token1' });
      const fee = s.read({ address: pool, abi: poolAbi, functionName: 'fee' });
      const slot0 = s.read({ address: pool, abi: poolAbi, functionName: 'slot0' });
      const symbol0 = s.read({ address: token0, abi: erc20Abi, functionName: 'symbol' });
      const symbol1 = s.read({ address: token1, abi: erc20Abi, functionName: 'symbol' });
      const d = s.tryRead({ address: token0, abi: erc20Abi, functionName: 'decimals' });
      const decimals0 = s.select(d.success, d.value, 18);
      const balance0 = s.read({
        address: token0,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [holder],
      });
      const tick = slot0[1];
      return s.return({ token0, token1, fee, tick, symbol0, symbol1, decimals0, balance0 });
    }),

  // examples/token-balances: a loop over a runtime array
  balances: () =>
    evscript({ name: 'balances', args: [t.array(t.address), t.address] }, (s, tokens, owner) => {
      const n = tokens.length();
      const out = s.newArray(t.uint256, n);
      s.for({ type: t.uint256, from: 0n, until: n }, (i) => {
        const r = s.tryRead({
          address: tokens.at(i),
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [owner],
        });
        out.set(i, s.select(r.success, r.value, 0n));
      });
      return s.return({ balances: out.expr() });
    }),

  // the stress case: a JavaScript loop records its body 100 times
  unrolled: () =>
    evscript(
      { name: 'unrolled', args: [t.array(t.address, UNROLLED), t.address] },
      (s, tokens, holder) => {
        const total = s.let(t.uint256, 0n);
        for (let i = 0; i < UNROLLED; i++) {
          const balance = s.read({
            address: tokens.at(i),
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [holder],
          });
          total.set(total.get().add(balance));
        }
        return s.return({ total: total.get() });
      },
    ),
};

type ScriptName = keyof typeof scripts;
const NAMES = Object.keys(scripts) as ScriptName[];
const LABELS: Record<ScriptName, string> = {
  supplyOf: 'supplyOf: 1 read',
  poolMeta: 'Pool metadata: 8 reads',
  balances: 'Balances: a loop',
  unrolled: '100 reads recorded by a JavaScript loop',
};

/** The script-shaped value `compile` takes: every entry of `scripts` is one. */
type AnyScript = Parameters<typeof compile>[0];
const record = (name: ScriptName): AnyScript => scripts[name]();

/**
 * `compile` for a script picked by name: its own return type is computed from the script's
 * literal type, which a script chosen at run time does not have.
 */
const build = compile as unknown as (
  script: AnyScript,
  options?: { optimize?: boolean },
) => { runtimeBytecode: string };

// ---------------------------------------------------------------------------
// cold sample: `node bench.ts --cold <script> <0|1>` prints one JSON line
// ---------------------------------------------------------------------------

interface ColdSample {
  importViem: number;
  importEvs: number;
  record: number;
  compile: number;
  /** The same compile again, in the same process. */
  again: number;
}

if (process.argv[2] === '--cold') {
  const name = process.argv[3] as ScriptName;
  const optimize = process.argv[4] === '1';
  mark = now();
  const script = record(name);
  const recordMs = now() - mark;
  mark = now();
  build(script, { optimize });
  const compileMs = now() - mark;
  mark = now();
  build(script, { optimize });
  const again = now() - mark;
  const sample: ColdSample = {
    importViem,
    importEvs,
    record: recordMs,
    compile: compileMs,
    again,
  };
  console.log(JSON.stringify(sample));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// the report
// ---------------------------------------------------------------------------

const COLD_SAMPLES = 30;
const WARM_RUNS = 2000;
const WARMUP_RUNS = 300;

function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

/** Median wall time of `fn` in milliseconds, after a warm-up. */
function warm(fn: () => unknown, scale = 1): number {
  for (let i = 0; i < WARMUP_RUNS * scale; i++) fn();
  const samples: number[] = [];
  for (let i = 0; i < WARM_RUNS * scale; i++) {
    const start = now();
    fn();
    samples.push(now() - start);
  }
  return median(samples);
}

function cold(name: ScriptName, optimize: boolean): ColdSample {
  const self = fileURLToPath(import.meta.url);
  const samples: ColdSample[] = [];
  for (let i = 0; i < COLD_SAMPLES; i++) {
    const out = execFileSync(process.execPath, [self, '--cold', name, optimize ? '1' : '0'], {
      encoding: 'utf8',
    });
    samples.push(JSON.parse(out) as ColdSample);
  }
  const pick = (key: keyof ColdSample): number => median(samples.map((sample) => sample[key]));
  return {
    importViem: pick('importViem'),
    importEvs: pick('importEvs'),
    record: pick('record'),
    compile: pick('compile'),
    again: pick('again'),
  };
}

const ms = (value: number): string => (value < 0.01 ? value.toFixed(3) : value.toFixed(2));
const bytesOf = (hex: string): number => (hex.length - 2) / 2;

function countStatements(body: readonly unknown[]): number {
  let n = 0;
  for (const stmt of body as readonly Record<string, unknown>[]) {
    n += 1;
    for (const key of ['header', 'body', 'then', 'else']) {
      const nested = stmt[key];
      if (Array.isArray(nested)) n += countStatements(nested);
    }
  }
  return n;
}

console.log(`node ${process.version}, ${process.platform} ${process.arch}\n`);

console.log(`## First call in a fresh process (ms, median of ${COLD_SAMPLES})\n`);
console.log(
  '| Script | Statements | Bytecode | Record | Compile | Compile again | Compile with optimize |',
);
console.log('| --- | --- | --- | --- | --- | --- | --- |');
let imports: ColdSample | undefined;
for (const name of NAMES) {
  const script = record(name);
  const plain = cold(name, false);
  const optimized = cold(name, true);
  imports ??= plain;
  console.log(
    `| ${LABELS[name]} | ${countStatements(script.ir.body)} | ` +
      `${bytesOf(build(script).runtimeBytecode)} bytes | ${ms(plain.record)} | ` +
      `${ms(plain.compile)} | ${ms(plain.again)} | ${ms(optimized.compile)} |`,
  );
}
if (imports !== undefined) {
  console.log(`\nimport viem: ${ms(imports.importViem)} ms, then evs: ${ms(imports.importEvs)} ms`);
}

console.log(`\n## Warm (ms, median of ${WARM_RUNS} runs; a fifth of that for the largest)\n`);
console.log('| Script | Record | Compile | Compile with optimize | Bytes with optimize |');
console.log('| --- | --- | --- | --- | --- |');
for (const name of NAMES) {
  const scale = name === 'unrolled' ? 0.2 : 1;
  const script = record(name);
  console.log(
    `| ${LABELS[name]} | ${ms(warm(() => record(name), scale))} | ` +
      `${ms(warm(() => build(script), scale))} | ` +
      `${ms(warm(() => build(script, { optimize: true }), scale))} | ` +
      `${bytesOf(build(script, { optimize: true }).runtimeBytecode)} |`,
  );
}

// The passes are not public API: they are loaded from the built library by path, and this
// table is skipped when the layout of `dist/` no longer matches.
try {
  const dist = new URL('../../../packages/evs/dist/', import.meta.url).href;
  const load = (path: string) => import(`${dist}${path}`);
  const [{ validateIr }, { eliminateDeadCode }, { lowerProgram }, { evsPeephole }, { assemble }] =
    await Promise.all([
      load('ir/validate.js'),
      load('ir/dce.js'),
      load('codegen/program.js'),
      load('codegen/peephole.js'),
      load('asm/assembler.js'),
    ]);
  const ir = record('poolMeta').ir;
  const live = eliminateDeadCode(ir);
  const us = (fn: () => unknown): number => warm(fn) * 1000;
  const row = (optimize: boolean): Record<string, number> => {
    const lower = (): { nodes: readonly unknown[] } =>
      lowerProgram(live, { evmVersion: 'cancun', optimize });
    const stream = optimize ? evsPeephole(lower().nodes) : [...lower().nodes];
    const unverified = us(() => assemble(stream, { evmVersion: 'cancun', verify: false }));
    return {
      validate: us(() => validateIr(ir)),
      'dead code': us(() => eliminateDeadCode(ir)),
      lower: us(lower),
      peephole: optimize ? us(() => evsPeephole(lower().nodes)) - us(lower) : 0,
      assemble: unverified,
      verify: us(() => assemble(stream, { evmVersion: 'cancun', verify: true })) - unverified,
    };
  };
  const plain = row(false);
  const optimized = row(true);
  console.log('\n## Passes of the pool metadata compile (µs, warm)\n');
  console.log('| Pass | Default | With optimize |');
  console.log('| --- | --- | --- |');
  for (const pass of Object.keys(plain)) {
    console.log(`| ${pass} | ${plain[pass]?.toFixed(0)} | ${optimized[pass]?.toFixed(0)} |`);
  }
} catch (error) {
  console.log(
    `\n(pass timings skipped: ${error instanceof Error ? error.message : String(error)})`,
  );
}
