import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { actionKey, tokenStore } from "../lib/storage.mjs";
import { createJobs } from "../lib/jobs.mjs";
import { nativeControls } from "../lib/native.mjs";
import { shiftSubtitles, subtitleCues } from "../lib/subtitles.mjs";
import { collectAlerts, createAlerts } from "../lib/alerts.mjs";
import { configuration } from "../lib/configuration.mjs";
import { imports } from "../lib/imports.mjs";
import { workflows } from "../lib/workflows.mjs";
import { operations } from "../lib/operations.mjs";
import { watch } from "../lib/watch.mjs";

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "deck-test-"));
const tick = () => new Promise(r => setTimeout(r, 15));
const settings = (api) => configuration({ api, cache: new Map(), tokens: tokenStore(null) });

test("different episodes and opposite monitoring values are separate operations", async () => {
  const dir = temp(); let release;
  try {
    const seen = [], jobs = createJobs(dir);
    const control = nativeControls({ jobs, services: {}, cache: new Map(), api: async (n, p, m, body) => { seen.push(body); if (seen.length === 1) await new Promise(r => release = r); } });
    const a = control.start({ action: "episodeMonitor", service: "sonarr", ids: [1], monitored: true });
    const b = control.start({ action: "episodeMonitor", service: "sonarr", ids: [2], monitored: false });
    assert.notEqual(a.id, b.id); assert.equal(b.status, "queued"); release(); await tick();
    assert.deepEqual(seen, [{ episodeIds: [1], monitored: true }, { episodeIds: [2], monitored: false }]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test("identical operations deduplicate regardless of label or property order", () => {
  assert.equal(actionKey({ action: "monitor", id: 1, monitored: true, label: "A" }), actionKey({ monitored: true, id: 1, action: "monitor", label: "B" }));
  assert.notEqual(actionKey({ action: "monitor", id: 1, monitored: true }), actionKey({ action: "monitor", id: 1, monitored: false }));
});
test("provider tokens survive restart and expired results are removed", () => {
  const dir = temp(); try {
    const store = tokenStore(dir, "searches"); store.set("valid", { expires: Date.now() + 60000, opaque: "exact provider object" }); store.set("expired", { expires: Date.now() - 1 });
    const restored = tokenStore(dir, "searches"); assert.equal(restored.get("valid").opaque, "exact provider object"); assert.equal(restored.get("expired"), undefined);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test("queued actions replay after restart; running commands reconcile without resubmission", async () => {
  const dir = temp(); try {
    fs.mkdirSync(path.join(dir, "data")); fs.writeFileSync(path.join(dir, "data/activity.json"), JSON.stringify([
      { id: "running", service: "radarr", status: "running", commandId: 7, key: "a", createdAt: new Date().toISOString() },
      { id: "queued", service: "bazarr", status: "queued", key: "b", _payload: { action: "subtitle", id: 9 }, createdAt: new Date().toISOString() },
    ]));
    const jobs = createJobs(dir), reconciled = [], replayed = [];
    await jobs.recover(async job => { reconciled.push(job.commandId); return { message: "Existing command completed" }; }, async payload => { replayed.push(payload); return { message: "Queued operation completed" }; });
    await tick(); assert.deepEqual(reconciled, [7]); assert.deepEqual(replayed, [{ action: "subtitle", id: 9 }]); assert.ok(jobs.list().every(j => j.status === "completed"));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test("bulk operations reserve each affected service", async () => {
  const dir = temp(); let release;
  try {
    const jobs = createJobs(dir);
    const a = jobs.start("Bulk", "bulk", "a", () => new Promise(r => release = r), { action: "bulk", kind: "monitor", items: [{ service: "radarr" }, { service: "sonarr" }] });
    const b = jobs.start("Sonarr", "sonarr", "b", async () => ({})); assert.equal(a.status, "running"); assert.equal(b.status, "queued"); release({}); await tick(); assert.equal(b.status, "completed");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test("bulk recovery resumes remaining episodes and keeps original item indexes", async () => {
  const dir = temp(); try {
    const actions = [], updates = [];
    const op = operations({ directory: dir, config: { services: {} }, jobs: {}, cache: new Map(), alerts: {}, api: async () => ({ data: [{ job_id: "existing", status: "completed" }] }), native: { execute: async (body, update) => { actions.push(body); update("Completed", { bazarrJobIds: ["next"] }); return { message: "Updated" }; } } });
    const item = { kind: "series", id: 3, title: "Show" }, second = { kind: "movie", id: 10, title: "Film" };
    const result = await op.reconcile({ _payload: { action: "bulk", kind: "subtitles", items: [item, second] }, bulkIndex: 0, bulkItem: item, bulkResults: [], bulkEpisodeIds: [1, 2, 3], bulkEpisodeIndex: 0, bazarrJobIds: ["existing"] }, (message, metadata) => updates.push(metadata));
    assert.deepEqual(actions.map(a => a.id), [2, 3, 10]); assert.equal(result.results.length, 2); assert.equal(result.partial, false); assert.ok(updates.some(m => m?.bulkIndex === 1 && m.bulkItem.id === 10));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test("SRT and VTT shifts preserve text and clip timestamps at zero", () => {
  const srt = "1\r\n00:00:01,000 --> 00:00:02,500\r\nThe clock says 00:00:01,000\r\n";
  assert.equal(shiftSubtitles(srt, -2), "1\r\n00:00:00,000 --> 00:00:00,500\r\nThe clock says 00:00:01,000\r\n");
  assert.match(shiftSubtitles("WEBVTT\n\n00:01.000 --> 00:02.000\nHello", 1, "vtt"), /00:02.000 --> 00:03.000/);
  assert.equal(subtitleCues(srt)[0].start, 1000);
  assert.throws(() => shiftSubtitles(srt, Infinity), /offset/);
  assert.throws(() => shiftSubtitles(srt, 1, "ass"), /styled/);
});
test("subtitle coverage is aggregated per series rather than reading nonexistent series fields", async () => {
  const native = nativeControls({ services: {}, cache: new Map(), jobs: {}, api: async (n, p) => {
    if (p.startsWith("/api/series")) return { data: [{ sonarrSeriesId: 3, title: "Show" }] };
    if (p.startsWith("/api/episodes?")) return { data: [{ sonarrSeriesId: 3, subtitles: [{ code2: "en" }], missing_subtitles: [] }, { sonarrSeriesId: 3, subtitles: [], missing_subtitles: [{ code2: "en" }] }] };
    if (p.includes("languages")) return []; return { data: [] };
  } });
  const x = await native.read("subtitle-library", new URLSearchParams()); assert.equal(x.series[0].subtitleEpisodeCount, 1); assert.equal(x.series[0].missingSubtitleEpisodeCount, 1);
});
test("duplicate service warnings group by cause and alerts retain resolution history", () => {
  const dir = temp(); try {
    const snapshot = { services: [], health: ["radarr", "sonarr", "prowlarr"].map(service => ({ service, source: "AllowedHostsCheck", message: service + " needs allowed hostnames" })), disks: [], torrents: [], queue: [] };
    assert.equal(collectAlerts(snapshot).length, 1); const alerts = createAlerts(dir); alerts.update(snapshot);
    const record = alerts.get().records[0]; assert.equal(record.services.length, 3); alerts.acknowledge(record.id); alerts.update({ ...snapshot, health: [] }); assert.ok(record.resolvedAt);
    alerts.update(snapshot); assert.equal(alerts.get().records.length, 2); assert.equal(alerts.get().records[0].acknowledged, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test("quality edits preserve unrelated rules and reject a disabled cutoff", async () => {
  const original = { id: 1, name: "Main", cutoff: 2, tags: [4], language: { id: 1 }, items: [{ quality: { id: 1, name: "SD" }, allowed: true }, { quality: { id: 2, name: "HD" }, allowed: true }], formatItems: [{ format: 7, name: "Preferred", score: 0 }] };
  let saved; const c = settings(async (n, p, m, body) => { if (m === "PUT") saved = body; return structuredClone(original); });
  const body = { action: "profileAdvanced", service: "radarr", id: 1, name: "Updated", cutoff: 2, upgradeAllowed: true, order: ["quality:1", "quality:2"], allowed: [2], scores: { 7: 100 } };
  await c.execute(body); assert.deepEqual(saved.tags, [4]); assert.deepEqual(saved.language, { id: 1 }); assert.equal(saved.formatItems[0].score, 100); assert.equal(saved.items[0].allowed, false);
  await assert.rejects(c.execute({ ...body, cutoff: 1 }), /enabled quality/);
});
test("provider saves keep blank credentials and only update the selected provider", async () => {
  const original = { general: { enabled_providers: ["opensubtitlescom", "gestdown"] }, opensubtitlescom: { password: "secret", username: "name", use_hash: true }, radarr: { apikey: "private" } };
  let saved; const c = settings(async (n, p, m, body) => { if (m === "POST") saved = body; if (p.endsWith("settings")) return original; if (p.includes("languages")) return []; });
  await c.execute({ action: "bazarrProvider", provider: "opensubtitlescom", enabled: true, fields: { password: "", use_hash: false } });
  assert.equal(saved.has("settings-opensubtitlescom-password"), false); assert.equal(saved.get("settings-opensubtitlescom-use_hash"), "false"); assert.equal(saved.has("settings-radarr-apikey"), false); assert.deepEqual(saved.getAll("settings-general-enabled_providers"), ["opensubtitlescom", "gestdown"]);
});
test("new connection templates do not expose or trust client supplied implementation fields", async () => {
  const schemas = [{ name: "Example", implementation: "TorrentRss", fields: [{ name: "apikey", label: "API key", privacy: 1, value: "private-default" }, { name: "url", type: "textbox", value: "https://example.com" }] }];
  const seen = []; const c = settings(async (n, p, m, body) => { seen.push({ p, m, body }); if (p.endsWith("schema")) return schemas; });
  const read = await c.read("connection-schemas", new URLSearchParams({ service: "prowlarr", type: "indexer" })); assert.equal(read.schemas[0].fields[0].value, "");
  await c.execute({ action: "connectionCreate", service: "prowlarr", type: "indexer", token: read.token, index: 0, name: "My indexer", implementation: "Injected", fields: { apikey: "provided" } });
  const created = seen.find(r => r.p === "/api/v1/indexer"); assert.equal(created.body.implementation, "TorrentRss"); assert.equal(created.body.fields[0].value, "provided"); assert.ok(seen.some(r => r.p.endsWith("/test")));
});
test("manual import trusts inspected paths, validates assignments, and preserves source by default", async () => {
  const dir = temp(); try {
    let command; const api = async (n, p) => p.startsWith("/api/v3/manualimport") ? [{ id: 7, path: "D:\\Downloads\\film.mkv", quality: { quality: { id: 2 }, revision: { version: 1 } }, movie: { id: 1 }, languages: [{ id: 1 }] }] : p.endsWith("/movie") ? [{ id: 1, title: "Film" }] : p.endsWith("qualitydefinition") ? [{ quality: { id: 2, name: "HD" } }] : [{ id: 1, name: "English" }];
    const i = imports({ api, directory: dir, runCommand: async (n, body) => { command = body; return {}; } });
    const plan = await i.read("import-plan", new URLSearchParams({ service: "radarr", folder: "D:\\Downloads" }));
    const body = { action: "manualImport", service: "radarr", token: plan.token, mode: "copy", files: [{ id: 7, titleId: 1, qualityId: 2, languageId: 1, path: "C:\\injected.mkv" }] };
    await assert.rejects(i.execute({ ...body, files: [{ ...body.files[0], id: 8 }] }, () => {}), /inspected/);
    await i.execute(body, () => {}); assert.equal(command.files[0].path, "D:\\Downloads\\film.mkv"); assert.equal(command.importMode, "copy"); assert.equal(command.name, "ManualImport");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test("title journeys use exact provider IDs and preserve upstream errors", async () => {
  const f = workflows({ native: { read: async () => ({ item: { id: 1, tmdbId: 99, title: "Film", monitored: true }, files: [{ path: "D:\\Film\\film.mkv" }] }) }, api: async (n, p) => {
    if (n === "bazarr") throw Error("Bazarr is offline"); if (n === "seerr") return { results: [{ id: 3, status: 5, type: "movie", media: { tmdbId: 99, status: 5 } }] };
    if (n === "jellyfin") return { Items: [{ Id: "correct", ProviderIds: { Tmdb: "99" }, Name: "Film" }, { Id: "wrong", ProviderIds: { Tmdb: "100" }, Name: "Film" }] }; return [];
  } });
  const result = await f.title("radarr", 1); assert.equal(result.journey.stages.find(s => s.key === "subtitles").state, "unknown"); assert.equal(result.journey.jellyfin.length, 1); assert.equal(result.journey.jellyfin[0].id, "correct"); assert.equal(result.journey.stages[0].state, "complete");
});
test("bulk actions report each failed item without abandoning remaining items", async () => {
  const dir = temp(); try {
    const seen = [], o = operations({ api: async () => [], native: { execute: async b => { seen.push(b.id); if (b.id === 2) throw Error("Unavailable"); return { message: "Saved" }; } }, config: { services: {} }, directory: dir, cache: new Map(), jobs: {}, alerts: {} });
    const result = await o.execute({ action: "bulk", kind: "monitor", monitored: true, items: [{ id: 1, service: "radarr" }, { id: 2, service: "radarr" }, { id: 3, service: "radarr" }] });
    assert.deepEqual(seen, [1, 2, 3]); assert.equal(result.partial, true); assert.deepEqual(result.results.map(r => r.success), [true, false, true]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test("watch sessions return credential-free stream URLs and persist progress for the selected user", async () => {
  const user = "a".repeat(32), id = "b".repeat(32), calls = [];
  const w = watch({ config: { services: { jellyfin: { key: "private-key" } } }, api: async (n, p, method, body) => {
    calls.push({ p, method, body }); if (p === "/Users") return [{ Id: user, Name: "Viewer", Policy: {} }];
    if (p.includes("PlaybackInfo")) return { PlaySessionId: "session", MediaSources: [{ Id: id, Container: "mp4", RunTimeTicks: 1000000000, MediaStreams: [{ Type: "Video", Codec: "h264" }, { Type: "Audio", Codec: "aac", Index: 1 }] }] };
    if (p.includes("UserData") && !method) return { Played: false, PlayCount: 4 }; return {};
  } });
  const session = await w.execute({ action: "watchStart", id, user }); assert.equal(session.source.includes("private-key"), false); assert.equal(session.hls, false);
  await w.execute({ action: "watchProgress", token: session.token, event: "progress", position: 25, paused: true });
  const saved = calls.find(c => c.p.includes("UserData") && c.method === "POST"); assert.equal(saved.body.PlaybackPositionTicks, 250000000); assert.equal(saved.body.PlayCount, 4); assert.ok(saved.p.includes(user));
});
