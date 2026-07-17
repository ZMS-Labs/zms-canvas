"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { discoverConfiguredModel, runConfigureMenu } = require("../configure-ui.js");

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "penecho-configure-ui-"));
  test.after(() => fs.rmSync(directory, { recursive:true, force:true }));
  return directory;
}

function uiScript({ selections = [], inputs = [], confirms = [], passwords = [] } = {}) {
  const headers = [], notes = [];
  return {
    interactive:true,
    select:async () => { assert.ok(selections.length, "unexpected select"); return selections.shift(); },
    input:async (_message, fallback = "") => inputs.length ? inputs.shift() : fallback,
    confirm:async (_message, fallback = false) => confirms.length ? confirms.shift() : fallback,
    password:async () => passwords.length ? passwords.shift() : "",
    header:(title, breadcrumb, detail) => headers.push({ title, breadcrumb, detail }),
    note:(title, message, kind) => notes.push({ title, message, kind }),
    pause:async () => {},
    headers,
    notes,
  };
}

test("main menu provides LLM source and Settings navigation with a parent return", async () => {
  const directory = temporaryDirectory(), configuration = {
    home:directory,
    stateDir:path.join(directory, ".penecho"),
    configFile:path.join(directory, ".penecho", "config.env"),
    env:{ AI_PROVIDER:"codex-cli", AI_TIMEOUT_SECONDS:"180", HOST:"0.0.0.0", PORT:"3888", AUTO_AI_DELAY_SECONDS:"1.2" },
  }, saved = [];
  const ui = uiScript({
    selections:["llm", "__back__", "settings", "webp", "127.0.0.1", "save", "exit"],
    inputs:["180", "25", "3999", "5.3"],
    confirms:[true],
  });
  await runConfigureMenu(configuration, {
    ui,
    save:async values => { saved.push(values); for (const [key, value] of Object.entries(values)) if (value !== null) configuration.env[key] = value; },
    test:async () => "ok",
  });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].AI_TIMEOUT_SECONDS, "180");
  assert.equal(saved[0].PENECHO_AI_IMAGE_FORMAT, "webp");
  assert.equal(saved[0].PENECHO_REQUEST_TRACE, "true");
  assert.equal(saved[0].PENECHO_REQUEST_TRACE_LIMIT, "25");
  assert.equal(saved[0].HOST, "127.0.0.1");
  assert.equal(saved[0].PORT, "3999");
  assert.equal(saved[0].AUTO_AI_DELAY_SECONDS, "5.3");
  assert.ok(ui.headers.some(item => item.title === "LLM source"));
  assert.ok(ui.headers.some(item => item.title === "Settings" && /logs.*requests/.test(item.detail)));
  assert.ok(ui.notes.some(item => /canvas/.test(item.message)));
});

test("provider pages include the requested model quality guidance", async () => {
  const directory = temporaryDirectory(), configuration = {
    home:directory, stateDir:path.join(directory, ".penecho"), configFile:path.join(directory, "config.env"), env:{},
  };
  const claudeUi = uiScript({ selections:["opus", "max", "cancel"] });
  await runConfigureMenu(configuration, { ui:claudeUi, directProvider:"claude-cli", save:async () => {}, test:async () => "ok" });
  assert.match(claudeUi.headers[0].detail, /Opus 4\.8 or newer/);
  assert.match(claudeUi.headers[0].detail, /Sonnet and Opus 4\.6/);

  const codexUi = uiScript({ selections:["gpt-5.6-sol", "xhigh", "cancel"] });
  await runConfigureMenu(configuration, { ui:codexUi, directProvider:"codex-cli", save:async () => {}, test:async () => "ok" });
  assert.match(codexUi.headers[0].detail, /GPT-5\.5 or newer/);
  assert.match(codexUi.headers[0].detail, /gpt-5\.6-sol/);
  assert.match(codexUi.headers[0].detail, /xhigh/);
});

test("configured CLI models are discovered when local settings expose them", () => {
  const home = temporaryDirectory();
  fs.mkdirSync(path.join(home, ".codex"), { recursive:true });
  fs.mkdirSync(path.join(home, ".claude"), { recursive:true });
  fs.writeFileSync(path.join(home, ".codex", "config.toml"), 'model = "gpt-detected"\n');
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ model:"claude-detected" }));
  assert.equal(discoverConfiguredModel("codex-cli", { home }), "gpt-detected");
  assert.equal(discoverConfiguredModel("claude-cli", { home }), "claude-detected");
});
