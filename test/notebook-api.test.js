"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { createNotebookApi } = require("../notebook-api.js");
const { createNotebookStore } = require("../notebook-store.js");

const PNG = Buffer.from("89504e470d0a1a0a00000000", "hex").toString("base64");

function payload(title = "Notebook") {
  return {
    title,
    theme: "research",
    view: { scale: 1.25, panX: 10, panY: -5 },
    preview: PNG,
    tiles: [{ key: "0,0", png: PNG }],
  };
}

async function fixtureServer(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zms-canvas-api-"));
  const store = createNotebookStore({ dbPath: path.join(directory, "notebooks.sqlite") });
  const api = createNotebookApi({
    store,
    enabled: true,
    ownerHeader: "x-authentik-uid",
    bodyLimit: options.bodyLimit ?? 64 * 1024 * 1024,
  });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (!(await api.handle(req, res, url))) {
      res.writeHead(418);
      res.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    server,
    origin: `http://127.0.0.1:${server.address().port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      store.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function request(fixture, method, pathname, body, headers = {}) {
  const response = await fetch(`${fixture.origin}${pathname}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text ? JSON.parse(text) : null,
  };
}

async function rawRequest(fixture, method, pathname, body, headers = {}) {
  const response = await fetch(`${fixture.origin}${pathname}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function createNotebook(fixture, owner = "owner-a") {
  const response = await request(fixture, "POST", "/api/notebooks", payload(), {
    "x-authentik-uid": owner,
  });
  assert.equal(response.status, 201);
  return response.body;
}

test("requires the configured trusted identity header", async () => {
  const fixture = await fixtureServer();
  try {
    const response = await request(fixture, "GET", "/api/notebooks");
    assert.equal(response.status, 401);
  } finally {
    await fixture.close();
  }
});

test("does not disclose another owner's notebook", async () => {
  const fixture = await fixtureServer();
  try {
    const created = await createNotebook(fixture, "owner-a");
    const response = await request(fixture, "GET", `/api/notebooks/${created.id}`, undefined, {
      "x-authentik-uid": "owner-b",
    });
    assert.equal(response.status, 404);
  } finally {
    await fixture.close();
  }
});

test("supports create, list, save, revision history, restore, and delete", async () => {
  const fixture = await fixtureServer();
  try {
    const createdResponse = await request(fixture, "POST", "/api/notebooks", payload("  Algebra  "), {
      "x-authentik-uid": "owner-a",
    });
    assert.equal(createdResponse.status, 201);
    assert.equal(createdResponse.headers.get("cache-control"), "no-store");
    assert.equal(createdResponse.body.title, "Algebra");
    assert.equal(createdResponse.body.revision, 1);

    const listed = await request(fixture, "GET", "/api/notebooks", undefined, {
      "x-authentik-uid": "owner-a",
    });
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.map(({ id }) => id), [createdResponse.body.id]);

    const saved = await request(fixture, "PUT", `/api/notebooks/${createdResponse.body.id}`, {
      ...payload("Geometry"),
      baseRevision: 1,
      theme: "scifi",
    }, { "x-authentik-uid": "owner-a" });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.revision, 2);
    assert.equal(saved.body.theme, "scifi");

    const current = await request(fixture, "GET", `/api/notebooks/${createdResponse.body.id}`, undefined, {
      "x-authentik-uid": "owner-a",
    });
    assert.equal(current.status, 200);
    assert.deepEqual(current.body.tiles, payload().tiles);

    const revisions = await request(fixture, "GET", `/api/notebooks/${createdResponse.body.id}/revisions`, undefined, {
      "x-authentik-uid": "owner-a",
    });
    assert.equal(revisions.status, 200);
    assert.deepEqual(revisions.body.map(({ revision }) => revision), [2, 1]);

    const restored = await request(fixture, "POST", `/api/notebooks/${createdResponse.body.id}/restore`, {
      baseRevision: 2,
      restoreRevision: 1,
    }, { "x-authentik-uid": "owner-a" });
    assert.equal(restored.status, 200);
    assert.equal(restored.body.revision, 3);
    assert.equal(restored.body.theme, "research");

    const deleted = await request(fixture, "DELETE", `/api/notebooks/${createdResponse.body.id}`, undefined, {
      "x-authentik-uid": "owner-a",
    });
    assert.equal(deleted.status, 200);
    assert.deepEqual(deleted.body, { deleted: true });
    assert.equal((await request(fixture, "GET", `/api/notebooks/${createdResponse.body.id}`, undefined, {
      "x-authentik-uid": "owner-a",
    })).status, 404);
  } finally {
    await fixture.close();
  }
});

test("returns the current revision summary for a stale save", async () => {
  const fixture = await fixtureServer();
  try {
    const created = await createNotebook(fixture);
    const response = await request(fixture, "PUT", `/api/notebooks/${created.id}`, {
      ...payload(),
      baseRevision: 0,
    }, { "x-authentik-uid": "owner-a" });
    assert.equal(response.status, 409);
    assert.equal(response.body.error, "revision_conflict");
    assert.equal(response.body.current.revision, 1);
    assert.equal(response.body.current.id, created.id);
    assert.equal(response.body.current.tiles, undefined);
  } finally {
    await fixture.close();
  }
});

test("rejects malformed canvas payloads before storage", async () => {
  const fixture = await fixtureServer();
  try {
    const owner = { "x-authentik-uid": "owner-a" };
    const cases = [
      { ...payload(), title: "x".repeat(81) },
      { ...payload(), theme: "other" },
      { ...payload(), view: { scale: 0, panX: 0, panY: 0 } },
      { ...payload(), view: { scale: 1, panX: 20001, panY: 0 } },
      { ...payload(), preview: `${PNG}\n` },
      { ...payload(), preview: Buffer.from("not a png").toString("base64") },
      { ...payload(), tiles: [{ key: "99,99", png: PNG }] },
      { ...payload(), tiles: [{ key: "0,0", png: PNG }, { key: "0,0", png: PNG }] },
      { ...payload(), tiles: Array.from({ length: 1601 }, (_, index) => ({ key: `${index % 40},${Math.floor(index / 40)}`, png: PNG })) },
    ];
    for (const invalid of cases) {
      const response = await request(fixture, "POST", "/api/notebooks", invalid, owner);
      assert.equal(response.status, 400);
      assert.equal(response.body.error, "invalid_payload");
    }
  } finally {
    await fixture.close();
  }
});

test("enforces the configured independent notebook body limit", async () => {
  const fixture = await fixtureServer({ bodyLimit: 128 });
  try {
    const response = await rawRequest(
      fixture,
      "POST",
      "/api/notebooks",
      JSON.stringify({ padding: "x".repeat(256) }),
      { "x-authentik-uid": "owner-a" },
    );
    assert.equal(response.status, 413);
    assert.equal(response.body.error, "body_too_large");
  } finally {
    await fixture.close();
  }
});

test("matches only exact notebook routes and rejects non-UUID item paths", async () => {
  const fixture = await fixtureServer();
  try {
    assert.equal((await request(fixture, "GET", "/api/notebooks-extra")).status, 418);
    assert.equal((await request(fixture, "GET", "/api/notebooks/not-a-uuid", undefined, {
      "x-authentik-uid": "owner-a",
    })).status, 404);
    assert.equal((await request(fixture, "GET", "/api/notebooks/11111111-1111-4111-8111-111111111111/extra", undefined, {
      "x-authentik-uid": "owner-a",
    })).status, 404);
  } finally {
    await fixture.close();
  }
});

test("advertises notebook capability without requiring an enabled store", () => {
  const api = createNotebookApi({
    store: null,
    enabled: false,
    ownerHeader: "x-authentik-uid",
    bodyLimit: 64 * 1024 * 1024,
  });
  assert.deepEqual(api.notebookConfig(), { enabled: false });
});
