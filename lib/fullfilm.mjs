// Whether a film is on YouTube in full: plenty of older and independent films are, uploaded by their
// makers or by fans. Search results are full of lookalikes, so a video only counts when its title names
// the film (by any of its titles, allowing for transliteration), says it's the film itself ("full movie",
// the year, or the director), runs about as long as the film, isn't commentary about it (reviews,
// podcasts, interviews, trailers) and YouTube says it plays here. No API key: search results and watch
// pages carry their data as JSON.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const LONG = "EgIYAg%253D%253D"; // search filter: over 20 minutes
const TTL = 12 * 3600e3, MISS_TTL = 6 * 3600e3, BACKOFF = 3600e3;
// Free full uploads of new releases are nearly always fakes; within this many years only a verified
// channel (the studio or a distributor) counts.
const RECENT_YEARS = 4;
const ABOUT = /\b(podcast|episode|ep\s?\d+|review|reviews|reaction|reacts?|explained|explaining|analysis|essay|interview|trailer|teaser|recap|ending|breakdown|discussion|commentary|scenes?|clips?|songs?|making of|behind the scenes|premiere|documentary on|tribute|memories|special story|ft\.?|w\/)(?=\W|$)/i;
const ITSELF = /\b(full movie|full film|full length|complete (movie|film)|entire (movie|film))\b/i;
const LURE = /(link in (the )?description|watch (it )?(here|now|free)|full movie link|download|bit\.ly|tinyurl)/i;

/** Lowercase letters and digits in any script, words separated by single spaces. */
export const words = s => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ").trim();

// Consonants only, so transliterations meet: "Maa Bhoomi", "Ma Bhoomi" and "Maa Bhumi" all give "mbhm".
const skeleton = s => words(s).replace(/[aeiouy\s]/g, "");

// Words uploaders put around a film's name: "MAA BHOOMI 1979 Full Movie HD Telugu #trending".
const FILLER = new Set(("full movie movies film films hd hq 4k 1080p 720p complete entire length with english subtitles subtitle " +
  "subs sub eng dubbed version official uncut restored remastered classic new old colour color telugu tamil hindi " +
  "malayalam kannada bengali bangla marathi punjabi gujarati urdu japanese korean french italian german spanish russian " +
  "chinese mandarin cantonese persian turkish").split(" "));

/**
 * Whether a video title names the film by one of its titles. The name has to be a whole part of the
 * title (between separators such as "|", "-" or brackets, once filler like "full movie" or the year is
 * set aside), so "Gangland in Motherland" doesn't pass for a film called "Motherland".
 */
