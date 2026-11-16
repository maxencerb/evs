---
'@maxencerb/vite-plugin-evs': patch
---

Requires `@maxencerb/evs` 0.7.0: the peer range moves to `^0.7.0`, so a project that keeps `@maxencerb/evs` on `^0.6.0` gets a peer conflict (`ERESOLVE` from npm) with this release. Upgrade both, or stay on 0.1.2 with `@maxencerb/evs` 0.6.0. The plugin's own code does not change. The chunk a client loads on its first `explainRevert()` grows, since it now carries what computes the keys of debug data written without them: from 8.7 to 11.4 kB minified (3.2 to 4.1 kB brotli) in `examples/vite-precompile`. The chunks a client loads up front do not change.
