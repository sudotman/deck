import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

test("HTTP dashboard preserves stale data, reports partial failures, hides secrets, and rejects cross-site actions", async () => {
  const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "deck-http-"));
  let broken = false, child;
  const service = http.createServer((req, res) => {
    const route = new URL(req.url, "http://localhost").pathname;
    const name = String(req.headers["x-api-key"] || "").replace("test-secret-", "");
    res.setHeader("Content-Type", "application/json");
    if (broken && name === "radarr" && ["/api/v3/queue", "/api/v3/calendar", "/api/v3/history"].includes(route)) {
      res.statusCode = 503; return res.end(JSON.stringify({ message: "Unavailable test-secret-radarr api_key=private-query" }));
    }
    let body = [];
    if (route === "/api/v2/auth/login") return res.end("Ok.");
    if (route.endsWith("/status") || route === "/System/Info") body = { version: "test" };
    else if (route === "/api/v2/app/version") body = "5.0";
    else if (route === "/api/v3/movie") body = [{ id: 1, title: "Test film", hasFile: true, images: [] }];
    else if (route === "/api/v3/queue") body = { records: name === "radarr" ? [{ id: 7, title: "Queued film", status: "downloading" }] : [] };
    else if (route === "/api/v3/calendar") body = name === "sonarr" ? [{ series: { title: "Test series" }, seriesId: 2, title: "Episode", airDateUtc: new Date().toISOString() }] : [];
    else if (route === "/api/v3/history") body = { records: [] };
    else if (route === "/api/v3/diskspace") body = [{ path: "D:", freeSpace: 100e9, totalSpace: 200e9 }];
    else if (route === "/api/v2/transfer/info") body = {};
    else if (route === "/api/v1/request") body = { results: [] };
    else if (route === "/api/providers" || route === "/api/movies/wanted") body = { data: [] };
    res.end(JSON.stringify(body));
  });
  try {
    await new Promise(resolve => service.listen(0, "127.0.0.1", resolve));
    fs.copyFileSync(path.join(source, "server.mjs"), path.join(directory, "server.mjs"));
    fs.cpSync(path.join(source, "lib"), path.join(directory, "lib"), { recursive: true });
    fs.writeFileSync(path.join(directory, "config.json"), JSON.stringify({ host: "127.0.0.1", bind: "127.0.0.1", services: Object.fromEntries(["radarr", "sonarr", "prowlarr", "bazarr", "qbittorrent", "seerr", "jellyfin"].map(name => [name, { port: service.address().port, key: "test-secret-" + name }])) }));
    child = spawn(process.execPath, ["server.mjs"], { cwd: directory, env: { ...process.env, PORT: "0", BIND: "127.0.0.1" }, stdio: ["ignore", "pipe", "pipe"] });
    const port = await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(Error("Server did not start")), 10000);
      child.once("exit", code => { clearTimeout(deadline); reject(Error("Server exited: " + code)); });
      child.stdout.on("data", data => { const match = String(data).match(/Deck listening on port (\d+)/); if (match) { clearTimeout(deadline); resolve(Number(match[1])); } });
    });
    const base = `http://127.0.0.1:${port}/hub/api/`;
    const initial = await (await fetch(base + "overview")).json(); assert.equal(initial.queue[0].id, 7); assert.equal(initial.dataErrors.length, 0);
    broken = true;
    const cross = await fetch(base + "action", { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://other.example" }, body: JSON.stringify({ action: "alertSettings" }) }); assert.equal(cross.status, 403);
    const deniedStatus = await new Promise((resolve, reject) => { const request = http.get(base + "overview", { headers: { Host: "other.example" } }, response => { response.resume(); resolve(response.statusCode); }); request.on("error", reject); }); assert.equal(deniedStatus, 403);
    const action = await (await fetch(base + "action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "alertSettings", label: "字幕 — café", lowDiskPercent: 10, lowDiskGB: 20, stalledMinutes: 30 }) })).json();
    for (let i = 0; i < 50; i++) { const job = await (await fetch(base + "jobs/" + action.job.id)).json(); if (job.status === "completed") break; assert.notEqual(job.status, "failed", job.message); await new Promise(r => setTimeout(r, 10)); }
    const partialResponse = await fetch(base + "overview"), raw = await partialResponse.text(), partial = JSON.parse(raw);
    assert.equal(partial.queue[0].id, 7); assert.ok(partial.dataErrors.find(e => e.service === "radarr" && e.section === "queue")?.staleAt); assert.ok(!raw.includes("test-secret-radarr")); assert.ok(!raw.includes("private-query"));
    const calendar = await (await fetch(base + "calendar")).json(); assert.equal(calendar.items[0].title, "Test series"); assert.equal(calendar.errors[0].service, "radarr");
    const history = await (await fetch(base + "history")).json(); assert.equal(history.errors[0].service, "radarr");
    const completed = await (await fetch(base + "jobs/" + action.job.id)).json(); assert.equal(completed.label, "字幕 — café"); const publicJob = JSON.stringify(completed); assert.ok(!publicJob.includes("_payload")); assert.ok(!publicJob.includes("_locks"));
  } finally {
    if (child && child.exitCode === null) { const stopped = new Promise(resolve => child.once("exit", resolve)); child.kill(); await stopped; }
    service.closeAllConnections(); await new Promise(resolve => service.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
