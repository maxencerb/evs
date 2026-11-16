/**
 * `ir/nodes.ts` — the ScriptIr node inventory, versioned JSON-safe (de)serialization, and
 * statement-tree traversal.
 *
 * The IR is a structured statement tree over flat value/cell/fn tables — plain JSON-safe data
 * (words as 0x-hex), versioned (`irVersion: 1`), frozen after recording. `deserializeIr`
 * performs the structural (shape + version) check only; `ir/validate.ts` is the semantic trust
 * boundary (`deserialize → validate` for external IR).
 *
 * A barrel over `ir/nodes/`: the node inventory, op vocabularies and nesting limits
 * (`schema.ts`), the JSON (de)serialization (`json.ts`), and the def/use tables + tree traversal
 * (`walk.ts`). `ir/nodes/origin.ts` (the registry of the IR objects evs itself produced) is not
 * re-exported here: only the compiler uses it, and this barrel is part of what the compiler-free
 * runtime entry loads.
 */

export {
  blockDepthMessage,
  callOutputs,
  isAccountOp,
  isEnvOp,
  MAX_BLOCK_DEPTH,
  MAX_TUPLE_DEPTH,
} from './nodes/schema.js';
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
