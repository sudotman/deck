import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nativeControls } from "../lib/native.mjs";
import { releaseChoices } from "../lib/release-choices.mjs";
import { imports } from "../lib/imports.mjs";
import { workflows } from "../lib/workflows.mjs";
import { watch } from "../lib/watch.mjs";

const release = { title: "RK RKAY (2021) Hindi 1080p ESub", guid: "https://indexer.invalid/release?apikey=private", indexerId: 2, indexer: "Knaben", rejected: true, rejections: ["Hardcode subs found: ESub"], quality: { quality: { id: 9, name: "HDTV-1080p" }, revision: { version: 1, real: 0 } }, languages: [{ id: 26, name: "Hindi" }] };
const selected = { service: "radarr", id: 24 };
const user = "a".repeat(32), jellyId = "b".repeat(32);
function fixture(t, failure) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "deck-choice-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls = [], state = { movie: { id: 24, tmdbId: 99, title: "RK/RKAY", monitored: true, qualityProfileId: 1, tags: [7], path: "D:\\Movies\\RK" }, files: [], history: [] };
  const api = async (n, endpoint, method, body) => {
    calls.push({ n, endpoint, method, body: structuredClone(body) });
    if (endpoint === "/api/v3/movie/24") {
      if (method === "PUT") state.movie = structuredClone(body);
      return structuredClone(state.movie);
    }
    if (endpoint.startsWith("/api/v3/release?")) return [structuredClone(release)];
    if (endpoint === "/api/v3/release" && method === "POST") { if (failure) throw Error(failure); return {}; }
    if (endpoint.startsWith("/api/v3/moviefile?")) return structuredClone(state.files);
    if (endpoint.startsWith("/api/v3/history?")) return { records: structuredClone(state.history) };
    if (endpoint.startsWith("/api/movies?")) return { data: [{ radarrId: 24, title: "RK/RKAY", subtitles: [], missing_subtitles: [{ code2: "en" }] }] };
    if (endpoint.includes("history")) return { data: [] };
    if (endpoint.includes("languages")) return [];
    return { data: [] };
  };
  const native = nativeControls({ directory, api, cache: new Map(), services: {}, jobs: { start: (label, service, key, operation) => operation(() => {}) } });
  return { directory, calls, state, api, native, choices: native.releaseChoices };
}
function imported(f) {
  f.state.history = [
    { eventType: "grabbed", date: new Date().toISOString(), sourceTitle: release.title, data: { guid: release.guid }, downloadId: "ABC123" },
    { eventType: "downloadFolderImported", data: { fileId: "51" }, downloadId: "abc123" },
  ];
  f.state.files = [{ id: 51, movieId: 24, path: "D:\\Movies\\RK\\selected.mkv" }];
}

test("force selection overrides a rejected cached release for the exact movie and survives restart", async t => {
  const f = fixture(t), search = await f.native.read("releases", new URLSearchParams({ service: "radarr", id: 24 }));
  assert.equal(search.results[0].guid, undefined);
  const body = { action: "grabRelease", service: "radarr", id: 24, token: search.token, index: 0, includedSubtitles: true };
  await assert.rejects(f.native.start(body), /accepted release/);
  await assert.rejects(f.native.start({ ...body, force: true, id: 25 }), /this title/);
  await assert.rejects(f.native.start({ ...body, force: true, service: "sonarr" }), /this library/);
  await assert.rejects(f.native.start({ ...body, force: true, index: 0.5 }), /valid release/);
  assert.equal(f.calls.some(c => c.method === "PUT" || c.method === "POST"), false);
  const result = await f.native.start({ ...body, force: true, quality: { fake: true }, languages: [] });
  const post = f.calls.find(c => c.method === "POST");
  assert.deepEqual(post.body, { guid: release.guid, indexerId: 2, movieId: 24, shouldOverride: true, quality: release.quality, languages: release.languages });
  assert.equal(f.state.movie.monitored, false);
  assert.deepEqual(f.state.movie.tags, [7]);
  assert.equal(result.choice.includedSubtitles, true);
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.deepEqual(releaseChoices({ directory: f.directory, api: f.api }).get("radarr", 24), result.choice);
  await assert.rejects(f.native.start({ ...body, force: true }), /already selected/);
  await assert.rejects(f.native.start({ action: "mediaSettings", service: "radarr", id: 24, monitored: true }), /Clear/);
  await assert.rejects(f.native.start({ action: "command", service: "radarr", name: "MoviesSearch", id: 24 }), /Clear/);
  await f.native.start({ action: "clearReleaseChoice", service: "radarr", id: 24 });
  assert.equal(f.state.movie.monitored, true);
  assert.equal(releaseChoices({ directory: f.directory, api: f.api }).get("radarr", 24), null);
});

