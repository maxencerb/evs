# @maxencerb/vite-plugin-evs

The Vite plugin for [evs](https://evs.maxencerb.com). It compiles your `*.evs.ts` modules during
the build, so the client bundle holds each script's bytecode and ABI and not the evs compiler.

The same file works without the plugin, with the same bytecode and the same types: the plugin
only moves the compilation from the browser to the build.

## Install

```sh
npm install -D @maxencerb/vite-plugin-evs
```

Requires `vite` ≥ 8 and `@maxencerb/evs`, both as peers. ESM only.

## Usage

Add the plugin to your Vite config.

```ts
// vite.config.ts
import { evs } from '@maxencerb/vite-plugin-evs';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [evs()],
});
```

Put your scripts in a file that ends in `.evs.ts`, and export each one precompiled. The plugin
runs this file in Node at build time.

```ts
// src/pool.evs.ts
import { evscript, t } from '@maxencerb/evs';
import { erc20Abi, parseAbi } from 'viem';

const poolAbi = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
]);

export const poolTokens = evscript({ name: 'poolTokens', args: [t.address] }, (s, pool) => {
  const token0 = s.read({ address: pool, abi: poolAbi, functionName: 'token0' });
  const token1 = s.read({ address: pool, abi: poolAbi, functionName: 'token1' });
  const symbol0 = s.read({ address: token0, abi: erc20Abi, functionName: 'symbol' });
  const symbol1 = s.read({ address: token1, abi: erc20Abi, functionName: 'symbol' });
  return s.return({ token0, token1, symbol0, symbol1 });
})
  .compile()
  .toPrecompiled();
```

Import the script where you call it. Take run-time helpers from `@maxencerb/evs/runtime`, the
entry without the compiler.

```ts
// src/main.ts
import { decodeScriptError } from '@maxencerb/evs/runtime';
import { createClient, http } from 'viem';
import { readContract } from 'viem/actions';
import { mainnet } from 'viem/chains';

import { poolTokens } from './pool.evs.ts';

const client = createClient({ chain: mainnet, transport: http() });

try {
  const { symbol0, symbol1 } = await readContract(client, {
    ...poolTokens.toViem(),
    functionName: 'poolTokens',
    args: ['0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'],
  });
  console.log(symbol0, symbol1);
} catch (error) {
  console.error(decodeScriptError(poolTokens, error) ?? error);
}
```

If another module still compiles a script at run time, the compiler ends up in the bundle
anyway. The build then warns, and names the chunk that holds it and the module that imports it.

## Documentation

The [precompiling guide](https://evs.maxencerb.com/guides/precompiling/) covers what a
`*.evs.ts` module may export, the `compilerInBundle` option, the dev server and
`explainRevert()` on a precompiled script.

## License

MIT
