"use strict";

const {
  NotebookConflictError,
  NotebookNotFoundError,
} = require("./notebook-store.js");

const API_ROOT = "/api/notebooks";
const UUID = "([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})";
const ITEM_PATH = new RegExp(`^${API_ROOT}/${UUID}$`, "i");
const REVISIONS_PATH = new RegExp(`^${API_ROOT}/${UUID}/revisions$`, "i");
const RESTORE_PATH = new RegExp(`^${API_ROOT}/${UUID}/restore$`, "i");
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const THEMES = new Set(["arcane", "scifi", "research"]);
const CANVAS_SIZE = 20000;
const TILE_SIZE = 512;
const MAX_TILE_INDEX = Math.ceil(CANVAS_SIZE / TILE_SIZE) - 1;
const MAX_TILES = 1600;
const MIN_SCALE = 0.03;
const MAX_SCALE = 2;

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(body));
  return true;
}

function requestError(code) {
  return Object.assign(new Error(code), { code });
}

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    const declaredLength = Number(req.headers["content-length"]);
    if (Number.isFinite(declaredLength) && declaredLength > limit) {
      reject(requestError("body_too_large"));
      req.pause();
      return;
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        if (!settled) {
          settled = true;
          req.pause();
          reject(requestError("body_too_large"));
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      try {
        settled = true;
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        settled = true;
        reject(requestError("invalid_json"));
      }
    });
    req.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalPng(value, bodyLimit) {
  if (typeof value !== "string" || value.length === 0 || value.length > bodyLimit) {
    throw requestError("invalid_payload");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length < PNG_SIGNATURE.length
      || decoded.length > bodyLimit
      || decoded.toString("base64") !== value
      || !decoded.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw requestError("invalid_payload");
  }
  return decoded;
}

function title(value) {
  if (typeof value !== "string") throw requestError("invalid_payload");
  const normalized = value.trim();
  if (!normalized || [...normalized].length > 80) throw requestError("invalid_payload");
  return normalized;
}

function boundedNumber(value, minimum, maximum) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw requestError("invalid_payload");
  }
  return value;
}

function canvasPayload(body, bodyLimit) {
  if (!isPlainObject(body) || Object.hasOwn(body, "ownerId") || Object.hasOwn(body, "owner_id")) {
    throw requestError("invalid_payload");
  }
  if (!THEMES.has(body.theme) || !isPlainObject(body.view) || !Array.isArray(body.tiles) || body.tiles.length > MAX_TILES) {
    throw requestError("invalid_payload");
  }
  const keys = new Set();
  const tiles = body.tiles.map((tile) => {
    if (!isPlainObject(tile) || typeof tile.key !== "string") throw requestError("invalid_payload");
    const match = tile.key.match(/^(0|[1-9]\d*),(0|[1-9]\d*)$/);
    if (!match || Number(match[1]) > MAX_TILE_INDEX || Number(match[2]) > MAX_TILE_INDEX || keys.has(tile.key)) {
      throw requestError("invalid_payload");
    }
    keys.add(tile.key);
    return { key: tile.key, png: canonicalPng(tile.png, bodyLimit) };
  });
  return {
    title: title(body.title),
    theme: body.theme,
    view: {
      scale: boundedNumber(body.view.scale, MIN_SCALE, MAX_SCALE),
      panX: boundedNumber(body.view.panX, -CANVAS_SIZE, CANVAS_SIZE),
      panY: boundedNumber(body.view.panY, -CANVAS_SIZE, CANVAS_SIZE),
    },
    preview: canonicalPng(body.preview, bodyLimit),
    tiles,
  };
}

function revision(value, { allowZero = false } = {}) {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < minimum) throw requestError("invalid_payload");
  return value;
}

function encodeNotebook(notebook) {
  if (!notebook) return null;
  return {
    ...notebook,
    preview: notebook.preview.toString("base64"),
    ...(notebook.tiles ? {
      tiles: notebook.tiles.map((tile) => ({ ...tile, png: tile.png.toString("base64") })),
    } : {}),
  };
}

