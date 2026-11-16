/**
 * What a node, a wallet or a proxy answers to an `eth_call`, and what the error decoders
 * (`decodeScriptError` / `matchScriptError`) have to make of the error viem builds from it.
 *
 * The table is data plus a mock JSON-RPC server, and imports neither viem nor the library: the
 * unit tests (`src/viem.test.ts`) run it through the workspace's viem, and the peer-floor check
 * (`packages/viem-floor`) through the oldest viem the peer range admits. Both call viem's own
 * `readContract` over HTTP, so the decoders read the error objects viem really throws.
 *
 * Plain Node runs this file (type stripping): erasable syntax only.
 */

import { createServer, type Server } from 'node:http';

/** The script both consumers declare: `guard(uint256, uint256)` with `Boom(uint256 code, address who)`. */
export const BOOM_ARGS = { code: 42n, who: '0x000000000000000000000000000000000000dEaD' } as const;

/** `Boom(42, 0x…dEaD)` ABI-encoded: selector `0x0caa8b81`, then the two words. */
export const BOOM_DATA =
  '0x0caa8b81000000000000000000000000000000000000000000000000000000000000002a000000000000000000000000000000000000000000000000000000000000dead';

/** `Panic(0x11)`. */
export const PANIC_DATA =
  '0x4e487b710000000000000000000000000000000000000000000000000000000000000011';

/** `Error("ERC20: transfer amount exceeds balance")`, as a callee bubbles it. */
export const ERROR_STRING_DATA =
  '0x08c379a00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000002645524332303a207472616e7366657220616d6f756e7420657863656564732062616c616e63650000000000000000000000000000000000000000000000000000';

/** A custom error of a callee, absent from the script ABI. */
export const FOREIGN_ERROR_DATA = '0xdeadbeef';

/** A JSON-RPC error object, as it sits in the HTTP body. */
export interface RpcErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

/** One answer of the mock server to an `eth_call`. */
export type RpcAnswer =
  | { readonly error: RpcErrorObject }
  | { readonly result: string }
  | { readonly http: number; readonly body: string }
  | { readonly hang: true };

/**
 * What the decoders return: the `name` of the decoded revert, or `'not a revert'` when
 * `decodeScriptError` returns `undefined` and `matchScriptError` rethrows the caught error.
 */
export type Outcome = 'Boom' | 'Panic' | 'Error' | 'unknown' | 'empty' | 'not a revert';

export interface RpcErrorShape {
  /** What answers this way. */
  readonly name: string;
  readonly answer: RpcAnswer;
  readonly expected: Outcome;
  /**
   * The outcome under a viem whose `ContractFunctionRevertedError` has no `cause` (before
   * 2.47.5), when it differs: the RPC error is then out of the decoders' reach, and only what
   * viem copied onto that error (`raw`, `reason`) is left.
   */
  readonly expectedWithoutCause?: Outcome;
}

const REVERTED = 'execution reverted';

