# ZMS Canvas Cross-Device Continuity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a distinctly branded, server-authoritative ZMS Canvas application whose confirmed notebooks autosave to SQLite and reopen safely across connected devices.

**Architecture:** A focused SQLite store owns immutable notebook revisions, a separate HTTP adapter owns identity and validation, and a testable browser sync controller owns autosave and conflict-copy behavior. Existing sparse canvas tiles remain the serialized content format, while IndexedDB is retained for recovery and legacy local snapshots.

**Tech Stack:** Node.js 22.5+, `node:sqlite`, Node test runner, browser IndexedDB/fetch, OCI/Docker, GitHub Actions.

## Global Constraints

- Product and package identity is `ZMS Canvas`; modified builds must not present themselves as official PenEcho releases.
- License remains `AGPL-3.0-only`; preserve upstream notices and provide a visible corresponding-source link.
- Notebook support is disabled by default and enabled with `PENECHO_NOTEBOOKS_ENABLED=true`.
- The server derives ownership only from `PENECHO_NOTEBOOKS_OWNER_HEADER`, defaulting to `x-authentik-uid`; clients never submit owner IDs.
- One SQLite database at `PENECHO_NOTEBOOKS_DB`, defaulting to `<PENECHO_STATE_DIR>/notebooks.sqlite`, is the notebook source of truth.
- Connected editing only; no CRDT, offline merge, collaboration, Supernote import, or model-profile switching.
- Retain 50 immutable revisions per notebook; restoring creates a new revision.
- Notebook JSON is limited to 64 MiB, 1,600 tiles, valid in-canvas tile keys, and PNG payloads.
- Existing PenEcho tests and behavior remain intact when notebooks are disabled.

---

### Task 1: Establish distinct product and runtime identity

**Files:**
- Create: `test/product-identity.test.js`
- Create: `Dockerfile`
- Create: `.dockerignore`
- Create: `.github/workflows/ci.yml`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `README.md`
- Modify: `NOTICE`
- Modify: `cli.js`
- Modify: `configure-ui.js`
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `server.js`
- Modify: `test/cli.test.js`
- Modify: `test/configure-ui.test.js`

**Interfaces:**
- Produces: npm package `@zms-labs/zms-canvas`, CLI `zms-canvas`, OCI image entrypoint `/app/cli.js`, source URL `https://github.com/ZMS-Labs/zms-canvas`.

- [ ] **Step 1: Write the failing identity test**

```js
test("the modified distribution has a distinct ZMS Canvas identity", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.name, "@zms-labs/zms-canvas");
  assert.equal(pkg.bin["zms-canvas"], "cli.js");
  assert.equal(pkg.repository.url, "git+https://github.com/ZMS-Labs/zms-canvas.git");
  assert.match(read("NOTICE"), /based on PenEcho/i);
  assert.match(read("public/index.html"), /ZMS Canvas/);
  assert.match(read("public/index.html"), /https:\/\/github\.com\/ZMS-Labs\/zms-canvas/);
});
```

- [ ] **Step 2: Run the test and verify the expected identity failure**

Run: `node --test test/product-identity.test.js`  
Expected: FAIL because `package.json` is still named `penecho`.

- [ ] **Step 3: Apply the minimal identity and container changes**

```json
{
  "name": "@zms-labs/zms-canvas",
  "version": "0.1.0",
  "license": "AGPL-3.0-only",
  "bin": { "zms-canvas": "cli.js" },
  "engines": { "node": ">=22.5.0" },
  "repository": { "type": "git", "url": "git+https://github.com/ZMS-Labs/zms-canvas.git" }
}
```

The Dockerfile must use the digest-pinned Node 22 Bookworm image, run as UID/GID 1000, expose 3888, copy the complete application source, set `PENECHO_STATE_DIR=/state`, and label the source and license. Visible HTML, CLI help, configuration UI, and startup output must say `ZMS Canvas`; `PenEcho` remains only in accurate upstream attribution and compatibility documentation.

- [ ] **Step 4: Regenerate the lockfile and run identity plus package checks**

Run: `npm install --package-lock-only --ignore-scripts && node --test test/product-identity.test.js && npm run check`  
Expected: identity test PASS and the complete check exits 0.

- [ ] **Step 5: Commit the identity boundary**