function notebookSummary(notebook) {
  const { tiles, revisionCreatedAt, ...summary } = encodeNotebook(notebook);
  return summary;
}

function sendBodyTooLarge(req, res) {
  req.pause();
  res.shouldKeepAlive = false;
  res.once("finish", () => req.destroy());
  return sendJson(res, 413, { error: "body_too_large" }, { Connection: "close" });
}

function createNotebookApi({ store, enabled, ownerHeader, bodyLimit }) {
  if (typeof ownerHeader !== "string" || !ownerHeader.trim() || !Number.isSafeInteger(bodyLimit) || bodyLimit < 1) {
    throw new TypeError("Invalid notebook API configuration");
  }
  const trustedHeader = ownerHeader.trim().toLowerCase();
  const notebookConfig = () => ({ enabled: Boolean(enabled) });

  async function handle(req, res, url) {
    const collection = url.pathname === API_ROOT;
    const item = url.pathname.match(ITEM_PATH);
    const revisions = url.pathname.match(REVISIONS_PATH);
    const restore = url.pathname.match(RESTORE_PATH);
    const notebookNamespace = collection || url.pathname.startsWith(`${API_ROOT}/`);
    if (!notebookNamespace) return false;
    if (!enabled) return sendJson(res, 404, { error: "not_found" });

    const ownerValue = req.headers[trustedHeader];
    const ownerId = typeof ownerValue === "string" ? ownerValue.trim() : "";
    if (!ownerId) return sendJson(res, 401, { error: "identity_required" });

    try {
      if (collection && req.method === "GET") {
        return sendJson(res, 200, store.list(ownerId).map(encodeNotebook));
      }
      if (collection && req.method === "POST") {
        const body = await readJson(req, bodyLimit);
        return sendJson(res, 201, encodeNotebook(store.create(ownerId, canvasPayload(body, bodyLimit))));
      }
      if (item && req.method === "GET") {
        const notebook = store.get(ownerId, item[1]);
        return notebook
          ? sendJson(res, 200, encodeNotebook(notebook))
          : sendJson(res, 404, { error: "not_found" });
      }
      if (item && req.method === "PUT") {
        const body = await readJson(req, bodyLimit);
        const baseRevision = revision(body?.baseRevision, { allowZero: true });
        return sendJson(res, 200, encodeNotebook(store.save(
          ownerId,
          item[1],
          baseRevision,
          canvasPayload(body, bodyLimit),
        )));
      }
      if (item && req.method === "DELETE") {
        store.delete(ownerId, item[1]);
        return sendJson(res, 200, { deleted: true });
      }
      if (revisions && req.method === "GET") {
        return sendJson(res, 200, store.listRevisions(ownerId, revisions[1]).map(encodeNotebook));
      }
      if (restore && req.method === "POST") {
        const body = await readJson(req, bodyLimit);
        const baseRevision = revision(body?.baseRevision, { allowZero: true });
        const restoreRevision = revision(body?.restoreRevision);
        return sendJson(res, 200, encodeNotebook(store.restore(
          ownerId,
          restore[1],
          baseRevision,
          restoreRevision,
        )));
      }
      if (collection || item || revisions || restore) {
        return sendJson(res, 405, { error: "method_not_allowed" });
      }
      return sendJson(res, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof NotebookNotFoundError) {
        return sendJson(res, 404, { error: "not_found" });
      }
      if (error instanceof NotebookConflictError) {
        const current = store.get(ownerId, (item || restore)[1]);
        return sendJson(res, 409, {
          error: "revision_conflict",
          current: notebookSummary(current),
        });
      }
      if (error?.code === "body_too_large") {
        return sendBodyTooLarge(req, res);
      }
      if (error?.code === "invalid_json" || error?.code === "invalid_payload") {
        return sendJson(res, 400, { error: error.code === "invalid_json" ? "invalid_json" : "invalid_payload" });
      }
      return sendJson(res, 500, { error: "internal_error" });
    }
  }

  return { handle, notebookConfig };
}

module.exports = { createNotebookApi };
