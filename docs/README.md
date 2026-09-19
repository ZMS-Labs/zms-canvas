# ZMS Canvas repository guide

ZMS Canvas is a ZMS Labs fork of [PenEcho](https://github.com/penecho/penecho), a browser canvas that combines ink and spatial context with AI-assisted responses. The fork includes notebook storage and source-level adaptations described by its implementation. Upstream authorship, notices, and license files remain part of the repository.

## Current scope

The package manifest names `@zms-labs/zms-canvas`, declares version `0.1.0`, and requires Node.js `>=22.13.0`. Those are source facts, not evidence of a published npm package or a running deployment. Start from this checkout using the [README quick start](../README.md#quick-start).

AI requests use the configured executor and credentials. Configuration and saved content can be sensitive; use synthetic content when reproducing a problem and keep local configuration out of commits.

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

With dependencies installed, `npm run check` performs JavaScript syntax checks and the repository's Node test suite. This is source verification; it does not prove a configured AI service, account, or deployment is healthy. For UI changes, exercise the affected interaction with appropriate synthetic content and record what was observed.

Keep fork-specific changes and upstream contributions distinguishable. Preserve upstream notices, and update this guide when setup, storage, executor behavior, or repository status changes.