```bash
git add package.json package-lock.json README.md NOTICE cli.js configure-ui.js public/index.html public/app.js server.js Dockerfile .dockerignore .github/workflows/ci.yml test/product-identity.test.js test/cli.test.js test/configure-ui.test.js
git commit -m "feat: establish ZMS Canvas product identity"
```

### Task 2: Implement the transactional notebook store

**Files:**
- Create: `notebook-store.js`
- Create: `test/notebook-store.test.js`
- Modify: `package.json`

**Interfaces:**
- Produces: `createNotebookStore({ dbPath, revisionLimit, now, randomUUID })`.
- Produces store methods: `list(ownerId)`, `create(ownerId, payload)`, `get(ownerId, id, revision)`, `save(ownerId, id, baseRevision, payload)`, `listRevisions(ownerId, id)`, `restore(ownerId, id, baseRevision, restoreRevision)`, `delete(ownerId, id)`, and `close()`.
- Produces errors: `NotebookConflictError` with `currentRevision`, and `NotebookNotFoundError`.
- Consumes payload fields: `{ title, theme, view:{scale,panX,panY}, preview:Buffer, tiles:[{key,png:Buffer}] }`.

- [ ] **Step 1: Write failing create/list/get tests against a temporary SQLite file**

```js
test("creates and reads an owner-scoped notebook revision", () => {
  const store = fixtureStore();
  const created = store.create("owner-a", canvasPayload("Algebra"));
  assert.equal(created.revision, 1);
  assert.equal(store.list("owner-a")[0].title, "Algebra");
  assert.deepEqual(store.get("owner-a", created.id).tiles[0].png, PNG_BUFFER);
  assert.equal(store.get("owner-b", created.id), null);
  store.close();
});
```

- [ ] **Step 2: Verify the store test fails because the module is absent**

Run: `node --test test/notebook-store.test.js`  
Expected: FAIL with `Cannot find module '../notebook-store.js'`.

- [ ] **Step 3: Implement schema creation and owner-scoped create/list/get**

```js
function createNotebookStore({ dbPath, revisionLimit = 50, now = Date.now, randomUUID = crypto.randomUUID }) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;");
  db.exec(SCHEMA);
  return { list, create, get, save, listRevisions, restore, delete: deleteNotebook, close: () => db.close() };
}
```

Every SQL statement must bind values. Every owner-scoped read must include `owner_id = ?`.

- [ ] **Step 4: Run the store test to green**

Run: `node --test test/notebook-store.test.js`  
Expected: PASS.

- [ ] **Step 5: Add failing compare-and-swap, restore, retention, deletion, and rollback tests**

```js
assert.throws(() => store.save("owner-a", id, 1, payload), error => {
  assert.equal(error.name, "NotebookConflictError");
  assert.equal(error.currentRevision, 2);
  return true;
});
const restored = store.restore("owner-a", id, current, 1);
assert.equal(restored.revision, current + 1);
assert.equal(store.get("owner-a", id).tiles[0].png.toString("hex"), first.tiles[0].png.toString("hex"));
```

- [ ] **Step 6: Verify the new tests fail for missing transaction behavior**

Run: `node --test test/notebook-store.test.js`  
Expected: FAIL at the first save/restore assertion.

- [ ] **Step 7: Implement strict save transactions, restore-as-new, retention, and deletion**

```js
function transaction(work) {
  db.exec("BEGIN IMMEDIATE");
  try { const result = work(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}
```

Within a save transaction: verify `current_revision === baseRevision`, insert the complete immutable revision and tiles, update the notebook pointer, delete revisions older than the newest `revisionLimit`, then commit.

- [ ] **Step 8: Run store tests and the complete suite**

Run: `node --test test/notebook-store.test.js && npm run check`  
Expected: all tests PASS and check exits 0.

- [ ] **Step 9: Commit the store**

```bash
git add notebook-store.js test/notebook-store.test.js package.json
git commit -m "feat: add transactional notebook revision store"
```

### Task 3: Add the authenticated notebook HTTP API

**Files:**
- Create: `notebook-api.js`
- Create: `test/notebook-api.test.js`
- Modify: `server.js`
- Modify: `package.json`

**Interfaces:**
- Produces: `createNotebookApi({ store, enabled, ownerHeader, bodyLimit })` returning `async handle(req, res, url): Promise<boolean>`.
- Produces: `notebookConfig()` returning `{ enabled: boolean }` for browser configuration.
- Consumes the store interface from Task 2.

