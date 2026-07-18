"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createNotebookController,
  createNotebookHttpApi,
  createIndexedDbRecovery,
} = require("../public/notebooks.js");

const PNG = "iVBORw0KGgo=";

function canvasPayload(title = "Untitled") {
  return {
    title,
    theme: "research",
    view: { scale: 1, panX: 0, panY: 0 },
    preview: PNG,
    tiles: [{ key: "0,0", png: PNG }],
  };
}

function createFakeTimers() {
  let clock = 0;
  let nextId = 1;
  const scheduled = new Map();
  return {
    setTimeout(callback, delay) {
      const id = nextId++;
      scheduled.set(id, { at: clock + delay, callback });
      return id;
    },
    clearTimeout(id) {
      scheduled.delete(id);
    },
    advance(milliseconds) {
      const target = clock + milliseconds;
      while (true) {
        const due = [...scheduled.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
        if (!due) break;
        const [id, timer] = due;
        scheduled.delete(id);
        clock = timer.at;
        timer.callback();
      }
      clock = target;
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function createApi() {
  const calls = [];
  return {
    calls,
    async create(payload) {
      calls.push({ method: "create", payload });
      return { id: "notebook-1", revision: 1, ...payload };
    },
    async update(id, payload) {
      calls.push({ method: "update", id, payload });
      return { id, revision: payload.baseRevision + 1, ...payload };
    },
  };
}

function createController(options = {}) {
  const timers = options.timers || createFakeTimers();
  const api = options.api || createApi();
  const captures = options.captures || [canvasPayload()];
  let captureIndex = 0;
  const controller = createNotebookController({
    api,
    recovery: options.recovery || { async put() {}, async get() { return null; }, async clear() {} },
    capture: () => captures[Math.min(captureIndex++, captures.length - 1)],
    apply: options.apply || (async () => {}),
    status: options.status || (() => {}),
    debounceMs: 2000,
    timers,
    now: options.now || (() => 1_700_000_000_000),
  });
  return { api, controller, timers };
}

test("coalesces confirmed mutations into one save and tracks the acknowledged revision", async () => {
  const { api, controller, timers } = createController();
  controller.configure({ enabled: true });

  controller.markConfirmedMutation();
  controller.markConfirmedMutation();
  timers.advance(1999);
  assert.equal(api.calls.length, 0);

  timers.advance(1);
  await controller.flush();
  assert.equal(api.calls.length, 1);
  assert.equal(controller.current().revision, 1);
});

test("waits for an in-flight acknowledgment before saving a later mutation", async () => {
  const timers = createFakeTimers();
  const firstSave = deferred();
  const calls = [];
  const api = {
    calls,
    create(payload) {
      calls.push({ method: "create", payload });
      return firstSave.promise;
    },
    async update(id, payload) {
      calls.push({ method: "update", id, payload });
      return { id, revision: payload.baseRevision + 1, ...payload };
    },
  };
  const { controller } = createController({
    api,
    timers,
    captures: [canvasPayload("First"), canvasPayload("Second")],
  });
  controller.configure({ enabled: true });

  controller.markConfirmedMutation();
  timers.advance(2000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);

  controller.markConfirmedMutation();
  timers.advance(2000);
  assert.equal(calls.length, 1);

  firstSave.resolve({ id: "notebook-1", revision: 1, ...canvasPayload("First") });
  await controller.flush();
  timers.advance(2000);
  await controller.flush();

  assert.equal(calls.length, 2);
  assert.equal(calls[1].method, "update");
  assert.equal(calls[1].payload.baseRevision, 1);
  assert.equal(controller.current().revision, 2);
});

test("writes complete recovery state before sending and clears it only after acknowledgment", async () => {
  const events = [];
  let record = null;
  const payload = canvasPayload("Recovered");
  const recovery = {
    async put(value) { events.push("recovery:put"); record = value; },
    async get() { return record; },
    async clear() { events.push("recovery:clear"); record = null; },
  };
  const api = {
    calls: [],
    async create(value) {
      events.push("api:create");
      assert.deepEqual(record.payload, payload);
      return { id: "notebook-1", revision: 1, ...value };
    },
  };
  const { controller } = createController({ api, recovery, captures: [payload] });
  controller.configure({ enabled: true });
  controller.markConfirmedMutation();

  await controller.flush();

  assert.deepEqual(events, ["recovery:put", "api:create", "recovery:clear"]);
  assert.equal(await recovery.get(), null);
});

test("retains recovery state and reports failure when a save fails", async () => {
  let record = null;
  const statuses = [];
  const failure = Error("offline");
  const recovery = {
    async put(value) { record = value; },
    async get() { return record; },
    async clear() { record = null; },
  };
  const api = { calls: [], async create() { throw failure; } };
  const { controller } = createController({ api, recovery, status: (value) => statuses.push(value) });
  controller.configure({ enabled: true });
  controller.markConfirmedMutation();

  await assert.rejects(controller.flush(), failure);

  assert.deepEqual((await recovery.get()).payload, canvasPayload());
  assert.deepEqual(statuses, ["Saving…", "Save failed"]);
});

test("turns a stale update into a complete conflict-copy notebook", async () => {
  const original = { id: "original", revision: 4, ...canvasPayload("Shared") };
  const pending = canvasPayload("Edited");
  const created = [];
  let record = null;
  const statuses = [];
  const api = {
    calls: [],
    async update(id, payload) {
      assert.equal(id, original.id);
      assert.equal(payload.baseRevision, 4);
      const error = Error("conflict");
      error.status = 409;
      error.body = { error: "revision_conflict", current: { id, revision: 5 } };
      throw error;
    },
    async create(payload) {
      created.push(payload);
      return { id: "conflict", revision: 1, ...payload };
    },
  };
  const recovery = {
    async put(value) { record = value; },
    async get() { return record; },
    async clear() { record = null; },
  };
  const { controller } = createController({
    api,
    recovery,
    captures: [pending],
    status: (value) => statuses.push(value),
    now: () => Date.UTC(2026, 6, 18, 12, 34, 56),
  });
  controller.configure({ enabled: true, current: original });
  controller.markConfirmedMutation();

  await controller.flush();

  assert.equal(created.length, 1);
  assert.match(created[0].title, /^Edited — conflict copy /);
  assert.deepEqual({ ...created[0], title: pending.title }, pending);
  assert.deepEqual(original, { id: "original", revision: 4, ...canvasPayload("Shared") });
  assert.equal(controller.current().id, "conflict");
  assert.equal(await recovery.get(), null);
  assert.deepEqual(statuses, ["Saving…", "Conflict copy saved"]);
});

test("retains recovery state when creating the conflict copy fails", async () => {
  let record = null;
  const api = {
    calls: [],
    async update() { const error = Error("conflict"); error.status = 409; throw error; },
    async create() { throw Error("still offline"); },
  };
  const recovery = {
    async put(value) { record = value; },
    async get() { return record; },
    async clear() { record = null; },
  };
  const { controller } = createController({ api, recovery });
  controller.configure({ enabled: true, current: { id: "original", revision: 1, ...canvasPayload() } });
  controller.markConfirmedMutation();

  await assert.rejects(controller.flush(), /still offline/);
  assert.notEqual(await recovery.get(), null);
});

test("rejects an incomplete load response before applying or replacing the current notebook", async () => {
  const original = { id: "original", revision: 1, ...canvasPayload("Original") };
  const applyCalls = [];
  const api = { calls: [], async get() { return { id: "bad", revision: 2, title: "Incomplete" }; } };
  const { controller } = createController({ api, apply: async (payload) => applyCalls.push(payload) });
  controller.configure({ enabled: true, current: original });

  await assert.rejects(controller.load("bad"), /complete notebook/);

  assert.equal(applyCalls.length, 0);
  assert.equal(controller.current(), original);
});

test("replaces the current notebook only after apply finishes decoding", async () => {
  const original = { id: "original", revision: 1, ...canvasPayload("Original") };
  const loaded = { id: "loaded", revision: 3, ...canvasPayload("Loaded") };
  const applying = deferred();
  const api = { calls: [], async get() { return loaded; } };
  const { controller } = createController({ api, apply: () => applying.promise });
  controller.configure({ enabled: true, current: original });

  const loading = controller.load(loaded.id);
  await Promise.resolve();
  assert.equal(controller.current(), original);
  applying.resolve();
  await loading;
  assert.deepEqual(controller.current(), loaded);
});

test("keeps the current canvas when apply cannot decode a loaded notebook", async () => {
  const original = { id: "original", revision: 1, ...canvasPayload("Original") };
  const loaded = { id: "loaded", revision: 3, ...canvasPayload("Loaded") };
  const api = { calls: [], async get() { return loaded; } };
  const { controller } = createController({ api, apply: async () => { throw Error("bad png"); } });
  controller.configure({ enabled: true, current: original });

  await assert.rejects(controller.load(loaded.id), /bad png/);
  assert.equal(controller.current(), original);
});

test("lists, restores, deletes, and explicitly imports complete legacy snapshots", async () => {
  const current = { id: "notebook-1", revision: 2, ...canvasPayload("Current") };
  const restored = { id: "notebook-1", revision: 3, ...canvasPayload("Restored") };
  const legacy = canvasPayload("From device");
  const calls = [];
  const applied = [];
  const api = {
    calls,
    async list() { calls.push({ method: "list" }); return [{ id: current.id, revision: 2, title: current.title }]; },
    async restore(id, payload) { calls.push({ method: "restore", id, payload }); return restored; },
    async delete(id) { calls.push({ method: "delete", id }); return { deleted: true }; },
    async create(payload) { calls.push({ method: "create", payload }); return { id: "imported", revision: 1, ...payload }; },
  };
  const { controller } = createController({ api, apply: async (payload) => applied.push(payload) });
  controller.configure({ enabled: true, current });

  assert.equal((await controller.list())[0].id, current.id);
  await controller.restore(current.id, 1);
  assert.deepEqual(calls[1], {
    method: "restore",
    id: current.id,
    payload: { baseRevision: 2, restoreRevision: 1 },
  });
  assert.deepEqual(applied, [restored]);
  assert.equal(controller.current().revision, 3);

  await controller.delete(current.id);
  assert.equal(controller.current(), null);
  const imported = await controller.importLegacy(legacy);
  assert.equal(imported.id, "imported");
  assert.deepEqual(calls.at(-1).payload, legacy);
  assert.equal(controller.current().id, "imported");
});

test("makes every synchronization operation inert when disabled", async () => {
  const calls = [];
  const api = new Proxy({}, {
    get(_target, method) {
      if (method === "calls") return calls;
      return async () => { calls.push(String(method)); throw Error("disabled operation called API"); };
    },
  });
  const { controller, timers } = createController({ api });
  controller.configure({ enabled: false });

  controller.markConfirmedMutation();
  timers.advance(5000);
  assert.equal(await controller.flush(), null);
  assert.deepEqual(await controller.list(), []);
  assert.equal(await controller.load("id"), null);
  assert.equal(await controller.restore("id", 1), null);
  assert.equal(await controller.delete("id"), false);
  assert.equal(await controller.importLegacy(canvasPayload()), null);
  assert.deepEqual(calls, []);
});

test("HTTP adapter maps notebook operations and preserves structured errors", async () => {
  const calls = [];
  const responses = [
    jsonResponse(200, []),
    jsonResponse(200, { id: "a" }),
    jsonResponse(200, [{ revision: 1 }]),
    jsonResponse(201, { id: "a", revision: 1 }),
    jsonResponse(200, { id: "a", revision: 2 }),
    jsonResponse(200, { id: "a", revision: 3 }),
    jsonResponse(200, { deleted: true }),
    jsonResponse(409, { error: "revision_conflict", current: { id: "a", revision: 4 } }),
  ];
  const api = createNotebookHttpApi({
    fetch: async (url, options = {}) => {
      calls.push({ url, ...options });
      return responses.shift();
    },
  });

  await api.list();
  await api.get("a/b");
  await api.revisions("a");
  await api.create(canvasPayload());
  await api.update("a", { ...canvasPayload(), baseRevision: 1 });
  await api.restore("a", { baseRevision: 2, restoreRevision: 1 });
  await api.delete("a");
  await assert.rejects(api.update("a", { ...canvasPayload(), baseRevision: 3 }), (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.body.current.revision, 4);
    return true;
  });

  assert.deepEqual(calls.map(({ url, method }) => [url, method || "GET"]), [
    ["/api/notebooks", "GET"],
    ["/api/notebooks/a%2Fb", "GET"],
    ["/api/notebooks/a/revisions", "GET"],
    ["/api/notebooks", "POST"],
    ["/api/notebooks/a", "PUT"],
    ["/api/notebooks/a/restore", "POST"],
    ["/api/notebooks/a", "DELETE"],
    ["/api/notebooks/a", "PUT"],
  ]);
  assert.deepEqual(JSON.parse(calls[5].body), { baseRevision: 2, restoreRevision: 1 });
});

test("IndexedDB recovery adapter persists, reads, and clears one pending record", async () => {
  const indexedDB = createFakeIndexedDb();
  const recovery = createIndexedDbRecovery({ indexedDB, databaseName: "test-recovery" });
  const pending = { notebookId: "a", baseRevision: 2, payload: canvasPayload() };

  await recovery.put(pending);
  assert.deepEqual(await recovery.get(), pending);
  await recovery.clear();
  assert.equal(await recovery.get(), null);
});

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return body === null ? "" : JSON.stringify(body); },
  };
}

