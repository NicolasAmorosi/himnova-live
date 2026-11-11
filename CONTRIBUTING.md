# Contributing to Himnova Live

Thanks for wanting to help. Himnova Live runs in live services, so the priority is that nothing
breaks in front of the congregation: we prefer a small, tested change over a big, ambitious one.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Reporting a bug

Open an [issue](https://github.com/NicolasAmorosi/himnova-live/issues/new/choose) with the version,
the operating system and, if you can, the file that failed and the logs (Settings › About › Open
logs folder). Security problems go privately, see [`SECURITY.md`](SECURITY.md).

## Before writing code

- For anything bigger than a targeted fix, open an issue first so we can talk it through.
- Read [`CLAUDE.md`](CLAUDE.md). Although it is written for Claude Code, it is the project guide:
  the architecture, the conventions that aren't negotiable and the reason behind each one.
  [`docs/knowledge/`](docs/knowledge/) has the detail per layer, and
  [`.claude/knowledge/`](.claude/knowledge/INDEX.md) the findings that were hard to discover.

## Conventions

- Everything in the repo is in **English**: code, comments, names, documentation and commit
  messages.
- No interface text is written inside a component: it all goes through `useT()` and
  `src/renderer/src/lib/i18n/`. A new string goes into the four dictionaries (`es`, `en`, `it`,
  `pt`) in the same change; if you don't speak one of those languages, say so in the PR. `es` is the
  reference dictionary: the other three are typed against it, so a missing key doesn't compile.
- No hand-written color, shadow or radius: use the primitives in `components/ui/` and the tokens in
  `styles/globals.css`.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org/) (`fix(bible): …`).
- The project doesn't use Prettier: keep the formatting of the file you touch.

## Before opening the PR

```bash
npm run typecheck && npm run lint && npm run test
```

If the change touches what gets projected, the keyboard or playback, also run `npm run test:e2e`.
The E2E suite starts the app in Spanish on purpose (`--lang=es`), so its locators are the Spanish
UI strings from `es.ts`. Say in the PR how you tested it.

## License

By contributing, you agree that your work is published under the project's license,
[GPL-3.0-or-later](LICENSE).
