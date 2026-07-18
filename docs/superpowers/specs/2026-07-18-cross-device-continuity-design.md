# ZMS Canvas Cross-Device Continuity Design

**Status:** Approved for implementation on 2026-07-18  
**Product:** ZMS Canvas, a distinct public application based on PenEcho  
**Repository:** `ZMS-Labs/zms-canvas`  
**Deployment:** Private ZMS homelab service behind Authentik

## Objective

Make a confirmed canvas opened on one connected Apple device available as the same fully editable notebook on another connected device. A restored notebook must reproduce its confirmed sparse canvas tiles, selected theme, and viewport and allow continued drawing, erasing, selection, and AI interaction.

For this release, “fully editable” does not mean vector stroke replay. PenEcho persists confirmed raster tiles; undo/redo history and unconfirmed AI drafts remain session-local and are excluded from saved revisions.

## Scope

This release includes:

- server-authoritative notebooks shared across connected devices;
- debounced autosave with an explicit `Saving`, `Saved`, `Offline`, or `Conflict copy` state;
- immutable, recoverable notebook revisions;
- optimistic revision checks that prevent silent lost updates;
- an Authentik-derived owner boundary;
- local IndexedDB recovery for work not yet acknowledged by the server;
- preservation and explicit import of existing device-local snapshots;
- a persistent SQLite database on the k3s deployment;
- a public container image build from this application repository; and
- a visible link to corresponding source.

This release does not include disconnected editing followed by later multi-device merge, simultaneous collaborative editing, CRDTs, Supernote import, model-profile switching, or multi-user administration and sharing. Supernote import is the next product increment. Visible local/cloud model switching follows it.

## Repository and Identity Boundary

`ZMS-Labs/penecho-runtime` remains the stable deployment wrapper until ZMS Canvas passes tests and a live workflow exercise. ZMS Canvas owns the modified application source, tests, container definition, and releases. After GitOps is cut over, the wrapper repository is archived rather than maintained as a second source for package and container truth.

ZMS Canvas remains `AGPL-3.0-only`, preserves upstream copyright and attribution, records material modifications, and describes itself factually as based on PenEcho. It uses a distinct name and visual identity because PenEcho's trademark policy does not grant branding rights for modified public builds.

Notebook content, SQLite files, backups, credentials, Authentik configuration, model endpoints, and homelab topology are never committed to the public repository.

## Architecture

The server is the single source of truth for synchronized notebooks. IndexedDB becomes a recovery cache and legacy-snapshot store, not a peer replica.

The client requires read-your-writes, monotonic reads, and monotonic writes session guarantees. The server provides them through one SQLite transaction per mutation and optimistic compare-and-swap on `current_revision`. There is one application replica and one persistent database; no distributed consensus or CRDT is required.

### Components

1. `notebook-store.js` owns schema creation, persistence operations, revision transactions, retention, and restore behavior.
2. `notebook-api.js` owns HTTP routing, owner extraction, request validation, body limits, and response mapping.
3. `server.js` composes the notebook API with the existing server and advertises notebook capability through `/api/config` and `/api/config.js`.
4. `public/notebooks.js` owns client requests, serialization, autosave state, conflict-copy recovery, and IndexedDB recovery records.
5. `public/app.js` exposes sparse-tile and notebook lifecycle integration points without restructuring the drawing engine.
6. The existing history panel presents synchronized notebooks, recent revisions, legacy device snapshots, rename, restore, and delete actions.

## Runtime Configuration

- `PENECHO_NOTEBOOKS_ENABLED=true` enables synchronized notebooks.
- `PENECHO_NOTEBOOKS_DB=/state/notebooks.sqlite` selects the database path.
- `PENECHO_NOTEBOOKS_OWNER_HEADER=x-authentik-uid` selects the trusted identity header.
- When notebooks are enabled and the trusted header is missing, notebook endpoints return `401`.
- Notebook endpoints remain under `/api/notebooks`; the deployment permits ingress only from Traefik, and Authentik supplies the trusted header.
- The application requires Node.js `>=22.5.0` so it can use the built-in `node:sqlite` module without a native npm addon.

Notebook support is disabled by default for generic local launches so the upstream local-snapshot experience remains usable without an identity proxy or database.

## Data Model

### `notebooks`

- `id TEXT PRIMARY KEY`
- `owner_id TEXT NOT NULL`
- `title TEXT NOT NULL`
- `current_revision INTEGER NOT NULL`
- `created_at INTEGER NOT NULL`
- `updated_at INTEGER NOT NULL`
- `UNIQUE(owner_id, id)`

### `notebook_revisions`

- `notebook_id TEXT NOT NULL`
- `revision INTEGER NOT NULL`
- `created_at INTEGER NOT NULL`
- `theme TEXT NOT NULL`
- `view_scale REAL NOT NULL`
- `view_pan_x REAL NOT NULL`
- `view_pan_y REAL NOT NULL`
- `preview_png BLOB NOT NULL`
- `tile_count INTEGER NOT NULL`
- `PRIMARY KEY(notebook_id, revision)`
- foreign key to `notebooks(id)` with cascade deletion

### `revision_tiles`

- `notebook_id TEXT NOT NULL`
- `revision INTEGER NOT NULL`
- `tile_key TEXT NOT NULL`
- `png BLOB NOT NULL`
- `PRIMARY KEY(notebook_id, revision, tile_key)`
- composite foreign key to `notebook_revisions(notebook_id, revision)` with cascade deletion

The key constraints make duplicate notebook revisions and duplicate tile keys within a revision unrepresentable. Every save transaction inserts revision metadata and its complete sparse tile set before advancing `notebooks.current_revision`, so no current revision can point at a partial manifest.

