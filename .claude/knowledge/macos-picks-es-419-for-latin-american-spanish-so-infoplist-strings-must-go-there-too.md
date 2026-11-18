## macOS picks `es_419` for Latin American Spanish, so `InfoPlist.strings` must go there too
**Area:** build
**Trigger:** adding or changing an `NS*UsageDescription` (`mac.extendInfo` in `package.json`) or anything else localized through `InfoPlist.strings`; a macOS permission prompt that shows in English on a Mac set to Spanish or Portuguese

- Believed: `es.lproj/InfoPlist.strings` covers every Spanish Mac. True: Electron's bundle already ships empty regional folders for Chromium's own locales (`es_419.lproj`, `pt_BR.lproj`, `pt_PT.lproj`, `en_GB.lproj`…), and `NSBundle` chooses ONE localization of the bundle for the user's languages. On a Mac set to es-AR, es-MX or es-419 it chooses `es_419`, which has no `InfoPlist.strings`, and the prompt falls back to Info.plist's English: it never looks in `es.lproj`. Only es-ES chose `es`. Portuguese has no bare `pt.lproj` to choose at all: pt-BR goes to `pt_BR`, pt-PT to `pt_PT`.
- Evidence (2026-11-17, Electron 44, a `electron-builder --mac dir` build): `NSBundle.preferredLocalizationsFromArrayForPreferences` (JXA) over the built bundle's localizations gave es-AR, es-419, es-MX → `es_419`; es-ES → `es`; pt-BR → `pt_BR`; pt-PT → `pt_PT`; it-IT → `it`; en-US and de-DE → no match, Info.plist's English.
- Rule: one `.strings` per language in `build/mac-locales/`, copied by `mac.extraResources` to EVERY folder the bundle has for that language: `es.strings` to `es.lproj` and `es_419.lproj`, `pt.strings` to `pt_BR.lproj` and `pt_PT.lproj`, `it.strings` to `it.lproj` (audit U18). English stays in `mac.extendInfo`. A new key goes into all three files and `extendInfo` at once. Check: `plutil -lint build/mac-locales/*.strings`, then a built bundle's `Contents/Resources/<lang>.lproj/InfoPlist.strings`.

**Last updated:** 2026-11-17
