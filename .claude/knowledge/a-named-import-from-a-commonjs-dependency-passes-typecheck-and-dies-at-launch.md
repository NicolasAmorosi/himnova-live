## A named import from a CommonJS dependency can pass every check and kill the app at launch
**Area:** build
**Trigger:** adding a dependency to main, or changing an import from one, especially a CommonJS package; the app dying at startup with `SyntaxError: Named export '…' not found`

- Main is emitted as ESM (`"type": "module"`, `out/main/index.js`), and `externalizeDepsPlugin`
  leaves `dependencies` out of the bundle (all but `drizzle-orm`, bundled since 2026-11-16 because
  resolving it as an external ESM package cost ~120 ms of main at each launch). So Node itself
  resolves `import { x } from "pkg"` at launch. For a CommonJS package, it only knows the names that `cjs-module-lexer` can find by
  reading the source.
- `import { autoUpdater } from "electron-updater"` passes `typecheck`, because the `.d.ts` declares
  it, and `lint` and `build` pass too. At launch it fails with
  `SyntaxError: Named export 'autoUpdater' not found. The requested module 'electron-updater' is a CommonJS module, which may not support all module.exports as named exports.`
  The reason: `out/main.js` defines it with
  `Object.defineProperty(exports, "autoUpdater", { enumerable: true, get: () => { … } })`, and the
  lexer skips a getter with a block body. In the same file it does detect `BaseUpdater`,
  `NsisUpdater` and the rest, which are TypeScript's re-export getters. So a named import "working"
  for one name proves nothing about another.
- The fix is a default import plus a property read:
  `import electronUpdater from "electron-updater"; electronUpdater.autoUpdater`. Type-only names can
  still be imported by name, since they are erased.
- How to check before trusting a named import from a package: from the app folder,
  `node --input-type=module -e "import * as m from 'pkg'; console.log(Object.keys(m))"` lists
  exactly what Node will accept. Nothing in the minimum bar runs main's real module graph. Vitest
  interops leniently and never imports `electron`, so only starting the app catches it:
  `npm run dev`, the E2E suite, or a package.

**Last updated:** 2026-11-16 (drizzle-orm bundled)
