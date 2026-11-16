## `npm install <dep>` on npm 11 skips the repo's `postinstall`: Electron is left without its binary

**Area:** build
**Trigger:** updating any dependency with `npm install` (Electron's patch for S8, a library bump), or `Error:
Electron uninstall` / a missing `node_modules/electron/dist` after an install that "succeeded".

- npm 11 gates install scripts ("install-scripts" warnings at the end of the output). The repo's own
  `postinstall` (`install-electron && tsx scripts/fetch-binaries.ts`) did not run after
  `npm install --save-dev electron@44.11.3` (2026-11-16): `package.json` and the lock said 44.11.3, but
  `node_modules/electron/dist` did not exist, so `npm run dev` and the E2E would have failed or used nothing.
- Run `npm run postinstall` by hand after any `npm install`, then check
  `node_modules/electron/dist/Electron.app/Contents/Info.plist` (`CFBundleVersion`) says the new version.
