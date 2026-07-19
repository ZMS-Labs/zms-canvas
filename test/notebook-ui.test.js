"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createNotebookController } = require("../public/notebooks.js");

const ROOT = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const functionSource = (source, name) => {
  let start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing function ${name}`);
  if (source.slice(start - 6, start) === "async ") start -= 6;
  const body = source.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < source.length; index++) {
    if (source[index] === "{") depth++;
    else if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`unterminated function ${name}`);
};
const loadPureFunction = (source, name) => vm.runInNewContext(`(${functionSource(source, name)})`);
const loadScopedFunctions = (source, names, scope) => {
  const keys = Object.keys(scope);
  const factory = vm.runInNewContext(`(function (${keys.join(",")}) {\n${names.map((name) => functionSource(source, name)).join("\n")}\nreturn { ${names.join(",")} };\n})`);
  return factory(...keys.map((key) => scope[key]));
};

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

test("a failed synchronized drain aborts blank-canvas replacement without resetting notebook state", async () => {
  const app = read("public/app.js");
  let configureCalls = 0;
  let clearCalls = 0;
  let cancelCalls = 0;
  let invalidationCalls = 0;
  let pendingCancelCalls = 0;
  const history = [{ keep: true }];
  const future = [{ keep: true }];
  const selection = { phase: "active", color: "#dc2626" };
  const state = {
    notebooksEnabled: true,
    currentNotebookTitle: "Active notebook",
    selection,
    snapshotLoadGeneration: 3,
    userRevision: 7,
    recognitionGeneration: 11,
    history,
    future,
    historyBefore: { clear() { clearCalls++; } },
    inkBounds: { clear() { clearCalls++; } },
    currentSnapshotId: "device-copy",
    currentSnapshotName: "Device copy",
  };
  const document = {
    querySelector(selector) {
      if (selector === "#newCanvasDialog") return { open: true, close() {} };
      if (selector === "#newSnapshotName") return { value: "keep" };
      if (selector === "#historyPanel") return { classList: { contains() { return false; } } };
      throw Error(`Unexpected selector: ${selector}`);
    },
  };
  const { startBlankCanvas } = loadScopedFunctions(app, ["detachNotebookCanvas", "startBlankCanvas"], {
    notebookController: {
      flush: async () => { throw Error("recovery write failed"); },
      configure() { configureCalls++; },
    },
    state,
    document,
    tiles: { clear() { clearCalls++; } },
    cancelSelection() { cancelCalls++; },
    invalidateRecognition() { invalidationCalls++; state.recognitionGeneration++; },
    cancelPendingForRevision() { pendingCancelCalls++; },
    closeHistoryPanel() {},
    fit() {},
    setStatusKey() {},
  });

  const failure = await startBlankCanvas().then(() => null, (error) => error);
  assert.match(failure?.message || "", /recovery write failed/);
  assert.equal(failure?.notebookSyncFailure, true);
  assert.equal(configureCalls, 0);
  assert.equal(clearCalls, 0);
  assert.equal(cancelCalls, 0);
  assert.equal(invalidationCalls, 0);
  assert.equal(pendingCancelCalls, 0);
  assert.equal(state.snapshotLoadGeneration, 3);
  assert.equal(state.userRevision, 7);
  assert.equal(state.recognitionGeneration, 11);
  assert.equal(state.selection, selection);
  assert.equal(state.currentNotebookTitle, "Active notebook");
  assert.equal(state.history, history);
  assert.equal(state.future, future);
});

test("canvas source changes await exactly one successful detach before replacement", () => {
  const app = read("public/app.js");
  const load = functionSource(app, "loadSnapshot");
  const blank = functionSource(app, "startBlankCanvas");

  assert.equal((blank.match(/detachNotebookCanvas\(\)/g) || []).length, 1);
  assert.ok(load.indexOf("await detachNotebookCanvas()") < load.indexOf("tiles.clear()"));
  assert.ok(blank.indexOf("await detachNotebookCanvas()") < blank.indexOf("tiles.clear()"));
  assert.ok(blank.indexOf("await detachNotebookCanvas()") < blank.indexOf("cancelSelection(true)"));
  assert.match(functionSource(app, "completeNewCanvas"), /await startBlankCanvas\(\)/);
  assert.match(app, /querySelector\("#newDiscard"\)\.onclick = \(\) => runSnapshotAction\(startBlankCanvas\)/);
});

test("blank transition drains a dirty recolored selection into the saved payload before clearing", async () => {
  const app = read("public/app.js");
  const events = [];
  let capture;
  let savedPayload;
  let cancelCalls = 0;
  const original = { blob: "original-pixels" };
  const recolored = { blob: "recolored-pixels" };
  const tiles = new Map();
  const clear = tiles.clear.bind(tiles);
  tiles.clear = () => { events.push("clear"); clear(); };
  const state = {
    selection: { phase: "active", fragments: [{ image: original, renderImage: recolored }] },
    currentNotebookTitle: "Colored proof",
    theme: "research",
    scale: 1,
    panX: 4,
    panY: 8,
    snapshotLoadGeneration: 1,
    userRevision: 2,
    history: [{ keep: true }],
    future: [],
    historyBefore: { clear() {} },
    inkBounds: { clear() {} },
    currentSnapshotId: null,
    currentSnapshotName: "",
    viewInitialized: true,
  };
  const document = {
    querySelector(selector) {
      if (selector === "#newCanvasDialog") return { open: false };
      if (selector === "#newSnapshotName") return { value: "" };
      if (selector === "#historyPanel") return { classList: { contains() { return false; } } };
      throw Error(`Unexpected selector: ${selector}`);
    },
  };
  const functions = loadScopedFunctions(app, ["mapWithConcurrency", "captureNotebookCanvas", "startBlankCanvas"], {
    state,
    tiles,
    NOTEBOOK_TILE_CONCURRENCY: 4,
    commitSelection() {
      tiles.set("0,0", state.selection.fragments[0].renderImage);
      state.selection = null;
    },
    cancelSelection() {
      cancelCalls++;
      tiles.set("0,0", original);
      state.selection = null;
    },
    async detachNotebookCanvas() {
      savedPayload = await capture();
      events.push("saved");
    },
    snapshotPreview: () => ({ blob: "preview" }),
    canvasBlob: async (canvas) => canvas.blob,
    blobToBase64: async (blob) => blob,
    t: () => "Untitled notebook",
    document,
    invalidateRecognition() {},
    cancelPendingForRevision() {},
    closeHistoryPanel() {},
    fit() {},
    setStatusKey() {},
  });
  capture = functions.captureNotebookCanvas;

  await functions.startBlankCanvas();

  assert.equal(cancelCalls, 0);
  assert.equal(savedPayload.tiles[0].png, "recolored-pixels");
  assert.ok(events.indexOf("saved") < events.indexOf("clear"));
});

test("snapshot actions distinguish synchronized drain failures from local history failures", async () => {
  const app = read("public/app.js");
  const syncErrors = [];
  const localStatuses = [];
  const { runSnapshotAction } = loadScopedFunctions(app, ["runSnapshotAction"], {
    setNotebookOperationError(key, error) { syncErrors.push({ key, message: error.message }); },
    setStatus(message) { localStatuses.push(message); },
    t: () => "Local history: ",
  });
  const syncFailure = Error("offline");
  syncFailure.notebookSyncFailure = true;

  await runSnapshotAction(async () => { throw syncFailure; });
  assert.deepEqual(syncErrors, [{ key: "notebookSyncError", message: "offline" }]);
  assert.deepEqual(localStatuses, []);

  await runSnapshotAction(async () => { throw Error("IndexedDB failed"); });
  assert.deepEqual(localStatuses, ["Local history: IndexedDB failed"]);
  assert.match(functionSource(app, "completeNewCanvas"), /notebookSyncFailure[\s\S]*setNotebookOperationError\("notebookSyncError", error\)/);
});

test("capturing a dirty recolored selection saves its pixels without scheduling an identical revision", async () => {
  const app = read("public/app.js");
  const apiCalls = [];
  const tiles = new Map();
  let controller;
  const state = {
    selection: {
      phase: "active",
      originalBox: { x: 0, y: 0, w: 1, h: 1 },
      box: { x: 0, y: 0, w: 1, h: 1 },
      fragments: [{ image: { blob: "original" }, renderImage: { blob: "recolored" } }],
      color: "#dc2626",
    },
    selectionGesture: {},
    userRevision: 4,
    notebookApplying: false,
    currentNotebookTitle: "One revision",
    theme: "research",
    scale: 1,
    panX: 0,
    panY: 0,
  };
  const bridge = { markConfirmedMutation() { controller.markConfirmedMutation(); } };
  const functions = loadScopedFunctions(app, ["mapWithConcurrency", "markNotebookDirty", "commitSelection", "captureNotebookCanvas"], {
    state,
    tiles,
    notebookController: bridge,
    NOTEBOOK_TILE_CONCURRENCY: 4,
    selectionHasChanges: () => true,
    cancelSelection() { throw Error("changed selection must commit"); },
    setStatusKey() {},
    SELECT: { mapFragment: () => ({ x: 0, y: 0, w: 1, h: 1 }) },
    blitSized(image) { tiles.set("0,0", { blob: image.blob }); },
    save: () => true,
    setCanvasCursor() {},
    render() {},
    snapshotPreview: () => ({ blob: "preview" }),
    canvasBlob: async (canvas) => canvas.blob,
    blobToBase64: async (blob) => blob,
    t: () => "Untitled notebook",
  });
  const api = {
    async create(payload) {
      apiCalls.push({ method: "create", payload });
      return { id: "notebook-1", revision: 1, ...payload };
    },
    async update(id, payload) {
      apiCalls.push({ method: "update", id, payload });
      return { id, revision: payload.baseRevision + 1, ...payload };
    },
  };
  controller = createNotebookController({
    api,
    recovery: { async put() {}, async clear() {} },
    capture: functions.captureNotebookCanvas,
    apply: async () => {},
    timers: { setTimeout: () => 1, clearTimeout() {} },
    debounceMs: 2000,
  });
  controller.configure({ enabled: true });
  controller.markConfirmedMutation();

  await controller.flush();
  await controller.flush();

  assert.equal(apiCalls.length, 1);
  assert.equal(apiCalls[0].payload.tiles[0].png, "recolored");
  assert.equal(state.selection, null);
});

test("notebook read and action failures use their localized operation path, not save status", async () => {
  const app = read("public/app.js");
  const localErrors = [];
  const saveStatuses = [];
  const list = { dataset: {}, querySelectorAll() { return []; } };
  const { runNotebookAction } = loadScopedFunctions(app, ["runNotebookAction"], {
    document: { querySelector() { return list; } },
    setNotebookOperationError(key, error) { localErrors.push({ key, message: error.message }); },
    reportNotebookStatus(...args) { saveStatuses.push(args); },
    renderSyncedNotebookList() {},
  });

  const result = await runNotebookAction(async () => { throw Error("offline"); }, "notebookLoadError");
  assert.equal(result, null);
  assert.deepEqual(localErrors, [{ key: "notebookLoadError", message: "offline" }]);
  assert.deepEqual(saveStatuses, []);
  assert.doesNotMatch(app, /reportNotebookStatus\("Save failed"/);

  const snapshotList = functionSource(app, "renderSnapshotList");
  const notebookList = functionSource(app, "renderSyncedNotebookList");
  const revisions = functionSource(app, "toggleNotebookRevisions");
  assert.match(snapshotList, /runNotebookAction\([\s\S]*"notebookCopyError"\)/);
  assert.match(notebookList, /runNotebookAction\([\s\S]*"notebookLoadError"\)/);
  assert.match(notebookList, /runNotebookAction\([\s\S]*"notebookDeleteError"\)/);
  assert.match(revisions, /runNotebookAction\([\s\S]*"notebookRestoreError"\)/);
  assert.match(revisions, /setNotebookOperationError\("notebookRevisionsError", error\)/);
  assert.match(functionSource(app, "openHistoryPanel"), /refreshSyncedNotebooksSafely\(\)/);
});

test("notebook operation errors and untitled names are localized in English and Chinese", () => {
  const app = read("public/app.js");
  const zh = read("public/locales/zh.js");
  const capture = functionSource(app, "captureNotebookCanvas");
  const keys = [
    "notebookListError",
    "notebookRevisionsError",
    "notebookLoadError",
    "notebookDeleteError",
    "notebookRestoreError",
    "notebookCopyError",
    "notebookSyncError",
  ];

  assert.match(capture, /title: state\.currentNotebookTitle \|\| t\("untitledNotebook"\)/);
  assert.doesNotMatch(capture, /"Untitled notebook"/);
  assert.match(app, /untitledNotebook: "Untitled notebook"/);
  assert.match(zh, /untitledNotebook: "未命名笔记本"/);
  for (const key of keys) {
    assert.match(app, new RegExp(`${key}:`));
    assert.match(zh, new RegExp(`${key}:`));
  }
});

test("bounded ordered map caps active tile work and preserves result order", async () => {
  const app = read("public/app.js");
  const map = loadPureFunction(app, "mapWithConcurrency");
  let active = 0;
  let maxActive = 0;
  const inputs = Array.from({ length: 11 }, (_, index) => index);

  const results = await map(inputs, 4, async (value) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, (inputs.length - value) % 3));
    active--;
    return `result-${value}`;
  });

  assert.equal(maxActive, 4);
  assert.deepEqual(Array.from(results), inputs.map((value) => `result-${value}`));
  assert.match(app, /const NOTEBOOK_TILE_CONCURRENCY = 4/);
  assert.match(functionSource(app, "captureNotebookCanvas"), /mapWithConcurrency\(\[\.\.\.tiles\], NOTEBOOK_TILE_CONCURRENCY/);
  assert.match(functionSource(app, "decodeNotebookTiles"), /mapWithConcurrency\(payload\.tiles, NOTEBOOK_TILE_CONCURRENCY/);
});
