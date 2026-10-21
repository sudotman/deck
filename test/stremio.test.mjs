import test from "node:test";
import assert from "node:assert/strict";
import { createStremio, parseStreams, verdict } from "../lib/stremio.mjs";

const stream = (quality, seeders, size = "2.1 GB") => ({ name: `Torrentio\n${quality}`, title: `Film.1973.${quality}.BluRay\n👤 ${seeders} 💾 ${size} ⚙️ YTS` });

test("Torrentio's labels give each source's resolution, seeders and size", () => {
  assert.deepEqual(parseStreams([stream("1080p", 133, "2.24 GB"), { name: "Torrentio\n4k HDR", title: "x\n👤 9 💾 40 GB" }, { name: "Torrentio\nCAM", title: "x" }]), [
    { quality: "1080p", rank: 3, seeders: 133, size: "2.24 GB" },
    { quality: "4k", rank: 4, seeders: 9, size: "40 GB" },
    { quality: null, rank: 0, seeders: 0, size: null },
  ]);
});

test("good means 1080p or better with enough seeders; resolution first, then seeders", () => {
  assert.deepEqual(verdict(parseStreams([stream("720p", 400), stream("1080p", 40), stream("1080p", 90), stream("2160p", 3)])),
    { good: true, quality: "1080p", seeders: 90, size: "2.1 GB", count: 4 });
  assert.equal(verdict(parseStreams([stream("720p", 400)])).good, false, "720p isn't good enough");
  assert.equal(verdict(parseStreams([stream("2160p", 18, "45 GB"), stream("1080p", 100)])).quality, "1080p", "thin 4K loses to well-seeded 1080p");
  assert.equal(verdict(parseStreams([stream("2160p", 80), stream("1080p", 300)])).quality, "2160p", "well-seeded 4K wins");
  assert.equal(verdict(parseStreams([stream("1080p", 4)])).good, false, "too few seeders");
  assert.deepEqual(verdict([]), { good: false, count: 0 });
});

test("checks are cached, and only IMDb ids are looked up", async () => {
  let calls = 0;
  const stremio = createStremio({ fetchJson: async url => { calls++; assert.match(url, /\/stream\/movie\/tt0071203\.json$/); return { streams: [stream("1080p", 50)] }; } });
  assert.equal((await stremio.check("tt0071203")).good, true);
  await stremio.check("tt0071203");
  assert.equal(calls, 1);
  assert.equal(await stremio.check("nope"), null);
});
