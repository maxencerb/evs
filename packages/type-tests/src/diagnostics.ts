/**
 * A warning, a site and an explained revert as an app reads them: the `onDiagnostic` callback
 * that filters acknowledged warnings on `code` and `key`, the site table, and the statement a
 * revert was traced to. The key is the part an app stores; the site id is a position.
 */
import {
  compile,
  evscript,
  t,
  type EvsDiagnostic,
  type RevertExplanation,
  type SiteId,
  type SourceMap,
} from '@maxencerb/evs';
import {
  hydrate,
  type EvsDiagnostic as RuntimeDiagnostic,
  type PrecompiledScriptDebug,
  type RevertExplanation as RuntimeExplanation,
  type SourceMap as RuntimeSourceMap,
} from '@maxencerb/evs/runtime';

import { expectType, type Same } from './assert.js';

type Site = SourceMap['sites'][number];
type SiteRef = { id: SiteId; key: string; detail: string };

// a warning: `key` is what to filter on, `site` and `sites` say where
expectType<Same<EvsDiagnostic['severity'], 'warning'>>();
expectType<Same<EvsDiagnostic['key'], string | undefined>>();
expectType<Same<EvsDiagnostic['site'], number | undefined>>();
expectType<Same<EvsDiagnostic['sites'], readonly { id: number; key: string }[] | undefined>>();
expectType<
  Same<
    EvsDiagnostic['code'],
    | 'LOOP_ALLOCATION'
    | 'LARGE_FRAME'
    | 'ENV_FRAME_DEPENDENT'
    | 'DEPLOYLESS_RESULT_PREFIX'
    | 'DEPLOYLESS_RESULT_SIZE'
  >
>();

// a site: both names of a statement, the position and the key
expectType<Same<Site['id'], SiteId>>();
expectType<Same<Site['key'], string>>();
expectType<Same<Site['kind'], 'panic' | 'decode' | 'call' | 'stmt'>>();
expectType<Same<Site['detail'], string>>();

// an explained revert carries the key next to the number the payload holds
expectType<Same<RevertExplanation['site'], SiteRef | undefined>>();
expectType<Same<RevertExplanation['candidateSites'], readonly SiteRef[] | undefined>>();

// the runtime entry exports the same types, and debug data holds the same sites
expectType<Same<RuntimeDiagnostic, EvsDiagnostic>>();
expectType<Same<RuntimeExplanation, RevertExplanation>>();
expectType<Same<RuntimeSourceMap, SourceMap>>();
expectType<Same<PrecompiledScriptDebug['sites'], SourceMap['sites']>>();

// a warning written by hand, as a test of an app's own reporter would: only three fields are
// required, and a whole-program warning has no key
const wholeProgram: EvsDiagnostic = {
  severity: 'warning',
  code: 'LARGE_FRAME',
  message: 'the static frame spans 40000 bytes',
};
const aboutOneStatement: EvsDiagnostic = {
  severity: 'warning',
  code: 'LOOP_ALLOCATION',
  message: 's.read(symbol) (returndata snapshot) allocates memory on every loop iteration',
  key: 's.read(symbol)#0',
  site: 8,
  sites: [{ id: 8, key: 's.read(symbol)#0' }],
};

const position = 8;
// @ts-expect-error a key is a string: the site id is not one
const numericKey: EvsDiagnostic = { ...aboutOneStatement, key: position };

// @ts-expect-error a site has a key
const siteWithoutKey: Site = { id: 0, kind: 'stmt', detail: 'const' };

/** The warnings an app decided to live with, as `code key`. */
const acknowledged: ReadonlySet<string> = new Set([
  'LOOP_ALLOCATION s.read(symbol)#0',
  'ENV_FRAME_DEPENDENT s.env(caller)',
  'DEPLOYLESS_RESULT_PREFIX s.return(total)',
]);

const symbols = evscript({ name: 'symbols', args: [t.array(t.address)] }, (s, tokens) => {
  const total = s.let(t.uint256, 0n);
  s.forEach(tokens, (token) => {
    total.set(total.get().add(s.balance(token)));
  });
  return s.return({ total: total.get(), caller: s.env('caller') });
});

export function report(): string[] {
  const lines: string[] = [];
  const compiled = compile(symbols, {
    onDiagnostic: (warning) => {
      expectType<Same<typeof warning, EvsDiagnostic>>();
      if (warning.key !== undefined && acknowledged.has(`${warning.code} ${warning.key}`)) return;
      // every statement the warning covers, by key: no lookup in the site table needed
      const where = (warning.sites ?? []).map((site) => site.key);
      expectType<Same<typeof where, string[]>>();
      lines.push(`${warning.code} ${warning.key ?? ''} [${where.join(', ')}]: ${warning.message}`);
    },
  });

  // the site table, by key
  const keyOfSite = new Map(compiled.sourceMap.sites.map((site) => [site.id, site.key]));
  expectType<Same<typeof keyOfSite, Map<number, string>>>();

  // an explained revert: match on the key, print the id
  const explained = compiled.explainRevert('0x');
  const key = explained.site?.key;
  expectType<Same<typeof key, string | undefined>>();
  for (const site of explained.candidateSites ?? []) lines.push(`${site.key} (site ${site.id})`);

  return [
    ...lines,
    wholeProgram.code,
    aboutOneStatement.key ?? '',
    numericKey.code,
    siteWithoutKey.detail,
  ];
}

export async function explainInTheClient(data: `0x${string}`): Promise<string | undefined> {
  const compiled = compile(symbols);
  const precompiled = compiled.toPrecompiled();
  const script = hydrate(precompiled.toJSON(), { debug: () => precompiled.debug() });
  const explained = await script.explainRevert(data);
  expectType<Same<typeof explained, RevertExplanation>>();
  const { sites } = await script.debug();
  expectType<Same<(typeof sites)[number]['key'], string>>();
  return explained.site?.key;
}
