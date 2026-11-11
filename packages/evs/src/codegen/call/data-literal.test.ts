import { describe, expect, test } from 'vite-plus/test';

import { dataLiteralArgIr, type LiteralPadding } from '../../../test/harness/data-literal-ir.js';
import { compile, type CompiledEvsScript } from '../../compile.js';

// A `bytes` / `string` const image may stop at its declared length or be padded part of the way
// (hand-written / deserialized IR); as a call argument it must encode exactly like the builder's
// fully padded image, in the calldata template and in the recursive encoder's staging block.
describe('unpadded data literals as call arguments', () => {
  describe.each(['bytes', 'string'] as const)('%s', (kind) => {
    describe.each(['flat', 'recursive'] as const)('%s calldata path', (path) => {
      test.each([false, true])('optimize: %s → byte-identical to the padded image', (optimize) => {
        const bytecodeOf = (padding: LiteralPadding): string => {
          const out: CompiledEvsScript = compile(dataLiteralArgIr(kind, path, padding), {
            optimize,
          });
          return out.runtimeBytecode;
        };
        const full = bytecodeOf('full');
        expect(bytecodeOf('exact')).toBe(full);
        expect(bytecodeOf('partial')).toBe(full);
      });
    });
  });
});
