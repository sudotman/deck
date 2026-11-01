import fs from "node:fs";
import path from "node:path";

// Films the user has watched and rated, for the TV's wall: stills from films they liked, with the date
// they watched each and the stars they gave it. Letterboxd's RSS carries the latest 50 diary entries
// (older diary pages sit behind a bot challenge), so every entry seen is kept on disk and the history
// grows from there. A Letterboxd data export, unzipped into data/letterboxd-export, adds everything
// before that. Stills and directors come from each film's Letterboxd page, cached with the watchlist's.
const FEED_TTL = 3 * 3600e3;
const MIN_RATING = 6; // half-stars: 3★ and up go on the wall
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const unescape = s => s.replace(/&amp;/g, "&").replace(/&#0?39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");

async function defaultFetch(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/rss+xml, text/xml" }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw Error(`Letterboxd answered ${r.status}`);
  return r.text();
}

/** Where a short link (boxd.it) points, without following it: Letterboxd's film URL. */
async function defaultResolve(url) {
  const r = await fetch(url, { redirect: "manual", headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
  return r.headers.get("location");
}

const slugOf = url => url?.match(/\/film\/([^/]+)\//)?.[1] || null;
const keyOf = (title, year) => `${String(title).toLowerCase()}|${year || ""}`;

/** Diary entries in the RSS feed; list and review-only items without a film are skipped. */
export function parseDiaryRss(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, item]) => {
    const tag = name => item.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1];
    const title = tag("letterboxd:filmTitle");
    const watched = tag("letterboxd:watchedDate");
    if (!title || !watched) return null;
    const stars = Number(tag("letterboxd:memberRating"));
    return {
      slug: slugOf(tag("link")),
      title: unescape(title),
      year: Number(tag("letterboxd:filmYear")) || null,
      tmdbId: Number(tag("tmdb:movieId")) || null,
      watched,
      rating: stars ? Math.round(stars * 2) : null,
      liked: tag("letterboxd:memberLike") === "Yes",
      rewatch: tag("letterboxd:rewatch") === "Yes",
    };
  }).filter(e => e?.slug);
}

/** RFC 4180 CSV: quoted fields may hold commas, quotes ("") and newlines. Rows as objects by header. */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows.filter(r => r.some(Boolean));
  return (body || []).map(r => Object.fromEntries((header || []).map((h, i) => [h.trim(), r[i] ?? ""])));
}

/**
 * A Letterboxd export (diary.csv, ratings.csv, likes/films.csv), as films keyed by title and year.
 * Each keeps its latest viewing; a film rated but never logged has a rating and no date.
 */
export function parseExport(dir) {
  const read = name => { try { return parseCsv(fs.readFileSync(path.join(dir, name), "utf8")); } catch { return []; } };
  const films = new Map();
  const film = (row) => {
    const key = keyOf(row.Name, row.Year);
    if (!films.has(key)) films.set(key, { title: row.Name, year: Number(row.Year) || null, uri: null, watched: null, rating: null, liked: false, rewatch: false });
    return films.get(key);
  };
  for (const row of read("ratings.csv")) {
    const f = film(row);
    f.rating = Math.round(Number(row.Rating) * 2) || f.rating;
    f.uri = row["Letterboxd URI"] || f.uri; // the film's own short link
  }
  for (const row of read(path.join("likes", "films.csv"))) {
    const f = film(row);
    f.liked = true;
    f.uri = row["Letterboxd URI"] || f.uri;
  }
  for (const row of read("diary.csv")) {
    const f = film(row);
    const watched = row["Watched Date"] || row.Date;
    if (f.watched && f.watched > watched) continue;
    f.watched = watched;
    f.rewatch = row.Rewatch === "Yes";
    // A viewing's own rating beats the film's when it's the latest viewing.
    if (Number(row.Rating)) f.rating = Math.round(Number(row.Rating) * 2);
    f.uri ||= row["Letterboxd URI"]; // a viewing's link also leads to the film
  }
  return [...films.values()];
}

