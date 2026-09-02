# GitHub Actions tier

**Tier: C** — in-repo checks (shared template does not apply)
**Reviewed: 2026-09-02** · **Next review due: 2026-12-01**

2026-12-01 is when this posture must be re-checked, not a date on which
anything was verified. Everything below was established on 2026-09-02.

**These checks are advisory, not a merge gate.** Neither the ruleset nor classic
branch protection requires any status-check context on the default branch, so a
pull request can be merged while the jobs below are failing or have not run at
all. They are worth reading before merging; nothing enforces that anyone did.

## Why the shared template does not apply

The org's Tier C gate templates live in the **private** `ZMS-Labs/zms-homelab`
repository (`.github/workflows/tier-c-gate-*.yml`). `zms-canvas` is **public**,
and GitHub does not permit a public repository to call a reusable workflow that
lives in a private one. The template cannot be referenced from here at all, so
the Tier C *shape* is implemented directly in this repo's own workflow instead.

## What the gate runs

`.github/workflows/ci.yml` (workflow name `CI`):

| Job | Runs on | Trigger | Timeout | What it proves |
| --- | --- | --- | --- | --- |
| `check` | `ubuntu-latest`, Node 22.13.0 | ready PRs + push to `main` | 15 min | `npm ci` then `npm run check` |
| `dependency-review` | `ubuntu-latest` | ready PRs only | 10 min | no newly-introduced vulnerable or disallowed dependencies |
| `image-build` | `ubuntu-latest` | ready PRs only, after `check` | 30 min | the container builds for `linux/amd64` and `linux/arm64` (no push) |
| `image-publish` | `ubuntu-latest` | push to `main` only, after `check` | 30 min | builds and pushes `ghcr.io/zms-labs/zms-canvas` with SBOM and max provenance |

## Tier C properties

- **Draft-gated.** Every job carries a job-level `draft == false` condition, and
  the `pull_request` trigger lists `ready_for_review` so marking a draft ready
  starts the gate. Work in progress costs no runner minutes.
- **Cancellation.** Workflow-level `concurrency` groups on `github.ref` and
  cancels superseded runs — but `cancel-in-progress` is the expression
  `github.event_name == 'pull_request'`, so a push-to-`main` run is never
  cancelled. `image-publish` pushes a real image to GHCR; interrupting it is not
  a saved minute, it is a half-published release.
- **Bounded.** Every job declares `timeout-minutes`.

## Required contexts

The `main` branch ruleset enforces deletion protection, non-fast-forward
protection, and Copilot code review. It requires **no status check contexts**,
so no job name in this file is load-bearing for merge. Classic branch protection
is not configured on this repository.
