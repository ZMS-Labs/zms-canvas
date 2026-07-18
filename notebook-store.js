"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS notebooks (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    title TEXT NOT NULL,
    current_revision INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(owner_id, id)
  );

  CREATE TABLE IF NOT EXISTS notebook_revisions (
    notebook_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    theme TEXT NOT NULL,
    view_scale REAL NOT NULL,
    view_pan_x REAL NOT NULL,
    view_pan_y REAL NOT NULL,
    preview_png BLOB NOT NULL,
    tile_count INTEGER NOT NULL,
    PRIMARY KEY(notebook_id, revision),
    FOREIGN KEY(notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS revision_tiles (
    notebook_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    tile_key TEXT NOT NULL,
    png BLOB NOT NULL,
    PRIMARY KEY(notebook_id, revision, tile_key),
    FOREIGN KEY(notebook_id, revision)
      REFERENCES notebook_revisions(notebook_id, revision) ON DELETE CASCADE
  );
`;

class NotebookConflictError extends Error {
  constructor(currentRevision) {
    super("Notebook revision conflict");
    this.name = "NotebookConflictError";
    this.currentRevision = currentRevision;
  }
}

class NotebookNotFoundError extends Error {
  constructor() {
    super("Notebook not found");
    this.name = "NotebookNotFoundError";
  }
}

function createNotebookStore({
  dbPath,
  revisionLimit = 50,
  now = Date.now,
  randomUUID = crypto.randomUUID,
}) {
  if (!Number.isInteger(revisionLimit) || revisionLimit < 1) {
    throw new RangeError("revisionLimit must be a positive integer");
  }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;");
  db.exec(SCHEMA);

  const insertNotebook = db.prepare(`
    INSERT INTO notebooks (id, owner_id, title, current_revision, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertRevision = db.prepare(`
    INSERT INTO notebook_revisions (
      notebook_id, revision, created_at, theme, view_scale, view_pan_x, view_pan_y,
      preview_png, tile_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertTile = db.prepare(`
    INSERT INTO revision_tiles (notebook_id, revision, tile_key, png)
    VALUES (?, ?, ?, ?)
  `);
  const listNotebooks = db.prepare(`
    SELECT n.id, n.title, n.current_revision, n.created_at, n.updated_at,
           r.theme, r.preview_png, r.tile_count
      FROM notebooks AS n
      JOIN notebook_revisions AS r
        ON r.notebook_id = n.id AND r.revision = n.current_revision
     WHERE n.owner_id = ?
     ORDER BY n.updated_at DESC, n.id ASC
  `);
  const selectRevision = db.prepare(`
    SELECT n.id, n.title, n.created_at, n.updated_at, r.revision,
           r.created_at AS revision_created_at, r.theme, r.view_scale,
           r.view_pan_x, r.view_pan_y, r.preview_png, r.tile_count
      FROM notebooks AS n
      JOIN notebook_revisions AS r ON r.notebook_id = n.id
     WHERE n.owner_id = ? AND n.id = ?
       AND r.revision = COALESCE(?, n.current_revision)
  `);
  const selectTiles = db.prepare(`
    SELECT t.tile_key, t.png
      FROM revision_tiles AS t
      JOIN notebooks AS n ON n.id = t.notebook_id
     WHERE n.owner_id = ? AND n.id = ? AND t.revision = ?
     ORDER BY t.tile_key ASC
  `);
  const selectCurrentRevision = db.prepare(`
    SELECT current_revision
      FROM notebooks
     WHERE owner_id = ? AND id = ?
  `);
  const updateNotebook = db.prepare(`
    UPDATE notebooks
       SET title = ?, current_revision = ?, updated_at = ?
     WHERE owner_id = ? AND id = ? AND current_revision = ?
  `);
  const selectRevisionSummaries = db.prepare(`
    SELECT r.revision, r.created_at, r.theme, r.preview_png, r.tile_count
      FROM notebook_revisions AS r
      JOIN notebooks AS n ON n.id = r.notebook_id
     WHERE n.owner_id = ? AND n.id = ?
     ORDER BY r.revision DESC
  `);
  const pruneRevisions = db.prepare(`
    DELETE FROM notebook_revisions
     WHERE notebook_id = ? AND revision <= ?
       AND EXISTS (
         SELECT 1
           FROM notebooks AS n
          WHERE n.id = notebook_revisions.notebook_id AND n.owner_id = ?
       )
  `);
  const deleteNotebookByOwner = db.prepare(`
    DELETE FROM notebooks
     WHERE owner_id = ? AND id = ?
  `);

  function transaction(work) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function writeRevision(id, revision, timestamp, payload) {
    insertRevision.run(
      id,
      revision,
      timestamp,
      payload.theme,
      payload.view.scale,
      payload.view.panX,
      payload.view.panY,
      payload.preview,
      payload.tiles.length,
    );
    for (const tile of payload.tiles) {
      insertTile.run(id, revision, tile.key, tile.png);
    }
  }

  function list(ownerId) {
    return listNotebooks.all(ownerId).map((row) => ({
      id: row.id,
      title: row.title,
      revision: row.current_revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      theme: row.theme,
      preview: Buffer.from(row.preview_png),
      tileCount: row.tile_count,
    }));
  }

  function create(ownerId, payload) {
    const id = randomUUID();
    const timestamp = now();
    transaction(() => {
      insertNotebook.run(id, ownerId, payload.title, 1, timestamp, timestamp);
      writeRevision(id, 1, timestamp, payload);
    });
    return get(ownerId, id);
  }

  function get(ownerId, id, revision) {
    const row = selectRevision.get(ownerId, id, revision ?? null);
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      revisionCreatedAt: row.revision_created_at,
      theme: row.theme,
      view: {
        scale: row.view_scale,
        panX: row.view_pan_x,
        panY: row.view_pan_y,
      },
      preview: Buffer.from(row.preview_png),
      tiles: selectTiles.all(ownerId, id, row.revision).map((tile) => ({
        key: tile.tile_key,
        png: Buffer.from(tile.png),
      })),
    };
  }

  function requireCurrentRevision(ownerId, id) {
    const row = selectCurrentRevision.get(ownerId, id);
    if (!row) throw new NotebookNotFoundError();
    return row.current_revision;
  }

  function advanceNotebook(ownerId, id, baseRevision, revision, timestamp, title) {
    const result = updateNotebook.run(title, revision, timestamp, ownerId, id, baseRevision);
    if (Number(result.changes) !== 1) {
      const currentRevision = requireCurrentRevision(ownerId, id);
      throw new NotebookConflictError(currentRevision);
    }
  }

  function prune(ownerId, id, newestRevision) {
    const oldestRetainedRevision = newestRevision - revisionLimit + 1;
    if (oldestRetainedRevision > 1) {
      pruneRevisions.run(id, oldestRetainedRevision - 1, ownerId);
    }
  }

  function save(ownerId, id, baseRevision, payload) {
    const revision = transaction(() => {
      const currentRevision = requireCurrentRevision(ownerId, id);
      if (currentRevision !== baseRevision) {
        throw new NotebookConflictError(currentRevision);
      }
      const nextRevision = currentRevision + 1;
      const timestamp = now();
      writeRevision(id, nextRevision, timestamp, payload);
      advanceNotebook(ownerId, id, baseRevision, nextRevision, timestamp, payload.title);
      prune(ownerId, id, nextRevision);
      return nextRevision;
    });
    return get(ownerId, id, revision);
  }

  function listRevisions(ownerId, id) {
    requireCurrentRevision(ownerId, id);
    return selectRevisionSummaries.all(ownerId, id).map((row) => ({
      revision: row.revision,
      createdAt: row.created_at,
      theme: row.theme,
      preview: Buffer.from(row.preview_png),
      tileCount: row.tile_count,
    }));
  }

  function restore(ownerId, id, baseRevision, restoreRevision) {
    const revision = transaction(() => {
      const currentRevision = requireCurrentRevision(ownerId, id);
      if (currentRevision !== baseRevision) {
        throw new NotebookConflictError(currentRevision);
      }
      const source = get(ownerId, id, restoreRevision);
      if (!source) throw new NotebookNotFoundError();
      const nextRevision = currentRevision + 1;
      const timestamp = now();
      writeRevision(id, nextRevision, timestamp, source);
      advanceNotebook(ownerId, id, baseRevision, nextRevision, timestamp, source.title);
      prune(ownerId, id, nextRevision);
      return nextRevision;
    });
    return get(ownerId, id, revision);
  }

  function deleteNotebook(ownerId, id) {
    return transaction(() => {
      requireCurrentRevision(ownerId, id);
      const result = deleteNotebookByOwner.run(ownerId, id);
      if (Number(result.changes) !== 1) throw new NotebookNotFoundError();
      return true;
    });
  }

  return {
    list,
    create,
    get,
    save,
    listRevisions,
    restore,
    delete: deleteNotebook,
    close: () => db.close(),
  };
}

module.exports = {
  createNotebookStore,
  NotebookConflictError,
  NotebookNotFoundError,
};
