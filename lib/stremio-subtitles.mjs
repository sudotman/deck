// A Stremio subtitles addon in front of OpenSubtitles (Stremio's own "OpenSubtitles v3" addon). That addon
// knows each subtitle's file name and release group, but Stremio drops them, so the TV lists subtitles
// by bare id ("30949") in no useful order and auto-picks whichever comes first. This one ranks them
// against the file being played (Stremio passes its OpenSubtitles hash and file name) and names them:
// "Same release · AMIABLE BluRay 1080p".
const UPSTREAM = "https://opensubtitles-v3.strem.io";
const PER_LANGUAGE = 8, TTL = 6 * 3600e3, KEEP = 300;

export const MANIFEST = {
  id: "in.sudotman.deck.subtitles",
  version: "1.0.0",
  name: "Deck subtitles",
  description: "OpenSubtitles, ranked against the file you're playing and named by release.",
  resources: ["subtitles"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  catalogs: [],
};

const SOURCES = [
  [/^(blu-?ray|bdrip|brrip|bdremux|bd|remux|bd25|bd50)$/, "BluRay"],
  [/^web-?dl$/, "WEB-DL"],
  [/^web-?rip$/, "WEBRip"],
  [/^web$/, "WEB-DL"],
  [/^(hdtv|pdtv)$/, "HDTV"],
  [/^(dvd-?rip|dvd|dvd5|dvd9|dvdscr)$/, "DVD"],
  [/^hd-?rip$/, "HDRip"],
  [/^(cam|hdcam|ts|telesync|hdts)$/, "CAM"],
];
// WEB-DL and WEBRip of one episode or film come from the same stream, so their timings agree.
const FAMILY = { "WEB-DL": "web", WEBRip: "web" };
const EDITIONS = ["extended", "unrated", "directors", "theatrical", "remastered", "imax", "criterion", "uncut"];
const NOISE = new Set(["x264", "x265", "h264", "h265", "hevc", "avc", "aac", "ac3", "dts", "ddp5", "dd5", "atmos", "10bit", "hdr", "srt", "sub", "eng", "english", "mkv", "mp4", "avi"]);

/** What a video or subtitle file name says about its release. */
export function releaseOf(name = "") {
  const base = String(name).replace(/\.(srt|sub|ass|ssa|vtt|mkv|mp4|avi|m4v|ts|webm)$/i, "");
  const tokens = base.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  // "Film.2019.1080p.WEB-DL.DDP5.1.H264-NTb": the group is the last thing after a dash.
  const group = base.match(/-([A-Za-z0-9]{2,15})(?:\[[^\]]*\])?$/)?.[1] || null;
  let source = null;
  for (const [i, t] of tokens.entries()) {
    const joined = t === "web" && ["dl", "rip"].includes(tokens[i + 1]) ? t + tokens[i + 1] : t;
    const hit = SOURCES.find(([re]) => re.test(joined));
    if (hit) { source = hit[1]; break; }
  }
  return {
    group: group && !NOISE.has(group.toLowerCase()) ? group : null,
    source,
    resolution: tokens.find(t => /^(2160|1080|720|576|480)p$/.test(t)) || (tokens.includes("4k") ? "2160p" : null),
    editions: EDITIONS.filter(e => tokens.includes(e)),
    // "CD1", "cd 2", "Part1": half a film, which drifts out of sync halfway through.
    part: /(^|[^a-z])(cd|disc|part)\s*[1-9]($|[^0-9])/i.test(base),
    words: new Set(tokens.filter(t => t.length > 1 && !NOISE.has(t))),
  };
}

const sameFamily = (a, b) => a && b && (a === b || (FAMILY[a] && FAMILY[a] === FAMILY[b]));

/** How well a subtitle fits the video: higher is better. Hash matches come from OpenSubtitles itself. */
export function score(sub, video) {
  const s = releaseOf(sub.subtitleFileName), group = sub.releaseGroup || s.group;
  let points = sub.m === "h" ? 100 : 0;
  if (video) {
    if (group && video.group && group.toLowerCase() === video.group.toLowerCase()) points += 40;
    if (sameFamily(s.source, video.source)) points += 15;
    else if (s.source && video.source) points -= 10;
    if (s.resolution && s.resolution === video.resolution) points += 3;
    const editions = new Set([...s.editions, ...video.editions]);
    for (const e of editions) points += s.editions.includes(e) && video.editions.includes(e) ? 8 : -6;
    let shared = 0;
    for (const w of s.words) if (video.words.has(w)) shared++;
    points += Math.min(10, shared);
  }
  if (s.part) points -= 60;
  return points;
}