test("known grab failure restores the prior monitoring; uncertain responses stay pinned without a duplicate grab", async t => {
  const denied = fixture(t, "Download client is disabled");
  await assert.rejects(denied.choices.choose(selected, release, {}), /disabled/);
  assert.equal(denied.state.movie.monitored, true);
  assert.equal(denied.choices.get("radarr", 24), null);
  const interrupted = fixture(t, "fetch failed");
  await assert.rejects(interrupted.choices.choose(selected, release, {}), /interrupted/);
  assert.equal(interrupted.state.movie.monitored, false);
  assert.equal(interrupted.choices.get("radarr", 24).status, "uncertain");
  await assert.rejects(interrupted.choices.choose(selected, { ...release, guid: "another" }, {}), /previous selection/);
  assert.equal(interrupted.calls.filter(c => c.method === "POST").length, 1);
  imported(interrupted);
  assert.equal((await interrupted.choices.verify("radarr", 24)).status, "selected");
  await interrupted.choices.clear("radarr", 24);
  assert.equal(interrupted.state.movie.monitored, true);
});

test("replacement choices retain the original monitoring setting and rejection policy remains per movie", async t => {
  const f = fixture(t);
  f.state.movie.monitored = false;
  await f.choices.choose(selected, release, {});
  await f.choices.choose(selected, { ...release, guid: "replacement", title: "Replacement" }, {});
  assert.equal(f.choices.get("radarr", 25), null);
  await f.choices.clear("radarr", 24);
  assert.equal(f.state.movie.monitored, false);
  assert.equal(f.calls.some(c => c.endpoint.includes("qualityprofile") || c.endpoint.includes("indexer")), false);
});

test("only the matching download import satisfies included subtitles; old files and mismatching GUIDs do not", async t => {
  const f = fixture(t);
  await f.choices.choose(selected, release, { includedSubtitles: true });
  f.state.files = [{ id: 50, movieId: 24, path: "D:\\Movies\\RK\\old.mkv" }];
  f.state.history = [{ eventType: "grabbed", date: new Date().toISOString(), sourceTitle: release.title, data: { guid: "different" }, downloadId: "wrong" }, { eventType: "downloadFolderImported", data: { fileId: "50" }, downloadId: "wrong" }];
  assert.equal((await f.choices.verify("radarr", 24)).imported, false);
  let detail = await f.native.read("subtitle-detail", new URLSearchParams({ kind: "movie", id: 24 }));
  assert.equal(detail.item.includedSubtitlesAccepted, undefined);
  assert.equal(detail.item.missing_subtitles.length, 1);
  imported(f);
  const verified = await f.choices.verify("radarr", 24);
  assert.equal(verified.fileId, 51);
  assert.equal(verified.imported, true);
  assert.equal((await f.choices.forDownload("radarr", "abc123")).id, 24);
  detail = await f.native.read("subtitle-detail", new URLSearchParams({ kind: "movie", id: 24 }));
  assert.equal(detail.item.includedSubtitlesAccepted, true);
  assert.deepEqual(detail.item.missing_subtitles, []);
  f.state.history = [];
  assert.equal((await releaseChoices({ directory: f.directory, api: f.api }).verify("radarr", 24)).imported, true);
  f.state.files = [{ id: 52, movieId: 24, path: "D:\\Movies\\RK\\unrelated.mkv" }];
  assert.equal((await f.choices.verify("radarr", 24)).imported, false);
});

