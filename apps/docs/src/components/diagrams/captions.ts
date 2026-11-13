// One-sentence text alternative per diagram. It is the visible `<figcaption>`, and it is all
// that survives in the Markdown outputs (/llms.txt, /llms-full.txt, the per-page `.md` files),
// which drop the animated stage: write each as a complete statement of the mechanism.
export const captions = {
  RoundTrips:
    'Reads that depend on earlier reads cost one RPC round trip per dependency level with a multicall; an evs script runs all of them inside one eth_call.',
  Pipeline:
    'The builder callback is recorded into an IR, compiled to runtime bytecode, executed as one eth_call, and decoded by viem into a typed object.',
  BuildVsRun:
    'The callback runs once at build time and only records statements; the recorded program is what runs on-chain, so a native JavaScript if never branches on a chain value.',
  CallVerbs:
    's.read is a STATICCALL that cannot write, s.call is a CALL whose write stays visible to later calls, and s.simulate is a CALL whose write is rolled back while its return value is kept.',
  ExecutionModes:
    'In deployless mode the code travels inside the call and a wrapper creates and calls the script, so msg.sender is the wrapper and address(this) is a counterfactual address; in state-override mode the code is placed at a fixed address (a default, or one you choose) and msg.sender is the account you pass.',
  RevertBubbling:
    'A callee revert bubbles through a strict verb unchanged and fails the whole eth_call; a try verb catches it and returns success = false with a zero value.',
  CellSnapshots:
    'A Cell is mutable state written with set(); get() returns an Expr, an immutable snapshot that keeps its value when the cell is set again.',
  CompilePasses:
    'compile() reads the program several times, in three forms: it validates the IR and drops its dead statements, lowers what is left to instructions, assembles them into bytecode and verifies the bytes; optimize: true adds the fuse and peephole passes over the instructions.',
  OnceVsEveryCall:
    'Importing the library, recording a script and compiling it happen once: about 13 ms, 2 ms and 4 ms in a fresh Node process on the benchmark machine. Every call after that encodes the arguments with the bytecode, makes one eth_call round trip and decodes the result, for about 0.015 ms of CPU.',
  LoopCollect:
    's.for walks a runtime array, makes one call per element and writes each result into an s.newArray buffer that is returned at the end.',
} as const;

export type DiagramName = keyof typeof captions;
