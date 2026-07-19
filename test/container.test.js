const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("container image is reproducible, non-root, and source-labelled", () => {
  const dockerfile = read("Dockerfile");

  assert.match(dockerfile, /^FROM node:22-bookworm-slim@sha256:/m);
  assert.match(dockerfile, /USER 1000:1000/);
  assert.match(dockerfile, /org\.opencontainers\.image\.source="https:\/\/github\.com\/ZMS-Labs\/zms-canvas"/);
  assert.match(dockerfile, /org\.opencontainers\.image\.licenses="AGPL-3\.0-only"/);
  assert.doesNotMatch(dockerfile, /COPY .*config\.env/);
});

test("container build context excludes runtime state and credentials", () => {
  const ignored = read(".dockerignore");

  const entries = ignored.split(/\r?\n/);
  for (const entry of ["config.env", "*.sqlite", "logs", "notebooks.sqlite"]) {
    assert.ok(entries.includes(entry), `missing ${entry} from .dockerignore`);
  }
});
