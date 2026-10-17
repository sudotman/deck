import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createMonitor } from "./lib/monitor.mjs";
import { createJobs } from "./lib/jobs.mjs";
import { createAlerts } from "./lib/alerts.mjs";
import { operations } from "./lib/operations.mjs";
import { redact } from "./lib/storage.mjs";
import { nativeControls } from "./lib/native.mjs";
import { createLights } from "./lib/lights.mjs";
import { fileURLToPath } from "node:url";
const dir = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(
  fs.readFileSync(path.join(dir, "config.json"), "utf8").replace(/^\uFEFF/, ""),
);
const port = Number(process.env.PORT || config.port || 8181);
const services = config.services;
const names = {
  radarr: "Radarr",
  sonarr: "Sonarr",
  prowlarr: "Prowlarr",
  bazarr: "Bazarr",
  qbittorrent: "qBittorrent",
  seerr: "Seerr",
  jellyfin: "Jellyfin",
};
const upstream = (n) =>
  `http://${config.host || "127.0.0.1"}:${services[n].port}`;
let qbCookie = "",
  qbPromise;
const cache = new Map();
const lastReads = new Map();
const secrets = Object.values(services).flatMap(s => [s.key, s.password]).filter(Boolean);
async function qbLogin() {
  if (qbPromise) return qbPromise;
  return (qbPromise = (async () => {
    const s = services.qbittorrent;
    const r = await fetch(upstream("qbittorrent") + "/api/v2/auth/login", {
      method: "POST",
      headers: { Referer: upstream("qbittorrent") },
      body: new URLSearchParams({
        username: s.username || "",
        password: s.password || "",
      }),
      signal: AbortSignal.timeout(6000),
    });
    if ((await r.text()) !== "Ok.") throw Error("qBittorrent login failed");
    qbCookie = r.headers.get("set-cookie")?.split(";")[0] || "";
  })().finally(() => (qbPromise = null)));
}
async function api(n, p, method = "GET", body, raw = false, timeout = 20000) {
  if (!services[n]) throw Error("Unknown service");
  const form = body instanceof FormData;
  const encoded = body instanceof URLSearchParams;
  const headers = form
    ? {}
    : {
        "Content-Type": encoded
          ? "application/x-www-form-urlencoded"
          : "application/json",
      };
  if (services[n].key) headers["X-Api-Key"] = services[n].key;
  if (n === "jellyfin" && services[n].key)
    headers["X-Emby-Token"] = services[n].key;
  if (n === "qbittorrent") {
    if (!qbCookie) await qbLogin();
    headers.Cookie = qbCookie;
    headers.Referer = upstream(n);
    if (body instanceof URLSearchParams)
      headers["Content-Type"] = "application/x-www-form-urlencoded";
  }
  let r = await fetch(upstream(n) + p, {
    method,
    headers,
    body:
      body === undefined
        ? undefined
        : form || encoded
          ? body
          : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  if (n === "qbittorrent" && r.status === 403) {
    await qbLogin();
    headers.Cookie = qbCookie;
    r = await fetch(upstream(n) + p, {
      method,
      headers,
      body:
        form || encoded
          ? body
          : body === undefined
            ? undefined
            : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
  }
  if (!r.ok) {
    const text = await r.text();
    let detail = text;
    try {
      const parsed = JSON.parse(text);
      detail =
        typeof parsed === "string"
          ? parsed
          : parsed.message ||
            parsed.error ||
            parsed.description ||
            JSON.stringify(parsed);
    } catch {}
    throw Error(`${names[n]} (${r.status}): ${redact(detail, secrets).slice(0, 700)}`);
  }
  if (raw) return r;
  if (r.status === 204) return null;
  const t = await r.text();
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}
async function safe(n, p, fallback) {
  try {
    return await api(n, p);
  } catch {
    return fallback;
  }
}
async function cached(k, fn, ttl = 12000) {
  const c = cache.get(k);
  if (c && Date.now() - c.time < ttl) return c.value;
  const value = await fn();
  cache.set(k, { time: Date.now(), value });
  return value;
}
function prefix(n) {
  return n === "prowlarr" ? "/api/v1" : "/api/v3";
}
function media(n, m) {
  const stats = m.statistics || {};
  return {
    id: m.id,
    service: n,
    title: m.title,
    year: m.year,
    overview: m.overview || "",
    monitored: !!m.monitored,
    available: n === "radarr" ? !!m.hasFile : (stats.episodeFileCount || 0) > 0,
    missing:
      n === "radarr"
        ? !m.hasFile
        : Math.max(
            0,
            (stats.episodeCount || 0) - (stats.episodeFileCount || 0),
          ),
    size:
      n === "radarr"
        ? m.sizeOnDisk || m.movieFile?.size || 0
        : stats.sizeOnDisk || 0,
    quality:
      n === "radarr"
        ? m.movieFile?.quality?.quality?.name || ""
        : `${stats.episodeFileCount || 0} / ${stats.episodeCount || 0} episodes`,
    sortTitle: m.sortTitle || m.title,
    added: m.added,
    path: m.path,
    slug: m.titleSlug,
    poster: (m.images || []).find((x) => x.coverType === "poster")?.url || "",
    status: m.status,
    tmdbId: m.tmdbId,
    tvdbId: m.tvdbId,
    releaseChoice: native.releaseChoices.get(n, m.id),
  };
}
async function library() {
  return cached(
    "library",
    async () => {
      const result = await Promise.allSettled([
        api("radarr", "/api/v3/movie"),
        api("sonarr", "/api/v3/series"),
      ]);
      return {
        items: result.flatMap((r, i) =>
          r.status === "fulfilled"
            ? r.value.map((m) => media(i ? "sonarr" : "radarr", m))
            : [],
        ),
        errors: result.flatMap((r, i) =>
          r.status === "rejected"
            ? [{ service: i ? "sonarr" : "radarr", message: r.reason.message }]
            : [],
        ),
      };
    },
    25000,
  );
}
async function acceptedSubtitleMovies(items) {
  const choices = await Promise.all(items.map(async item => {
    if (!native.releaseChoices.get("radarr", item.radarrId)) return null;
    try { return await native.releaseChoices.verify("radarr", item.radarrId); } catch { return null; }
  }));
  return items.filter((item, index) => !(choices[index]?.imported && choices[index].includedSubtitles));
}
async function overview() {
  const dataErrors = [];
  async function read(n, p, fallback) {
    const key = n + p;
    const section = p.split("?")[0].split("/").pop();
    try { const value = await api(n, p); lastReads.set(key, { value, at: new Date().toISOString() }); return value; }
    catch (error) { const previous = lastReads.get(key); dataErrors.push({ service: n, section, message: error.message, staleAt: previous?.at }); return previous?.value ?? fallback; }
  }
  const statuses = await Promise.all(
    Object.keys(services).map(async (n) => {
      const start = Date.now();
      try {
        const p =
          n === "bazarr"
            ? "/api/system/status"
            : n === "qbittorrent"
              ? "/api/v2/app/version"
              : n === "jellyfin"
                ? "/System/Info"
                : n === "seerr"
                  ? "/api/v1/status"
                  : prefix(n) + "/system/status";
        const s = await api(n, p);
        return {
          id: n,
          name: names[n],
          online: true,
          latency: Date.now() - start,
          version:
            typeof s === "string"
              ? s
              : s.version ||
                s.Version ||
                s.data?.version ||
                s.data?.bazarr_version ||
                "",
        };
      } catch (e) {
        return { id: n, name: names[n], online: false, error: e.message };
      }
    }),
  );
  const [
    lib,
    disks,
    rh,
    sh,
    ph,
    torrents,
    transfer,
    rq,
    sq,
    indexers,
    subs,
    requests,
    providers,
  ] = await Promise.all([
    library(),
    read("radarr", "/api/v3/diskspace", []),
    read("radarr", "/api/v3/health", []),
    read("sonarr", "/api/v3/health", []),
    read("prowlarr", "/api/v1/health", []),
    read("qbittorrent", "/api/v2/torrents/info", []),
    read("qbittorrent", "/api/v2/transfer/info", {}),
    read("radarr", "/api/v3/queue?pageSize=100", {}),
    read("sonarr", "/api/v3/queue?pageSize=100", {}),
    read("prowlarr", "/api/v1/indexer", []),
    read("bazarr", "/api/movies/wanted?length=100", {}),
    services.seerr.key
      ? read("seerr", "/api/v1/request?take=20&filter=pending", null)
      : null,
    read("bazarr", "/api/providers", { data: [] }),
  ]);
  const wanted = await acceptedSubtitleMovies(subs.data || []);
  const acceptedCount = (subs.data || []).length - wanted.length;
  const health = [
    ...rh.map((x) => ({ ...x, service: "radarr" })),
    ...sh.map((x) => ({ ...x, service: "sonarr" })),
    ...ph.map((x) => ({ ...x, service: "prowlarr" })),
  ];
  const pending = await Promise.all(
    (requests?.results || []).map(async (r) => {
      const m = await read(
        "seerr",
        `/api/v1/${r.type === "tv" ? "tv" : "movie"}/${r.media.tmdbId}`,
        {},
      );
      return {
        id: r.id,
        type: r.type,
        title: m.title || m.name || `Request ${r.id}`,
        year: (m.releaseDate || m.firstAirDate || "").slice(0, 4),
        requestedBy:
          r.requestedBy?.displayName || r.requestedBy?.username || "",
        createdAt: r.createdAt,
        status: r.status,
      };
    }),
  );
  return {
    updated: new Date().toISOString(),
    services: statuses,
    dataErrors,
    providers: providers.data || [],
    library: lib.items,
    libraryErrors: lib.errors,
    disks,
    health,
    torrents,
    transfer,
    queue: [
      ...(rq.records || []).map((x) => ({ ...x, service: "radarr" })),
      ...(sq.records || []).map((x) => ({ ...x, service: "sonarr" })),
    ],
    indexers: indexers.map((x) => ({
      id: x.id,
      name: x.name,
      enable: x.enable,
      priority: x.priority,
      protocol: x.protocol,
    })),
    subtitles: { movies: subs.total !== undefined ? Math.max(0, subs.total - acceptedCount) : subs.data ? wanted.length : null },
    requests: pending,
    requestsConnected: !!services.seerr.key,
    requestError:
      services.seerr.key && requests === null
        ? "Could not fetch requests from Seerr"
        : null,
  };
}
async function readBody(req) {
  req.setEncoding("utf8");
  let s = "";
  for await (const b of req) {
    s += b;
    if (Buffer.byteLength(s) > 4000000) throw Error("Request too large");
  }
  return s ? JSON.parse(s) : {};
}
function json(res, v, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(v, (key, value) => key.startsWith("_") ? undefined : value));
}
function sameOrigin(req) {
  const h = req.headers.origin;
  if (h && h !== `http://${req.headers.host}`) return false;
  return !["cross-site"].includes(req.headers["sec-fetch-site"]);
}
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};
function staticFile(res, file) {
  const p = path.join(dir, "public", file);
  try {
    res.writeHead(200, {
      "Content-Type": types[path.extname(p)] || "application/octet-stream",
      "Cache-Control": p.endsWith(".woff2") ? "public, max-age=2592000" : "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-src 'none'; connect-src 'self'; base-uri 'self'; frame-ancestors 'self'",
    });
    fs.createReadStream(p).pipe(res);
  } catch {
    res.writeHead(404);
    res.end();
  }
}
const jobs = createJobs(dir);
const alerts = createAlerts(dir);
const monitor = createMonitor(dir, async () => { const snapshot = await cached("overview", overview); alerts.update(snapshot, jobs.list()); return snapshot; });
const native = nativeControls({
  api,
  safe,
  cache,
  jobs,
  services,
  media,
  directory: dir,
});
const extra = operations({ api, native, jobs, cache, directory: dir, config, library, overview, alerts });
const lights = createLights(config);
await jobs.recover(extra.reconcile, extra.execute);
// Browsers may only reach Deck by a name it expects, which blocks DNS-rebinding attacks.
// Its own addresses are allowed automatically; add DNS names in config.allowedHosts.
const permittedHosts = new Set(
  [
    "localhost",
    config.host,
    config.bind,
    ...Object.values(os.networkInterfaces()).flat().map((i) => i.address),
    ...(config.allowedHosts || []),
  ]
    .filter((h) => h && h !== "0.0.0.0")
    .map((h) => String(h).toLowerCase()),
);
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);
    const p = u.pathname;
    if (!permittedHosts.has(u.hostname.toLowerCase()))
      return json(res, { error: "Hostname is not allowed" }, 403);
    if (req.method !== "GET" && req.method !== "HEAD" && !sameOrigin(req))
      return json(res, { error: "Cross-site action rejected" }, 403);
    if (p === "/" || p === "/hub" || p === "/hub/")
      return staticFile(res, "index.html");
    if (p === "/hub/vendor/hls.min.js") return staticFile(res, "vendor/hls.min.js");
    if (["/hub/app.js", "/hub/style.css", "/hub/icon.svg", "/hub/enhancements.js", "/hub/lights.js"].includes(p))
      return staticFile(res, p.split("/").pop());
    if (/^\/hub\/fonts\/[a-z-]+\.woff2$/.test(p)) return staticFile(res, "fonts/" + p.split("/").pop());
    if (p === "/hub/api/watch-image") {
      // Jellyfin artwork through Deck, so the browser never needs Jellyfin's address or key.
      const id = u.searchParams.get("id") || "", kind = u.searchParams.get("kind");
      if (!/^[a-f0-9]{32}$/i.test(id) || !["Primary", "Backdrop", "Thumb"].includes(kind)) return json(res, { error: "Choose a valid image" }, 400);
      const width = Math.min(1600, Math.max(120, Number(u.searchParams.get("w")) || 640));
      const r = await api("jellyfin", `/Items/${id}/Images/${kind}?maxWidth=${width}&quality=82`, "GET", undefined, true);
      res.writeHead(200, { "Content-Type": r.headers.get("content-type") || "image/jpeg", "Cache-Control": "private,max-age=86400" });
      return res.end(Buffer.from(await r.arrayBuffer()));
    }
    if (p === "/hub/api/lights" && req.method === "GET") return json(res, await lights.state());
    if (p === "/hub/api/lights-scenes") return json(res, { scenes: lights.scenes() });
    if (p === "/hub/api/lights" && req.method === "POST") {
      try {
        return json(res, await lights.set(await readBody(req)));
      } catch (error) {
        return json(res, { error: error.message }, error.status || 400);
      }
    }
    if (p === "/hub/api/overview")
      return json(res, await cached("overview", overview));
    if (p === "/hub/api/library") return json(res, await library());
    if (p === "/hub/api/calendar") {
      const start = new Date();
      const end = new Date(Date.now() + 14 * 86400000);
      const q = `?start=${start.toISOString()}&end=${end.toISOString()}`;
      const calendarReads = await Promise.allSettled([
        api("radarr", "/api/v3/calendar" + q),
        api("sonarr", "/api/v3/calendar" + q + "&includeSeries=true"),
      ]);
      const [m, e] = calendarReads.map(r => r.status === "fulfilled" ? r.value : []);
      const errors = calendarReads.flatMap((r, i) => r.status === "rejected" ? [{ service: i ? "sonarr" : "radarr", message: r.reason.message }] : []);
      return json(
        res,
        { errors, items: [
          ...m.map((x) => ({
            title: x.title,
            date: x.digitalRelease || x.inCinemas,
            service: "radarr",
            detail: "Movie release",
            id: x.id,
          })),
          ...e.map((x) => ({
            title: x.series?.title || "Series",
            date: x.airDateUtc,
            service: "sonarr",
            detail: `S${x.seasonNumber} · E${x.episodeNumber} — ${x.title}`,
            id: x.seriesId,
          })),
        ]
          .filter((x) => x.date)
          .sort((a, b) => a.date.localeCompare(b.date)) },
      );
    }
    if (p === "/hub/api/subtitles") {
      const [m, s] = await Promise.all([
        api("bazarr", "/api/movies/wanted?length=500"),
        api("bazarr", "/api/episodes/wanted?length=500"),
      ]);
      const movies = await acceptedSubtitleMovies(m.data || []);
      return json(res, {
        movies,
        episodes: s.data || [],
        total: Math.max(0, (m.total ?? (m.data || []).length) - ((m.data || []).length - movies.length)) + (s.total || 0),
      });
    }
    if (p === "/hub/api/history") {
      const reads = await Promise.allSettled(["radarr", "sonarr"].map(n => api(n, "/api/v3/history?pageSize=20&sortKey=date&sortDirection=descending")));
      return json(res, {
        errors: reads.flatMap((r, i) => r.status === "rejected" ? [{ service: i ? "sonarr" : "radarr", message: r.reason.message }] : []),
        items: reads.flatMap((r, i) => r.status === "fulfilled" ? (r.value.records || []).map(x => ({ ...x, service: i ? "sonarr" : "radarr" })) : []).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 30),
      });
    }
    if (p === "/hub/api/lookup") {
      const n = u.searchParams.get("service");
      if (!["radarr", "sonarr"].includes(n))
        return json(res, { error: "Choose movies or series" }, 400);
      return json(
        res,
        await api(
          n,
          prefix(n) +
            (n === "radarr" ? "/movie/lookup" : "/series/lookup") +
            "?term=" +
            encodeURIComponent(u.searchParams.get("q") || ""),
        ),
      );
    }
    if (p === "/hub/api/options") {
      const n = u.searchParams.get("service");
      if (!["radarr", "sonarr"].includes(n))
        return json(res, { error: "Unknown library" }, 400);
      const [profiles, roots] = await Promise.all([
        api(n, prefix(n) + "/qualityprofile"),
        api(n, prefix(n) + "/rootfolder"),
      ]);
      return json(res, {
        profiles: profiles.map((x) => ({ id: x.id, name: x.name })),
        roots: roots.map((x) => ({ path: x.path, freeSpace: x.freeSpace })),
      });
    }
    if (p === "/hub/api/poster") {
      const n = u.searchParams.get("service");
      if (!["radarr", "sonarr"].includes(n)) return res.end();
      const id = Number(u.searchParams.get("id"));
      const m = await api(
        n,
        prefix(n) + (n === "radarr" ? "/movie/" : "/series/") + id,
      );
      const coverType = u.searchParams.get("kind") === "fanart" ? "fanart" : "poster";
      let poster = m.images?.find((x) => x.coverType === coverType)?.url;
      if (!poster || !poster.startsWith("/MediaCover/")) {
        res.writeHead(404);
        return res.end();
      }
      const r = await api(n, poster, "GET", undefined, true);
      res.writeHead(200, {
        "Content-Type": r.headers.get("content-type") || "image/jpeg",
        "Cache-Control": "private,max-age=86400",
      });
      return res.end(Buffer.from(await r.arrayBuffer()));
    }
    if (p === "/hub/api/action" && req.method === "POST")
      return json(res, { job: extra.start(await readBody(req)) }, 202);
    if (p === "/hub/api/watch-progress" && req.method === "POST")
      return json(res, await extra.playback(await readBody(req)));
    if (p === "/hub/api/watch-stream" && ["GET", "HEAD"].includes(req.method))
      return extra.stream(req, res, u.searchParams);
    if (p === "/hub/api/monitor") return json(res, monitor.get());
    if (p === "/hub/api/jobs") return json(res, jobs.list());
    if (p.startsWith("/hub/api/jobs/")) {
      const job = jobs.get(p.split("/").pop());
      return json(res, job || { error: "Task not found" }, job ? 200 : 404);
    }
    if (p.startsWith("/hub/api/") && req.method === "GET") {
      const extension = await extra.read(p.slice("/hub/api/".length), u.searchParams);
      if (extension !== undefined) return json(res, extension);
      const result = await native.read(
        p.slice("/hub/api/".length),
        u.searchParams,
      );
      if (result !== undefined) return json(res, result);
    }
    res.writeHead(404);
    res.end("Not found");
  } catch (e) {
    json(res, { error: e.message }, 502);
  }
});
// At boot Wi-Fi can come up after Deck starts. Wait for the address instead of crashing.
const bindAddress = process.env.BIND || config.bind || "0.0.0.0";
let waitingForAddress = false;
server.on("error", (error) => {
  if (!["EADDRNOTAVAIL", "EADDRINUSE"].includes(error.code)) throw error;
  if (!waitingForAddress)
    console.log(`Waiting for ${bindAddress}:${port} (${error.code}); retrying every 5 seconds`);
  waitingForAddress = true;
  setTimeout(() => server.listen(port, bindAddress), 5000);
});
server.on("listening", () =>
  console.log(`Deck listening on port ${server.address().port}`),
);
server.listen(port, bindAddress);
