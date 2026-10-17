import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { failedJobAlerts } from "../lib/alerts.mjs";

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function startDeck(directory, port, upstreamPort, extraConfig = {}) {
  fs.copyFileSync(path.join(source, "server.mjs"), path.join(directory, "server.mjs"));
  fs.cpSync(path.join(source, "lib"), path.join(directory, "lib"), { recursive: true });
  fs.writeFileSync(path.join(directory, "config.json"), JSON.stringify({ host: "127.0.0.1", bind: "127.0.0.1", services: Object.fromEntries(["radarr", "sonarr", "prowlarr", "bazarr", "qbittorrent", "seerr", "jellyfin"].map(name => [name, { port: upstreamPort, key: "key-" + name }])), ...extraConfig }));
  const child = spawn(process.execPath, ["server.mjs"], { cwd: directory, env: { ...process.env, PORT: String(port), BIND: "127.0.0.1" }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", data => (output += data));
  const waitFor = (pattern, ms = 15000) => new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(Error("Timed out waiting for " + pattern + "; output: " + output)), ms);
    const check = () => { const match = output.match(pattern); if (match) { clearTimeout(deadline); child.stdout.off("data", check); resolve(match); } };
    child.stdout.on("data", check); check();
    child.once("exit", code => { clearTimeout(deadline); reject(Error("Deck exited: " + code + "; output: " + output)); });
  });
  return { child, waitFor, stop: async () => { if (child.exitCode === null) { const stopped = new Promise(resolve => child.once("exit", resolve)); child.kill(); await stopped; } } };
}

function upstream(handler) {
  const server = http.createServer((req, res) => {
    const route = new URL(req.url, "http://localhost").pathname;
    res.setHeader("Content-Type", "application/json");
    const result = handler(route, req);
    if (Array.isArray(result)) { res.statusCode = result[0]; return res.end(JSON.stringify(result[1])); }
    res.end(JSON.stringify(result ?? []));
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server)));
}

test("Deck waits for its listening address instead of crashing", async () => {
  const blocker = net.createServer();
  await new Promise(resolve => blocker.listen(0, "127.0.0.1", resolve));
  const port = blocker.address().port;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "deck-listen-"));
  const service = await upstream(() => ({}));
  const deck = startDeck(directory, port, service.address().port);
  try {
    await deck.waitFor(/Waiting for 127\.0\.0\.1:\d+ \(EADDRINUSE\)/);
    await new Promise(resolve => blocker.close(resolve));
    await deck.waitFor(/Deck listening on port (\d+)/, 15000);
    assert.equal(deck.child.exitCode, null);
  } finally {
    await deck.stop();
    service.closeAllConnections(); await new Promise(resolve => service.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("one failed Seerr title lookup does not hide the other requests; lights routes are guarded", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "deck-requests-"));
  const service = await upstream(route => {
    if (route === "/api/v1/request") return { pageInfo: { results: 2 }, results: [{ id: 1, type: "movie", status: 2, media: { tmdbId: 11, status: 5 } }, { id: 2, type: "movie", status: 2, media: { tmdbId: 22, status: 3 } }] };
    if (route === "/api/v1/movie/11") return { title: "Found film", releaseDate: "2020-01-01" };
    if (route === "/api/v1/movie/22") return [500, { message: "Unable to retrieve movie." }];
    if (route === "/api/v2/auth/login") return "Ok.";
    return {};
  });
  const bridgeCalls = [];
  const bridge = http.createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    bridgeCalls.push(JSON.parse(body || "null"));
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(req.url === "/state" ? { version: "test", devices: [{ name: "neon", kind: "neon" }], effects: [], wizScenes: {} } : { results: { neon: { ok: true } } }));
  });
  await new Promise(resolve => bridge.listen(0, "127.0.0.1", resolve));
  const deck = startDeck(directory, 0, service.address().port, { lights: { bridge: `http://127.0.0.1:${bridge.address().port}` } });
  try {
    const [, port] = await deck.waitFor(/Deck listening on port (\d+)/);
    const base = `http://127.0.0.1:${port}/hub/api/`;
    const requests = await fetch(base + "requests?filter=all");
    assert.equal(requests.status, 200);
    const body = await requests.json();
    assert.equal(body.results.length, 2);
    assert.equal(body.results[0].title, "Found film");
    assert.match(body.results[1].title, /TMDB 22/);
    assert.match(body.errors[0].message, /Unable to retrieve movie/);

    const state = await (await fetch(base + "lights")).json();
    assert.equal(state.bridge.online, true);
    assert.ok((await (await fetch(base + "lights-scenes")).json()).scenes.some(s => s.id === "movie"));
    const post = (payload, headers = {}) => fetch(base + "lights", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(payload) });
    assert.equal((await post({ targets: ["neon"], brightness: 500 })).status, 400);
    assert.equal((await post({ targets: ["neon"], on: true }, { Origin: "http://evil.example" })).status, 403);
    const ok = await post({ targets: ["neon"], color: [0, 40, 255] });
    assert.equal(ok.status, 200);
    assert.deepEqual(bridgeCalls.at(-1), { steps: [{ targets: ["neon"], color: [0, 40, 255] }] });
  } finally {
    await deck.stop();
    for (const s of [service, bridge]) { s.closeAllConnections(); await new Promise(resolve => s.close(resolve)); }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("failed tasks stop alerting once a later run succeeds or they are a week old", () => {
  const now = Date.parse("2026-10-17T12:00:00Z");
  const job = (id, key, status, finishedAt) => ({ id, key, label: "Library task · Scan", service: "radarr", status, message: status, finishedAt });
  const alerts = failedJobAlerts([
    job("old", "a", "failed", "2026-10-04T08:20:27Z"),
    job("retried", "b", "failed", "2026-10-16T08:00:00Z"),
    job("retry-ok", "b", "completed", "2026-10-16T09:00:00Z"),
    job("recent", "c", "failed", "2026-10-17T10:00:00Z"),
    job("before-failure", "c", "completed", "2026-10-17T09:00:00Z"),
  ], now);
  assert.deepEqual(alerts.map(a => a.key), ["job:recent"]);
});
