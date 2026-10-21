import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { letterboxdWatchlist, parseFilmPage, parseWatchlistPage } from "../lib/watchlist.mjs";

const item = (name, slug) => `<li><div data-item-name="${name}" data-item-slug="${slug}" data-item-link="/film/${slug}/"></div></li>`;
const page = (films, total) => `<span class="js-watchlist-count">${total}&nbsp;films</span><ul>${films.map(([n, s]) => item(n, s)).join("")}</ul>`;
const filmPage = (id, { director = "Mike Leigh", minutes = 131 } = {}) => `
<meta name="description" content="An unemployed Brit&#039;s nocturnal London odyssey." />
<meta name="twitter:label1" content="Directed by" /><meta name="twitter:data1" content="${director}" />
<div class="backdrop-container"><div id="backdrop" data-backdrop="https://a.ltrbxd.com/b-1200.jpg" data-backdrop2x="https://a.ltrbxd.com/b-1920.jpg"></div></div>
<body data-tmdb-id="${id}" data-tmdb-type="movie"><p class="text-link">${minutes}&nbsp;mins</p>
<script type="application/ld+json">{"image":"https://a.ltrbxd.com/resized/film-poster/1/2/3/123-naked-0-600.jpg","@type":"Movie"}</script>`;

test("watchlist pages yield titles, years and slugs, unescaped", () => {
  const { total, films } = parseWatchlistPage(page([["Moulin Rouge! (2001)", "moulin-rouge-2001"], ["Kiki&#039;s Delivery Service (1989)", "kikis-delivery-service"], ["Untitled", "untitled"]], "1,970"));
  assert.equal(total, 1970);
  assert.deepEqual(films[0], { slug: "moulin-rouge-2001", title: "Moulin Rouge!", year: 2001 });
  assert.equal(films[1].title, "Kiki's Delivery Service");
  assert.equal(films[2].year, null);
});

test("film pages give the TMDB identity, 1080p backdrop, poster, synopsis, director and runtime", () => {
  assert.deepEqual(parseFilmPage(filmPage(21450)), {
    tmdbId: 21450, imdbId: null, type: "movie",
    backdrop: "https://a.ltrbxd.com/b-1920.jpg",
    poster: "https://a.ltrbxd.com/resized/film-poster/1/2/3/123-naked-0-600.jpg",
    overview: "An unemployed Brit's nocturnal London odyssey.",
    director: "Mike Leigh", runtime: 131,
  });
  assert.equal(parseFilmPage("<body>").tmdbId, null);
});

