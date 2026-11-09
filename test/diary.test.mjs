import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { letterboxdDiary, parseCsv, parseDiaryRss, parseExport } from "../lib/diary.mjs";

const item = ({ slug, title, year, watched, stars, liked = "No", rewatch = "No", tmdb = 1 }) => `<item>
<title>${title}, ${year}</title><link>https://letterboxd.com/me/film/${slug}/</link>
<letterboxd:watchedDate>${watched}</letterboxd:watchedDate><letterboxd:rewatch>${rewatch}</letterboxd:rewatch>
<letterboxd:filmTitle>${title}</letterboxd:filmTitle><letterboxd:filmYear>${year}</letterboxd:filmYear>
${stars ? `<letterboxd:memberRating>${stars}</letterboxd:memberRating>` : ""}<letterboxd:memberLike>${liked}</letterboxd:memberLike>
<tmdb:movieId>${tmdb}</tmdb:movieId><description><![CDATA[<p>review</p>]]></description></item>`;
const rss = items => `<rss><channel><title>Letterboxd</title>${items.map(item).join("")}
<item><title>A list</title><link>https://letterboxd.com/me/list/x/</link></item></channel></rss>`;

test("RSS diary entries give the film, the date watched, half-star rating, like and rewatch", () => {
  const [a, b] = parseDiaryRss(rss([
    { slug: "blow-out", title: "Blow Out", year: 1981, watched: "2026-10-17", stars: "4.5", liked: "Yes" },
    { slug: "kabul-express", title: "Kabul Express", year: 2006, watched: "2026-10-30", rewatch: "Yes", tmdb: 30244 },
  ]));
  assert.deepEqual(a, { slug: "blow-out", title: "Blow Out", year: 1981, tmdbId: 1, watched: "2026-10-17", rating: 9, liked: true, rewatch: false });
  assert.equal(b.rating, null);
  assert.equal(b.rewatch, true);
  assert.equal(b.tmdbId, 30244);
});

test("a rewatch's link (…/film/slug/1/) still gives the film's slug", () => {
  const [e] = parseDiaryRss(rss([{ slug: "margin-call/1", title: "Margin Call", year: 2011, watched: "2026-10-16", stars: "5.0" }]));
  assert.equal(e.slug, "margin-call");
});

test("CSV fields may hold commas, quotes and newlines", () => {
  const rows = parseCsv('Name,Year,Rating\r\n"Crouching Tiger, Hidden Dragon",2000,4.5\n"The ""Real"" One",1999,3\n"Two\nLines",2001,\n');
  assert.deepEqual(rows.map(r => r.Name), ["Crouching Tiger, Hidden Dragon", 'The "Real" One', "Two\nLines"]);
  assert.equal(rows[0].Rating, "4.5");
});

test("an export merges ratings, likes and the latest diary viewing per film", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lbx-"));
  fs.mkdirSync(path.join(dir, "likes"));
  fs.writeFileSync(path.join(dir, "ratings.csv"), "Date,Name,Year,Letterboxd URI,Rating\n2020-01-01,Heat,1995,https://boxd.it/heat,4\n2020-01-01,Cats,2019,https://boxd.it/cats,1\n");
  fs.writeFileSync(path.join(dir, "likes", "films.csv"), "Date,Name,Year,Letterboxd URI\n2020-01-01,Heat,1995,https://boxd.it/heat\n");
  fs.writeFileSync(path.join(dir, "diary.csv"), [
    "Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date",
    "2019-05-02,Heat,1995,https://boxd.it/v1,3.5,,,2019-05-01",
    "2023-07-02,Heat,1995,https://boxd.it/v2,4.5,Yes,,2023-07-01",
  ].join("\n"));
  const films = parseExport(dir);
  const heat = films.find(f => f.title === "Heat");
  assert.deepEqual(heat, { title: "Heat", year: 1995, uri: "https://boxd.it/heat", watched: "2023-07-01", rating: 9, liked: true, rewatch: true });
  assert.equal(films.find(f => f.title === "Cats").watched, null);
});

