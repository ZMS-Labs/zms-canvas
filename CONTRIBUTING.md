# Contributing to ZMS Canvas

ZMS Canvas is a fork of [PenEcho](https://github.com/penecho/penecho). Use this repository for changes to the fork, and the PenEcho repository for changes intended for PenEcho. Read the [repository guide](docs/README.md) first, and read [Contribution licensing](#contribution-licensing) before you submit anything.

## Development Setup

1. Install Node.js 22.13 or newer, as required by `package.json`.
2. Install dependencies and link this checkout's command:

   ```bash
   npm ci
   npm link
   ```

3. Run `zms-canvas configure` and choose API, Codex CLI, or Claude CLI. Codex and Claude modes require their installed CLI to be authenticated first.
4. Run `zms-canvas` and open `http://localhost:3888`, or use this computer's LAN IP from another device on the same trusted network.

The default development configuration is the same global `~/.zms-canvas/config.env` that the `zms-canvas` command uses. For an isolated test setup, use `zms-canvas configure --config ./local.env` and `zms-canvas --config ./local.env`. Project `.env` files are not loaded automatically.

## Before Submitting Changes

Run:

```bash
npm run check
```

For browser-facing changes, verify desktop and mobile layouts and test stylus/mouse drawing, touch navigation, Manual/Auto AI delay controls, AI draft confirmation, New canvas choices, and local snapshots.

## Engineering Guidelines

- Keep server secrets out of `public/`, logs, screenshots, and test fixtures.
- Preserve the sparse tile architecture. Do not allocate a full 20k canvas bitmap.
- Keep English as the default interface and source-facing language. Add user-visible Chinese copy through the localization table.
- Do not persist unconfirmed AI drafts in local snapshots.
- Use dependencies only when their licenses explicitly permit commercial use.
- Keep changes focused and document new data formats or external services.

## Contribution licensing

[CONTRIBUTOR-LICENSE-AGREEMENT.md](CONTRIBUTOR-LICENSE-AGREEMENT.md) is PenEcho's contributor agreement. By its own terms it covers contributions submitted to the canonical PenEcho repository and grants rights to PenEcho's Project Owner, so it applies when you contribute to PenEcho, not when you open a pull request here.

Under [GitHub's terms of service](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service#6-contributions-under-repository-license), when no separate agreement applies, you license a contribution to this repository under the repository's own license, [GNU AGPL v3.0 only](LICENSE).

Do not submit code owned by an employer or another party unless you have permission to license it under those terms.

## Pull Requests

Describe the user-visible behavior, implementation approach, validation performed, and any known limitations. Avoid committing configuration files containing credentials, logs, browser test output, local agent state, or generated dependency directories.

## Visual documentation quality

Apply the [shared visual documentation standard](https://github.com/ZMS-Labs/.github/blob/main/docs/documentation-standard.md#use-visuals-to-explain)
to all new or changed visual headings, Mermaid diagrams, flowcharts, sequences,
screenshots, and charts. Verify labels, arrows, grouping, order, and status
against authoritative source; distinguish conceptual, planned, implemented, and
observed evidence. Preserve authentic product screenshots and product-local
design identity. Use generated images only for illustrative explanation, and
keep exact diagrams editable.

Inspect the rendered destination at desktop and narrow widths, with readable
labels, a text equivalent, and light/dark presentation where supported. Record
the source scope, actual semantic and render checks, and remaining limits in the
change description. Use one bounded review and recheck affected content; this
standard adds no mandatory independent-model gate. Adoption does not certify
that historical visuals have been reviewed.