test("pages are read once, state comes from Radarr, offers from Seerr, and film details are cached on disk", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "deck-watchlist-"));
  const fetched = [];
  const fetchText = async url => {
    fetched.push(url);
    if (url.endsWith("/watchlist/")) return page(Array.from({ length: 28 }, (_, i) => [`Film ${i} (2000)`, `film-${i}`]), 30);
    if (url.endsWith("/page/2/")) return page([["Film 28 (2000)", "film-28"], ["Film 29 (2000)", "film-29"]], 30);
    return filmPage(100 + Number(url.match(/film-(\d+)\//)[1]));
  };
  const api = async (name, p) => {
    assert.equal(name, "seerr");
    return { watchProviders: [{ iso_3166_1: "US", flatrate: [{ name: "Max" }] }, { iso_3166_1: "IN", flatrate: [{ name: "Netflix" }, { name: "Netflix" }] }] };
  };
  // film-0 is downloaded, film-1 is in Radarr waiting, the rest are missing.
  const library = async () => [{ service: "radarr", tmdbId: 100, available: true }, { service: "radarr", tmdbId: 101, available: false }, { service: "sonarr", tmdbId: 102, available: true }];
  const watchlist = letterboxdWatchlist({ api, user: "someone", directory, library, fetchText, random: () => 0 });
  const result = await watchlist.read(new URLSearchParams({ count: "30" }));
  assert.equal(result.total, 30);
  assert.equal(fetched.filter(u => u.includes("/watchlist/")).length, 2);
  const bySlug = Object.fromEntries(result.films.map(f => [f.slug, f]));
  assert.equal(bySlug["film-0"].status, "available"); assert.deepEqual(bySlug["film-0"].providers, []);
  assert.equal(bySlug["film-1"].status, "requested");
  assert.equal(bySlug["film-2"].status, "missing"); assert.deepEqual(bySlug["film-2"].providers, ["Netflix"]);
  assert.equal(bySlug["film-2"].backdrop, "https://a.ltrbxd.com/b-1920.jpg");
  assert.equal(bySlug["film-2"].director, "Mike Leigh");

  const before = fetched.length;
  const again = letterboxdWatchlist({ api, user: "someone", directory, library, fetchText });
  await again.read(new URLSearchParams({ count: "5" }));
  assert.equal(fetched.slice(before).filter(u => u.includes("/film/")).length, 0);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("when Seerr is down, films still arrive and Seerr isn't asked again for a while", async () => {
  let seerrCalls = 0;
  const fetchText = async url => url.includes("/watchlist/") ? page([["A (1999)", "a"], ["B (1999)", "b"], ["C (1999)", "c"]], 3) : filmPage(url.includes("/a/") ? 1 : url.includes("/b/") ? 2 : 3);
  const watchlist = letterboxdWatchlist({ api: async () => { seerrCalls++; throw Error("Unable to retrieve movie."); }, user: "u", fetchText });
  const { films } = await watchlist.read(new URLSearchParams());
  assert.equal(films.length, 3);
  assert.ok(films.every(f => f.status === "missing" && f.providers.length === 0 && f.backdrop));
  assert.equal(seerrCalls, 1);
});

test("a film page that won't load still comes back as a title", async () => {
  const fetchText = async url => { if (url.includes("/watchlist/")) return page([["Lost (1999)", "lost"]], 1); throw Error("Letterboxd answered 403"); };
  const watchlist = letterboxdWatchlist({ api: async () => ({}), user: "u", fetchText });
  const { films } = await watchlist.read(new URLSearchParams());
  assert.deepEqual(films, [{ slug: "lost", title: "Lost", year: 1999, status: "unknown", providers: [] }]);
});

test("requests become a Radarr add with search, on the configured or best-matching profile", async () => {
  const api = async (name, p) => {
    assert.equal(name, "radarr");
    return p.endsWith("rootfolder") ? [{ path: "D:\\Movies" }] : [{ id: 1, name: "Any" }, { id: 4, name: "HD-1080p" }, { id: 6, name: "HD - 720p/1080p" }];
  };
  const watchlist = letterboxdWatchlist({ api, user: "u", fetchText: async () => page([], 0) });
  assert.deepEqual(await watchlist.requestPlan({ tmdbId: 21450 }), { action: "add", service: "radarr", externalId: 21450, root: "D:\\Movies", profile: 6, search: true });
  const pinned = letterboxdWatchlist({ api, user: "u", profile: "HD-1080p", fetchText: async () => page([], 0) });
  assert.equal((await pinned.requestPlan({ tmdbId: 1 })).profile, 4);
  await assert.rejects(watchlist.requestPlan({ tmdbId: "1/../x" }), e => e.status === 400);
});

test("without a configured user the endpoint says so", async () => {
  const watchlist = letterboxdWatchlist({ api: async () => ({}), fetchText: async () => "" });
  await assert.rejects(watchlist.read(new URLSearchParams()), e => e.status === 404 && /not configured/.test(e.message));
});

test("tonight's film holds until 5 am, can be chosen or re-rolled, and survives a restart", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "deck-tonight-"));
  const films = [["Alpha (2001)", "alpha"], ["Beta (2002)", "beta"], ["Gamma (2003)", "gamma"]];
  const fetchText = async url => url.includes("/watchlist/") ? page(films, 3) : filmPage(1 + ["alpha", "beta", "gamma"].findIndex(s => url.includes(`/${s}/`)));
  let clock = new Date(2026, 9, 20, 20, 0).getTime(); // 8 pm on the 20th
  let roll = 0;
  const make = () => letterboxdWatchlist({ api: async () => ({}), user: "u", directory, fetchText, now: () => clock, random: () => [0, 0.5, 0.9][roll++ % 3] });
  const watchlist = make();

  const first = await watchlist.tonight();
  assert.equal(first.night, "2026-10-20");
  clock = new Date(2026, 9, 21, 1, 30).getTime(); // 1.30 am: still the night of the 20th
  assert.equal((await watchlist.tonight()).film.slug, first.film.slug);
  assert.equal((await make().tonight()).film.slug, first.film.slug, "a restart keeps tonight's film");

  const other = await watchlist.choose({ next: true });
  assert.notEqual(other.film.slug, first.film.slug);
  const third = await watchlist.choose({ next: true });
  assert.ok(![first.film.slug, other.film.slug].includes(third.film.slug), "films offered tonight aren't offered again");

  assert.equal((await watchlist.choose({ slug: "beta" })).film.slug, "beta");
  assert.equal((await watchlist.tonight()).film.slug, "beta");
  await assert.rejects(watchlist.choose({ slug: "nope" }), /isn't on the watchlist/);

  clock = new Date(2026, 9, 21, 6, 0).getTime(); // 6 am: a new night
  assert.equal((await watchlist.tonight()).night, "2026-10-21");
  fs.rmSync(directory, { recursive: true, force: true });
});

test("the film picker searches titles and years, ignoring case and accents", async () => {
  const fetchText = async url => url.includes("/watchlist/") ? page([["Amélie (2001)", "amelie"], ["Heat (1995)", "heat"]], 2) : filmPage(1);
  const watchlist = letterboxdWatchlist({ api: async () => ({}), user: "u", fetchText });
  assert.deepEqual((await watchlist.search(new URLSearchParams({ q: "AMELIE" }))).films.map(f => f.slug), ["amelie"]);
  assert.deepEqual((await watchlist.search(new URLSearchParams({ q: "1995" }))).films.map(f => f.slug), ["heat"]);
  assert.equal((await watchlist.search(new URLSearchParams())).films.length, 2);
});

test("tonight's film carries Stremio's verdict when the film has an IMDb id", async () => {
  const fetchText = async url => url.includes("/watchlist/") ? page([["Belladonna of Sadness (1973)", "belladonna"]], 1)
    : filmPage(5) + '<a href="http://www.imdb.com/title/tt0071203/maindetails" data-track-action="IMDb">IMDb</a>';
  const checked = [];
  const stremio = { check: async id => { checked.push(id); return { good: true, quality: "1080p", seeders: 90, count: 4 }; } };
  const watchlist = letterboxdWatchlist({ api: async () => ({}), user: "u", fetchText, stremio });
  const { film } = await watchlist.tonight();
  assert.equal(film.imdbId, "tt0071203");
  assert.deepEqual(checked, ["tt0071203"]);
  assert.equal(film.stremio.quality, "1080p");
});
