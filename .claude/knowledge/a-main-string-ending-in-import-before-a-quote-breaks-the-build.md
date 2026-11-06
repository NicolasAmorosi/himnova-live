## A main-process string ending in the word «import» right before a quote breaks the build
**Area:** build
**Trigger:** `npm run build` fails with `[vite:esbuild-transpile] … ERROR: Unterminated string literal` and the excerpt shows `// -- CommonJS Shims --` inside a string; or you add a main-side text (`src/main/i18n/messages/*.ts`, an error message) that ends in «import» / «Import».

- electron-vite's `vite:esm-shim` plugin (`node_modules/electron-vite/dist/chunks/lib-*.js`, `esmShimPlugin`) finds where to append its CommonJS shim by scanning the bundled main chunk with a regex for static imports, `ESMStaticImportRe`: `(?<=\s|^|;)import\s*(…from\s*)?["']…["']`. It does not parse JavaScript, so any ` import` preceded by whitespace and followed (with only whitespace between) by a quote matches — including the end of a string literal.
- 2026-11-05: the English `songs.importPickTitle: "Choose the songs to import",` followed by `importFilter: "Songs (…)"` matched from `import"` to the next string's opening quote; the shim (`import __cjs_mod__ from 'node:module'; const require = …`) was inserted INSIDE the following string, and esbuild failed on it. Typecheck, lint and Vitest all passed — only `electron-vite build` sees it, and only because main's chunk contains `require(` / `__dirname`, which is what turns the shim on.
- The cure is the wording: «Import songs» instead of «… to import». Spanish «importar», Italian «importare» and Portuguese «importar» do not match (letters follow «import»). Before adding a main-side text, avoid ending it with the bare English word «import»; if the build shows a shim inside a string, look for the last ` import"` / ` import'` in `out/main/index.js`'s source strings.

**Last updated:** 2026-11-05
