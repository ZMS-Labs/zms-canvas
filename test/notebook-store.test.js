"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const {
  createNotebookStore,
  NotebookConflictError,
  NotebookNotFoundError,
} = require("../notebook-store.js");

const PNG_BUFFER = Buffer.from("89504e470d0a1a0a00000000", "hex");
const STORE_SOURCE = fs.readFileSync(path.resolve(__dirname, "..", "notebook-store.js"), "utf8");

function canvasPayload(title, marker = 1) {
  return {
    title,
    theme: "research",
    view: { scale: 1.25, panX: 10, panY: -5 },
    preview: Buffer.concat([PNG_BUFFER, Buffer.from([marker])]),
    tiles: [{ key: "0,0", png: Buffer.concat([PNG_BUFFER, Buffer.from([marker])]) }],
  };
}

function fixtureStore(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zms-canvas-store-"));
  const dbPath = path.join(directory, "nested", "notebooks.sqlite");
  const store = createNotebookStore({
    dbPath,
    now: () => 1_720_000_000_000,
    randomUUID: () => "11111111-1111-4111-8111-111111111111",
    ...options,
  });
  return {
    store,
    dbPath,
    close() {
      store.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

function isConflictAt(revision) {
  return (error) => {
    assert.ok(error instanceof NotebookConflictError);
    assert.equal(error.name, "NotebookConflictError");
    assert.equal(error.currentRevision, revision);
    return true;
  };
}

function isNotFound(error) {
  assert.ok(error instanceof NotebookNotFoundError);
  assert.equal(error.name, "NotebookNotFoundError");
  return true;
}

test("creates and reads an owner-scoped notebook revision", () => {
  const fixture = fixtureStore();
  try {
    const created = fixture.store.create("owner-a", canvasPayload("Algebra"));

    assert.equal(created.id, "11111111-1111-4111-8111-111111111111");
    assert.equal(created.revision, 1);
    assert.equal(fixture.store.list("owner-a")[0].title, "Algebra");
    assert.deepEqual(fixture.store.list("owner-b"), []);
    assert.deepEqual(fixture.store.get("owner-a", created.id).tiles[0].png, canvasPayload("Algebra").tiles[0].png);
    assert.equal(fixture.store.get("owner-b", created.id), null);
  } finally {
    fixture.close();
  }
});

test("saves complete immutable revisions and rejects stale or cross-owner writes", () => {
  const fixture = fixtureStore();
  try {
    const created = fixture.store.create("owner-a", canvasPayload("Algebra", 1));
    const saved = fixture.store.save("owner-a", created.id, 1, {
      ...canvasPayload("Geometry", 2),
      theme: "arcane",
      view: { scale: 2, panX: 30, panY: 40 },
      tiles: [
        { key: "0,0", png: Buffer.concat([PNG_BUFFER, Buffer.from([2])]) },
        { key: "1,-1", png: Buffer.concat([PNG_BUFFER, Buffer.from([3])]) },
      ],
    });

    assert.equal(saved.revision, 2);
    assert.equal(saved.title, "Geometry");
    assert.equal(saved.tiles.length, 2);
    assert.equal(fixture.store.get("owner-a", created.id, 1).theme, "research");
    assert.deepEqual(fixture.store.get("owner-a", created.id, 1).tiles, canvasPayload("Algebra", 1).tiles);
    assert.throws(
      () => fixture.store.save("owner-a", created.id, 1, canvasPayload("Stale", 9)),
      isConflictAt(2),
    );
    assert.throws(
      () => fixture.store.save("owner-b", created.id, 2, canvasPayload("Stolen", 9)),
      isNotFound,
    );
    assert.throws(() => fixture.store.listRevisions("owner-b", created.id), isNotFound);
  } finally {
    fixture.close();
  }
});

test("restores a retained revision as a new current revision", () => {
  const fixture = fixtureStore();
  try {
    const first = fixture.store.create("owner-a", canvasPayload("Notebook", 1));
    const second = fixture.store.save("owner-a", first.id, 1, {
      ...canvasPayload("Notebook", 2),
      theme: "scifi",
    });

    const restored = fixture.store.restore("owner-a", first.id, second.revision, 1);

    assert.equal(restored.revision, 3);
    assert.equal(restored.theme, first.theme);
    assert.deepEqual(restored.view, first.view);
    assert.deepEqual(restored.preview, first.preview);
    assert.deepEqual(restored.tiles, first.tiles);
    assert.deepEqual(
      fixture.store.listRevisions("owner-a", first.id).map(({ revision }) => revision),
      [3, 2, 1],
    );
    assert.equal(fixture.store.get("owner-a", first.id, 2).theme, "scifi");
    assert.throws(() => fixture.store.restore("owner-a", first.id, 2, 1), isConflictAt(3));
    assert.throws(() => fixture.store.restore("owner-b", first.id, 3, 1), isNotFound);
  } finally {
    fixture.close();
  }
});

test("retains the newest 50 revisions by default", () => {
  const fixture = fixtureStore();
  try {
    const created = fixture.store.create("owner-a", canvasPayload("Revision 1", 1));
    for (let revision = 2; revision <= 52; revision += 1) {
      fixture.store.save(
        "owner-a",
        created.id,
        revision - 1,
        canvasPayload(`Revision ${revision}`, revision),
      );
    }

    const revisions = fixture.store.listRevisions("owner-a", created.id).map(({ revision }) => revision);
    assert.equal(revisions.length, 50);
    assert.deepEqual(revisions.slice(0, 3), [52, 51, 50]);
    assert.deepEqual(revisions.slice(-3), [5, 4, 3]);
    assert.equal(fixture.store.get("owner-a", created.id, 2), null);
    assert.equal(fixture.store.get("owner-a", created.id).revision, 52);
    assert.throws(() => fixture.store.restore("owner-a", created.id, 52, 1), isNotFound);
    assert.equal(fixture.store.get("owner-a", created.id).revision, 52);
  } finally {
    fixture.close();
  }
});

test("retention pruning binds the owner boundary in SQL", () => {
  assert.match(
    STORE_SOURCE,
    /DELETE FROM notebook_revisions[\s\S]*?EXISTS\s*\([^)]*owner_id = \?[^)]*\)/,
  );
  assert.match(
    STORE_SOURCE,
    /pruneRevisions\.run\(id, oldestRetainedRevision - 1, ownerId\)/,
  );
});

test("owner-scoped deletion cascades through revisions and tiles", () => {
  const fixture = fixtureStore();
  let inspector;
  try {
    const created = fixture.store.create("owner-a", canvasPayload("Delete me", 1));
    fixture.store.save("owner-a", created.id, 1, canvasPayload("Delete me", 2));

    assert.throws(() => fixture.store.delete("owner-b", created.id), isNotFound);
    assert.equal(fixture.store.get("owner-a", created.id).revision, 2);
    assert.equal(fixture.store.delete("owner-a", created.id), true);
    assert.equal(fixture.store.get("owner-a", created.id), null);

    inspector = new DatabaseSync(fixture.dbPath, { readOnly: true });
    assert.equal(inspector.prepare("SELECT COUNT(*) AS count FROM notebooks").get().count, 0);
    assert.equal(inspector.prepare("SELECT COUNT(*) AS count FROM notebook_revisions").get().count, 0);
    assert.equal(inspector.prepare("SELECT COUNT(*) AS count FROM revision_tiles").get().count, 0);
  } finally {
    inspector?.close();
    fixture.close();
  }
});

test("rolls back a failed save without advancing the current revision", () => {
  const fixture = fixtureStore();
  try {
    const created = fixture.store.create("owner-a", canvasPayload("Atomic", 1));
    const invalidPayload = {
      ...canvasPayload("Partial", 2),
      tiles: [
        { key: "0,0", png: Buffer.from(PNG_BUFFER) },
        { key: "0,0", png: Buffer.from(PNG_BUFFER) },
      ],
    };

    assert.throws(() => fixture.store.save("owner-a", created.id, 1, invalidPayload));
    assert.equal(fixture.store.get("owner-a", created.id).revision, 1);
    assert.deepEqual(
      fixture.store.listRevisions("owner-a", created.id).map(({ revision }) => revision),
      [1],
    );
    assert.equal(fixture.store.save("owner-a", created.id, 1, canvasPayload("Recovered", 3)).revision, 2);
  } finally {
    fixture.close();
  }
});

test("rolls back a failed create without leaving a partial notebook", () => {
  const fixture = fixtureStore();
  try {
    const invalidPayload = {
      ...canvasPayload("Partial", 1),
      tiles: [
        { key: "0,0", png: Buffer.from(PNG_BUFFER) },
        { key: "0,0", png: Buffer.from(PNG_BUFFER) },
      ],
    };

    assert.throws(() => fixture.store.create("owner-a", invalidPayload));
    assert.deepEqual(fixture.store.list("owner-a"), []);
    assert.equal(fixture.store.create("owner-a", canvasPayload("Recovered", 2)).revision, 1);
  } finally {
    fixture.close();
  }
});
