/**
 * Unit tests — the shared revert classifier (`abi/revert.ts`): `explainRevert` and
 * `decodeScriptError` must agree on what every payload is (one corpus fed to both), and the
 * per-ABI error table is cached for frozen ABIs only.
 */

import { encodeErrorResult } from 'viem';
import { describe, expect, test } from 'vite-plus/test';

import { evscript } from '../builder/script.js';
import { compile, type RevertExplanation } from '../compile.js';
import { namedArg, t, type Hex } from '../core/types.js';
import { decodeScriptError, type DecodedScriptError } from '../viem.js';
import { classifyRevert, errorTableOf } from './revert.js';

const NoBalance = t.error('NoBalance', [namedArg('balance', t.uint256)]);
const NotOwner = t.error('NotOwner');
const compiled = compile(
  evscript({ name: 'guard', args: [t.uint256], errors: [NoBalance, NotOwner] }, (s, x) => {
    s.if(x.lt(10n), () => {
      s.throw(NoBalance, { balance: x });
    });
    s.if(x.eq(11n), () => {
      s.throw(NotOwner);
    });
    return s.return({ x });
  }),
);

const encode = (name: string, inputs: readonly { name: string; type: string }[], args: unknown[]) =>
  encodeErrorResult({ abi: [{ type: 'error', name, inputs }], errorName: name, args });

const PANIC = encode('Panic', [{ name: 'code', type: 'uint256' }], [0x11n]);
const ERROR = encode('Error', [{ name: 'reason', type: 'string' }], ['boom']);
const DECODE = encode('EvsDecodeError', [{ name: 'site', type: 'uint256' }], [3n]);
const NO_BALANCE = encode('NoBalance', [{ name: 'balance', type: 'uint256' }], [5n]);
const NOT_OWNER = encode('NotOwner', [], []);
const BAD_CALLDATA = encode('EvsInvalidCalldata', [], []);

/** Payloads covering every arm, each boundary of the byte-level rules, and malformed variants. */
const CORPUS: readonly Hex[] = [
  '0x',
  '0x4e48',
  '0x4e487b71',
  PANIC,
  `${PANIC}00`, // Panic needs exactly 36 bytes
  `0x${PANIC.slice(2, -2)}`,
  ERROR,
  '0x08c379a0ffff', // Error selector, garbage body
  `0x08c379a0${'00'.repeat(31)}20`, // offset only, no length word
  DECODE,
  `${DECODE}${'00'.repeat(32)}`, // trailing bytes
  `0x${DECODE.slice(2, -2)}`,
  BAD_CALLDATA,
  `${BAD_CALLDATA}00`,
  NO_BALANCE,
  `0x${NO_BALANCE.slice(2, 10)}ff`, // declared selector, malformed args
  NOT_OWNER,
  `${NOT_OWNER}00`,
  '0xdeadbeef',
  `0xDEADBEEF${'00'.repeat(32)}`, // upper-case hex
  `0x${PANIC.slice(2).toUpperCase()}`,
];

/** What each presentation says the payload IS, in one shared vocabulary. */
function fromExplanation(e: RevertExplanation): string {
  switch (e.kind) {
    case 'panic':
      return `panic ${e.panicCode}`;
    case 'evs-decode':
      return 'EvsDecodeError';
    case 'evs-invalid-calldata':
      return 'EvsInvalidCalldata';
    case 'error-string':
      return 'error-string';
    case 'script-error':
      // a declared selector whose args do not decode is reported, but without args
      return e.errorArgs === undefined ? 'unknown' : `declared ${e.errorName}`;
    case 'custom':
      return 'unknown';
    default: // 'empty'
      return 'empty';
  }
}

function fromDecoded(d: DecodedScriptError | undefined): string {
  if (d === undefined) return 'no revert data';
  if ('code' in d) return `panic ${d.code}`;
  switch (d.name) {
    case 'Error':
      return 'error-string';
    case 'EvsDecodeError':
    case 'EvsInvalidCalldata':
    case 'empty':
    case 'unknown':
      return d.name;
    default:
      return `declared ${d.name}`;
  }
}

describe('explainRevert and decodeScriptError agree (one classifier)', () => {
  test.each(CORPUS.map((raw) => [raw]))('%s', (raw) => {
    expect(fromExplanation(compiled.explainRevert(raw))).toBe(
      fromDecoded(decodeScriptError(compiled, raw)),
    );
  });

  test('the corpus reaches every classifier arm', () => {
    const table = errorTableOf(compiled.abi);
    const kinds = new Set(CORPUS.map((raw) => classifyRevert(raw, table).kind));
    expect([...kinds].toSorted()).toEqual([
      'abi-error',
      'empty',
      'error-string',
      'panic',
      'short',
      'unknown',
    ]);
  });
});

describe('errorTableOf', () => {
  test('maps selectors to entries, first entry wins, malformed entries skipped', () => {
    const abi = [
      null,
      { type: 'function', name: 'f', inputs: [] },
      { type: 'error', name: 'Dup', inputs: [{ name: 'first', type: 'uint256' }] },
      { type: 'error', name: 'Dup', inputs: [{ name: 'second', type: 'uint256' }] },
      { type: 'error', inputs: [] },
    ];
    const table = errorTableOf(abi);
    expect([...table.values()]).toEqual([
      { name: 'Dup', inputs: [{ name: 'first', type: 'uint256' }] },
    ]);
  });

  test('cached per frozen ABI; a mutable ABI is rebuilt so edits are seen', () => {
    expect(Object.isFrozen(compiled.abi)).toBe(true);
    expect(errorTableOf(compiled.abi)).toBe(errorTableOf(compiled.abi));

    const mutable: unknown[] = [];
    expect(errorTableOf(mutable).size).toBe(0);
    mutable.push({ type: 'error', name: 'Late', inputs: [] });
    expect([...errorTableOf(mutable).values()].map((e) => e.name)).toEqual(['Late']);
  });

  test('a non-array ABI matches nothing (never throws)', () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a JS caller's wrong input
    expect(errorTableOf({} as unknown as readonly unknown[]).size).toBe(0);
  });
});
