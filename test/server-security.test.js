"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PERSONA = "Warm interdisciplinary knowledge guide. Favor intuition, memorable analogies, creative synthesis, conceptual connections across science and humanities, and exploratory alternatives while keeping facts and reasoning precise.";
const TEST_CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "penecho-test-codex-home-"));
fs.writeFileSync(path.join(TEST_CODEX_HOME, "auth.json"), '{"auth_mode":"test"}');
test.after(() => fs.rmSync(TEST_CODEX_HOME, { recursive:true, force:true }));

function serverEnv(overrides = {}) {
  return {
    ...process.env,
    AI_PROVIDER: "codex-cli",
    HOST: "127.0.0.1",
    PORT: "0",
    CODEX_HOME: TEST_CODEX_HOME,
    CODEX_CLI_MAX_CONCURRENCY: "1",
    ...overrides,
  };
}

function apiServerEnv(origin, overrides = {}) {
  return {
    ...process.env,
    AI_PROVIDER: "api",
    HOST: "127.0.0.1",
    PORT: "0",
    OPENAI_API_KEY: "test-key",
    OPENAI_PRO_API_KEY: "",
    OPENAI_API_URL: `${origin}/v1`,
    OPENAI_MODEL: "test-model",
    ...overrides,
  };
}

function startApiServer(responseContent = '{"intent":"none","commands":[]}') {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      requests.push(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "Content-Type":"application/json" });
      res.end(JSON.stringify({ choices:[{ message:{ content:responseContent } }] }));
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, requests, origin:`http://127.0.0.1:${server.address().port}` }));
  });
}

function startServer(env) {
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  return new Promise((resolve, reject) => {
    let stdout = "", stderr = "";
    const timeout = setTimeout(() => finish(new Error(`Server did not start.\n${stdout}\n${stderr}`)), 10000);
    const finish = (error, value) => {
      clearTimeout(timeout);
      child.stdout.removeAllListeners("data");
      child.stderr.removeAllListeners("data");
      child.removeAllListeners("exit");
      if (error) reject(error);
      else resolve(value);
    };
    child.stdout.on("data", chunk => {
      stdout += chunk.toString("utf8");
      const match = stdout.match(/PenEcho: http:\/\/[^:]+:(\d+)/);
      if (match) finish(null, { child, origin: `http://127.0.0.1:${match[1]}` });
    });
    child.stderr.on("data", chunk => { stderr += chunk.toString("utf8"); });
    child.once("exit", code => finish(new Error(`Server exited before listening (${code}).\n${stdout}\n${stderr}`)));
  });
}

