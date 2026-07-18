(function (root, factory) {
  "use strict";
  const notebookApi = factory();
  if (typeof module === "object" && module.exports) module.exports = notebookApi;
  else root.ZMSCanvasNotebooks = notebookApi;
})(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";

  function createNotebookController(options) {
    const api = options.api;
    const recovery = options.recovery || {
      put: function () { return Promise.resolve(); },
      get: function () { return Promise.resolve(null); },
      clear: function () { return Promise.resolve(); },
    };
    const capture = options.capture;
    const apply = options.apply;
    const reportStatus = options.status || function () {};
    const debounceMs = options.debounceMs === undefined ? 2000 : options.debounceMs;
    const timers = options.timers || { setTimeout, clearTimeout };
    const now = options.now || Date.now;
    let enabled = false;
    let currentNotebook = null;
    let dirtyVersion = 0;
    let acknowledgedVersion = 0;
    let timerId = null;
    let inFlight = null;
    let operationTail = Promise.resolve();

    function cancelTimer() {
      if (timerId !== null) timers.clearTimeout(timerId);
      timerId = null;
    }

    function schedule() {
      if (!enabled || inFlight || dirtyVersion === acknowledgedVersion) return;
      cancelTimer();
      timerId = timers.setTimeout(function () {
        timerId = null;
        flush().catch(function () {});
      }, debounceMs);
    }

    function configure(config) {
      enabled = Boolean(config && config.enabled);
      if (config && Object.prototype.hasOwnProperty.call(config, "current")) {
        currentNotebook = config.current;
      }
      if (!enabled) {
        cancelTimer();
        dirtyVersion = acknowledgedVersion;
      }
      return current();
    }

    function markConfirmedMutation() {
      if (!enabled) return;
      dirtyVersion += 1;
      schedule();
    }

    function enqueue(operation) {
      const result = operationTail.then(operation, operation);
      operationTail = result.catch(function () {});
      return result;
    }

    function flush() {
      if (inFlight) return inFlight;
      let saveAcknowledged = false;
      const operation = enqueue(async function () {
        saveAcknowledged = await runSave();
        return currentNotebook;
      });
      const tracked = operation.finally(function () {
        if (inFlight === tracked) {
          inFlight = null;
          if (saveAcknowledged) schedule();
        }
      });
      inFlight = tracked;
      return tracked;
    }

    async function runSave() {
      if (!enabled || dirtyVersion === acknowledgedVersion) return false;
      try {
        cancelTimer();
        const savingVersion = dirtyVersion;
        const original = currentNotebook;
        const payload = copyCanvasPayload(await capture());
        const operationToken = createOperationToken();
        const pending = {
          operationToken,
          notebookId: original ? original.id : null,
          baseRevision: original ? original.revision : null,
          capturedAt: now(),
          payload,
        };
        reportStatus("Saving…");
        await recovery.put(pending);
        try {
          const acknowledged = original && original.id
            ? await api.update(original.id, { ...payload, baseRevision: original.revision })
            : await api.create(payload);
          currentNotebook = copyCompleteNotebook(acknowledged);
          acknowledgedVersion = savingVersion;
          await finishRecovery(operationToken, "Saved");
        } catch (error) {
          if (!original || error.status !== 409) throw error;
          const conflictPayload = {
            ...payload,
            title: makeConflictTitle(payload.title, now()),
          };
          currentNotebook = copyCompleteNotebook(await api.create(conflictPayload));
          acknowledgedVersion = savingVersion;
          await finishRecovery(operationToken, "Conflict copy saved");
        }
        return true;
      } catch (error) {
        reportStatus("Save failed", error);
        throw error;
      }
    }

    async function drainDirty() {
      while (enabled && dirtyVersion !== acknowledgedVersion) await runSave();
    }

    function load(id) {
      return enqueue(async function () {
        await drainDirty();
        return runLoad(id);
      });
    }

    async function runLoad(id) {
      if (!enabled) return Promise.resolve(currentNotebook);
      const notebook = copyCompleteNotebook(await api.get(id));
      await apply(notebook);
      currentNotebook = notebook;
      resetDirtyState();
      return currentNotebook;
    }

    function restore(id, revision) {
      return enqueue(async function () {
        await drainDirty();
        return runRestore(id, revision);
      });
    }

    async function runRestore(id, revision) {
      if (!enabled) return null;
      if (!currentNotebook || currentNotebook.id !== id) {
        throw Error("Restore requires the notebook to be current");
      }
      reportStatus("Saving…");
      try {
        const notebook = copyCompleteNotebook(await api.restore(id, {
          baseRevision: currentNotebook.revision,
          restoreRevision: revision,
        }));
        await apply(notebook);
        currentNotebook = notebook;
        resetDirtyState();
        reportStatus("Saved");
        return currentNotebook;
      } catch (error) {
        reportStatus("Save failed", error);
        throw error;
      }
    }

    function remove(id) {
      return enqueue(async function () {
        if (currentNotebook && currentNotebook.id === id) await drainDirty();
        return runRemove(id);
      });
    }

    async function runRemove(id) {
      if (!enabled) return false;
      const result = await api.delete(id);
      if (currentNotebook && currentNotebook.id === id) {
        currentNotebook = null;
        resetDirtyState();
      }
      return Boolean(result && result.deleted);
    }

    function importLegacy(snapshot) {
      return enqueue(async function () {
        await drainDirty();
        return runImportLegacy(snapshot);
      });
    }

    async function runImportLegacy(snapshot) {
      if (!enabled) return null;
      const payload = copyCanvasPayload(snapshot);
      const operationToken = createOperationToken();
      reportStatus("Saving…");
      await recovery.put({
        operationToken,
        notebookId: null,
        baseRevision: null,
        capturedAt: now(),
        payload,
      });
      try {
        currentNotebook = copyCompleteNotebook(await api.create(payload));
        resetDirtyState();
        await finishRecovery(operationToken, "Saved");
        return currentNotebook;
      } catch (error) {
        reportStatus("Save failed", error);
        throw error;
      }
    }

    async function finishRecovery(operationToken, successStatus) {
      try {
        await recovery.clear(operationToken);
        reportStatus(successStatus);
      } catch (error) {
        reportStatus("Saved with recovery warning", error);
      }
    }

    function list() {
      if (!enabled) return Promise.resolve([]);
      return api.list();
    }

    function resetDirtyState() {
      cancelTimer();
      dirtyVersion = 0;
      acknowledgedVersion = 0;
    }

    function current() {
      return currentNotebook;
    }

    return {
      configure,
      markConfirmedMutation,
      flush,
      load,
      restore,
      delete: remove,
      importLegacy,
      list,
      current,
    };
  }

  function copyCanvasPayload(value) {
    if (!value || typeof value !== "object"
      || typeof value.title !== "string"
      || typeof value.theme !== "string"
      || !isCompleteView(value.view)
      || typeof value.preview !== "string"
      || !Array.isArray(value.tiles)
      || value.tiles.some(function (tile) {
        return !tile || typeof tile !== "object"
          || typeof tile.key !== "string"
          || typeof tile.png !== "string";
      })) {
      throw Error("Expected a complete notebook canvas payload");
    }
    return {
      title: value.title,
      theme: value.theme,
      view: { scale: value.view.scale, panX: value.view.panX, panY: value.view.panY },
      preview: value.preview,
      tiles: value.tiles.map(function (tile) { return { key: tile.key, png: tile.png }; }),
    };
  }

  function copyCompleteNotebook(value) {
    if (!value || typeof value.id !== "string" || !value.id
      || !Number.isInteger(value.revision) || value.revision < 1) {
      throw Error("Expected a complete notebook response");
    }
    return { ...value, ...copyCanvasPayload(value) };
  }

  function isCompleteView(view) {
    return view && typeof view === "object"
      && Number.isFinite(view.scale)
      && Number.isFinite(view.panX)
      && Number.isFinite(view.panY);
  }

  function makeConflictTitle(title, timestamp) {
    const suffix = ` — conflict copy ${new Date(timestamp).toISOString()}`;
    const available = Math.max(0, 80 - [...suffix].length);
    return `${[...title].slice(0, available).join("")}${suffix}`;
  }

  let fallbackOperationCounter = 0;

  function createOperationToken() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
      return globalThis.crypto.randomUUID();
    }
    fallbackOperationCounter += 1;
    return `${Date.now()}-${fallbackOperationCounter}-${Math.random().toString(36).slice(2)}`;
  }

  function createNotebookHttpApi(options) {
    const config = options || {};
    const fetchRequest = config.fetch || globalThis.fetch;
    const baseUrl = (config.baseUrl || "/api/notebooks").replace(/\/$/, "");
    if (typeof fetchRequest !== "function") throw Error("fetch is required");

    async function request(method, path, body) {
      const requestOptions = { method, credentials: "same-origin" };
      if (body !== undefined) {
        requestOptions.headers = { "content-type": "application/json" };
        requestOptions.body = JSON.stringify(body);
      }
      const response = await fetchRequest(`${baseUrl}${path}`, requestOptions);
      const text = await response.text();
      let result = null;
      if (text) {
        try {
          result = JSON.parse(text);
        } catch (_error) {
          const invalid = Error("Notebook API returned invalid JSON");
          invalid.status = response.status;
          throw invalid;
        }
      }
      if (!response.ok) {
        const error = Error(result && (result.message || result.error) || `Notebook request failed (${response.status})`);
        error.status = response.status;
        error.body = result;
        throw error;
      }
      return result;
    }

    function itemPath(id) {
      return `/${encodeURIComponent(id)}`;
    }

    return {
      list: function () { return request("GET", ""); },
      get: function (id) { return request("GET", itemPath(id)); },
      create: function (payload) { return request("POST", "", payload); },
      update: function (id, payload) { return request("PUT", itemPath(id), payload); },
      revisions: function (id) { return request("GET", `${itemPath(id)}/revisions`); },
      restore: function (id, payload) { return request("POST", `${itemPath(id)}/restore`, payload); },
      delete: function (id) { return request("DELETE", itemPath(id)); },
    };
  }

  function createIndexedDbRecovery(options) {
    const config = options || {};
    const indexedDb = config.indexedDB || globalThis.indexedDB;
    const databaseName = config.databaseName || "zms-canvas-notebook-recovery";
    const storeName = config.storeName || "pending-saves";
    if (!indexedDb || typeof indexedDb.open !== "function") throw Error("IndexedDB is required");
    let databasePromise = null;

    function database() {
      if (databasePromise) return databasePromise;
      databasePromise = new Promise(function (resolve, reject) {
        const request = indexedDb.open(databaseName, 1);
        request.onupgradeneeded = function () {
          if (!request.result.objectStoreNames.contains(storeName)) request.result.createObjectStore(storeName);
        };
        request.onsuccess = function () { resolve(request.result); };
        request.onerror = function () { reject(request.error || Error("Could not open recovery database")); };
      });
      return databasePromise;
    }

    async function transact(mode, operation) {
      const db = await database();
      return new Promise(function (resolve, reject) {
        const transaction = db.transaction(storeName, mode);
        const request = operation(transaction.objectStore(storeName));
        let result;
        request.onsuccess = function () { result = request.result; };
        request.onerror = function () { reject(request.error || Error("Recovery record request failed")); };
        transaction.oncomplete = function () { resolve(result === undefined ? null : result); };
        transaction.onerror = function () { reject(transaction.error || Error("Recovery transaction failed")); };
        transaction.onabort = function () { reject(transaction.error || Error("Recovery transaction aborted")); };
      });
    }

    return {
      put: function (record) {
        if (!record || typeof record.operationToken !== "string" || !record.operationToken) {
          return Promise.reject(Error("Recovery operation token is required"));
        }
        return transact("readwrite", function (store) { return store.put(record, record.operationToken); });
      },
      get: function (operationToken) {
        return transact("readonly", function (store) { return store.get(operationToken); });
      },
      list: async function () {
        const records = await transact("readonly", function (store) { return store.getAll(); });
        return records || [];
      },
      clear: function (operationToken) {
        return transact("readwrite", function (store) { return store.delete(operationToken); });
      },
    };
  }

  return { createNotebookController, createNotebookHttpApi, createIndexedDbRecovery };
});
