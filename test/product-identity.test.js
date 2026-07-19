"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

test("the modified distribution has a distinct ZMS Canvas identity", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.name, "@zms-labs/zms-canvas");
  assert.equal(pkg.bin["zms-canvas"], "cli.js");
  assert.equal(pkg.repository.url, "git+https://github.com/ZMS-Labs/zms-canvas.git");
  assert.match(read("NOTICE"), /based on PenEcho/i);
  assert.match(read("README.md"), /ZMS Canvas/);
  assert.doesNotMatch(read("README.md"), /penecho-readme-header\.png/i);
  assert.match(read("public/index.html"), /ZMS Canvas/);
  assert.ok(read("public/index.html").includes("https://github.com/ZMS-Labs/zms-canvas"));
  assert.match(read("public/locales/zh.js"), /title: "ZMS Canvas \| 手写 AI 画板"/);
  assert.match(read("public/locales/zh.js"), /debugTitle: "ZMS Canvas 调试"/);
  assert.match(read("Dockerfile"), /^FROM node:22-bookworm-slim@sha256:[a-f0-9]{64}$/m);
  assert.match(read("Dockerfile"), /USER 1000:1000/);
  assert.match(read("Dockerfile"), /EXPOSE 3888/);
  assert.match(read("Dockerfile"), /PENECHO_STATE_DIR=\/state/);
  assert.match(read("Dockerfile"), /org\.opencontainers\.image\.source="https:\/\/github\.com\/ZMS-Labs\/zms-canvas"/);
  assert.match(read("Dockerfile"), /org\.opencontainers\.image\.licenses="AGPL-3\.0-only"/);
  assert.match(read("Dockerfile"), /ENTRYPOINT \["node", "\/app\/cli\.js"\]/);
});

test("log rotation operates on one opened file descriptor", () => {
  const server = read("server.js");
  const start = server.indexOf("function log(entry)");
  const block = server.slice(start, server.indexOf("function short", start));

  assert.ok(start >= 0);
  assert.match(block, /fs\.openSync\(LOG_FILE/);
  assert.match(block, /fs\.fstatSync\(descriptor\)/);
  assert.match(block, /fs\.ftruncateSync\(descriptor, 0\)/);
  assert.doesNotMatch(block, /existsSync|statSync\(LOG_FILE\)|renameSync\(LOG_FILE/);
});