function setup({ items, exportFiles, random = () => 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diary-"));
  if (exportFiles) {
    const root = path.join(dir, "data", "letterboxd-export");
    fs.mkdirSync(root, { recursive: true });
    for (const [name, text] of Object.entries(exportFiles)) fs.writeFileSync(path.join(root, name), text);
  }
  const pages = [];
  const diary = letterboxdDiary({
    user: "me", directory: dir, random,
    fetchText: async () => rss(items),
    resolve: async uri => `https://letterboxd.com/film/${uri.split("/").pop()}/`,
    details: async ({ slug }) => { pages.push(slug); return slug === "no-still" ? { director: "X" } : { backdrop: `https://img/${slug}.jpg`, director: "Dir", tmdbId: 7 }; },
  });
  return { diary, dir, pages };
}

test("the wall gets films rated 3★ and up, with stills, dates and stars; others stay off", async () => {
  const { diary } = setup({ items: [
    { slug: "blow-out", title: "Blow Out", year: 1981, watched: "2026-10-17", stars: "4.5", liked: "Yes" },
    { slug: "meh", title: "Meh", year: 2020, watched: "2026-10-10", stars: "2.5" },
    { slug: "unrated", title: "Unrated", year: 2020, watched: "2026-10-09" },
    { slug: "no-still", title: "No Still", year: 2020, watched: "2026-10-08", stars: "4" },
    { slug: "fine", title: "Fine", year: 2021, watched: "2026-10-07", stars: "3" },
  ] });
  const { total, films } = await diary.read(new URLSearchParams("count=10"));
  assert.equal(total, 3);
  assert.deepEqual(films.map(f => f.slug).sort(), ["blow-out", "fine"]);
  assert.deepEqual(films.find(f => f.slug === "blow-out"), {
    slug: "blow-out", title: "Blow Out", year: 1981, director: "Dir", tmdbId: 7,
    backdrop: "https://img/blow-out.jpg", watched: "2026-10-17", rating: 9, liked: true, rewatch: false,
  });
});

test("entries are kept on disk, so the history outlives the RSS's 50", async () => {
  const first = setup({ items: [{ slug: "old", title: "Old", year: 1990, watched: "2020-01-01", stars: "4" }] });
  await first.diary.read(new URLSearchParams());
  const later = letterboxdDiary({
    user: "me", directory: first.dir, now: () => Date.now() + 4 * 3600e3,
    fetchText: async () => rss([{ slug: "new", title: "New", year: 2026, watched: "2026-10-01", stars: "5" }]),
    details: async ({ slug }) => ({ backdrop: `https://img/${slug}.jpg` }),
  });
  await later.read(new URLSearchParams()); // the first read starts the refresh and serves what's known
  const { films } = await later.read(new URLSearchParams());
  assert.deepEqual(films.map(f => f.slug).sort(), ["new", "old"]);
});

test("export films are resolved through their short link, once, and the RSS wins for the same film", async () => {
  const { diary, dir } = setup({
    items: [{ slug: "heat", title: "Heat", year: 1995, watched: "2026-01-01", stars: "5" }],
    exportFiles: {
      "ratings.csv": "Date,Name,Year,Letterboxd URI,Rating\n2020-01-01,Heat,1995,https://boxd.it/heat,3\n2020-01-01,Ran,1985,https://boxd.it/ran,4.5\n",
    },
  });
  const { films } = await diary.read(new URLSearchParams());
  assert.deepEqual(films.map(f => [f.slug, f.rating, f.watched]).sort(), [["heat", 10, "2026-01-01"], ["ran", 9, null]]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "data", "diary.json"), "utf8")).slugs["https://boxd.it/ran"], "ran");
});

test("sampling leans toward favourites", async () => {
  const items = [
    { slug: "five", title: "Five", year: 2000, watched: "2026-01-01", stars: "5" },
    { slug: "three", title: "Three", year: 2000, watched: "2026-01-02", stars: "3" },
  ];
  let firsts = { five: 0, three: 0 };
  // Seeded (mulberry32), so the count is the same every run; Math.random fell short about 1 run in 300.
  let seed = 7;
  const random = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  for (let i = 0; i < 200; i++) {
    const { diary } = setup({ items, random });
    const { films } = await diary.read(new URLSearchParams("count=1"));
    firsts[films[0].slug]++;
  }
  // Weights 6 and 2: five should come first about three times as often.
  assert.ok(firsts.five > firsts.three * 2, JSON.stringify(firsts));
});