- [ ] **Step 1: Write failing API tests for missing identity and owner isolation**

```js
test("requires the configured trusted identity header", async () => {
  const response = await request(server, "GET", "/api/notebooks");
  assert.equal(response.status, 401);
});

test("does not disclose another owner's notebook", async () => {
  const created = await createNotebook(server, "owner-a");
  const response = await request(server, "GET", `/api/notebooks/${created.id}`, null, { "x-authentik-uid":"owner-b" });
  assert.equal(response.status, 404);
});
```

- [ ] **Step 2: Verify API tests fail because `notebook-api.js` is absent**

Run: `node --test test/notebook-api.test.js`  
Expected: FAIL with a missing-module error.

- [ ] **Step 3: Implement routing, identity extraction, JSON responses, and config advertisement**

```js
async function handle(req, res, url) {
  if (!url.pathname.startsWith("/api/notebooks")) return false;
  if (!enabled) return sendJson(res, 404, { error:"not_found" });
  const ownerId = String(req.headers[ownerHeader] || "").trim();
  if (!ownerId) return sendJson(res, 401, { error:"identity_required" });
  // Match exact collection and UUID item routes, validate payload, then call store.
  return true;
}
```

Call `await notebookApi.handle(req, res, url)` before debug and AI routes. Add `notebooks:notebookApi.notebookConfig()` to both config endpoints.

- [ ] **Step 4: Run identity and isolation tests to green**

Run: `node --test test/notebook-api.test.js`  
Expected: PASS for identity and isolation cases.

- [ ] **Step 5: Add failing validation, CRUD, revision, restore, `409`, and size-limit tests**

```js
assert.equal((await putNotebook(id, { ...payload, baseRevision:0 })).status, 409);
assert.equal((await postNotebook({ ...payload, preview:"not-base64" })).status, 400);
assert.equal((await postNotebook({ ...payload, tiles:[{key:"99,99", png:PNG}] })).status, 400);
assert.equal((await sendOversizedNotebook()).status, 413);
```

- [ ] **Step 6: Verify the new API cases fail for missing validation/routes**

Run: `node --test test/notebook-api.test.js`  
Expected: FAIL at the first unimplemented CRUD or validation assertion.

- [ ] **Step 7: Implement exact CRUD and validation behavior**

Use canonical base64 decoding, the eight-byte PNG signature `89504e470d0a1a0a`, finite bounded view numbers, themes `arcane|scifi|research`, UUID item routes, 80-code-point titles, 1,600-tile maximum, and 64 MiB request limit. Map `NotebookConflictError` to `409` and `NotebookNotFoundError` to `404`.

- [ ] **Step 8: Run API, security, and complete checks**

Run: `node --test test/notebook-api.test.js test/server-security.test.js && npm run check`  
Expected: all tests PASS and check exits 0.

- [ ] **Step 9: Commit the notebook API**

```bash
git add notebook-api.js server.js package.json test/notebook-api.test.js
git commit -m "feat: expose authenticated notebook API"
```

### Task 4: Build the testable browser synchronization controller

**Files:**
- Create: `public/notebooks.js`
- Create: `test/notebook-client.test.js`
- Modify: `package.json`

**Interfaces:**
- Produces: `createNotebookController({ api, recovery, capture, apply, status, debounceMs, timers, now })`.
- Produces controller methods: `configure(config)`, `markConfirmedMutation()`, `flush()`, `load(id)`, `restore(id, revision)`, `delete(id)`, `importLegacy(snapshot)`, `list()`, and `current()`.
- `capture()` returns the complete serializable canvas payload.
- `apply(payload)` returns a promise and must finish decoding before replacing the current canvas.

- [ ] **Step 1: Write failing autosave coalescing and acknowledged-revision tests with fake timers**

```js
controller.configure({ enabled:true });
controller.markConfirmedMutation();
controller.markConfirmedMutation();
timers.advance(1999);
assert.equal(api.calls.length, 0);
timers.advance(1);
await controller.flush();
assert.equal(api.calls.length, 1);
assert.equal(controller.current().revision, 1);
```

- [ ] **Step 2: Verify the client test fails because the module is absent**

Run: `node --test test/notebook-client.test.js`  
Expected: FAIL with a missing-module error.

- [ ] **Step 3: Implement UMD export, one-flight autosave, and revision tracking**

