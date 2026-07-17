"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveApiConfig } = require("../api-config.js");

test("API format selection builds the matching endpoint", () => {
  assert.deepEqual(resolveApiConfig("https://api.openai.com/v1", "openai"), {
    format:"openai", endpoint:"https://api.openai.com/v1/chat/completions",
  });
  assert.deepEqual(resolveApiConfig("https://api.anthropic.com", "anthropic"), {
    format:"anthropic", endpoint:"https://api.anthropic.com/v1/messages",
  });
});

test("explicit API endpoints must agree with the selected format", () => {
  assert.equal(resolveApiConfig("https://example.test/v1/messages", "openai"), null);
  assert.equal(resolveApiConfig("https://example.test/v1/chat/completions", "anthropic"), null);
  assert.equal(resolveApiConfig("https://user:secret@example.test/v1", "openai"), null);
});