The latest 50 revisions per notebook are retained. Pruning occurs inside the save transaction after the new current revision is established. Restoring an older revision creates a new revision containing the selected state; it never rewrites history or moves `current_revision` backward.

## HTTP Contract

All responses use JSON. PNG blobs use strict base64 encoding. Notebook request bodies have an independent 64 MiB limit, a maximum of 1,600 sparse tiles, and validated tile keys matching the `tx,ty` grid form within the 20,000-unit canvas.

- `GET /api/notebooks` returns owner-scoped notebook summaries ordered by `updatedAt` descending.
- `POST /api/notebooks` creates a notebook at revision `1` from a complete canvas payload.
- `GET /api/notebooks/:id` returns the current complete notebook revision.
- `PUT /api/notebooks/:id` accepts `baseRevision`, title, theme, view, preview, and the complete current sparse tile set and returns the new revision.
- `GET /api/notebooks/:id/revisions` returns retained revision summaries.
- `POST /api/notebooks/:id/restore` accepts `baseRevision` and `restoreRevision` and creates a new current revision.
- `DELETE /api/notebooks/:id` deletes the owner-scoped notebook and revisions after client confirmation.

Unknown notebooks return `404` regardless of whether another owner has an object with that identifier. Invalid payloads return `400`; oversized payloads return `413`; missing trusted identity returns `401`; stale `baseRevision` returns `409` with the current revision summary.

## Client Save and Recovery Semantics

The first confirmed mutation of a new canvas creates an untitled synchronized notebook. Later confirmed mutations schedule a save after two seconds without another confirmed mutation. Navigating away or hiding the page triggers a best-effort immediate save when possible.

Only one save may be in flight. If the canvas changes during a save, the client schedules another save after the acknowledged revision arrives. The visible state distinguishes unsaved local changes from an acknowledged server revision.

Before sending, the client writes the complete pending payload to a dedicated IndexedDB recovery record. It removes that record only after the server acknowledges the new revision. On startup, an unapplied recovery record is offered as a recovery copy; it is never silently substituted for a newer server revision.

If a save receives `409`, the client creates a new notebook named `<title> — conflict copy <timestamp>` from the unsaved complete state. The original server notebook is left unchanged. This converts a lost-update anomaly into two explicit recoverable histories.

Existing local snapshots remain visible under `On this device`. The user can copy one into synchronized notebooks; the legacy record is retained until explicitly deleted.

## UI Contract

- The history panel title becomes `Notebooks` when server notebooks are enabled.
- A synchronized section lists notebook preview, title, last-updated time, current revision, and load action.
- The loaded notebook is visually identified.
- A persistent status near the toolbar reports `Saving…`, `Saved`, `Save failed`, or `Conflict copy saved`.
- Recent revisions are reachable from each notebook and can be restored with confirmation.
- Device-local snapshots are clearly labeled and never represented as synchronized.
- The About/source surface names ZMS Canvas, says it is based on PenEcho, and links to `https://github.com/ZMS-Labs/zms-canvas`.

## Security and Privacy

- The browser cannot submit an owner identifier; the server derives ownership only from the configured trusted request header.
- Every query predicates on `owner_id` even though the initial deployment has one user.
- IDs are server-generated UUIDs.
- Titles are plain text, trimmed, and limited to 80 Unicode code points.
- SQLite parameters are bound; no values are interpolated into SQL.
- PNG data is signature-checked, base64-validated, and bounded before storage.
- Notebook endpoints use `Cache-Control: no-store`.
- Notebook contents and titles are not written to application logs.
- The deployment mounts the database volume read-write only into the application pod.

## Failure Handling

- Database initialization failure prevents notebook-enabled startup rather than silently falling back to local-only storage.
- Transaction failure rolls back without advancing `current_revision`.
- Save network failure leaves the IndexedDB recovery record intact and shows `Save failed`; this connected-first release does not claim synchronization while unreachable.
- A failed notebook load does not clear the current canvas.
- A malformed stored PNG fails the requested load and leaves the current canvas untouched.

## Deployment and Cutover

The application repository builds a multi-architecture OCI image for `linux/amd64` and `linux/arm64`, publishes SBOM and provenance attestations, and carries AGPL/source labels. GitOps pins the verified digest, enables notebooks, mounts a dedicated persistent volume at `/state`, and retains the existing Authentik and NetworkPolicy boundary.

Cutover requires unit and integration tests, a successful multi-architecture image build, a temporary deployment exercise, an iPad save followed by an iPhone or desktop load, a stale-revision exercise proving neither device is overwritten, and database backup/restore evidence.

Only after those checks does GitOps replace the `penecho-runtime` image digest. The runtime repository is archived after the live deployment remains healthy.

## Testing Strategy

- Store tests use temporary SQLite databases and assert owner scoping, atomic revision creation, retention, restore-as-new-revision, deletion, and stale revision rejection.
- API tests exercise identity absence, cross-owner non-disclosure, validation limits, malformed PNG rejection, body limits, and `409` responses.
- Client tests exercise autosave coalescing, in-flight mutation handling, recovery-record lifecycle, conflict-copy creation, and load-before-clear behavior.
- Existing server-security, drawing, selection, CLI, and UI tests remain green.
- Deployment tests verify non-root execution, writable persistent state, immutable image references, and source/license labels.

## Success Criteria

The release is complete only when a confirmed canvas saved on one authenticated connected device can be opened and continued on another, the prior revision can be restored without destroying newer history, and a stale second-device save produces a conflict copy rather than a lost update.
