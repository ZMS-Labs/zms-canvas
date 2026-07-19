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
  for (const entry of ["config.env", ".env", ".env.cli", ".env.*", "*.env", "*.sqlite", "logs", "notebooks.sqlite"]) {
    assert.ok(entries.includes(entry), `missing ${entry} from .dockerignore`);
  }
});

test("container documentation supplies runtime configuration without baking secrets", () => {
  const readme = read("README.md");

  assert.match(readme, /--env-file/);
  assert.match(readme, /^AI_PROVIDER=api$/m);
  assert.match(readme, /^AI_API_URL=/m);
  assert.match(readme, /^AI_API_MODEL=/m);
  assert.match(readme, /^AI_API_KEY=/m);
});

test("CI keeps pull-request builds read-only and publishes immutable images only on main", () => {
  const workflow = read(".github/workflows/ci.yml");
  const actions = [...workflow.matchAll(/^\s*uses:\s*([^\s]+)/gm)].map(([, action]) => action);
  const expectedPins = {
    "actions/checkout": "df4cb1c069e1874edd31b4311f1884172cec0e10",
    "actions/setup-node": "249970729cb0ef3589644e2896645e5dc5ba9c38",
    "actions/dependency-review-action": "a1d282b36b6f3519aa1f3fc636f609c47dddb294",
    "github/codeql-action/init": "eec0bff2f6c15bf3f1e8a0152f94d17664a06a06",
    "github/codeql-action/analyze": "eec0bff2f6c15bf3f1e8a0152f94d17664a06a06",
    "docker/setup-qemu-action": "96fe6ef7f33517b61c61be40b68a1882f3264fb8",
    "docker/setup-buildx-action": "bb05f3f5519dd87d3ba754cc423b652a5edd6d2c",
    "docker/login-action": "af1e73f918a031802d376d3c8bbc3fe56130a9b0",
    "docker/metadata-action": "dc802804100637a589fabce1cb79ff13a1411302",
    "docker/build-push-action": "53b7df96c91f9c12dcc8a07bcb9ccacbed38856a",
  };
  const jobBlock = (name) => {
    const start = workflow.indexOf(`  ${name}:`);
    const next = /\n {2}\S[^:\n]*:/.exec(workflow.slice(start + 1));
    return start < 0 ? "" : workflow.slice(start, next ? start + 1 + next.index : undefined);
  };

  assert.ok(actions.length > 0);
  for (const action of actions) assert.match(action, /@[a-f0-9]{40}$/);
  for (const [name, sha] of Object.entries(expectedPins)) assert.ok(actions.includes(`${name}@${sha}`), `missing ${name}@${sha}`);
  assert.match(workflow, /image-build:\n\s+if: github\.event_name == 'pull_request'/);
  assert.match(workflow, /image-publish:\n\s+if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/);
  assert.doesNotMatch(jobBlock("image-build"), /packages: write/);
  assert.match(jobBlock("image-publish"), /packages: write/);
  assert.match(workflow, /type=sha,prefix=sha-,format=long/);
  assert.doesNotMatch(workflow, /value=latest/);
});