```js
(function(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ZMSCanvasNotebooks = api;
})(typeof globalThis === "object" ? globalThis : this, function() {
  return { createNotebookController };
});
```

If mutation occurs during an in-flight save, schedule a second flush only after the first acknowledgment updates `baseRevision`.

- [ ] **Step 4: Run autosave tests to green**

Run: `node --test test/notebook-client.test.js`  
Expected: PASS for coalescing and in-flight behavior.

- [ ] **Step 5: Add failing recovery, conflict-copy, and load-before-clear tests**

```js
await assert.rejects(controller.load("bad"));
assert.equal(apply.calls.length, 0);
await controller.flushWithConflict();
assert.match(api.created.at(-1).title, /conflict copy/);
assert.equal(await recovery.get(), null);
```

- [ ] **Step 6: Verify recovery/conflict tests fail for missing behavior**

Run: `node --test test/notebook-client.test.js`  
Expected: FAIL at the first recovery or conflict assertion.

- [ ] **Step 7: Implement IndexedDB recovery lifecycle and conflict-copy creation**

Write recovery before fetch, clear only after acknowledgment, retain it on network failure, create a complete new notebook on `409`, and call `apply()` only after a complete response has been validated and decoded.

- [ ] **Step 8: Run client tests and complete checks**

Run: `node --test test/notebook-client.test.js && npm run check`  
Expected: all tests PASS and check exits 0.

- [ ] **Step 9: Commit the synchronization controller**

```bash
git add public/notebooks.js test/notebook-client.test.js package.json
git commit -m "feat: add connected notebook synchronization controller"
```

### Task 5: Integrate synchronized notebooks into the canvas UI

**Files:**
- Create: `test/notebook-ui.test.js`
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/style.css`
- Modify: `public/locales/zh.js`
- Modify: `docs/architecture.md`

**Interfaces:**
- Consumes: `window.ZMSCanvasNotebooks.createNotebookController` from Task 4.
- Produces: `captureNotebookCanvas()`, `applyNotebookCanvas(payload)`, `markNotebookDirty()`, synchronized notebook/revision rendering, and legacy snapshot import.

- [ ] **Step 1: Write failing structural UI tests**

```js
for (const id of ["notebookSyncStatus", "syncedNotebooks", "deviceSnapshots"]) assert.match(html, new RegExp(`id="${id}"`));
assert.ok(html.indexOf('src="notebooks.js"') < html.indexOf('src="app.js"'));
assert.match(app, /function captureNotebookCanvas\(\)/);
assert.match(app, /function applyNotebookCanvas\(payload\)/);
assert.match(app, /markNotebookDirty\(\)/);
```

- [ ] **Step 2: Verify UI tests fail because synchronized controls are absent**

Run: `node --test test/notebook-ui.test.js`  
Expected: FAIL on `notebookSyncStatus`.

- [ ] **Step 3: Add source/status markup, notebook sections, accessible controls, and localized copy**

The status element must use `role="status"` and `aria-live="polite"`. Device snapshots must retain their existing load/delete behavior and gain a `Copy to synced notebooks` action only when server notebooks are enabled.

- [ ] **Step 4: Implement canvas capture/apply without clearing before decode**

```js
async function captureNotebookCanvas() {
  if (state.selection) commitSelection();
  return {
    title: state.currentNotebookTitle || "Untitled notebook",
    theme: state.theme,
    view: { scale:state.scale, panX:state.panX, panY:state.panY },
    preview: await blobToBase64(await canvasBlob(snapshotPreview())),
    tiles: await Promise.all([...tiles].map(async ([key, canvas]) => ({ key, png:await blobToBase64(await canvasBlob(canvas)) }))),
  };
}
```

Decode every tile into temporary canvases first; only then invalidate recognition, clear current confirmed tiles, install decoded tiles, restore theme/view, and render.

- [ ] **Step 5: Connect confirmed mutation boundaries and lifecycle events to autosave**

Call `markNotebookDirty()` after completed pen/eraser history, accepted AI output, committed/recolored selection, undo, redo, and clear. Do not mark dirty for pan, zoom, unconfirmed AI drafts, or selection preview movement. Trigger best-effort flush on `visibilitychange` when hidden and on `pagehide`.

- [ ] **Step 6: Implement notebook list, revision restore, delete, and legacy import actions**

List current notebooks newest first, visually identify the loaded notebook, require confirmation for restore/delete, and refresh only after the controller operation succeeds.

- [ ] **Step 7: Run UI, client, and complete checks**

Run: `node --test test/notebook-ui.test.js test/notebook-client.test.js test/ui-controls.test.js && npm run check`  
Expected: all tests PASS and check exits 0.

- [ ] **Step 8: Commit the browser integration**

```bash
git add public/index.html public/app.js public/style.css public/locales/zh.js docs/architecture.md test/notebook-ui.test.js
git commit -m "feat: synchronize editable notebooks across devices"
```

### Task 6: Verify distribution, persistence, and licensing

**Files:**
- Create: `test/container.test.js`
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`
- Modify: `NOTICE`
- Modify: `Dockerfile`

