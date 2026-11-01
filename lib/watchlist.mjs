import fs from "node:fs";
import path from "node:path";

// A public Letterboxd watchlist, sampled at random for the TV launcher. Each film's artwork and
// details come from its Letterboxd page; library state comes from Radarr. Seerr adds streaming
// offers when it can reach TMDB, and is skipped for a while when it can't.
const PAGE_SIZE = 28;
const LIST_TTL = 12 * 3600e3, FILM_TTL = 30 * 86400e3, OFFER_TTL = 6 * 3600e3, SEERR_BACKOFF = 10 * 60e3;
// "Tonight" runs until 5 am, so a film chosen at midnight is still tonight's film at 1.
const NIGHT_ENDS_AT = 5;

/** The evening a moment belongs to, as a local date: 1 am on the 21st is still the night of the 20th. */
export function nightOf(t) {
  const d = new Date(t - NIGHT_ENDS_AT * 3600e3);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const unescape = s => s.replace(/&amp;/g, "&").replace(/&#0?39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, " ").replace(/&#x27;/g, "'");

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

export function parseFilmPage(html) {
  const meta = name => html.match(new RegExp(`<meta (?:name|property)="${name}" content="([^"]*)"`))?.[1];
  const label = meta("twitter:label1");
  return {
    tmdbId: Number(html.match(/data-tmdb-id="(\d+)"/)?.[1]) || null,
    imdbId: html.match(/imdb\.com\/title\/(tt\d+)/)?.[1] || null,
    type: html.match(/data-tmdb-type="(movie|tv)"/)?.[1] || "movie",
    backdrop: html.match(/data-backdrop2x="([^"]+)"/)?.[1] || html.match(/data-backdrop="([^"]+)"/)?.[1] || null,
    poster: html.match(/"image":"(https:[^"]+film-poster[^"]+)"/)?.[1] || null,
    overview: meta("description") ? unescape(meta("description")) : null,
    director: label && /direct/i.test(label) ? unescape(meta("twitter:data1") || "") || null : null,
    runtime: Number(html.match(/(\d+)&nbsp;mins/)?.[1]) || null,
    originalTitle: unescape(html.match(/class="originalname"[^>]*>\s*<em[^>]*>([^<]+)</)?.[1] || "").trim() || null,
    alternativeTitles: unescape(html.match(/Alternative Titles<\/span><\/h3>\s*<div[^>]*>\s*<p>([^<]*)</)?.[1] || "")
      .split(",").map(t => t.trim()).filter(Boolean),
  };
}

export function letterboxdWatchlist({
  api, user, region = "IN", directory, library = async () => [], profile, root, stremio = null, fullFilm = null,
  fetchText = defaultFetch, now = Date.now, random = Math.random,
}) {
  const filename = directory && path.join(directory, "data", "watchlist.json");
  const cache = (() => {
    try { return { list: null, films: {}, tonight: null, ...JSON.parse(fs.readFileSync(filename, "utf8")) }; } catch { return { list: null, films: {}, tonight: null }; }
  })();
  const offers = new Map();
  let refreshing = null, seerrDownUntil = 0, seerrQueue = Promise.resolve();
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

  async function details(film) {
    const known = cache.films[film.slug];
    if (known && known.v === 4 && now() - known.at < FILM_TTL) return known;
    const entry = { v: 4, at: now(), ...parseFilmPage(await fetchText(`https://letterboxd.com/film/${film.slug}/`)) };
    cache.films[film.slug] = entry;
    save();
    return entry;
  }

  // Subscription services for the region, from Seerr (TMDB/JustWatch). Optional. Calls go one at a
  // time so that a single failure stops the rest instead of every film timing out in parallel.
  function streaming(type, tmdbId) {
    const run = async () => {
      const key = type + tmdbId, hit = offers.get(key);
      if (hit && now() - hit.at < OFFER_TTL) return hit.names;
      if (now() < seerrDownUntil) return [];
      try {
        const item = await api("seerr", `/api/v1/${type}/${tmdbId}`);
        const names = [...new Set(((item.watchProviders || []).find(p => p.iso_3166_1 === region)?.flatrate || []).map(p => p.providerName || p.name).filter(Boolean))];
        offers.set(key, { at: now(), names });
        return names;
      } catch {
        seerrDownUntil = now() + SEERR_BACKOFF;
        return [];
      }
    };
    const result = seerrQueue.then(run);
    seerrQueue = result.catch(() => {});
    return result;
  }

  async function enrich(film, owned) {
    const d = await details(film);
    const inRadarr = d.tmdbId && owned.get(d.tmdbId);
    return {
      slug: film.slug, title: film.title, year: film.year,
      tmdbId: d.tmdbId, imdbId: d.imdbId, type: d.type, runtime: d.runtime, overview: d.overview, director: d.director,
      originalTitle: d.originalTitle, alternativeTitles: d.alternativeTitles,
      backdrop: d.backdrop, poster: d.poster,
      status: !d.tmdbId ? "unknown" : inRadarr ? (inRadarr.available ? "available" : "requested") : "missing",
      providers: d.tmdbId && !inRadarr?.available ? await streaming(d.type, d.tmdbId) : [],
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

  const owned = async () => {
    const items = await library().catch(() => []);
    return new Map(items.filter(i => i.service === "radarr" && i.tmdbId).map(i => [i.tmdbId, i]));
  };
  const enrichSafely = (film, mine) => enrich(film, mine).catch(() => ({ ...film, status: "unknown", providers: [] }));

  // One pick per night, kept on disk, so every screen shows the same film and a reboot doesn't reshuffle.
  // Films already offered tonight aren't offered again until the list runs out.
  function pickFor(night, films, avoid = []) {
    const seen = new Set(cache.tonight?.night === night ? cache.tonight.offered || [] : []);
    avoid.forEach(slug => seen.add(slug));
    const fresh = films.filter(f => !seen.has(f.slug));
    const pool = fresh.length ? fresh : films;
    const film = pool[Math.floor(random() * pool.length)];
    cache.tonight = { night, slug: film.slug, offered: [...(fresh.length ? seen : []), film.slug] };
    save();
    return film;
  }

  return {
    async read(params) {
      if (!user) throw Object.assign(Error("Letterboxd is not configured"), { status: 404 });
      const count = Math.min(40, Math.max(1, Number(params.get("count")) || 12));
      const [{ total, at, films }, items] = await Promise.all([list(), library().catch(() => [])]);
      const owned = new Map(items.filter(i => i.service === "radarr" && i.tmdbId).map(i => [i.tmdbId, i]));
      const pool = [...films];
      for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
      const picked = await mapLimit(pool.slice(0, count), 4, f => enrich(f, owned).catch(() => ({ ...f, status: "unknown", providers: [] })));
      return { user, total, updated: new Date(at).toISOString(), films: picked };
    },

    /** Tonight's film, enriched with its current library state. */
    async tonight() {
      if (!user) throw Object.assign(Error("Letterboxd is not configured"), { status: 404 });
      const [{ total, films }, mine] = await Promise.all([list(), owned()]);
      if (!films.length) throw Object.assign(Error("The watchlist is empty"), { status: 404 });
      const night = nightOf(now());
      const kept = cache.tonight?.night === night && films.find(f => f.slug === cache.tonight.slug);
      const film = await enrichSafely(kept || pickFor(night, films), mine);
      // Whether Stremio has a good copy and whether YouTube has the whole film, both checked before
      // anyone asks; neither holds tonight's film up for long.
      const [onStremio, onYouTube] = await Promise.all([
        stremio && film.imdbId ? stremio.check(film.imdbId).catch(() => null) : null,
        fullFilm ? fullFilm.check(film).catch(() => null) : null,
      ]);
      if (onStremio) film.stremio = onStremio;
      if (onYouTube) film.youtube = onYouTube;
      return { night, total, film };
    },

    /** Changes tonight's film: `{ slug }` to choose one, `{ next: true }` for another at random. */
    async choose(body) {
      if (!user) throw Object.assign(Error("Letterboxd is not configured"), { status: 404 });
      const { films } = await list();
      const night = nightOf(now());
      if (body?.next) {
        pickFor(night, films, cache.tonight?.night === night ? [cache.tonight.slug] : []);
      } else {
        const film = typeof body?.slug === "string" && films.find(f => f.slug === body.slug);
        if (!film) throw Object.assign(Error("That film isn't on the watchlist"), { status: 404 });
        const offered = cache.tonight?.night === night ? cache.tonight.offered || [] : [];
        cache.tonight = { night, slug: film.slug, offered: [...new Set([...offered, film.slug])] };
        save();
      }
      return this.tonight();
    },

    /** Watchlist titles matching a search, for choosing a film from a phone. No enrichment: it's a picker. */
    async search(params) {
      const { films } = await list();
      const q = String(params.get("q") || "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      const fold = s => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      const hits = q ? films.filter(f => fold(`${f.title} ${f.year || ""}`).includes(q)) : films;
      return { films: hits.slice(0, 40).map(f => ({ slug: f.slug, title: f.title, year: f.year, poster: cache.films[f.slug]?.poster || null })) };
    },

    // Turns "request this film" into Deck's own Radarr add, searching straight away.
    async requestPlan(body) {
      const tmdbId = Number(body?.tmdbId);
      if (!Number.isInteger(tmdbId) || tmdbId < 1) throw Object.assign(Error("Choose a valid film"), { status: 400 });
      const [roots, profiles] = await Promise.all([api("radarr", "/api/v3/rootfolder"), api("radarr", "/api/v3/qualityprofile")]);
      const folder = roots.find(r => r.path === root) || roots[0];
      const quality = profiles.find(p => p.id === Number(profile) || p.name === profile)
        || profiles.find(p => /720p\/1080p/i.test(p.name)) || profiles.find(p => /1080p/i.test(p.name)) || profiles[0];
      if (!folder || !quality) throw Object.assign(Error("Radarr has no root folder or quality profile"), { status: 502 });
      return { action: "add", service: "radarr", externalId: tmdbId, root: folder.path, profile: quality.id, search: true };
    },
  };
}