test("manual import carries the selected movie and metadata through parser mismatches and rejects reassignment", async t => {
  const f = fixture(t);
  await f.choices.choose(selected, release, {}); imported(f);
  let command;
  const importer = imports({ directory: f.directory, native: f.native, runCommand: async (n, body) => { command = body; return {}; }, api: async (n, p) => {
    if (p.includes("queue/details")) return [{ id: 8, downloadId: "ABC123" }];
    if (p.includes("manualimport?")) return [{ id: 7, movie: { id: 25 }, path: "D:\\Downloads\\selected.mkv", quality: { quality: { id: 1 } }, languages: [{ id: 1 }] }];
    if (p.endsWith("/movie")) return [{ id: 24, title: "RK/RKAY" }, { id: 25, title: "Wrong film" }];
    if (p.endsWith("qualitydefinition")) return [{ quality: release.quality.quality }];
    return release.languages;
  } });
  const plan = await importer.read("import-plan", new URLSearchParams({ service: "radarr", queueId: 8 }));
  assert.equal(plan.files[0].movie.id, 24); assert.deepEqual(plan.files[0].quality, release.quality); assert.deepEqual(plan.files[0].languages, release.languages);
  const body = { action: "manualImport", service: "radarr", token: plan.token, mode: "copy", files: [{ id: 7, titleId: 25, qualityId: 9, languageId: 26 }] };
  await assert.rejects(importer.execute(body, () => {}), /assigned to your selected movie/);
  await importer.execute({ ...body, files: [{ ...body.files[0], titleId: 24 }] }, () => {});
  assert.equal(command.files[0].movieId, 24); assert.deepEqual(command.files[0].quality, release.quality); assert.deepEqual(command.files[0].languages, release.languages); assert.equal(command.files[0].downloadId, "ABC123");
});

test("the journey follows the verified chosen file instead of an existing copy with the same provider ID", async t => {
  const f = fixture(t); await f.choices.choose(selected, release, { includedSubtitles: true });
  f.state.files = [{ id: 50, path: "D:\\old.mkv" }];
  const flow = workflows({ native: { read: async () => ({ item: f.state.movie, files: f.state.files, releaseChoice: await f.choices.verify("radarr", 24) }) }, api: async n => {
    if (n === "seerr") return { results: [] };
    if (n === "bazarr") return { data: [{ missing_subtitles: [{ code2: "en" }] }] };
    if (n === "jellyfin") return { Items: [{ Id: "old", Path: "D:\\old.mkv", ProviderIds: { Tmdb: "99" } }, { Id: "chosen", Path: "D:\\Movies\\RK\\selected.mkv", ProviderIds: { Tmdb: "99" } }] };
    return [];
  } });
  let result = await flow.title("radarr", 24);
  assert.equal(result.journey.stages[3].state, "blocked"); assert.equal(result.journey.stages[5].action, undefined); assert.equal(result.journey.missingSubtitles, 1);
  imported(f); result = await flow.title("radarr", 24);
  assert.equal(result.journey.missingSubtitles, 0); assert.equal(result.journey.stages[4].state, "complete"); assert.equal(result.journey.stages[5].action.id, "chosen"); assert.equal(result.journey.jellyfin.length, 1);
});

test("playback waits for the selected import and chooses its Jellyfin source when multiple copies exist", async t => {
  const f = fixture(t); await f.choices.choose(selected, release, {});
  const item = { Id: jellyId, ProviderIds: { Tmdb: "99" }, Path: "D:\\old.mkv", MediaSources: [{ Id: "old-source", Path: "D:\\old.mkv", MediaStreams: [] }, { Id: "chosen-source", Path: "D:\\Movies\\RK\\selected.mkv", Container: "mp4", MediaStreams: [{ Type: "Video", Codec: "h264" }, { Type: "Audio", Codec: "aac", Index: 1 }] }] };
  const w = watch({ native: f.native, config: { services: { jellyfin: {} } }, api: async (n, p) => {
    if (p === "/Users") return [{ Id: user }];
    if (p.startsWith("/Items?")) return { Items: [item] };
    if (p.includes("PlaybackInfo")) return { MediaSources: item.MediaSources };
    return {};
  } });
  await assert.rejects(w.execute({ action: "watchStart", id: jellyId, user }), /not available for playback yet/);
  imported(f);
  const detail = await w.read("watch-item", new URLSearchParams({ id: jellyId, user }));
  assert.equal(detail.releaseChoice.sourceId, "chosen-source"); assert.equal(detail.audioTracks[0].index, 1);
  const playback = await w.execute({ action: "watchStart", id: jellyId, user });
  assert.equal(playback.hls, false); assert.equal(playback.source.includes("private"), false);
});