export const RPC_ERROR_SHAPES: readonly RpcErrorShape[] = [
  // --- reverts ---------------------------------------------------------------------------
  {
    name: 'code 3 with the revert data (geth, reth, anvil, nitro, bor, Nethermind)',
    answer: { error: { code: 3, message: REVERTED, data: BOOM_DATA } },
    expected: 'Boom',
  },
  {
    name: 'code 3, the data repeated in the message (BNB)',
    answer: { error: { code: 3, message: `${REVERTED}: ${BOOM_DATA}`, data: BOOM_DATA } },
    expected: 'Boom',
  },
  {
    name: 'code 3 with a Panic',
    answer: {
      error: {
        code: 3,
        message: `${REVERTED}: arithmetic underflow or overflow`,
        data: PANIC_DATA,
      },
    },
    expected: 'Panic',
  },
  {
    name: 'code 3 with the Error(string) of a callee',
    answer: {
      error: {
        code: 3,
        message: `${REVERTED}: ERC20: transfer amount exceeds balance`,
        data: ERROR_STRING_DATA,
      },
    },
    expected: 'Error',
  },
  {
    name: 'code 3 with a selector the script ABI does not declare',
    answer: { error: { code: 3, message: REVERTED, data: FOREIGN_ERROR_DATA } },
    expected: 'unknown',
  },
  {
    name: 'empty revert: code 3 with data "0x" (geth, reth, zkSync)',
    answer: { error: { code: 3, message: REVERTED, data: '0x' } },
    expected: 'empty',
  },
  {
    name: 'empty revert: code 3 without a data field',
    answer: { error: { code: 3, message: REVERTED } },
    expected: 'empty',
  },
  {
    name: 'empty revert: code -32000 without a data field (Scroll, Sonic)',
    answer: { error: { code: -32000, message: REVERTED } },
    expected: 'empty',
  },
  {
    name: 'code -32000 with the revert data (nodes that predate code 3)',
    answer: { error: { code: -32000, message: REVERTED, data: BOOM_DATA } },
    expected: 'Boom',
  },
  {
    name: 'internal error wrapping the node error: data { code: 3, data } (wallets)',
    answer: {
      error: {
        code: -32603,
        message: 'Internal JSON-RPC error.',
        data: { code: 3, message: REVERTED, data: BOOM_DATA },
      },
    },
    expected: 'Boom',
  },
  {
    name: 'internal error wrapping the revert: data { message, data } (Hardhat)',
    answer: {
      error: {
        code: -32603,
        message:
          'Error: VM Exception while processing transaction: reverted with custom error \'Boom(42, "0x000000000000000000000000000000000000dEaD")\'',
        data: {
          message:
            'Error: VM Exception while processing transaction: reverted with custom error \'Boom(42, "0x000000000000000000000000000000000000dEaD")\'',
          data: BOOM_DATA,
        },
      },
    },
    expected: 'Boom',
  },
  {
    name: 'internal error wrapping the node error: data.originalError (wallets, some RPCs)',
    answer: {
      error: {
        code: -32603,
        message: 'Internal JSON-RPC error.',
        data: { originalError: { code: 3, data: BOOM_DATA, message: REVERTED } },
      },
    },
    expected: 'Boom',
    expectedWithoutCause: 'not a revert',
  },
  {
    name: 'internal error wrapping an empty revert: data { code: 3 } without data',
    answer: {
      error: {
        code: -32603,
        message: 'Internal JSON-RPC error.',
        data: { code: 3, message: REVERTED },
      },
    },
    expected: 'empty',
    expectedWithoutCause: 'not a revert',
  },
  {
    name: 'data "Reverted 0x…" (OpenEthereum, older Nethermind)',
    answer: {
      error: { code: -32015, message: 'VM execution error.', data: `Reverted ${BOOM_DATA}` },
    },
    expected: 'Boom',
  },
  {
    // a message is prose and every node words it differently: the revert is recognized, the
    // bytes are not read out of it
    name: 'revert data only in the message',
    answer: { error: { code: -32000, message: `${REVERTED}: ${BOOM_DATA}` } },
    expected: 'empty',
  },
  // --- not reverts -----------------------------------------------------------------------
  {
    name: 'internal error "Internal error"',
    answer: { error: { code: -32603, message: 'Internal error' } },
    expected: 'not a revert',
  },
  {
    name: 'internal error "Remote Error"',
    answer: { error: { code: -32603, message: 'Remote Error' } },
    expected: 'not a revert',
  },
  {
    name: 'upstream timeout reported as an internal error',
    answer: { error: { code: -32603, message: 'upstream request timeout' } },
    expected: 'not a revert',
  },
  {
    name: 'out of gas reported as an internal error (Monad)',
    answer: { error: { code: -32603, message: 'out of gas' } },
    expected: 'not a revert',
  },
  {
    name: 'out of gas, code -32000 (geth)',
    answer: { error: { code: -32000, message: 'out of gas' } },
    expected: 'not a revert',
  },
  {
    name: 'out of gas, code -32003 (reth, anvil)',
    answer: {
      error: {
        code: -32003,
        message: 'out of gas: gas exhausted during memory expansion: 300000',
      },
    },
    expected: 'not a revert',
  },
  {
    name: 'out of gas, code 0 with data "0x" (Avalanche)',
    answer: { error: { code: 0, message: 'out of gas', data: '0x' } },
    expected: 'not a revert',
  },
  {
    name: 'rejected creation, the code in data: over the size cap (Avalanche)',
    answer: {
      error: { code: 0, message: 'max code size exceeded', data: `0x${'00'.repeat(96)}` },
    },
    expected: 'not a revert',
  },
  {
    name: 'rejected creation, the code in data: starts with 0xEF (Avalanche)',
    answer: {
      error: {
        code: 0,
        message: 'invalid code: must not begin with 0xef',
        data: `0xef${'00'.repeat(31)}`,
      },
    },
    expected: 'not a revert',
  },
  {
    name: 'rate limit as a JSON-RPC error, code 429',
    answer: { error: { code: 429, message: 'Too Many Requests' } },
    expected: 'not a revert',
  },
  {
    name: 'rate limit, code -32005',
    answer: { error: { code: -32005, message: 'rate limit exceeded' } },
    expected: 'not a revert',
  },
  {
    name: 'refused method with a JSON string in data',
    answer: {
      error: {
        code: -32012,
        message: 'Method "eth_call" is not available for unregistered accounts.',
        data: '{"traceId":"1a1e43380ce5eba1"}',
      },
    },
    expected: 'not a revert',
  },
  {
    name: 'HTTP 429 with a text body',
    answer: { http: 429, body: 'Too Many Requests' },
    expected: 'not a revert',
  },
  {
    name: 'HTTP 503 with an HTML body',
    answer: { http: 503, body: '<html>Service Unavailable</html>' },
    expected: 'not a revert',
  },
  {
    name: 'no answer (the transport times out)',
    answer: { hang: true },
    expected: 'not a revert',
  },
  {
    name: 'result "0x" (the state override was ignored)',
    answer: { result: '0x' },
    expected: 'not a revert',
  },
  {
    name: 'a result that does not fit the ABI',
    answer: { result: '0x1234' },
    expected: 'not a revert',
  },
];

/** A local JSON-RPC endpoint that gives every request the answer last set with `answer()`. */
export interface MockRpc {
  readonly url: string;
  answer(next: RpcAnswer): void;
  close(): Promise<void>;
}

/** Starts the mock endpoint on a free loopback port. */
export async function startMockRpc(): Promise<MockRpc> {
  let current: RpcAnswer = { result: '0x' };
  const server: Server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on('end', () => {
      const answer = current;
      if ('hang' in answer) return;
      if ('http' in answer) {
        response.writeHead(answer.http, { 'content-type': 'text/plain' });
        response.end(answer.body);
        return;
      }
      const parsed: unknown = JSON.parse(body);
      const id = typeof parsed === 'object' && parsed !== null && 'id' in parsed ? parsed.id : null;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id, ...answer }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) {
    throw new Error('mock RPC: the server has no port');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    answer(next) {
      current = next;
    },
    async close() {
      // the unanswered requests of the `hang` answer keep their sockets open
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
