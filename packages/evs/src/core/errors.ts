/**
 * `core/errors.ts` — EvsError hierarchy, error codes, diagnostics.
 */

export type EvsErrorCode =
  | 'STAGING_MISUSE'
  | 'TYPE_MISMATCH'
  | 'LITERAL_RANGE'
  | 'CERTAIN_PANIC'
  | 'SCOPE_VIOLATION'
  | 'FOREIGN_HANDLE'
  | 'RECORDING_CLOSED'
  | 'UNSUPPORTED_V0'
  | 'ABI_SHAPE'
  // custom errors (issue #15):
  | 'ERROR_DECL' // invalid `errors: [...]` declaration (duplicate/reserved name, selector clash, script name = error name)
  | 'ERROR_UNDECLARED' // s.throw of an error missing from the script's declared set
  | 'COMPILE_LIMIT'
  | 'EVM_VERSION'
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

export interface EvsDiagnostic {
  severity: 'warning';
  // 'ENV_FRAME_DEPENDENT': s.env('caller')/s.env('address') read
  // the execution frame, whose shape differs between toViem() deployless (default) and
  // stateOverride modes. 'DEPLOYLESS_RESULT_PREFIX' / 'DEPLOYLESS_RESULT_SIZE': the result
  // shape can start with 0xEF / is always over 24,576 bytes, which the deployless mode rejects
  // (it deposits the result as contract code — see deployless.ts).
  code:
    | 'LOOP_ALLOCATION'
    | 'LARGE_FRAME'
    | 'ENV_FRAME_DEPENDENT'
    | 'DEPLOYLESS_RESULT_PREFIX'
    | 'DEPLOYLESS_RESULT_SIZE';
  message: string;
}
