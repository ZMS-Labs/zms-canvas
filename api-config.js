"use strict";

function resolveApiConfig(value, formatOverride) {
  if (!value) return null;
  const requestedFormat = String(formatOverride || "").trim().toLowerCase();
  if (requestedFormat && !["openai", "anthropic"].includes(requestedFormat)) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    url.hash = "";
    const basePath = url.pathname.replace(/\/+$/, ""), path = basePath.toLowerCase(),
      explicitAnthropic = path.endsWith("/v1/messages"), explicitOpenAi = path.endsWith("/chat/completions");
    if (requestedFormat === "openai" && explicitAnthropic || requestedFormat === "anthropic" && explicitOpenAi) return null;
    if (explicitAnthropic) {
      url.pathname = basePath;
      return { format: "anthropic", endpoint: url.href };
    }
    if (explicitOpenAi) {
      url.pathname = basePath;
      return { format: "openai", endpoint: url.href };
    }
    const openaiBase = path.endsWith("/v1") || /\/(?:v1beta\/)?openai$/i.test(path),
      format = requestedFormat || (openaiBase ? "openai" : "anthropic");
    url.pathname = format === "openai" ? `${basePath}/chat/completions` : `${basePath}/v1/messages`;
    return { format, endpoint: url.href };
  } catch {
    return null;
  }
}

module.exports = { resolveApiConfig };
