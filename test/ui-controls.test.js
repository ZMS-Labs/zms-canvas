"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

test("New canvas controls are available in the toolbar and History panel", () => {
  const html = read("public/index.html"), app = read("public/app.js");
  assert.ok(html.indexOf('id="newCanvasBtn"') < html.indexOf('id="historyBtn"'));
  for (const id of ["historyNew", "newCanvasDialog", "newDiscard", "newSaveCopy", "newOverwrite"]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(app, /currentSnapshotId:\s*null/);
  assert.match(app, /saveSnapshot\(\{\s*overwriteId\s*=\s*null,\s*name\s*=\s*null\s*\}/);
  assert.match(app, /completeNewCanvas\("overwrite"\)/);
  assert.match(app, /function startBlankCanvas\(\)/);
});

test("New, Clear, and Debug are accessible theme-aware icon buttons", () => {
  const html = read("public/index.html"), css = read("public/style.css");
  for (const id of ["newCanvasBtn", "clearCanvasBtn", "debugBtn"]) {
    const button = html.match(new RegExp(`<button[^>]*id="${id}"[\\s\\S]*?<\\/button>`))?.[0] || "";
    assert.match(button, /class="[^"]*icon-button[^"]*utility-icon[^"]*"/);
    assert.match(button, /data-i18n-aria=/);
    assert.match(button, /data-i18n-title=/);
    assert.match(button, /<svg /);
    assert.doesNotMatch(button, />\s*(New|Clear|Debug)\s*</);
  }
  for (const theme of ["arcane", "scifi", "research"]) assert.match(html, new RegExp(`value="${theme}"`));
  assert.match(css, /button\.utility-icon:not\(\.active\).*var\(--ink\)/);
  assert.match(css, /button\.utility-icon\.danger:not\(\.active\).*var\(--danger\)/);
});

test("Auto AI exposes a persisted zero-to-ten-second delay control", () => {
  const html = read("public/index.html"), app = read("public/app.js"), css = read("public/style.css");
  assert.match(html, /id="autoDelayRange"[^>]*min="0"[^>]*max="10"[^>]*step="0\.1"/);
  assert.match(app, /penecho-auto-delay-ms/);
  assert.match(app, /penecho-auto-ai/);
  assert.match(app, /setTimeout\(hideAutoDelayControl,\s*5000\)/);
  assert.match(app, /if\s*\(state\.auto\)\s*setAutoEnabled\(false\)/);
  assert.match(app, /else\s*setAutoEnabled\(true,\s*true\)/);
  assert.match(css, /\.auto-delay-popover\[hidden\]\s*\{\s*display:\s*none/);
});

test("New canvas and Auto AI controls have English and Chinese copy", () => {
  const app = read("public/app.js"), zh = read("public/locales/zh.js");
  for (const key of ["autoDelay", "newCanvas", "newCanvasTitle", "saveAsNewAndCreate", "overwriteAndCreate", "newCanvasReady"]) {
    assert.match(app, new RegExp(`${key}:`));
    assert.match(zh, new RegExp(`${key}:`));
  }
});