/** The name shown in the TV's subtitle menu. */
export function labelFor(sub, video) {
  const s = releaseOf(sub.subtitleFileName), group = sub.releaseGroup || s.group;
  const descriptor = [group, s.source, s.resolution].filter(Boolean).join(" ")
    || shorten(String(sub.subtitleFileName || "").replace(/\.(srt|sub|ass|ssa|vtt)$/i, "").replace(/[._\s]+/g, " ").trim())
    || "Unnamed release";
  const sameGroup = group && video?.group && group.toLowerCase() === video.group.toLowerCase();
  const note = sub.m === "h" ? "Exact match" : sameGroup ? "Same release" : s.part ? "Part of a split" : null;
  return note ? `${note} · ${descriptor}` : descriptor;
}

const shorten = (text, max = 40) => text.length <= max ? text : text.slice(0, max + 1).replace(/\s+\S*$/, "").trimEnd() + "…";

/** Stremio's extra args ("videoHash=…&videoSize=…&filename=…") as an object. */
export function parseExtra(extra = "") {
  return Object.fromEntries(new URLSearchParams(String(extra)));
}

/** Ranks and names OpenSubtitles' answer, best first within each language, a few per language. */
export function rankSubtitles(subtitles = [], { filename } = {}) {
  const video = filename ? releaseOf(filename) : null;
  const seen = new Set(), perLanguage = new Map();
  return subtitles
    .filter(s => s && s.id && s.url && s.lang)
    .map((s, i) => ({ s, i, points: score(s, video) }))
    .sort((a, b) => b.points - a.points || a.i - b.i)
    .filter(({ s }) => {
      // The same file uploaded twice: keep the first (best-ranked).
      const key = `${s.lang}|${String(s.subtitleFileName || s.id).toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      const n = (perLanguage.get(s.lang) || 0) + 1;
      perLanguage.set(s.lang, n);
      return n <= PER_LANGUAGE;
    })
    // A fragment keeps Stremio from treating these as the same tracks as OpenSubtitles v3's own,
    // when both addons are installed. It never reaches the server.
    .map(({ s }) => ({ id: `deck-${s.id}`, url: `${s.url}#deck`, lang: s.lang, label: labelFor(s, video) }));
}

export function createStremioSubtitles({ upstream = UPSTREAM, fetchJson = defaultFetch, now = Date.now } = {}) {
  const cache = new Map();
  return {
    manifest: () => MANIFEST,
    /** `type` is movie or series, `id` "tt0111161" or "tt0903747:1:2", `extra` Stremio's extra args. */
    async subtitles(type, id, extra = "") {
      if (!MANIFEST.types.includes(type) || !/^tt\d+(:\d+:\d+)?$/.test(id)) return { subtitles: [] };
      const args = parseExtra(extra);
      // OpenSubtitles matches by hash when it has one, so the hash and size go upstream too.
      const forward = new URLSearchParams(Object.entries(args).filter(([k]) => ["videoHash", "videoSize", "filename"].includes(k))).toString();
      const url = `${upstream}/subtitles/${type}/${encodeURIComponent(id)}${forward ? "/" + forward : ""}.json`;
      const hit = cache.get(url);
      let found = hit && now() - hit.at < TTL ? hit.subtitles : null;
      if (!found) {
        found = (await fetchJson(url))?.subtitles || [];
        cache.delete(url);
        cache.set(url, { at: now(), subtitles: found });
        if (cache.size > KEEP) cache.delete(cache.keys().next().value);
      }
      return { subtitles: rankSubtitles(found, args), cacheMaxAge: 3600 };
    },
  };
}

async function defaultFetch(url) {
  const r = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw Error(`OpenSubtitles answered ${r.status}`);
  return r.json();
}