export function letterboxdDiary({
  user, directory, details, fetchText = defaultFetch, resolve = defaultResolve, now = Date.now, random = Math.random,
}) {
  const filename = directory && path.join(directory, "data", "diary.json");
  const exportDir = directory && path.join(directory, "data", "letterboxd-export");
  // entries: title|year → film. slugs: short link → slug, so an export is only resolved once.
  const cache = (() => {
    try { return { at: 0, entries: {}, slugs: {}, ...JSON.parse(fs.readFileSync(filename, "utf8")) }; } catch { return { at: 0, entries: {}, slugs: {} }; }
  })();
  const save = () => { if (filename) try { fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, JSON.stringify(cache)); } catch {} };
  let refreshing = null, exported = null;

  /** Latest viewing wins; a newer entry without stars keeps the older stars. */
  function remember(e) {
    const key = keyOf(e.title, e.year), known = cache.entries[key];
    if (known && known.watched && e.watched && known.watched > e.watched) return;
    cache.entries[key] = { ...known, ...e, rating: e.rating ?? known?.rating ?? null, liked: e.liked || !!known?.liked };
  }

  async function refresh() {
    const entries = parseDiaryRss(await fetchText(`https://letterboxd.com/${encodeURIComponent(user)}/rss/`));
    entries.forEach(remember);
    cache.at = now();
    save();
  }

  function fresh() {
    if (now() - cache.at > FEED_TTL && !refreshing) refreshing = refresh().finally(() => { refreshing = null; });
    // Whatever is already known is good enough to show while the feed is read.
    if (Object.keys(cache.entries).length) { refreshing?.catch(() => {}); return Promise.resolve(); }
    return refreshing || Promise.resolve();
  }

  /** The export, read once; entries the RSS knows better aren't overwritten. */
  function fromExport() {
    if (exported) return exported;
    exported = exportDir ? parseExport(exportDir) : [];
    return exported;
  }

  function pool() {
    const all = new Map(fromExport().map(f => [keyOf(f.title, f.year), f]));
    for (const [key, e] of Object.entries(cache.entries)) {
      const old = all.get(key);
      all.set(key, { ...old, ...e, rating: e.rating ?? old?.rating ?? null, liked: e.liked || !!old?.liked });
    }
    return [...all.values()].filter(f => (f.rating || 0) >= MIN_RATING);
  }

  async function slugFor(film) {
    if (film.slug) return film.slug;
    if (!film.uri) return null;
    if (!(film.uri in cache.slugs)) { cache.slugs[film.uri] = slugOf(await resolve(film.uri).catch(() => null)); save(); }
    return cache.slugs[film.uri];
  }

  /** Weighted toward the films loved most: 3★ counts 2, 5★ counts 6, a like adds one. */
  function sample(films, count) {
    const left = films.map(f => ({ f, w: f.rating - 4 + (f.liked ? 1 : 0) }));
    const out = [];
    while (out.length < count && left.length) {
      let r = random() * left.reduce((s, x) => s + x.w, 0);
      const i = Math.max(0, left.findIndex(x => (r -= x.w) < 0));
      out.push(left.splice(i, 1)[0].f);
    }
    return out;
  }

  if (user) fresh().catch(() => {}); // warm the feed at startup

  return {
    /** A weighted sample of the films rated 3★ and up, each with its still. Films without one are skipped. */
    async read(params) {
      if (!user) throw Object.assign(Error("Letterboxd is not configured"), { status: 404 });
      const count = Math.min(40, Math.max(1, Number(params.get("count")) || 16));
      await fresh().catch(() => {});
      const films = pool();
      const out = [];
      // One at a time: a cold cache means a Letterboxd page per film.
      for (const f of sample(films, films.length)) {
        if (out.length >= count) break;
        const slug = await slugFor(f).catch(() => null);
        const d = slug && await details({ slug }).catch(() => null);
        if (!d?.backdrop) continue;
        out.push({
          slug, title: f.title, year: f.year, director: d.director, tmdbId: d.tmdbId ?? f.tmdbId ?? null,
          backdrop: d.backdrop, watched: f.watched || null, rating: f.rating, liked: !!f.liked, rewatch: !!f.rewatch,
        });
      }
      return { user, total: films.length, updated: cache.at ? new Date(cache.at).toISOString() : null, films: out };
    },
  };
}
