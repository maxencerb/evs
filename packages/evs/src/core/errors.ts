/**
 * M1 `core/errors.ts` — EvsError hierarchy, error codes, diagnostics.
 *
 * Contract: docs/design/module-interfaces.md §M1 (frozen) + architecture.md §13.
 */

export interface SourceLoc {
  file: string;
  line: number;
  column: number;
}

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
  | 'COMPILE_LIMIT'
  | 'EVM_VERSION'
  | 'INTERNAL';

export class EvsError extends Error {
  readonly code: EvsErrorCode;
  readonly loc: SourceLoc | null;
  readonly relatedLocs: readonly { label: string; loc: SourceLoc | null }[];

  constructor(
    code: EvsErrorCode,
    message: string,
    opts?: {
      loc?: SourceLoc | null;
      relatedLocs?: readonly { label: string; loc: SourceLoc | null }[];
    },
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.loc = opts?.loc ?? null;
    this.relatedLocs = opts?.relatedLocs ?? [];
  }
}

export class EvsStagingError extends EvsError {}
export class EvsTypeError extends EvsError {}
export class EvsScopeError extends EvsError {}
export class EvsCompileError extends EvsError {}

/** The exact phrase every `EvsInternalError` message must contain (module-interfaces §M1). */
const INTERNAL_MARKER = 'bug in evs, please report';

export class EvsInternalError extends EvsError {
  constructor(
    code: EvsErrorCode,
    message: string,
    opts?: {
      loc?: SourceLoc | null;
      relatedLocs?: readonly { label: string; loc: SourceLoc | null }[];
    },
  ) {
    super(
      code,
      message.includes(INTERNAL_MARKER) ? message : `${message} (this is a ${INTERNAL_MARKER})`,
      opts,
    );
  }
}

export interface EvsDiagnostic {
  severity: 'warning';
  // 'ENV_FRAME_DEPENDENT' extends the frozen §M1 union (recorded in
  // docs/design/amendments.md): s.env('caller')/s.env('address') read the execution frame,
  // whose shape differs between toViem() deployless (default) and stateOverride modes.
  code: 'LOOP_ALLOCATION' | 'LARGE_FRAME' | 'ENV_FRAME_DEPENDENT';
  message: string;
  loc: SourceLoc | null;
}
