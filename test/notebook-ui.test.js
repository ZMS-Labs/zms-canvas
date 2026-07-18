"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const functionSource = (source, name) => {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const body = source.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < source.length; index++) {
    if (source[index] === "{") depth++;
    else if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`unterminated function ${name}`);
};
const loadPureFunction = (source, name) => vm.runInNewContext(`(${functionSource(source, name)})`);

test("synchronized notebook controls and canvas integration points are present", () => {
  const html = read("public/index.html");
  const app = read("public/app.js");

  for (const id of ["notebookSyncStatus", "syncedNotebooks", "deviceSnapshots"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.ok(html.indexOf('src="notebooks.js"') < html.indexOf('src="app.js"'));
  assert.match(app, /function captureNotebookCanvas\(\)/);
  assert.match(app, /function applyNotebookCanvas\(payload\)/);
  assert.match(app, /markNotebookDirty\(\)/);
});

test("sync status presentation maps controller states to stable UI tones", () => {
  const present = loadPureFunction(read("public/app.js"), "notebookStatusPresentation");

  assert.deepEqual({ ...present("Saving…") }, { key: "notebookSaving", tone: "saving" });
  assert.deepEqual({ ...present("Saved") }, { key: "notebookSaved", tone: "saved" });
  assert.deepEqual({ ...present("Save failed") }, { key: "notebookSaveFailed", tone: "error" });
  assert.deepEqual({ ...present("Conflict copy saved") }, { key: "notebookConflictSaved", tone: "conflict" });
  assert.deepEqual({ ...present("Saved with recovery warning") }, { key: "notebookRecoveryWarning", tone: "warning" });
});

test("notebook summaries render newest first without mutating the API result", () => {
  const sort = loadPureFunction(read("public/app.js"), "sortNotebookSummaries");
  const summaries = [
    { id: "old", updatedAt: 10 },
    { id: "new", updatedAt: 30 },
    { id: "middle", updatedAt: 20 },
  ];

  assert.deepEqual(Array.from(sort(summaries), ({ id }) => id), ["new", "middle", "old"]);
  assert.deepEqual(summaries.map(({ id }) => id), ["old", "new", "middle"]);
});

test("loaded notebook tiles are decoded before the current canvas is cleared", () => {
  const app = read("public/app.js");
  const apply = functionSource(app, "applyNotebookCanvas");

  assert.ok(app.includes("async function decodeNotebookTiles(payload)"));
  assert.ok(apply.indexOf("await decodeNotebookTiles(payload)") < apply.indexOf("tiles.clear()"));
  assert.match(apply, /state\.notebookApplying = true/);
  assert.match(apply, /finally\s*{\s*state\.notebookApplying = false/);
});

test("sync controls are accessible, localized, and styled as toolbar state", () => {
  const html = read("public/index.html");
  const app = read("public/app.js");
  const css = read("public/style.css");
  const zh = read("public/locales/zh.js");
  const status = html.match(/<div id="notebookSyncStatus"[\s\S]*?<\/div>/)?.[0] || "";

  assert.match(status, /role="status"/);
  assert.match(status, /aria-live="polite"/);
  assert.match(status, /aria-atomic="true"/);
  for (const key of [
    "notebooksTitle",
    "syncedNotebooksTitle",
    "deviceSnapshotsTitle",
    "copyToSyncedNotebooks",
    "notebookSaving",
    "notebookSaved",
    "notebookSaveFailed",
    "notebookConflictSaved",
  ]) {
    assert.match(app, new RegExp(`${key}:`));
    assert.match(zh, new RegExp(`${key}:`));
  }
  assert.match(css, /\.notebook-sync-status\s*\{/);
  assert.match(css, /\.history-source-heading\s*\{/);
  assert.match(css, /@media \(max-width: 620px\)[\s\S]*\.notebook-sync-status/);
});

test("controller setup, confirmed mutations, and lifecycle flushes are wired", () => {
  const app = read("public/app.js");
  const initialize = functionSource(app, "initializeNotebookSync");

  assert.match(initialize, /createNotebookHttpApi/);
  assert.match(initialize, /createIndexedDbRecovery/);
  assert.match(initialize, /createNotebookController/);
  assert.match(initialize, /configure\(configuredNotebooks\)/);
  for (const name of ["finishDrawing", "acceptPending", "acceptPendingItem", "commitSelection", "applySelectionColor", "undo", "redo"]) {
    assert.match(functionSource(app, name), /markNotebookDirty\(\)/, `${name} must mark a confirmed mutation`);
  }
  assert.match(app, /if \(save\(\)\) markNotebookDirty\(\);\s*render\(\);/);
  assert.match(app, /document\.visibilityState === "hidden"\) flushNotebookBestEffort\(\)/);
  assert.match(app, /window\.addEventListener\("pagehide", flushNotebookBestEffort\)/);
});

test("device snapshot copy retains the local record and synchronized destructive actions confirm", () => {
  const app = read("public/app.js");
  const copy = functionSource(app, "copySnapshotToSyncedNotebooks");

  assert.match(copy, /notebookController\.importLegacy\(payload\)/);
  assert.doesNotMatch(copy, /deleteSnapshot|\.delete\(/);
  assert.match(app, /confirm\(t\("deleteNotebookConfirm"\)\)/);
  assert.match(app, /confirm\(t\("restoreRevisionConfirm"\)\.replace\("\{revision\}", revision\.revision\)\)/);
});

test("canvas source changes drain a pending synchronized save before replacement", () => {
  const app = read("public/app.js");
  const detach = functionSource(app, "detachNotebookCanvas");
  const load = functionSource(app, "loadSnapshot");
  const blank = functionSource(app, "startBlankCanvas");

  assert.match(detach, /await notebookController\.flush\(\)/);
  assert.ok(load.indexOf("await detachNotebookCanvas()") < load.indexOf("tiles.clear()"));
  assert.ok(blank.indexOf("await detachNotebookCanvas()") < blank.indexOf("tiles.clear()"));
  assert.match(functionSource(app, "completeNewCanvas"), /await startBlankCanvas\(\)/);
});
