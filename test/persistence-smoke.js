"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const ownerHeader = { "x-authentik-uid": "persistence-smoke-owner" };
const png = Buffer.from("89504e470d0a1a0a00000000", "hex").toString("base64");

function payload(title = "Persistence smoke") {
  return {
    title,
    theme: "research",
    view: { scale: 1.25, panX: 10, panY: -5 },
    preview: png,
    tiles: [{ key: "0,0", png }],
  };
}

function startServer(stateDir) {
  const child = spawn(process.execPath, [path.join(root, "cli.js")], {
    cwd: root,
    env: {
      ...process.env,
      AI_PROVIDER: "api",
      AI_API_URL: "http://127.0.0.1:9/v1",
      AI_API_MODEL: "persistence-smoke-model",
      AI_API_KEY: "persistence-smoke-key",
      HOST: "127.0.0.1",
      PORT: "0",
      PENECHO_STATE_DIR: stateDir,
      PENECHO_NOTEBOOKS_ENABLED: "true",
      PENECHO_NOTEBOOKS_DB: path.join(stateDir, "notebooks.sqlite"),
      PENECHO_NOTEBOOKS_OWNER_HEADER: "x-authentik-uid",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => finish(new Error(`server did not start: ${output}`)), 10000);
    const finish = (error, value) => {
      clearTimeout(timeout);
      child.stdout.removeAllListeners("data");
      child.stderr.removeAllListeners("data");
      child.removeAllListeners("exit");
      if (error) reject(error);
      else resolve(value);
    };
    child.stdout.on("data", chunk => {
      output += chunk.toString("utf8");
      const match = output.match(/ZMS Canvas: http:\/\/[^:]+:(\d+)/);
      if (match) finish(null, { child, origin: `http://127.0.0.1:${match[1]}` });
    });
    child.stderr.on("data", chunk => { output += chunk.toString("utf8"); });
    child.once("exit", code => finish(new Error(`server exited before listening (${code}): ${output}`)));
  });
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    child.once("exit", resolve);
    child.kill();
  });
}

async function request(origin, method, pathname, body) {
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers: {
      ...ownerHeader,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function exercise() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "zms-canvas-persistence-smoke-"));
  let first;
  let second;
  try {
    first = await startServer(stateDir);
    assert.equal((await fetch(`${first.origin}/api/notebooks`)).status, 401, "identity header must be required");

    const created = await request(first.origin, "POST", "/api/notebooks", payload());
    assert.equal(created.status, 201, "create must succeed");
    assert.equal(created.body.revision, 1);

    const loaded = await request(first.origin, "GET", `/api/notebooks/${created.body.id}`);
    assert.equal(loaded.status, 200, "load must succeed");
    assert.equal(loaded.body.revision, 1);

    const updated = await request(first.origin, "PUT", `/api/notebooks/${created.body.id}`, {
      ...payload("Updated persistence smoke"),
      theme: "scifi",
      baseRevision: 1,
    });
    assert.equal(updated.status, 200, "update must succeed");
    assert.equal(updated.body.revision, 2);

    const conflict = await request(first.origin, "PUT", `/api/notebooks/${created.body.id}`, {
      ...payload(),
      baseRevision: 1,
    });
    assert.equal(conflict.status, 409, "stale update must conflict");

    const restored = await request(first.origin, "POST", `/api/notebooks/${created.body.id}/restore`, {
      baseRevision: 2,
      restoreRevision: 1,
    });
    assert.equal(restored.status, 200, "restore must succeed");
    assert.equal(restored.body.revision, 3);
    await stopServer(first.child);
    first = null;

    second = await startServer(stateDir);
    const reloaded = await request(second.origin, "GET", `/api/notebooks/${created.body.id}`);
    assert.equal(reloaded.status, 200, "reload after restart must succeed");
    assert.equal(reloaded.body.revision, 3);
    assert.equal(reloaded.body.theme, "research");
    console.log("persistence smoke passed: create/load/update/conflict/restore/restart/reload");
  } finally {
    if (first) await stopServer(first.child);
    if (second) await stopServer(second.child);
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

exercise().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
