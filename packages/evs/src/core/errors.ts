/**
 * `core/errors.ts` — EvsError hierarchy, error codes, diagnostics.
 */

/**
 * Every `EvsError` code: stable and machine-checkable (`error.code`). The user-facing table, with
 * the class that throws each one, is the docs site's diagnostics reference.
 */
export type EvsErrorCode =
  /** A staged handle was coerced to a host value (`x + 1`, a template literal, `JSON.stringify`). */
  | 'STAGING_MISUSE'
  /** Wrong operand/argument type, or a structurally invalid host input to an API entry point. */
  | 'TYPE_MISMATCH'
  /** A literal invalid for its type (out of range, not a safe integer, malformed hex). */
  | 'LITERAL_RANGE'
  /** An all-literal operation that provably panics at run time (overflow, division by zero, …). */
  | 'CERTAIN_PANIC'
  /** A value, cell or loop control used outside the scope that recorded it. */
  | 'SCOPE_VIOLATION'
  /** A handle that belongs to another script (or another evs install). */
  | 'FOREIGN_HANDLE'
  /** A builder call after `s.return` sealed the script. */
  | 'RECORDING_CLOSED'
  /** A type or feature outside the supported surface (arrays nested past `MAX_ARRAY_DEPTH`, a
   *  static size past `MAX_STATIC_SIZE`, …). */
  | 'UNSUPPORTED_V0'
  /** Malformed ABI material, or a `functionName` that selects no function / an ambiguous overload. */
  | 'ABI_SHAPE'
  /** An invalid `t.error` / `errors: [...]` declaration (bad, reserved or duplicate name, selector
   *  clash, script name equal to an error name). */
  | 'ERROR_DECL'
  /** `s.throw` of an error missing from the script's declared `errors`. */
  | 'ERROR_UNDECLARED'
  /** A whole-program limit: EIP-170 code size at compile time, `maxSteps` in `interpret()`. */
  | 'COMPILE_LIMIT'
  /** An unsupported `evmVersion` option. */
  | 'EVM_VERSION'
  /** A broken evs invariant or a failed bytecode verifier: a bug in evs (`EvsInternalError`). */
  | 'INTERNAL';

export class EvsError extends Error {
  readonly code: EvsErrorCode;

  constructor(code: EvsErrorCode, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class EvsStagingError extends EvsError {}
export class EvsTypeError extends EvsError {}
export class EvsScopeError extends EvsError {}
export class EvsCompileError extends EvsError {}

/** The exact phrase every `EvsInternalError` message must contain. */
const INTERNAL_MARKER = 'bug in evs, please report';

export class EvsInternalError extends EvsError {
  constructor(code: EvsErrorCode, message: string) {
    super(
      code,
      message.includes(INTERNAL_MARKER) ? message : `${message} (this is a ${INTERNAL_MARKER})`,
    );
  }
}

/** A compile-time warning, delivered through `compile()`'s `onDiagnostic` option. */
export interface EvsDiagnostic {
  severity: 'warning';
  code:
    /** An allocating statement inside a loop: memory (and its gas) grows every iteration. */
    | 'LOOP_ALLOCATION'
    /** The static frame exceeds 32 KiB, so memory-expansion gas gets expensive. */
    | 'LARGE_FRAME'
    /** `s.env('caller')` / `s.env('address')` (and the script's own balance,
     *  `s.balance(s.env('address'))`) read the execution frame, whose shape differs between the
     *  `toViem()` deployless (default) and stateOverride modes. */
    | 'ENV_FRAME_DEPENDENT'
    /** The ABI-static result can start with `0xEF`, which the deployless mode rejects (it
     *  deposits the result as contract code; see `deployless.ts`). */
    | 'DEPLOYLESS_RESULT_PREFIX'
    /** The encoded result is always over 24,576 bytes, past the deployless mode's EIP-170 cap. */
    | 'DEPLOYLESS_RESULT_SIZE';
  message: string;
  /**
   * The id of the statement that raised it (a `SiteId` — plain `number` here, since core/ does
   * not import the IR): the `site` of that statement in `compiled.ir` and its entry in
   * `compiled.sourceMap.sites` (one per recorded statement, so two warnings raised by look-alike
   * statements still differ in `site`). Set by the per-statement codes (`LOOP_ALLOCATION`,
   * `ENV_FRAME_DEPENDENT`); absent on whole-program ones (`LARGE_FRAME`,
   * `DEPLOYLESS_RESULT_PREFIX`, `DEPLOYLESS_RESULT_SIZE`).
   */
  site?: number;
}
