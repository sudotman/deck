// Whether Stremio will have a good copy of a film, checked ahead of time. Stremio's sources come from
// its addons; Torrentio is the one most installs use, and its stream list says each source's resolution
// (in the name) and seeders and size (in the title), e.g. "Torrentio\n1080p" / "… 👤 133 💾 2.24 GB ⚙️ YTS".
const RANK = { "2160p": 4, "4k": 4, "1080p": 3, "720p": 2, "576p": 1, "480p": 1 };
const TTL = 3 * 3600e3, MISS_TTL = 20 * 60e3;

/** Each stream's resolution, seeders and size, as far as its labels say. */
export function parseStreams(streams = []) {
  return streams.map(s => {
    const name = String(s.name || ""), title = String(s.title || s.description || "");
    const quality = name.split("\n").slice(1).join(" ").match(/\b(2160p|4k|1080p|720p|576p|480p)\b/i)?.[1]?.toLowerCase() || null;
    const seeders = Number(title.match(/👤\s*(\d+)/)?.[1] ?? NaN);
    const size = title.match(/💾\s*([\d.]+\s*[KMGT]B)/i)?.[1] || null;
    return { quality, rank: RANK[quality] || 0, seeders: Number.isFinite(seeders) ? seeders : 0, size };
  });
}

/**
 * The copy to watch: 4K only when it's well seeded (a thinly seeded 40 GB remux streams badly), otherwise
 * the best-seeded 1080p-or-better copy, otherwise whatever has the most seeders.
 * Good means 1080p or better with at least `minSeeders`.
 */
export function verdict(sources, { minSeeders = 15, strong4k = 50 } = {}) {
  const healthy = sources.filter(s => s.seeders >= minSeeders);
  const mostSeeded = list => [...list].sort((a, b) => b.seeders - a.seeders)[0];
  const best = mostSeeded(healthy.filter(s => s.rank >= 4 && s.seeders >= strong4k))
    || mostSeeded(healthy.filter(s => s.rank >= 3))
    || [...healthy].sort((a, b) => b.rank - a.rank || b.seeders - a.seeders)[0]
    || mostSeeded(sources);
  if (!best) return { good: false, count: 0 };
  return { good: healthy.length > 0 && best.rank >= 3, quality: best.quality, seeders: best.seeders, size: best.size, count: sources.length };
}

export function createStremio({ addon = "https://torrentio.strem.fun", minSeeders, fetchJson = defaultFetch, now = Date.now } = {}) {
  const base = addon.replace(/\/manifest\.json$/, "").replace(/\/$/, "");
  const cache = new Map();
  return {
    async check(imdbId) {
      if (!/^tt\d+$/.test(imdbId || "")) return null;
      const hit = cache.get(imdbId);
      if (hit && now() - hit.at < (hit.result.count ? TTL : MISS_TTL)) return hit.result;
      const data = await fetchJson(`${base}/stream/movie/${imdbId}.json`);
      const result = verdict(parseStreams(data.streams), { minSeeders });
      cache.set(imdbId, { at: now(), result });
      return result;
    },
  };
}

async function defaultFetch(url) {
  const r = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw Error(`Stremio's addon answered ${r.status}`);
  return r.json();
}