function rawRequest(port, pathText, headers = {}) {
  const net = require("node:net");
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
      const headerLines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`).join("\r\n");
      socket.write(`GET ${pathText} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n${headerLines}\r\n\r\n`);
    });
    let response = "";
    socket.setEncoding("utf8");
    socket.on("data", chunk => { response += chunk; });
    socket.on("end", () => resolve(response));
    socket.on("error", reject);
  });
}

function httpRequest(origin, { method = "GET", pathText = "/", headers = {}, body = "" } = {}) {
  const http = require("node:http"), target = new URL(origin);
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: target.hostname, port: target.port, method, path: pathText, headers }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise(resolve => child.once("exit", resolve));
  child.kill();
  await closed;
}

function validPayload() {
  const box = { x: 0, y: 0, w: 1, h: 1 };
  return {
    atlasImage: PNG,
    atlasSize: { w: 1, h: 1 },
    imageScale: 1,
    changedBox: box,
    visibleRect: box,
    captureRect: box,
    sourceRect: box,
    focusInset: null,
    hotspotGrid: { columns: 8, rows: 8, order: "oldest-to-newest", hotspots: [{ cell: [0, 0], imageRect: box }] },
    trigger: "user_paused",
    userAction: "auto",
    canvasSize: { w: 20000, h: 20000 },
    uiTheme: "arcane",
    persona: PERSONA,
  };
}

test("minimal API and Codex environment files enable localhost and LAN directly", () => {
  const api = fs.readFileSync(path.join(ROOT, "env.api.example"), "utf8"), codex = fs.readFileSync(path.join(ROOT, "env.codex.example"), "utf8");
  assert.match(api, /^AI_PROVIDER=api$/m);
  assert.match(codex, /^AI_PROVIDER=codex-cli$/m);
  for (const example of [api, codex]) {
    assert.match(example, /^HOST=0\.0\.0\.0$/m);
    assert.match(example, /^PORT=3888$/m);
    assert.doesNotMatch(example, /PUBLIC_ORIGIN|ALLOW_REMOTE|LOCAL_PROVIDER|\bOSS\b/i);
  }
});

test("Codex CLI mode starts with no extra access or model-provider settings", { timeout: 10000 }, async () => {
  const {child,origin}=await startServer(serverEnv({HOST:"0.0.0.0"}));
  try {
    const localPage=await fetch(origin);
    assert.equal(localPage.status,200);
    assert.ok(localPage.headers.get("set-cookie"));
  } finally { await stopServer(child); }
});

test("Codex process launches require a same-origin session and release concurrency after failure", { timeout: 20000 }, async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "penecho-server-test-"));
  const fakeCli = path.join(directory, "fake-codex.js");
  await fs.promises.writeFile(fakeCli, "process.stderr.write('expected test failure'); process.exit(2);\n");
  const { child, origin } = await startServer(serverEnv({ CODEX_CLI_PATH: fakeCli }));
  try {
    const page = await fetch(`${origin}/`), setCookie = page.headers.get("set-cookie"), cookie = setCookie?.split(";", 1)[0];
    assert.equal(page.status, 200);
    assert.match(setCookie || "", /HttpOnly/);
    assert.match(setCookie || "", /SameSite=Strict/);
    assert.ok(cookie);
    assert.match(page.headers.get("content-security-policy") || "", /script-src 'self'/);

    const wrongHost = await httpRequest(origin, { headers: { Host: "attacker.example" } });
    assert.equal(wrongHost.status, 421);
    assert.equal(wrongHost.headers["set-cookie"], undefined);

    const debugLog = await fetch(`${origin}/api/debug/log`);
    const debugAtlas = await fetch(`${origin}/api/debug/atlas`);
    assert.equal(debugLog.status, 404);
    assert.equal(debugAtlas.status, 404);

    const withoutSession = await fetch(`${origin}/api/ai/command`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: "{}" });
    assert.equal(withoutSession.status, 403);

    const wrongType = await fetch(`${origin}/api/ai/command`, { method: "POST", headers: { "Content-Type": "text/plain", Cookie: cookie, Origin: origin }, body: "{}" });
    assert.equal(wrongType.status, 415);

    const crossSite = await fetch(`${origin}/api/ai/command`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie, Origin: "https://evil.example" }, body: "{}" });
    assert.equal(crossSite.status, 403);

    const authorizedInvalid = await fetch(`${origin}/api/ai/command`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie, Origin: origin }, body: "{}" });
    assert.equal(authorizedInvalid.status, 400);

    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(`${origin}/api/ai/command`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie, Origin: origin }, body: JSON.stringify(validPayload()) });
      assert.equal(response.status, 502);
      const body = await response.json();
      assert.match(body.error, /exit code 2/);
    }

    const port = Number(new URL(origin).port), malformed = await rawRequest(port, "/%");
    assert.match(malformed, /^HTTP\/1\.1 400 /);
    const healthy = await fetch(`${origin}/`);
    assert.equal(healthy.status, 200);
  } finally {
    await stopServer(child);
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("API mode preserves unrestricted remote request behavior", { timeout: 20000 }, async () => {
  const upstream = await startApiServer(), { child, origin } = await startServer(apiServerEnv(upstream.origin));
  try {
    const deadline = Date.now() + 5000;
    while (!upstream.requests.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(upstream.requests.length);
    const page = await httpRequest(origin,{headers:{Host:"my-pc:3888"}}), before = upstream.requests.length, body=JSON.stringify(validPayload());
    assert.equal(page.status,200);
    assert.equal(page.headers["set-cookie"],undefined);
    const remote = await httpRequest(origin,{method:"POST",pathText:"/api/ai/command",headers:{Host:"my-pc:3888",Origin:"https://unrelated.example","Content-Type":"text/plain","Content-Length":Buffer.byteLength(body)},body});
    assert.equal(remote.status,200);
    assert.equal(upstream.requests.length, before + 1);
  } finally {
    await stopServer(child);
    await new Promise(resolve => upstream.server.close(resolve));
  }
});

test("API mode does not retry or reject a valid in-canvas draw because of aggregate area", { timeout: 20000 }, async () => {
  const responseContent=JSON.stringify({intent:"plot",commands:[{tool:"draw",origin:[100,100],types:["rect"],items:[[0,0,4000,4000]]}]}),upstream=await startApiServer(responseContent),{child,origin}=await startServer(apiServerEnv(upstream.origin));
  try {
    const payload=validPayload();payload.trigger="manual";payload.userAction="plot";
    const response=await fetch(`${origin}/api/ai/command`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)}),body=await response.json();
    assert.equal(response.status,200);
    assert.equal(body.attempts,1);
    assert.equal(body.commands[0]?.tool,"draw");
  } finally {
    await stopServer(child);
    await new Promise(resolve=>upstream.server.close(resolve));
  }
});

test("a replacement Codex request waits for cancelled process cleanup", { timeout: 20000 }, async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "penecho-replacement-test-")), fakeCli = path.join(directory, "fake-codex.js"), countFile = path.join(directory, "count.txt"), startedFile = path.join(directory, "started.txt");
  await fs.promises.writeFile(fakeCli, `"use strict";const fs=require("node:fs"),path=require("node:path"),root=__dirname,countFile=path.join(root,"count.txt"),count=Number(fs.existsSync(countFile)?fs.readFileSync(countFile,"utf8"):0)+1;fs.writeFileSync(countFile,String(count));if(count===1){fs.writeFileSync(path.join(root,"started.txt"),"ready");setInterval(()=>{},1000);}else{const at=process.argv.indexOf("-o");fs.writeFileSync(process.argv[at+1],'{"intent":"none","commands":[]}');}\n`);
  const { child, origin } = await startServer(serverEnv({ CODEX_CLI_PATH:fakeCli }));
  const controller = new AbortController();
  try {
    const page = await fetch(origin), cookie = page.headers.get("set-cookie")?.split(";", 1)[0], firstId="10000000-0000-4000-8000-000000000011", replacementId="10000000-0000-4000-8000-000000000012", headers = { "Content-Type":"application/json", Origin:origin, Cookie:cookie, "X-PenEcho-Client-Request":firstId };
    const config=await fetch(`${origin}/api/config`).then(response=>response.json());
    assert.equal(config.aiRequestTimeoutMs,200000);
    const first = fetch(`${origin}/api/ai/command`, { method:"POST", signal:controller.signal, headers, body:JSON.stringify(validPayload()) }), firstHandled = first.catch(error => assert.equal(error.name, "AbortError"));
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(startedFile) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(fs.existsSync(startedFile));
    const spoofed = await fetch(`${origin}/api/ai/command`, { method:"POST", headers:{ ...headers, "X-PenEcho-Client-Request":"10000000-0000-4000-8000-000000000013", "X-PenEcho-Replaces":"10000000-0000-4000-8000-000000000099" }, body:JSON.stringify(validPayload()) });
    assert.equal(spoofed.status,409);
    const unrelated = await fetch(`${origin}/api/ai/command`, { method:"POST", headers:{ ...headers, "X-PenEcho-Client-Request":"10000000-0000-4000-8000-000000000014" }, body:JSON.stringify(validPayload()) });
    assert.equal(unrelated.status,503);
    controller.abort();
    const replacement = await fetch(`${origin}/api/ai/command`, { method:"POST", headers:{ ...headers, "X-PenEcho-Client-Request":replacementId, "X-PenEcho-Replaces":firstId }, body:JSON.stringify(validPayload()) });
    assert.equal(replacement.status, 200);
    await firstHandled;
    assert.equal(await fs.promises.readFile(countFile, "utf8"), "2");
    const staleReplacement=await fetch(`${origin}/api/ai/command`,{method:"POST",headers:{...headers,"X-PenEcho-Client-Request":"10000000-0000-4000-8000-000000000015","X-PenEcho-Replaces":"10000000-0000-4000-8000-000000000099"},body:JSON.stringify(validPayload())});
    assert.equal(staleReplacement.status,409);
  } finally {
    controller.abort();
    await stopServer(child);
    await fs.promises.rm(directory, { recursive:true, force:true });
  }
});

test("a queued Codex replacement can itself be superseded", { timeout: 20000 }, async () => {
  const directory=await fs.promises.mkdtemp(path.join(os.tmpdir(),"penecho-replacement-chain-test-")),fakeCli=path.join(directory,"fake-codex.js"),countFile=path.join(directory,"count.txt"),startedFile=path.join(directory,"started.txt");
  await fs.promises.writeFile(fakeCli,`"use strict";const fs=require("node:fs"),path=require("node:path"),countFile=path.join(__dirname,"count.txt"),count=Number(fs.existsSync(countFile)?fs.readFileSync(countFile,"utf8"):0)+1;fs.writeFileSync(countFile,String(count));if(count===1){fs.writeFileSync(path.join(__dirname,"started.txt"),"ready");setInterval(()=>{},1000)}else{const at=process.argv.indexOf("-o");fs.writeFileSync(process.argv[at+1],'{"intent":"none","commands":[]}')}\n`);
  const {child,origin}=await startServer(serverEnv({CODEX_CLI_PATH:fakeCli})),controller=new AbortController();
  try{
    const page=await fetch(origin),cookie=page.headers.get("set-cookie")?.split(";",1)[0],base={"Content-Type":"application/json",Origin:origin,Cookie:cookie},firstId="10000000-0000-4000-8000-000000000021",secondId="10000000-0000-4000-8000-000000000022",thirdId="10000000-0000-4000-8000-000000000023";
    const first=fetch(`${origin}/api/ai/command`,{method:"POST",signal:controller.signal,headers:{...base,"X-PenEcho-Client-Request":firstId},body:JSON.stringify(validPayload())}).catch(error=>assert.equal(error.name,"AbortError"));
    const deadline=Date.now()+5000;while(!fs.existsSync(startedFile)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));assert.ok(fs.existsSync(startedFile));
    controller.abort();
    const second=fetch(`${origin}/api/ai/command`,{method:"POST",headers:{...base,"X-PenEcho-Client-Request":secondId,"X-PenEcho-Replaces":firstId},body:JSON.stringify(validPayload())});
    await new Promise(resolve=>setTimeout(resolve,50));
    const third=fetch(`${origin}/api/ai/command`,{method:"POST",headers:{...base,"X-PenEcho-Client-Request":thirdId,"X-PenEcho-Replaces":secondId},body:JSON.stringify(validPayload())});
    const secondResponse=await second,thirdResponse=await third;
    assert.equal(secondResponse.status,409);
    assert.equal(thirdResponse.status,200);
    await first;
    assert.equal(await fs.promises.readFile(countFile,"utf8"),"2");
  }finally{controller.abort();await stopServer(child);await fs.promises.rm(directory,{recursive:true,force:true})}
});

test("Codex LAN mode accepts the machine address and rejects attacker-selected Hosts and origins", { timeout: 20000 }, async () => {
  const lanAddress = Object.values(os.networkInterfaces()).flat().find(entry => !entry.internal && (entry.family === 4 || entry.family === "IPv4"))?.address || os.hostname();
  const { child, origin } = await startServer(serverEnv({ HOST: "0.0.0.0" }));
  try {
    const port = new URL(origin).port;
    const attackerPage = await httpRequest(origin, { headers: { Host: `attacker.example:${port}` } });
    assert.equal(attackerPage.status, 421);
    assert.equal(attackerPage.headers["set-cookie"], undefined);

    const canonicalPage = await httpRequest(origin, { headers: { Host: `${lanAddress}:3888` } }), setCookie = canonicalPage.headers["set-cookie"]?.[0], cookie = setCookie?.split(";", 1)[0];
    assert.equal(canonicalPage.status, 200);
    assert.ok(cookie);

    const firstLocalCookie = (await httpRequest(origin, { headers: { Host:"localhost:3888" } })).headers["set-cookie"]?.[0].split("=",1)[0],
      secondLocalCookie = (await httpRequest(origin, { headers: { Host:"localhost:4000" } })).headers["set-cookie"]?.[0].split("=",1)[0];
    assert.ok(firstLocalCookie);
    assert.ok(secondLocalCookie);
    assert.notEqual(firstLocalCookie,secondLocalCookie);

    const attackerPost = await httpRequest(origin, { method: "POST", pathText: "/api/ai/command", headers: { Host: `attacker.example:${port}`, Origin: `http://attacker.example:${port}`, Cookie: cookie, "Content-Type": "application/json", "Content-Length": 2 }, body: "{}" });
    assert.equal(attackerPost.status, 421);

    const wrongOrigin = await httpRequest(origin, { method: "POST", pathText: "/api/ai/command", headers: { Host: `${lanAddress}:3888`, Origin: "http://attacker.example", Cookie: cookie, "Content-Type": "application/json", "Content-Length": 2 }, body: "{}" });
    assert.equal(wrongOrigin.status, 403);

    const authorized = await httpRequest(origin, { method: "POST", pathText: "/api/ai/command", headers: { Host: `${lanAddress}:3888`, Origin: `http://${lanAddress}:3888`, Cookie: cookie, "Content-Type": "application/json", "Content-Length": 2 }, body: "{}" });
    assert.equal(authorized.status, 400);
  } finally {
    await stopServer(child);
  }
});

