import test from "node:test";
import assert from "node:assert/strict";
import { mediaRequests } from "../lib/requests.mjs";
import { nativeControls } from "../lib/native.mjs";

test("search excludes people and keeps movie and TV identities and availability", async () => {
  let path;
  const requests = mediaRequests({ api: async (n, p) => { assert.equal(n, "seerr"); path = p; return { page: 2, totalPages: 3, results: [{ id: 7, mediaType: "movie", title: "Film", releaseDate: "2024-02-01", mediaInfo: { status: 5 } }, { id: 7, mediaType: "tv", name: "Series" }, { mediaType: "person" }] }; } });
  const result = await requests.read("request-search", new URLSearchParams({ q: "A & B", page: 2 }));
  assert.equal(new URL("http://seerr" + path).searchParams.get("query"), "A & B");
  assert.ok(path.includes("A%20%26%20B"));
  assert.equal(result.results.length, 2); assert.equal(result.results[0].status, "Available"); assert.equal(result.results[1].type, "tv"); assert.equal(result.page, 2);
});

test("movie requests use server defaults and refuse existing requests before POST", async () => {
  let status = 1; const writes = [];
  const requests = mediaRequests({ api: async (n, p, method, body) => {
    if (method === "POST") { writes.push(body); return { id: 11, status: 2 }; }
    return { id: 9, title: "Film", mediaInfo: { status } };
  } });
  assert.deepEqual(await requests.create({ mediaType: "movie", mediaId: 9, userId: 88, profileId: 77, is4k: true }), { requestId: 11, message: "Film · Request approved" });
  assert.deepEqual(writes, [{ mediaType: "movie", mediaId: 9, is4k: false }]);
  for (status of [2, 3, 5]) await assert.rejects(requests.create({ mediaType: "movie", mediaId: 9 }), /already requested/);
  assert.equal(writes.length, 1);
  await assert.rejects(requests.create({ mediaType: "person", mediaId: 9 }), /movie or series/);
  await assert.rejects(requests.create({ mediaType: "movie", mediaId: "9/other" }), /valid title/);
});

test("TV requests validate exact seasons against refreshed availability and pending requests", async () => {
  const writes = [];
  const requests = mediaRequests({ api: async (n, p, method, body) => {
    if (p.endsWith("auth/me")) return { displayName: "Owner", password: "secret" };
    if (method === "POST") { writes.push(body); return { id: 12, status: 1 }; }
    return { id: 9, name: "Series", seasons: [0, 1, 2, 3, 4].map(seasonNumber => ({ seasonNumber, name: "Season " + seasonNumber, episodeCount: 8 })), mediaInfo: { status: 4, seasons: [{ seasonNumber: 1, status: 5 }], requests: [{ status: 1, seasons: [{ seasonNumber: 2, status: 1 }] }, { status: 3, seasons: [{ seasonNumber: 3, status: 3 }] }] } };
  } });
  const details = await requests.read("request-details", new URLSearchParams({ type: "tv", id: 9 }));
  assert.equal(details.requester, "Owner"); assert.equal(details.password, undefined);
  assert.deepEqual(details.seasons.map(s => s.canRequest), [true, false, false, true, true]);
  for (const seasons of [[], [1], [2], [99], [-1], [3.2]]) await assert.rejects(requests.create({ mediaType: "tv", mediaId: 9, seasons }), /season/i);
  assert.equal(writes.length, 0);
  await requests.create({ mediaType: "tv", mediaId: 9, seasons: [4, 0, 3, 3] });
  assert.deepEqual(writes[0], { mediaType: "tv", mediaId: 9, is4k: false, seasons: [0, 3, 4] });
});

test("native dispatcher queues requests as Seerr tasks and forwards upstream errors", async () => {
  let service;
  const controls = nativeControls({ cache: new Map(), services: {}, api: async () => { throw Error("Seerr is unavailable"); }, jobs: { start(label, name) { service = name; return { label }; } } });
  assert.equal(controls.start({ action: "requestCreate", mediaType: "movie", mediaId: 1 }).label, "Request media");
  assert.equal(service, "seerr");
  await assert.rejects(controls.execute({ action: "requestCreate", mediaType: "movie", mediaId: 1 }), /Seerr is unavailable/);
});
