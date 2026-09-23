# GitHub Actions tier

This page describes which automated checks run on this repository, and when.
"Tier C" is the org's name for one set of rules about when checks run and how
long they may take; [Tier C properties](#tier-c-properties) below lists them.
This repository is on Tier C, with the checks written into its own workflow
because the shared template does not apply here.

**Reviewed: 2026-09-02** · **Next review due: 2026-12-01**

2026-12-01 is when this posture must be re-checked, not a date on which
anything was verified. Everything below was established on 2026-09-02.

**These checks are advisory, not a merge gate.** Neither the ruleset nor classic
branch protection requires any status-check context on the default branch, so a
pull request can be merged while the jobs below are failing or have not run at
all. They are worth reading before merging; nothing enforces that anyone did.

## Why the shared template does not apply

The org's Tier C gate templates live in a **private** repository. `zms-canvas` is **public**,
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

- Drafts are skipped: every job carries a job-level `draft == false` condition,
  and the `pull_request` trigger lists `ready_for_review` so marking a draft
  ready starts the gate. Work in progress costs no runner minutes.
- Cancellation works differently for pull requests and for `main`. Pull-request
  runs group on `github.ref` and supersede each other. Pushes to `main` group on
  the **commit**, so each is alone in its group. Both halves matter. `image-publish` pushes a real image to GHCR, and
  `cancel-in-progress: false` would not have been enough on its own: it protects
  a *running* member of a group but not a pending one, so a third push to `main`
  would have evicted the second while it was still queued and that commit's
  `sha-<commit>` image would never have been published, leaving a deployment
  pinned to that tag with nothing to pull.
- Moving a ready PR back to draft is handled too: `converted_to_draft` is in
  the `pull_request` types. Without it, that move fires no event, so nothing enters the concurrency group to supersede the running jobs
  and they bill on to their timeouts.
- Every job declares `timeout-minutes`, so no run can go on without a limit.

## Required contexts

The `main` branch ruleset enforces deletion protection, non-fast-forward
protection, and Copilot code review. It requires **no status check contexts**,
so no job in this file has to pass before a merge. Classic branch protection
is not configured on this repository.
