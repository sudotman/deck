import fs from "node:fs";
import path from "node:path";

// A public Letterboxd watchlist, sampled at random, with Seerr's view of each film:
// artwork, synopsis, whether it's in the library or requested, and where it streams.
const PAGE_SIZE = 28;
const LIST_TTL = 12 * 3600e3, FILM_TTL = 30 * 86400e3, STATE_TTL = 10 * 60e3;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const IMAGE = "https://image.tmdb.org/t/p/";
const unescape = s => s.replace(/&amp;/g, "&").replace(/&#0?39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, " ");
const status = s => ({ 2: "requested", 3: "downloading", 4: "available", 5: "available" }[s] || "missing");

async function defaultFetch(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw Error(`Letterboxd answered ${r.status}`);
  return r.text();
}

export function parseWatchlistPage(html) {
  const total = Number((html.match(/js-watchlist-count">([\d,]+)/)?.[1] || "").replace(/,/g, "")) || null;
  const films = [...html.matchAll(/data-item-name="([^"]+)"\s+data-item-slug="([^"]+)"/g)].map(([, name, slug]) => {
    const year = Number(name.match(/\((\d{4})\)\s*$/)?.[1]) || null;
    return { slug, title: unescape(name.replace(/\s*\(\d{4}\)\s*$/, "")), year };
  });
  return { total, films };
}

export function letterboxdWatchlist({ api, user, region = "IN", directory, fetchText = defaultFetch, now = Date.now, random = Math.random }) {
  const filename = directory && path.join(directory, "data", "watchlist.json");
  const cache = (() => {
    try { return { list: null, films: {}, ...JSON.parse(fs.readFileSync(filename, "utf8")) }; } catch { return { list: null, films: {} }; }
  })();
  const states = new Map();
  let refreshing = null;
  const save = () => { if (filename) try { fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, JSON.stringify(cache)); } catch {} };

  async function fetchList() {
    const base = `https://letterboxd.com/${encodeURIComponent(user)}/watchlist/`;
    const first = parseWatchlistPage(await fetchText(base));
    const pages = Math.ceil((first.total || first.films.length) / PAGE_SIZE);
    const films = [...first.films];
    // One page at a time: this runs twice a day and Letterboxd doesn't need a burst.
    for (let n = 2; n <= pages; n++) films.push(...parseWatchlistPage(await fetchText(`${base}page/${n}/`)).films);
    cache.list = { at: now(), total: first.total || films.length, films: [...new Map(films.map(f => [f.slug, f])).values()] };
    save();
    return cache.list;
  }

  function list() {
    const fresh = cache.list && now() - cache.list.at < LIST_TTL;
    if (!fresh && !refreshing) refreshing = fetchList().finally(() => { refreshing = null; });
    // A stale list is still a good list; serve it while the refresh runs.
    if (cache.list) { refreshing?.catch(() => {}); return Promise.resolve(cache.list); }
    return refreshing;
  }

  async function identity(film) {
    const known = cache.films[film.slug];
    if (known && now() - known.at < FILM_TTL) return known;
    const html = await fetchText(`https://letterboxd.com/film/${film.slug}/`);
    const entry = { at: now(), tmdbId: Number(html.match(/data-tmdb-id="(\d+)"/)?.[1]) || null, type: html.match(/data-tmdb-type="(movie|tv)"/)?.[1] || "movie" };
    cache.films[film.slug] = entry;
    save();
    return entry;
  }

  async function details(type, tmdbId) {
    const key = type + tmdbId, hit = states.get(key);
    if (hit && now() - hit.at < STATE_TTL) return hit.item;
    const item = await api("seerr", `/api/v1/${type}/${tmdbId}`);
    states.set(key, { at: now(), item });
    return item;
  }

  async function enrich(film) {
    const { tmdbId, type } = await identity(film);
    if (!tmdbId) return { ...film, status: "unknown", providers: [] };
    const item = await details(type, tmdbId);
    const offers = (item.watchProviders || []).find(p => p.iso_3166_1 === region);
    return {
      slug: film.slug,
      title: item.title || item.name || film.title,
      year: Number((item.releaseDate || item.firstAirDate || "").slice(0, 4)) || film.year,
      tmdbId, type,
      runtime: item.runtime || item.episodeRunTime?.[0] || null,
      overview: item.overview || null,
      director: item.credits?.crew?.find(c => c.job === "Director")?.name || item.createdBy?.[0]?.name || null,
      backdrop: item.backdropPath ? IMAGE + "w1280" + item.backdropPath : null,
      poster: item.posterPath ? IMAGE + "w500" + item.posterPath : null,
      status: status(item.mediaInfo?.status),
      providers: [...new Set((offers?.flatrate || []).map(p => p.providerName || p.name).filter(Boolean))],
    };
  }

  // Small pool so a cold cache doesn't open dozens of connections at once.
  async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
    }));
    return out;
  }

  if (user) list()?.catch(() => {}); // warm the list at startup

  return {
    async read(params) {
      if (!user) throw Object.assign(Error("Letterboxd is not configured"), { status: 404 });
      const count = Math.min(40, Math.max(1, Number(params.get("count")) || 12));
      const { total, at, films } = await list();
      const pool = [...films];
      for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
      const picked = await mapLimit(pool.slice(0, count), 4, f => enrich(f).catch(() => ({ ...f, status: "unknown", providers: [] })));
      return { user, total, updated: new Date(at).toISOString(), films: picked };
    },
  };
}