function createFakeIndexedDb() {
  const databases = new Map();
  return {
    open(name) {
      const request = {};
      queueMicrotask(() => {
        let database = databases.get(name);
        const isNew = !database;
        if (!database) {
          const stores = new Map();
          database = {
            objectStoreNames: { contains: (storeName) => stores.has(storeName) },
            createObjectStore(storeName) { stores.set(storeName, new Map()); },
            transaction(storeName) { return fakeTransaction(stores.get(storeName)); },
          };
          databases.set(name, database);
        }
        request.result = database;
        if (isNew && request.onupgradeneeded) request.onupgradeneeded();
        if (request.onsuccess) request.onsuccess();
      });
      return request;
    },
  };
}

function fakeTransaction(records) {
  const transaction = {
    objectStore() {
      return {
        put(value, key) { return operation(() => records.set(key, structuredClone(value))); },
        get(key) { return operation(() => records.get(key)); },
        delete(key) { return operation(() => records.delete(key)); },
      };
    },
  };
  function operation(action) {
    const request = {};
    queueMicrotask(() => {
      request.result = action();
      if (request.onsuccess) request.onsuccess();
      queueMicrotask(() => { if (transaction.oncomplete) transaction.oncomplete(); });
    });
    return request;
  }
  return transaction;
}
