# ZMS Canvas repository guide

ZMS Canvas is my fork of [PenEcho](https://github.com/penecho/penecho), a browser canvas where you write or sketch a problem and an AI model answers beside your marks. The fork adds synchronized notebooks that keep pending edits until the server confirms a save, and keep a separate copy when two versions conflict. It also has security fixes for three problems (a text pattern that crafted input could slow down badly, file checks that could race with changes to the file, and an optional debug file that an unusually large model response could fill, which is now capped), plus its own CI and a container build. PenEcho's authorship, notices and license files remain part of the repository.

## Current scope

The package is named `@zms-labs/zms-canvas` and needs Node.js 22.13 or newer. It is not published to npm, so start from this checkout using the [README quick start](../README.md#quick-start).

AI requests use the configured executor and credentials. Configuration and saved content can be sensitive; use made-up content when reproducing a problem and keep local configuration out of commits.

## Reading paths

| Task | Source |
|---|---|
| Install from source and configure an executor | [README](../README.md) |
| Understand the browser/server boundary and response flow | [Architecture](architecture.md) |
| Find CLI commands and config-file handling | [CLI source](../cli.js) |
| Understand notebook persistence | [Notebook API](../notebook-api.js) and [store](../notebook-store.js) |
| Change and verify the fork | [Contributing](../CONTRIBUTING.md) and [package scripts](../package.json) |
| Understand hosted CI coverage | [Actions guide](actions-tier.md) |
| Check license and attribution | [License](../LICENSE), [notice](../NOTICE), and [trademarks](../TRADEMARKS.md) |

## Verify a change

With dependencies installed, `npm run check` performs JavaScript syntax checks and the repository's Node test suite. This is source verification; it does not prove a configured AI service, account, or deployment is healthy. For UI changes, exercise the affected interaction with made-up content and record what was observed.

Keep fork-specific changes and upstream contributions distinguishable. Preserve upstream notices, and update this guide when setup, storage, executor behavior, or repository status changes.
