import test from "node:test";
import assert from "node:assert/strict";
import { createStremioSubtitles, labelFor, parseExtra, rankSubtitles, releaseOf } from "../lib/stremio-subtitles.mjs";

const sub = (id, subtitleFileName, extra = {}) => ({ id: String(id), url: `https://subs5.strem.io/en/download/file/${id}`, lang: "eng", m: "i", subtitleFileName, ...extra });
const FILE = "The.Shawshank.Redemption.1994.REMASTERED.1080p.BluRay.x264-AMIABLE.mkv";

test("a file name gives its release group, source, resolution and edition", () => {
  const r = releaseOf(FILE);
  assert.equal(r.group, "AMIABLE");
  assert.equal(r.source, "BluRay");
  assert.equal(r.resolution, "1080p");
  assert.deepEqual(r.editions, ["remastered"]);
  assert.equal(r.part, false);
  assert.equal(releaseOf("Film.2019.1080p.WEB-DL.DDP5.1.H264-NTb.srt").source, "WEB-DL");
  assert.equal(releaseOf("Film.2019.1080p.WEB.H264-NTb").group, "NTb");
  assert.equal(releaseOf("film_engl.srt").group, null);
  assert.equal(releaseOf("The_Shawshank_Redemption_(1994).CD1.aFLDp.srt").part, true);
  assert.equal(releaseOf("Film.1080p.x264-x264.srt").group, null, "a codec isn't a group");
});

test("the subtitle for the same release comes first, split ones last, OpenSubtitles' hash match above all", () => {
  const ranked = rankSubtitles([
    sub(1, "sawshank_redemption_engl.srt"),
    sub(2, "The_Shawshank_Redemption_(1994).CD1.aFLDp.srt"),
    sub(3, "The.Shawshank.Redemption.1994.DVDRip.XviD-OS.srt"),
    sub(4, "The.Shawshank.Redemption.1994.REMASTERED.1080p.BluRay.x264-AMIABLE.srt"),
    sub(5, "Shawshank.Redemption.1994.720p.BRRip.x264-YIFY.srt"),
  ], { filename: FILE });
  assert.deepEqual(ranked.map(s => s.id), ["deck-4", "deck-5", "deck-1", "deck-3", "deck-2"]);
  assert.equal(ranked[0].label, "Same release · AMIABLE BluRay 1080p");
  assert.equal(ranked.at(-1).label, "Part of a split · The Shawshank Redemption (1994) CD1…");
  assert.equal(ranked[0].url, "https://subs5.strem.io/en/download/file/4#deck");

  const hashed = rankSubtitles([sub(4, "The.Shawshank.Redemption.1994.REMASTERED.1080p.BluRay.x264-AMIABLE.srt"), sub(9, "whatever.srt", { m: "h" })], { filename: FILE });
  assert.equal(hashed[0].id, "deck-9");
  assert.match(hashed[0].label, /^Exact match/);
});

test("WEB-DL and WEBRip count as one source; without a file name the order stays OpenSubtitles'", () => {
  const ranked = rankSubtitles([sub(1, "Film.2020.1080p.BluRay.x264-GRP.srt"), sub(2, "Film.2020.1080p.WEBRip.x264-OTHER.srt")], { filename: "Film.2020.1080p.WEB-DL.DDP5.1.H264-NTb.mkv" });
  assert.deepEqual(ranked.map(s => s.id), ["deck-2", "deck-1"]);
  assert.deepEqual(rankSubtitles([sub(1, "b.srt"), sub(2, "a.srt")]).map(s => s.id), ["deck-1", "deck-2"]);
});

test("each language keeps its eight best, duplicates go, and every subtitle has a name", () => {
  const many = Array.from({ length: 12 }, (_, i) => sub(i, `Film.${i}.srt`)).concat([sub(20, "Film.0.srt"), { ...sub(30, "Film.fr.srt"), lang: "fre" }]);
  const ranked = rankSubtitles(many);
  assert.equal(ranked.filter(s => s.lang === "eng").length, 8);
  assert.equal(ranked.filter(s => s.lang === "fre").length, 1);
  assert.ok(!ranked.some(s => s.id === "deck-20"), "the re-upload of Film.0.srt is dropped");
  assert.equal(labelFor({ subtitleFileName: "" }), "Unnamed release");
  assert.equal(labelFor({ subtitleFileName: "sawshank_redemption_engl.srt" }), "sawshank redemption engl");
  assert.equal(labelFor({ subtitleFileName: "S01E01 _ Pilot.srt" }), "S01E01 Pilot");
});

test("Stremio's extra args go upstream (hash, size, file name only) and answers are cached", async () => {
  const urls = [];
  const addon = createStremioSubtitles({ fetchJson: async url => { urls.push(url); return { subtitles: [sub(1, FILE)] }; } });
  const extra = "videoHash=8e245d9679d31e12&videoSize=12909756&filename=" + encodeURIComponent(FILE) + "&other=1";
  assert.deepEqual(parseExtra(extra).videoHash, "8e245d9679d31e12");
  const first = await addon.subtitles("movie", "tt0111161", extra);
  await addon.subtitles("movie", "tt0111161", extra);
  assert.equal(urls.length, 1);
  assert.equal(urls[0], `https://opensubtitles-v3.strem.io/subtitles/movie/tt0111161/videoHash=8e245d9679d31e12&videoSize=12909756&filename=${encodeURIComponent(FILE).replace(/%20/g, "+")}.json`);
  assert.match(first.subtitles[0].label, /^Same release/);
  assert.equal((await addon.subtitles("series", "tt0903747:1:2")).subtitles.length, 1);
  assert.match(urls[1], /\/subtitles\/series\/tt0903747%3A1%3A2\.json$/);
  assert.deepEqual(await addon.subtitles("movie", "kitsu:1"), { subtitles: [] });
  assert.deepEqual(await addon.subtitles("channel", "tt1"), { subtitles: [] });
});