**Interfaces:**
- Produces: reproducible non-root container using `/state/notebooks.sqlite` and publishing source/license OCI labels.

- [ ] **Step 1: Write failing container-policy tests**

```js
assert.match(dockerfile, /^FROM node:22-bookworm-slim@sha256:/m);
assert.match(dockerfile, /USER 1000:1000/);
assert.match(dockerfile, /org\.opencontainers\.image\.source="https:\/\/github\.com\/ZMS-Labs\/zms-canvas"/);
assert.match(dockerfile, /org\.opencontainers\.image\.licenses="AGPL-3\.0-only"/);
assert.doesNotMatch(dockerfile, /COPY .*config\.env/);
```

- [ ] **Step 2: Verify the policy test fails at any missing build requirement**

Run: `node --test test/container.test.js`  
Expected: FAIL until all image policy assertions are present.

- [ ] **Step 3: Complete container and CI release behavior**

CI must run `npm ci`, `npm run check`, dependency review, CodeQL, and a Buildx multi-platform build for `linux/amd64,linux/arm64`. Main pushes publish `ghcr.io/zms-labs/zms-canvas` with commit and immutable digest metadata, SBOM, and provenance.

- [ ] **Step 4: Run local distribution verification**

Run: `npm ci --no-audit --no-fund && npm run check && node --test test/container.test.js && docker build -t zms-canvas:local .`  
Expected: install, tests, and image build exit 0.

- [ ] **Step 5: Exercise a temporary SQLite database through the real server**

Run the container with notebooks enabled, a temporary `/state` mount, and a test identity header; create, load, update, conflict, restore, restart, and reload one notebook. Expected: revision history survives restart and stale save returns `409`.

- [ ] **Step 6: Commit distribution completion**

```bash
git add Dockerfile .github/workflows/ci.yml README.md NOTICE test/container.test.js
git commit -m "build: publish persistent ZMS Canvas image"
```

### Task 7: Final application review and publication

**Files:**
- Modify only files required by review findings.

**Interfaces:**
- Produces: a reviewable feature branch and public pull request against `main`.

- [ ] **Step 1: Run the complete verification gate fresh**

Run: `npm ci --no-audit --no-fund && npm run check && git diff --check`  
Expected: all commands exit 0 with no test failures or whitespace errors.

- [ ] **Step 2: Review the diff against every design success criterion**

Confirm owner scoping, connected autosave, acknowledged revisions, conflict copies, restore-as-new, legacy snapshot preservation, distinct identity, source link, container persistence, and disabled-by-default compatibility.

- [ ] **Step 3: Request an independent code review and resolve all critical or important findings**

Provide the reviewer the design path, plan path, `origin/main` base SHA, feature HEAD SHA, and complete diff. Add a failing regression test before each behavior fix.

- [ ] **Step 4: Re-run the complete verification gate after review changes**

Run: `npm run check && git diff --check`  
Expected: all commands exit 0.

- [ ] **Step 5: Push the feature branch and open a pull request**

```bash
git push -u origin feat/cross-device-continuity
gh pr create --repo ZMS-Labs/zms-canvas --base main --head feat/cross-device-continuity --title "feat: add cross-device notebook continuity" --body "Adds server-authoritative SQLite notebooks, connected autosave, immutable revisions, conflict-copy recovery, distinct ZMS Canvas identity, and a multi-architecture AGPL container. Verification and deployment prerequisites are documented in the committed plan. GitOps is intentionally not cut over by this application PR."
```

The PR body must summarize architecture, tests, AGPL/trademark handling, deployment prerequisites, and the fact that GitOps has not yet been cut over.