export function namesFilm(videoTitle, names) {
  const parts = String(videoTitle || "").replace(/#\s*\S+/g, " ").split(/\s*(?:[|()[\]{}\/–—:•"“”]|\s-\s|,)\s*/)
    .map(p => words(p).split(" ").filter(w => w && !FILLER.has(w) && !/^(19|20)\d\d$/.test(w)).join(" "))
    .filter(Boolean);
  return names.some(n => {
    const w = words(n), b = skeleton(n);
    if (!w) return false;
    const kept = words(n).split(" ").filter(x => !FILLER.has(x)).join(" ") || w;
    return parts.some(p => p === w || p === kept || (/^[a-z]+$/.test(b) && b.length >= 4 && skeleton(p) === b));
  });
}

/** "2:19:30" → 139.5 minutes. */
export const minutes = text => String(text || "").split(":").map(Number).reduce((m, n) => m * 60 + n, 0) / 60;

/** The search result's videos, as far as this needs them. */
export function parseResults(html) {
  const raw = html.match(/var ytInitialData = (\{.*?\});<\/script>/s)?.[1];
  if (!raw) return [];
  const found = [];
  (function walk(o) {
    if (!o || typeof o !== "object") return;
    if (o.videoRenderer) return void found.push(o.videoRenderer);
    for (const v of Object.values(o)) walk(v);
  })(JSON.parse(raw));
  const text = x => x?.simpleText ?? x?.runs?.map(r => r.text).join("") ?? "";
  return found.map(v => ({
    id: v.videoId,
    title: text(v.title),
    channel: text(v.ownerText),
    minutes: minutes(text(v.lengthText)),
    views: Number(text(v.viewCountText).replace(/\D/g, "")) || 0,
    verified: (v.ownerBadges || []).some(b => /VERIFIED/.test(b.metadataBadgeRenderer?.style || "")),
    snippet: (v.detailedMetadataSnippets || []).map(s => text(s.snippetText)).join(" "),
    live: Boolean(v.badges?.some(b => /LIVE/.test(b.metadataBadgeRenderer?.style || ""))),
  })).filter(v => v.id);
}

/** The videos that are the film itself, most likely first: named by its own title before an alternative. */
export function candidates(videos, film, year = new Date().getFullYear()) {
  const own = [film.title, film.originalTitle].filter(Boolean);
  const names = [...own, ...(film.alternativeTitles || [])].filter(Boolean);
  const surname = String(film.director || "").split(",")[0].trim().split(/\s+/).pop();
  const runtime = film.runtime;
  return videos.filter(v => {
    if (v.live || !namesFilm(v.title, names)) return false;
    if (film.year && year - film.year < RECENT_YEARS && !v.verified) return false;
    // The film's own title can't count against it ("The Interview", "Scenes from a Marriage").
    const rest = names.reduce((t, n) => words(n) ? t.replace(` ${words(n)} `, " ") : t, ` ${words(v.title)} `);
    if (ABOUT.test(rest) || ABOUT.test(v.channel) || LURE.test(v.snippet)) return false;
    const itself = ITSELF.test(v.title) || (film.year && v.title.includes(String(film.year)))
      || (surname?.length > 2 && words(v.title).split(" ").includes(words(surname)));
    if (!itself) return false;
    return runtime ? v.minutes >= runtime * 0.8 && v.minutes <= runtime * 1.15 + 5 : v.minutes >= 60;
  }).map(v => ({ ...v, own: namesFilm(v.title, own) })).sort((a, b) => b.own - a.own || score(b) - score(a));
}

// Genuine uploads gather views; a verified channel is a distributor or the makers.
const score = v => Math.log10(v.views + 1) + (v.verified ? 2 : 0);

/**
 * Whether a watch page says the video plays here. Age-restricted films count: the TV is signed in. A
 * description that sends viewers elsewhere ("full movie link", downloads) marks a lure, not the film.
 */
export function parsePlayable(html) {
  const raw = html.match(/var ytInitialPlayerResponse = (\{.*?\});(?:var |<\/script>)/s)?.[1];
  if (!raw) return { ok: false };
  const p = JSON.parse(raw);
  const status = p.playabilityStatus?.status, reason = p.playabilityStatus?.reason || "";
  const plays = status === "OK" || (status === "LOGIN_REQUIRED" && /\bage\b/i.test(reason));
  return {
    ok: plays && !p.videoDetails?.isLiveContent && !LURE.test(p.videoDetails?.shortDescription || ""),
    minutes: Number(p.videoDetails?.lengthSeconds || 0) / 60,
  };
}

export function createFullFilm({ region = "IN", fetchText = defaultFetch, fetchStatus = defaultStatus, now = Date.now } = {}) {
  const cache = new Map();
  let quietUntil = 0;
  const searchUrl = q => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=${LONG}&hl=en&gl=${region}`;

  async function find(film) {
    // The film's own title first, then other titles that might be what uploaders use.
    const others = [film.originalTitle, ...(film.alternativeTitles || [])]
      .filter(n => n && /^[\p{Script=Latin}\d\s\p{P}]+$/u.test(n) && words(n) !== words(film.title));
    const queries = [`${film.title} ${film.year || ""} full movie`, ...[...new Set(others.map(words))].slice(0, 2).map(n => `${n} full movie`)];
    const seen = new Map();
    // A refusal anywhere means no answer (not "not on YouTube"), so it isn't cached.
    for (const q of queries) {
      for (const v of parseResults(await fetchText(searchUrl(q)))) if (!seen.has(v.id)) seen.set(v.id, v);
    }
    for (const v of candidates([...seen.values()], film, new Date(now()).getFullYear()).slice(0, 3)) {
      if (await plays(v.id)) return { found: true, id: v.id, title: v.title, channel: v.channel, minutes: Math.round(v.minutes), views: v.views };
    }
    return { found: false };
  }

  // The watch page says the most; YouTube is quicker to turn scrapers away from it than from search,
  // so when it does, oEmbed (which answers only for public, playable videos) settles it instead.
  async function plays(id) {
    const page = await fetchText(`https://www.youtube.com/watch?v=${id}&hl=en&gl=${region}`).catch(() => null);
    if (page != null) return parsePlayable(page).ok;
    const status = await fetchStatus(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`);
    if (status === 200) return true;
    if ([400, 401, 403, 404].includes(status)) return false;
    throw Error(`YouTube answered ${status}`);
  }

  return {
    /** Tonight's film on YouTube, or `{ found: false }`; cached, since it changes rarely. */
    async check(film) {
      if (!film?.title) return null;
      const key = film.slug || `${film.title}:${film.year}`, hit = cache.get(key);
      if (hit && now() - hit.at < (hit.result.found ? TTL : MISS_TTL)) return hit.result;
      // YouTube turns away scrapers that ask too often; leave it be for a while when it does.
      if (now() < quietUntil) return null;
      const result = await find(film).catch(error => { quietUntil = now() + BACKOFF; throw error; });
      cache.set(key, { at: now(), result });
      return result;
    },
  };
}

async function defaultStatus(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA }, redirect: "manual", signal: AbortSignal.timeout(12000) });
  return r.status;
}

async function defaultFetch(url) {
  // Redirects aren't followed: the one YouTube sends is to its "unusual traffic" page.
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en" }, redirect: "manual", signal: AbortSignal.timeout(12000) });
  if (r.status !== 200) throw Error(`YouTube answered ${r.status}`);
  return r.text();
}
