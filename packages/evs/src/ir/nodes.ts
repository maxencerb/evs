/**
 * `ir/nodes.ts` — the ScriptIr node inventory, versioned JSON-safe (de)serialization, and
 * statement-tree traversal.
 *
 * The IR is a structured statement tree over flat value/cell/fn tables — plain JSON-safe data
 * (words as 0x-hex), versioned (`irVersion: 1`), frozen after recording. `deserializeIr`
 * performs the structural (shape + version) check only; `ir/validate.ts` is the semantic trust
 * boundary (`deserialize → validate` for external IR).
 *
 * A barrel over `ir/nodes/`: the node inventory and op vocabularies (`schema.ts`), the JSON
 * (de)serialization (`json.ts`), and the def/use tables + tree traversal (`walk.ts`).
 */

export { callOutputs, isAccountOp, isEnvOp } from './nodes/schema.js';
export type {
  ValueId,
  CellId,
  FnId,
  SiteId,
  ScriptIr,
  ValueInfo,
  CellInfo,
  FnIr,
  BinOp,
  UnOp,
  ModArithOp,
  EnvOp,
  AccountOp,
  ConstData,
  PlainAbiParam,
  PlainAbiFunction,
  PlainAbiError,
  Stmt,
} from './nodes/schema.js';
export { serializeIr, deserializeIr, deepFreeze } from './nodes/json.js';
export { stmtReads, stmtDefs, walkStmts, walkStmtsWithPath } from './nodes/walk.js';
