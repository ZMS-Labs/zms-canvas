# Actions tier: C

| Field | Value |
|---|---|
| Tier | **C** (best effort / experimental) per ZMS-Labs/zms-homelab `docs/actions/OPERATING-MODEL.md` |
| Class | `node` |
| Gate | `.github/workflows/gate.yml` -> check context `tier-c / gate` |
| Template | `ZMS-Labs/zms-homelab/.github/workflows/tier-c-gate-node.yml@965ac8d43196924f51d7fcee389a1e63e79f614f` |
| Assigned | 2026-09-01 |
| **Review date** | **2026-12-01** |

Tier C means: one minimal gate, run only when a PR is marked ready (drafts run nothing);
no automatic work on the default branch unless the repo publishes something; deep or
security scanning is manual or monthly. The gate's policy (ready-only, concurrency with
cancellation, timeout, SHA-pinned actions, failure-only artifacts) is enforced by the
template, not by this repo; to change a command, edit `gate.yml`; to change policy, change
the template in zms-homelab and re-pin.

PR-triggered workflows this gate replaced:
- `.github/workflows/ci.yml job `check` (npm run check) -- now the gate; the file remains for the jobs below`

Workflows deliberately kept as-is:
- `.github/workflows/ci.yml job `image-publish` (push to main, ghcr publish with SBOM/provenance)`
- `.github/workflows/ci.yml job `image-build` (PR multi-arch build proof; ready PRs only, now with a timeout)`
- `.github/workflows/ci.yml job `dependency-review` (PR-only action; ready PRs only, now with a timeout)`

`image-build` and `dependency-review` are kept because neither is a shell command the
template could run (an action, and a QEMU arm64 build that would serialize the fast check
behind it). Both are now gated to ready PRs and no longer depend on the removed `check` job.
The push-to-main run no longer re-runs `npm run check`; the merged ready PR proved it.

Rulesets and required checks were NOT changed by this assignment (a separate baseline
governs those). On 2026-12-01 re-derive the tier from the registry and billing data; a repo
that becomes `supported` moves to Tier B and leaves the template.
