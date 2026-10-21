import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createYouTube, parseFeed, parseTakeout, pickLatest } from "../lib/youtube.mjs";

const A = "UCBJycsmduvYEL83R_U4JriQ", B = "UCsBjURrPoezykLs9EqgamOA";
const entry = (id, title, published, shorts = false) =>
  `<entry><yt:videoId>${id}</yt:videoId><title>${title}</title><link rel="alternate" href="https://www.youtube.com/${shorts ? "shorts/" : "watch?v="}${id}"/><published>${published}</published></entry>`;
const feed = (name, entries) => `<feed><author><name>${name}</name></author>${entries.join("")}</feed>`;

test("Takeout's CSV gives channel ids and titles, whatever the header language", () => {
  const csv = `Kanal-ID,Kanal-URL,Kanaltitel\n${A},http://www.youtube.com/channel/${A},Marques Brownlee\n${B},http://www.youtube.com/channel/${B},"Fireship, Inc"\n${A},dup,dup\n`;
  assert.deepEqual(parseTakeout(csv), [{ id: A, title: "Marques Brownlee" }, { id: B, title: "Fireship, Inc" }]);
  assert.deepEqual(parseTakeout("nothing here"), []);
});

test("feeds give uploads with Shorts marked; the room gets the newest, two per channel at most", () => {
  const videos = parseFeed(feed("MKBHD &amp; co", [entry("a1", "One", "2026-10-21T10:00:00Z"), entry("s1", "Short", "2026-10-21T12:00:00Z", true), entry("a2", "Two", "2026-10-20T10:00:00Z"), entry("a3", "Three", "2026-10-19T10:00:00Z")]))
    .concat(parseFeed(feed("Fireship", [entry("b1", "Code &quot;report&quot;", "2026-10-20T12:00:00Z")])));
  assert.equal(videos[0].channel, "MKBHD & co");
  assert.equal(videos.find(v => v.id === "s1").short, true);
  assert.deepEqual(pickLatest(videos, 10).map(v => v.id), ["a1", "b1", "a2"]);
  assert.equal(videos.find(v => v.id === "b1").title, 'Code "report"');
});

test("an imported list feeds the room from public channel feeds, kept on disk; disconnecting forgets it", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "deck-youtube-"));
  const fetched = [];
  const fetch = async (url, init) => {
    fetched.push(url);
    if (init?.method === "HEAD") return { ok: url.includes("a1") };
    const id = new URL(url).searchParams.get("channel_id");
    return { ok: true, text: async () => feed(id === A ? "MKBHD" : "Fireship", [entry(id === A ? "a1" : "b1", "x", id === A ? "2026-10-21T10:00:00Z" : "2026-10-20T10:00:00Z")]) };
  };
  const youtube = createYouTube({ directory, fetch });
  assert.deepEqual(await youtube.videos(), []);
  assert.equal(youtube.status().connected, false);
  assert.equal(youtube.importTakeout(`id,url,title\n${A},u,MKBHD\n${B},u,Fireship`), 2);
  const videos = await youtube.videos(5);
  assert.deepEqual(videos.map(v => [v.id, v.thumb]), [["a1", "https://i.ytimg.com/vi/a1/hq720.jpg"], ["b1", "https://i.ytimg.com/vi/b1/mqdefault.jpg"]]);
  assert.deepEqual(createYouTube({ directory, fetch }).status(), { connected: true, source: "takeout", channels: 2, canSignIn: false, signIn: null });
  assert.throws(() => youtube.importTakeout("no channels"), /no channels/);
  await assert.rejects(youtube.startSignIn(), /OAuth client/);
  youtube.disconnect();
  assert.equal(createYouTube({ directory, fetch }).status().connected, false);
  fs.rmSync(directory, { recursive: true, force: true });
});
