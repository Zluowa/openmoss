# es-module-lexer

`es-module-lexer.js` is the unmodified `dist/lexer.minimal.asm.js` from the
already installed **es-module-lexer 3.0.3** package. It is self-contained,
works under Node and Bun, and is bundled as local server source by tsdown.
It does not require a production install of a transitive development package.

- Upstream: https://github.com/guybedford/es-module-lexer
- SHA-256: `95f6b0530ab27cb146e89bc33acfa45f606c66ee589d16469b414942fc1b4864`
- Bytes: 27,257
- License: full MIT text in `es-module-lexer.LICENSE.txt`.
- The adjacent declaration describes only the API used here. Do not hand-edit
  the upstream JavaScript. An upgrade must preserve its license and update the
  exact-byte regression and receipt.
- `moduleLexer.ts` carries the full MIT as a legal comment next to the import;
  tsdown preserves it in the chunk owning this code, not a repeated global banner.
