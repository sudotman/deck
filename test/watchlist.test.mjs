import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { letterboxdWatchlist, parseWatchlistPage } from "../lib/watchlist.mjs";

const item = (name, slug) => `<li><div data-item-name="${name}" data-item-slug="${slug}" data-item-link="/film/${slug}/"></div></li>`;
const page = (films, total) => `<span class="js-watchlist-count">${total}&nbsp;films</span><ul>${films.map(([n, s]) => item(n, s)).join("")}</ul>`;

test("watchlist pages yield titles, years and slugs, unescaped", () => {
  const { total, films } = parseWatchlistPage(page([["Moulin Rouge! (2001)", "moulin-rouge-2001"], ["Kiki&#039;s Delivery Service (1989)", "kikis-delivery-service"], ["Untitled", "untitled"]], "1,970"));
  assert.equal(total, 1970);
  assert.deepEqual(films[0], { slug: "moulin-rouge-2001", title: "Moulin Rouge!", year: 2001 });
  assert.equal(films[1].title, "Kiki's Delivery Service");
  assert.equal(films[2].year, null);
});

test("every page is read once, films are enriched from Seerr, and identities are cached on disk", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "deck-watchlist-"));
  const fetched = [];
  const fetchText = async url => {
    fetched.push(url);
    if (url.endsWith("/watchlist/")) return page(Array.from({ length: 28 }, (_, i) => [`Film ${i} (2000)`, `film-${i}`]), 30);
    if (url.endsWith("/page/2/")) return page([["Film 28 (2000)", "film-28"], ["Film 29 (2000)", "film-29"]], 30);
    const slug = url.match(/film\/([^/]+)\//)[1];
    return `<body data-tmdb-id="${100 + Number(slug.split("-")[1])}" data-tmdb-type="movie">`;
  };
  const calls = [];
  const api = async (name, p) => {
    assert.equal(name, "seerr"); calls.push(p);
    const id = Number(p.split("/").pop());
    return {
      title: `Film ${id - 100}`, releaseDate: "2000-05-01", runtime: 107, overview: "A film.", backdropPath: "/b.jpg", posterPath: "/p.jpg",
      credits: { crew: [{ job: "Writer", name: "W" }, { job: "Director", name: "D" }] },
      mediaInfo: { status: id % 2 ? 5 : 2 },
      watchProviders: [{ iso_3166_1: "US", flatrate: [{ name: "Max" }] }, { iso_3166_1: "IN", flatrate: [{ name: "Netflix" }, { name: "Netflix" }] }],
    };
  };
  const watchlist = letterboxdWatchlist({ api, user: "someone", directory, fetchText, random: () => 0.5 });
  const result = await watchlist.read(new URLSearchParams({ count: "3" }));
  assert.equal(result.total, 30);
  assert.equal(fetched.filter(u => u.includes("/watchlist/")).length, 2);
  assert.equal(result.films.length, 3);
  const film = result.films[0];
  assert.equal(film.director, "D"); assert.equal(film.runtime, 107); assert.equal(film.year, 2000);
  assert.equal(film.backdrop, "https://image.tmdb.org/t/p/w1280/b.jpg");
  assert.deepEqual(film.providers, ["Netflix"]);
  assert.ok(["available", "requested"].includes(film.status));

  // A second instance reads film identities from disk instead of Letterboxd.
  const before = fetched.length;
  const again = letterboxdWatchlist({ api, user: "someone", directory, fetchText, random: () => 0.5 });
  await again.read(new URLSearchParams({ count: "3" }));
  assert.equal(fetched.slice(before).filter(u => u.includes("/film/")).length, 0);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("a film Letterboxd can't identify, or Seerr can't find, still comes back as a title", async () => {
  const fetchText = async url => url.includes("/watchlist/") ? page([["Lost (1999)", "lost"]], 1) : "<body>";
  const watchlist = letterboxdWatchlist({ api: async () => { throw Error("down"); }, user: "u", fetchText });
  const { films } = await watchlist.read(new URLSearchParams());
  assert.deepEqual(films, [{ slug: "lost", title: "Lost", year: 1999, status: "unknown", providers: [] }]);
});

test("without a configured user the endpoint says so", async () => {
  const watchlist = letterboxdWatchlist({ api: async () => ({}), fetchText: async () => "" });
  await assert.rejects(watchlist.read(new URLSearchParams()), e => e.status === 404 && /not configured/.test(e.message));
});