test("debug persistence redacts recognized and generated text", { timeout: 20000 }, async () => {
  const marker = `sensitive-${Date.now()}-${Math.random()}`;
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "penecho-redaction-test-")), fakeCli = path.join(directory, "fake-codex.js"), promptFile = path.join(directory, "prompt.txt");
  await fs.promises.writeFile(fakeCli, `"use strict";const fs=require("node:fs"),path=require("node:path");let input="";process.stdin.setEncoding("utf8");process.stdin.on("data",chunk=>input+=chunk);process.stdin.on("end",()=>{fs.writeFileSync(path.join(__dirname,"prompt.txt"),input);const at=process.argv.indexOf("-o");fs.writeFileSync(process.argv[at+1],'{"intent":"none","commands":[]}');});\n`);
  const { child, origin } = await startServer(serverEnv({ PENECHO_DEBUG_ARTIFACTS: "true", CODEX_CLI_PATH: fakeCli }));
  try {
    const events = [
      { event: "ai-response", details: { requestId: "10000000-0000-4000-8000-000000000001", intent: "answer", rawCount: 1, attempts: 1, observedText: marker, text: marker, latex: marker } },
      { event: "ai-error", details: { requestId: "10000000-0000-4000-8000-000000000002", action: "answer", error: marker, nested: { value: marker } } },
      { event: "tool-error", details: { requestId: "10000000-0000-4000-8000-000000000003", tool: "write_text", error: marker } },
    ];
    for (const event of events) {
      const response = await fetch(`${origin}/api/debug/client`, { method: "POST", headers: { "Content-Type": "application/json", Origin:origin }, body: JSON.stringify(event) });
      assert.equal(response.status, 204);
    }
    const page = await fetch(origin), cookie = page.headers.get("set-cookie")?.split(";", 1)[0], malformed = validPayload();
    malformed.userAction = { value: marker };
    const malformedResponse = await fetch(`${origin}/api/ai/command`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin, Cookie: cookie }, body: JSON.stringify(malformed) });
    assert.equal(malformedResponse.status, 400);
    const extra = validPayload(), nested = { value: marker };
    extra.atlasSize.extra = nested;
    extra.changedBox.extra = nested;
    extra.visibleRect.extra = nested;
    extra.captureRect.extra = nested;
    extra.sourceRect.extra = nested;
    extra.hotspotGrid.attention = marker;
    extra.hotspotGrid.extra = nested;
    extra.hotspotGrid.hotspots[0].extra = nested;
    extra.hotspotGrid.hotspots[0].imageRect.extra = nested;
    extra.focusInset = { sourceRect:{ x:0, y:0, w:1, h:1, extra:nested }, imageRect:{ x:0, y:0, w:1, h:1, extra:nested }, imageScale:2, purpose:marker, extra:nested };
    const extraResponse = await fetch(`${origin}/api/ai/command`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin, Cookie: cookie }, body: JSON.stringify(extra) }), extraBody = await extraResponse.json();
    assert.equal(extraResponse.status, 200);
    const prompt = await fs.promises.readFile(promptFile, "utf8");
    assert.equal(prompt.includes(marker), false);
    const atlasMetadataPath = path.join(ROOT, "logs", "latest-atlas.json"), deadline = Date.now() + 3000;
    let atlasMetadata = "";
    while (Date.now() < deadline) {
      try { atlasMetadata = await fs.promises.readFile(atlasMetadataPath, "utf8"); } catch {}
      if (atlasMetadata.includes(extraBody.requestId)) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.match(atlasMetadata, new RegExp(extraBody.requestId));
    assert.equal(atlasMetadata.includes(marker), false);
    const log = await fetch(`${origin}/api/debug/log`), text = await log.text();
    assert.equal(log.status, 200);
    assert.match(text, /10000000-0000-4000-8000-000000000001/);
    assert.equal(text.includes(marker), false);
  } finally {
    await stopServer(child);
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("static page keeps strict styles while allowing the pinned MathJax CDN", () => {
  const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8"), css = fs.readFileSync(path.join(ROOT, "public", "style.css"), "utf8"), app = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8"), config=fs.readFileSync(path.join(ROOT,"public","mathjax-config.js"),"utf8"), server=fs.readFileSync(path.join(ROOT,"server.js"),"utf8");
  assert.doesNotMatch(html, /\sstyle=/i);
  assert.match(css, /\.color-blue\s*\{/);
  assert.doesNotMatch(app, /\.style\.|setAttribute\(\s*["']style["']/);
  assert.match(html, /https:\/\/cdn\.jsdelivr\.net\/npm\/mathjax@3\.2\.2\/es5\/tex-svg\.js/);
  assert.match(html, /integrity="sha384-KKWa9jJ1MZvssLeOoXG6FiOAZfAgmzsIIfw8BXwI9\+kYm0lPCbC6yTQPBC00F1\/L"/);
  assert.match(html, /crossorigin="anonymous"/);
  assert.match(config, /fontCache:\s*"none"/);
  assert.match(app, /MathJax\?\.tex2svgPromise/);
  assert.match(server, /script-src 'self' https:\/\/cdn\.jsdelivr\.net/);
  assert.doesNotMatch(app, /clientRequestId\s*=\s*crypto\.randomUUID\(/);
  assert.match(app, /function newClientRequestId\(\)/);
});

test("client and server contain no aggregate draft rejection budget", () => {
  const app=fs.readFileSync(path.join(ROOT,"public","app.js"),"utf8"),draw=fs.readFileSync(path.join(ROOT,"public","draw.js"),"utf8"),server=fs.readFileSync(path.join(ROOT,"server.js"),"utf8");
  for(const source of [app,draw,server])assert.doesNotMatch(source,/Draft destination budget|Draft raster budget|MAX_DRAFT_RASTER_PIXELS|MAX_LOGICAL_PIXELS|MAX_DESTINATION_TILES/);
  assert.doesNotMatch(server,/padded union bounds may total at most|intersect at most 64/);
});
