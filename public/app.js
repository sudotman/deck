const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const icons = {
  overview: '<path d="M4 10.4 12 4l8 6.4V19a1.5 1.5 0 0 1-1.5 1.5H15V15h-6v5.5H5.5A1.5 1.5 0 0 1 4 19z"/>',
  activity: '<path d="M3 12h4l2.5-6 5 12 2.5-6h4"/>',
  library: '<rect x="4" y="3.5" width="6.5" height="17" rx="1.6"/><rect x="13.5" y="3.5" width="6.5" height="17" rx="1.6"/>',
  downloads: '<path d="M12 4v11m-4.5-4.5L12 15l4.5-4.5M5 20h14"/>',
  imports: '<path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5V18a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18z"/><path d="M12 10.5v5.5m-2.5-2.5L12 16l2.5-2.5"/>',
  watch: '<circle cx="12" cy="12" r="8.5"/><path d="m10.2 8.6 5.2 3.4-5.2 3.4z"/>',
  play: '<path d="M7 4.5v15l12-7.5z" fill="currentColor"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  subtitles: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M7 12.5h4m3 0h3M7 15.5h10"/>',
  requests: '<path d="M6.5 3.5h11a1 1 0 0 1 1 1v16l-6.5-4-6.5 4v-16a1 1 0 0 1 1-1z"/><path d="M12 7.5v5M9.5 10h5"/>',
  services: '<rect x="4" y="4" width="16" height="6.5" rx="1.8"/><rect x="4" y="13.5" width="16" height="6.5" rx="1.8"/><path d="M7.5 7.25h.01M7.5 16.75h.01"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>',
  film: '<rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M7.5 4v16M16.5 4v16M3.5 9h4m9 0h4M3.5 15h4m9 0h4"/>',
  tv: '<rect x="3" y="5" width="18" height="12.5" rx="2"/><path d="M8.5 20.5h7"/>',
  more: '<circle cx="5.5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18.5" cy="12" r="1.2"/>',
  back: '<path d="M15 5.5 8.5 12l6.5 6.5"/>',
};
const serviceIcons = { seerr: "requests", prowlarr: "search", qbittorrent: "downloads", radarr: "film", sonarr: "tv", bazarr: "subtitles", jellyfin: "watch" };
const icon = (n) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[n] || icons.services}</svg>`;
// Sidebar sections; pages registered in navs but missing here land in the last group.
const navGroups = [
  ["", ["overview"]],
  ["Watch", ["watch", "library", "requests", "calendar"]],
  ["Manage", ["downloads", "imports", "subtitles", "activity"]],
  ["Room", ["lights"]],
  ["System", ["services", "alerts"]],
];
const tabbarRoutes = ["overview", "watch", "library", "lights"];
const navs = [
  ["overview", "Home"],
  ["activity", "Activity"],
  ["library", "Library"],
  ["downloads", "Downloads"],
  ["calendar", "Calendar"],
  ["subtitles", "Subtitles"],
  ["requests", "Requests"],
  ["services", "Services"],
];
const descriptions = {
  seerr: "Review requests, approvals, processing, and availability.",
  prowlarr:
    "Manage indexers, search sources, and their connections to your library.",
  qbittorrent: "Manage downloads, files, trackers, and seeding.",
  radarr: "Manage movies, quality profiles, folders, and imports.",
  sonarr: "Manage series, seasons, episodes, and release profiles.",
  bazarr: "Find and manage subtitles across your library.",
  jellyfin: "Inspect libraries, devices, playback, and scheduled tasks.",
};
const stages = {
  seerr: "Discover",
  prowlarr: "Find",
  qbittorrent: "Download",
  radarr: "Movies",
  sonarr: "Series",
  bazarr: "Subtitles",
  jellyfin: "Watch",
};
let viewDirty = false;
let jobs = [],
  monitorData = null,
  viewData = null,
  subtitleSearches = new Map(),
  detailTab = "tracks",
  detailQuery = "",
  subtitleFilter = "all",
  subtitleQuery = "",
  subtitleType = "movie",
  requestFilter = "all",
  activeJobIds = new Set(),
  refreshTimer;
let data = null,
  route = "overview",
  libraryFilter = "all",
  libraryQuery = "",
  libraryStatus = "all",
  librarySort = "recent",
  selectedAdd = null,
  addService = "radarr",
  toastTimer,
  renderId = 0,
  refreshing = false;
const service = (n) => data?.services.find((s) => s.id === n);
function bytes(v) {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  if (v === 0) return "0 B";
  const k = Math.min(4, Math.floor(Math.log(Math.abs(v)) / Math.log(1024)));
  return `${(v / 1024 ** k).toFixed(k > 1 ? 1 : 0)} ${["B", "KB", "MB", "GB", "TB"][k]}`;
}
function speed(v) {
  return bytes(v || 0) + "/s";
}
function ago(d) {
  const sec = Math.max(0, (Date.now() - new Date(d)) / 1000);
  if (sec < 60) return "Just now";
  if (sec < 3600) return Math.floor(sec / 60) + "m ago";
  if (sec < 86400) return Math.floor(sec / 3600) + "h ago";
  return Math.floor(sec / 86400) + "d ago";
}
function date(d) {
  return new Date(d).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
function toast(s, error = false) {
  clearTimeout(toastTimer);
  $("#toast").textContent = s;
  $("#toast").className = "visible" + (error ? " error" : "");
  toastTimer = setTimeout(() => ($("#toast").className = ""), 5500);
}
async function get(p) {
  const r = await fetch("/hub/api/" + p);
  const j = await r.json();
  if (!r.ok) throw Error(j.error || "Could not load data");
  return j;
}
async function action(body, success, button) {
  if (button) button.disabled = true;
  try {
    const response = await fetch("/hub/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || "Action failed");
    const job = result.job;
    activeJobIds.add(job.id);
    updateJobStrip([job, ...jobs.filter((x) => x.id !== job.id)]);
    toast("Started · " + job.label);
    for (let attempt = 0; attempt < 1200; attempt++) {
      const current = await get("jobs/" + job.id);
      if (!["queued", "running"].includes(current.status)) {
        activeJobIds.delete(job.id);
        await pollJobs();
        if (current.status !== "completed") throw Error(current.message);
        toast(current.message || success);
        data = await get("overview");
        return current.result || true;
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    throw Error("This task is still running. Follow its progress in Activity.");
  } catch (error) {
    toast(error.message, true);
    return false;
  } finally {
    if (button?.isConnected) button.disabled = false;
  }
}
function empty(title, text, symbol = "✓") {
  return `<div class="empty"><div class="empty-symbol">${symbol}</div><strong>${esc(title)}</strong>${esc(text)}</div>`;
}
function title(name, sub = "", actions = "") {
  return `<div class="page-title"><div><h1>${name}</h1>${sub ? `<p>${sub}</p>` : ""}</div>${actions ? `<div class="title-actions">${actions}</div>` : ""}</div>`;
}
function status(s) {
  return `<span class="status-badge ${s?.online ? "" : "off"}"><span class="led ${s?.online ? "" : "off"}"></span>${s?.online ? "Connected" : "Unavailable"}</span>`;
}
function navActive(key) {
  const section = route.split("/")[0];
  return route === key || ({ service: "services", configure: "services", media: "library", player: "watch" }[section] || section) === key;
}
function renderNav() {
  const pending =
    (data?.health.length || 0) +
    (data?.services.filter((s) => !s.online).length || 0);
  const labels = new Map(navs);
  const grouped = new Set(navGroups.flatMap(([, keys]) => keys));
  const groups = navGroups.map(([name, keys], i) => [name, [...keys, ...(i === navGroups.length - 1 ? navs.map(([k]) => k).filter((k) => !grouped.has(k)) : [])].filter((k) => labels.has(k))]);
  const item = (key) =>
    `<a href="#${key}" class="nav-item ${navActive(key) ? "active" : ""}" ${navActive(key) ? 'aria-current="page"' : ""}>${icon(key)}<span>${labels.get(key)}</span>${key === "services" && pending ? `<span class="count attention-count">${pending}</span>` : ""}</a>`;
  $("#nav").innerHTML = groups
    .filter(([, keys]) => keys.length)
    .map(([name, keys]) => (name ? `<div class="nav-group nav-label">${name}</div>` : "") + keys.map(item).join(""))
    .join("");
  const moreActive = !tabbarRoutes.some(navActive);
  $("#tabbar").innerHTML =
    tabbarRoutes.filter((k) => labels.has(k)).map((key) => `<a href="#${key}" class="${navActive(key) ? "active" : ""}">${icon(key)}<span>${key === "overview" ? "Home" : labels.get(key)}</span></a>`).join("") +
    `<button id="menu-more" class="${moreActive ? "active" : ""}" aria-label="More pages" aria-controls="sidebar">${icon("more")}<span>More</span></button>`;
  $("#crumb").textContent = route.startsWith("service/")
    ? service(route.split("/")[1])?.name || "Service"
    : route.startsWith("subtitles/")
      ? "Subtitles"
      : route.startsWith("media/")
        ? "Library"
        : navs.find((n) => n[0] === route)?.[1] || "Home";
}
function poster(m) {
  return `<button class="poster-card" data-detail="${m.service}:${m.id}" aria-label="Manage ${esc(m.title)}"><div class="poster"><div class="poster-fallback">${esc(m.title)}</div><img src="/hub/api/poster?service=${m.service}&id=${m.id}" alt="" loading="lazy">${m.available ? "" : `<span class="badge">Missing</span>`}</div><h3>${esc(m.title)}</h3><p>${esc(m.year)} · ${esc(m.service === "radarr" ? m.quality || "Movie" : "Series")}${m.releaseChoice ? " · Selected release" : ""}</p></button>`;
}
function storage() {
  const disks = (data.disks || []).filter(
    (d, i, a) => a.findIndex((x) => x.path === d.path) === i,
  );
  return (
    disks
      .map((d) => {
        const used = d.totalSpace - d.freeSpace,
          pct = Math.min(100, Math.round((used / d.totalSpace) * 100));
        return `<div class="storage-row"><div class="storage-label"><span>${esc(d.path === "C:\\" ? "System · C:" : d.path === "D:\\" ? "Media · D:" : d.path)}</span><small>${pct}% used</small></div><div class="progress"><span style="width:${pct}%;${pct > 90 ? "background:var(--amber)" : ""}"></span></div><div class="storage-foot"><span>${bytes(d.freeSpace)} free</span><span>of ${bytes(d.totalSpace)}</span></div></div>`;
      })
      .join("") ||
    empty("Storage unavailable", "Check Radarr’s connection.", "—")
  );
}
function downloadState(t) {
  const s = t.state || "";
  if (/error|missingFiles/i.test(s)) return ["Needs attention", "error"];
  if (/paused|stopped/i.test(s)) return ["Paused", "paused"];
  if (/UP|upload/i.test(s))
    return [s.includes("stalled") ? "Seeding · idle" : "Seeding", "good"];
  if (/checking/i.test(s)) return ["Checking", ""];
  if (/stalledDL/i.test(s)) return ["Waiting for peers", ""];
  if (/queued/i.test(s)) return ["Queued", "paused"];
  if (/meta/i.test(s)) return ["Getting metadata", ""];
  return ["Downloading", ""];
}
function downloadRow(t) {
  const [state, cls] = downloadState(t),
    pct = Math.min(100, Math.round((t.progress || 0) * 100)),
    paused = cls === "paused";
  return `<div class="download-row"><div class="download-info"><div class="download-name" title="${esc(t.name)}">${esc(t.name)}</div><div class="download-meta"><span>${state}</span><span>${pct}% · ${speed(t.dlspeed)}</span></div><div class="progress"><span style="width:${pct}%"></span></div></div><button class="button small-button" data-torrent="${t.hash}" data-operation="${paused ? "resume" : "pause"}">${paused ? "Resume" : "Pause"}</button></div>`;
}
function health(limit = Infinity) {
  const offline = data.services.filter((s) => !s.online);
  if (!offline.length && !data.health.length)
    return empty(
      "Everything is in good shape",
      "No service warnings right now.",
    );
  return [
    ...offline.map(
      (s) =>
        `<div class="health-row"><span class="health-icon">!</span><div><button class="text-link" data-app="${s.id}">${esc(s.name)}</button><p>${esc(s.error)}. Check the service on the PC.</p></div></div>`,
    ),
    ...data.health
      .slice(0, limit)
      .map(
        (h) =>
          `<div class="health-row"><span class="health-icon">!</span><div><button class="text-link" data-app="${h.service}">${esc(service(h.service)?.name)}</button><p>${esc(h.message)}</p></div></div>`,
      ),
  ].join("");
}
function overview() {
  const movies = data.library.filter((x) => x.service === "radarr"),
    shows = data.library.filter((x) => x.service === "sonarr"),
    active = data.torrents.filter((t) => !/(paused|stopped|UP)/i.test(t.state)),
    missing = data.library.filter((x) => x.missing > 0 && x.monitored),
    offline = data.services.filter((x) => !x.online);
  const attentionRow = (id, heading, detail) =>
    `<div class="health-row"><span class="health-icon">!</span><div><button class="text-link" data-app="${esc(id)}">${esc(heading)}</button><p>${esc(detail)}</p></div></div>`;
  const attention = [
    ...offline.map((x) => attentionRow(x.id, x.name + " is unavailable", x.error || "Not answering")),
    ...data.health.slice(0, 4).map((h) => attentionRow(h.service, service(h.service)?.name || h.service, h.message)),
    ...(data.dataErrors || []).slice(0, 3).map((e) => attentionRow(e.service, `Couldn’t refresh ${e.section}`, e.message)),
  ];
  const recent = [...data.library]
    .filter((x) => x.available)
    .sort((a, b) => (b.added || "").localeCompare(a.added || ""))
    .slice(0, 14);
  const now = new Date(), hour = now.getHours();
  const greeting = hour < 5 ? "Up late" : hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const facts = [
    attention.length ? `<b>${attention.length} ${attention.length === 1 ? "thing needs" : "things need"} a look</b>` : `All ${data.services.length} services running`,
    `${movies.length} ${movies.length === 1 ? "film" : "films"}`,
    `${shows.length} series`,
    active.length ? `${active.length} downloading at ${speed(data.transfer.dl_info_speed)}` : "",
    missing.length ? `${missing.length} still to find` : "",
  ].filter(Boolean);
  const section = (heading, link, body) =>
    `<section class="home-section"><div class="section-head"><h2>${heading}</h2>${link || ""}</div>${body}</section>`;
  const stack = ["seerr", "prowlarr", "qbittorrent", "radarr", "sonarr", "bazarr", "jellyfin"]
    .map((n) => {
      const s = service(n);
      return s ? `<button class="stack-node" data-app="${n}"><span>${esc(s.name)}<i class="led ${s.online ? "" : "off"}"></i></span><small>${stages[n]}${s.online ? (s.latency ? ` · ${s.latency} ms` : "") : " · unavailable"}</small></button>` : "";
    })
    .join("");
  return (
    `<section class="home-hero"><p class="eyebrow">${now.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}</p><h1>${greeting}.</h1><p class="home-summary">${facts.join(" · ")}</p>${attention.length ? `<div class="home-attention">${attention.join("")}</div>` : ""}</section>` +
    (typeof deckHomeWatch === "function" ? deckHomeWatch(section) : "") +
    (typeof deckLightsHome === "function" ? deckLightsHome(section) : "") +
    (recent.length ? section("Recently added", '<a href="#library" class="text-link">Library</a>', `<div class="shelf">${recent.map(poster).join("")}</div>`) : "") +
    `<div class="home-columns">${section(
      "Downloads",
      '<a href="#downloads" class="text-link">All downloads</a>',
      (active.length ? active.slice(0, 4).map(downloadRow).join("") : '<p class="quiet-line">Nothing downloading right now.</p>') +
        (data.queue.length ? `<p class="quiet-line">${data.queue.length} ${data.queue.length === 1 ? "item is" : "items are"} waiting to import. <button class="text-link" data-imports="true">Review imports</button></p>` : ""),
    )}${section("Storage", "", storage())}</div>` +
    section("Your stack", '<a href="#services" class="text-link">Services</a>', `<div class="stack-strip">${stack}</div><div class="home-monitor">${monitorView()}</div>`)
  );
}
function libraryView() {
  return (
    title(
      "Library",
      `${data.library.filter((x) => x.service === "radarr").length} films and ${data.library.filter((x) => x.service === "sonarr").length} series on the media server.`,
      `<button class="button small-button" data-command="radarr:RefreshMovie">Refresh films</button><button class="button small-button" data-command="sonarr:RefreshSeries">Refresh series</button>`,
    ) +
    `<div class="toolbar"><input class="search" id="library-search" placeholder="Search titles" aria-label="Search your collection" value="${esc(libraryQuery)}"><div class="segmented" aria-label="Media type">${[
      ["all", "All"],
      ["radarr", "Movies"],
      ["sonarr", "Series"],
    ]
      .map(
        ([v, t]) =>
          `<button data-filter="${v}" class="${libraryFilter === v ? "selected" : ""}" aria-pressed="${libraryFilter === v}">${t}</button>`,
      )
      .join(
        "",
      )}</div><select id="library-status" aria-label="Availability"><option value="all">Any status</option><option value="available" ${libraryStatus === "available" ? "selected" : ""}>Available</option><option value="missing" ${libraryStatus === "missing" ? "selected" : ""}>Missing</option><option value="monitored" ${libraryStatus === "monitored" ? "selected" : ""}>Monitored</option></select><select id="library-sort" aria-label="Sort library"><option value="recent">Recently added</option><option value="title" ${librarySort === "title" ? "selected" : ""}>Title A–Z</option><option value="year" ${librarySort === "year" ? "selected" : ""}>Newest year</option><option value="size" ${librarySort === "size" ? "selected" : ""}>Largest files</option></select></div>${data.libraryErrors?.map((e) => `<div class="notice">${esc(e.message)}. That part of the library may be incomplete.</div>`).join("")}<div class="library-grid" id="library-grid"></div><div class="page-footer" id="library-count"></div>`
  );
}
function filterLibrary() {
  const rows = data.library
    .filter(
      (m) =>
        (libraryFilter === "all" || m.service === libraryFilter) &&
        m.title.toLowerCase().includes(libraryQuery.toLowerCase()) &&
        (libraryStatus === "all" ||
          (libraryStatus === "available" && m.available) ||
          (libraryStatus === "missing" && m.missing > 0) ||
          (libraryStatus === "monitored" && m.monitored)),
    )
    .sort((a, b) =>
      librarySort === "title"
        ? a.sortTitle.localeCompare(b.sortTitle)
        : librarySort === "year"
          ? b.year - a.year
          : librarySort === "size"
            ? b.size - a.size
            : (b.added || "").localeCompare(a.added || ""),
    );
  $("#library-grid").innerHTML = rows.length
    ? rows.map(poster).join("")
    : empty("No matching titles", "Try a different search or filter.", "⌕");
  $("#library-count").textContent = `${rows.length} titles shown`;
}
function downloads() {
  return (
    title(
      "Downloads",
      `↓ ${speed(data.transfer.dl_info_speed)} · ↑ ${speed(data.transfer.up_info_speed)} · ${data.torrents.length} torrents`,
      `<button class="button" data-limits="global">Speed limits</button>`,
    ) +
    `<section class="panel">${
      data.torrents.length
        ? `<div class="table-wrap"><table class="table"><thead><tr><th>Title</th><th>Status</th><th>Progress</th><th>Transfer</th><th>Ratio</th><th>Controls</th></tr></thead><tbody>${data.torrents
            .map((t) => {
              const [s, c] = downloadState(t),
                paused = c === "paused";
              return `<tr><td class="title-cell"><button class="text-link torrent-title" data-torrent-detail="${t.hash}">${esc(t.name)}</button><small>${esc(t.category || "Uncategorized")} · ${bytes(t.size)}</small></td><td><span class="state ${c}">${s}</span></td><td>${Math.round(t.progress * 100)}%<div class="progress"><span style="width:${Math.round(t.progress * 100)}%"></span></div></td><td>↓ ${speed(t.dlspeed)}<small>↑ ${speed(t.upspeed)}</small></td><td>${(t.ratio || 0).toFixed(2)}<small>${Math.floor((t.seeding_time || 0) / 3600)}h seeded</small></td><td><div class="actions"><button class="button small-button" data-torrent="${t.hash}" data-operation="${paused ? "resume" : "pause"}">${paused ? "Resume" : "Pause"}</button><button class="button small-button" data-torrent="${t.hash}" data-operation="recheck">Recheck</button></div></td></tr>`;
            })
            .join("")}</tbody></table></div>`
        : empty(
            "No torrents",
            "Add media through requests or your library.",
            "↓",
          )
    }</section>${data.queue.length ? `<div class="shelf-head"><h2>Import queue</h2></div><section class="panel">${data.queue.map((q) => `<div class="health-row"><span class="health-icon">↳</span><div><h3>${esc(q.title)}</h3><p>${esc(q.status)} · ${esc(q.trackedDownloadStatus || "")}${q.statusMessages?.length ? " · " + esc(q.statusMessages.flatMap((x) => x.messages || []).join("; ")) : ""}</p><button class="text-link" data-queue="${q.service}:${q.id}">Resolve import</button></div></div>`).join("")}</section>` : ""}<p class="section-note">Existing tracker rules and seeding limits stay in place. Pause and resume act on the selected torrent.</p>`
  );
}

const chip = (text, good = false) =>
  `<span class="state ${good ? "good" : ""}">${esc(text)}</span>`;
const button = (label, attributes, primary = false) =>
  `<button class="button ${primary ? "primary" : "small-button"}" ${attributes}>${label}</button>`;
const field = (label, html) => `<label class="field">${label}${html}</label>`;
const select = (name, items, value) =>
  `<select name="${name}">${items.map((x) => `<option value="${esc(x.value)}" ${String(x.value) === String(value) ? "selected" : ""}>${esc(x.label)}</option>`).join("")}</select>`;
const input = (name, value, type = "text", extra = "") =>
  `<input name="${name}" type="${type}" value="${esc(value)}" ${extra}>`;
const table = (headers, rows) =>
  `<div class="table-wrap"><table class="table"><thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
const row = (cells) =>
  `<tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`;
const panel = (name, body, controls = "") =>
  `<section class="panel"><div class="panel-head"><h2>${name}</h2>${controls}</div>${body}</section>`;
const loading = () =>
  '<div class="loading"><span class="spinner"></span> Loading live details…</div>';
const tabs = (items, active, attribute = "data-tab") =>
  `<div class="detail-tabs">${items.map(([key, label]) => `<button ${attribute}="${key}" class="${active === key ? "selected" : ""}">${label}</button>`).join("")}</div>`;

function showDialog(html) {
  $("#dialog-content").innerHTML = html;
  if (!$("#dialog").open) $("#dialog").showModal();
}
function hideBrokenImages() {
  document.querySelectorAll(".poster img").forEach((image) => {
    image.onerror = () => (image.style.display = "none");
  });
}
function details(key) {
  $("#dialog").close();
  location.hash = "media/" + key.replace(":", "/");
}
function jobState(job) {
  if (job.result?.partial) return chip("Partially completed");
  return chip(
    job.status === "running"
      ? "Running"
      : job.status === "queued"
        ? "Waiting"
        : job.status === "completed"
          ? "Completed"
          : job.status === "interrupted"
            ? "Interrupted"
            : "Failed",
    job.status === "completed",
  );
}
function updateJobStrip(list) {
  jobs = list;
  for (const id of activeJobIds) if (!list.some(j => j.id === id && ["queued", "running"].includes(j.status))) activeJobIds.delete(id);
  const active = jobs.filter((job) =>
    ["running", "queued"].includes(job.status),
  );
  $("#job-strip").innerHTML = active.length
    ? `<a href="#activity"><span class="spinner"></span><strong>${esc(active[0].label)}</strong><span>${esc(active[0].message)}</span><b>${active.length > 1 ? "+" + (active.length - 1) : "View activity"}</b></a>`
    : "";
  $("#job-strip").hidden = !active.length;
  $("#job-count").textContent = active.length
    ? `${active.length} running`
    : "Activity";
  $("#job-count").classList.toggle("running", active.length > 0);
}
async function pollJobs() {
  try {
    updateJobStrip(await get("jobs"));
    if (route === "activity") renderActivity();
  } catch {}
}
function spark(values, color = "var(--accent)") {
  if (values.length < 2)
    return '<span class="muted small">Collecting samples</span>';
  const max = Math.max(...values, 1);
  return `<svg class="sparkline" viewBox="0 0 240 42" preserveAspectRatio="none" aria-hidden="true"><polyline fill="none" stroke="${color}" stroke-width="2" points="${values.map((v, i) => `${(i / (values.length - 1)) * 240},${40 - (v / max) * 36}`).join(" ")}"/></svg>`;
}
function monitorView() {
  const samples = monitorData?.samples || [];
  return panel(
    "Stack monitoring",
    `<div class="monitor-summary"><div><small>Download throughput</small><strong>${speed(data.transfer.dl_info_speed)}</strong>${spark(samples.slice(-180).map((x) => x.download))}</div><div><small>Upload throughput</small><strong>${speed(data.transfer.up_info_speed)}</strong>${spark(
      samples.slice(-180).map((x) => x.upload),
      "var(--green)",
    )}</div><div><small>Observed uptime</small><div class="uptime-services">${data.services
      .map((s) => {
        const checks = monitorData?.services[s.id];
        return `<div><span>${esc(s.name)}</span><b>${checks ? (checks.uptime * 100).toFixed(1) + "%" : "—"}</b></div>`;
      })
      .join(
        "",
      )}</div></div></div><div class="panel-note">Checks every 20 seconds · ${samples.length} samples${samples.length ? " since " + new Date(samples[0].at).toLocaleString() : ""} · up to 24 hours retained</div>`,
    '<a href="#activity" class="text-link">Activity & history</a>',
  );
}
function servicesView() {
  return (
    title("Services", "Everything Deck talks to, how it is doing, and its settings.") +
    `<div class="services-grid">${data.services.map((s) => `<article class="service-card"><div class="service-card-top"><div class="service-logo">${icon(serviceIcons[s.id])}</div><h2>${esc(s.name)}</h2>${status(s)}</div><p>${descriptions[s.id]}</p>${button("Open " + esc(s.name), `data-app="${s.id}"`)}<div class="version">${s.online ? `${esc(s.version)} · ${s.latency}ms` : esc(s.error)}</div></article>`).join("")}</div><div class="shelf-head"><h2>Live health</h2></div>${panel("Warnings", health())}<div class="shelf-head"><h2>Monitoring history</h2></div>${monitorView()}`
  );
}
function renderActivity() {
  if (route !== "activity") return;
  $("#main").innerHTML =
    title(
      "Activity",
      "Follow work from start to finish. Failed tasks keep their error details.",
    ) +
    `<div class="activity-stats">${["running", "completed", "failed"].map((state) => `<div><strong>${jobs.filter((j) => j.status === state).length}</strong><span>${state === "running" ? "In progress" : state === "completed" ? "Completed" : "Need attention"}</span></div>`).join("")}</div>` +
    panel(
      "Deck tasks",
      jobs.length
        ? `<div class="job-list">${jobs.map((job) => `<article class="job-row"><div class="job-dot ${job.status}">${job.status === "completed" ? "✓" : job.status === "failed" ? "!" : "↻"}</div><div><h3>${esc(job.label)}</h3><p>${esc(job.message)}</p><small>${esc(service(job.service)?.name || "Deck")} · ${new Date(job.createdAt).toLocaleString()}${job.finishedAt ? " · " + Math.max(1, Math.round((new Date(job.finishedAt) - new Date(job.startedAt || job.createdAt)) / 1000)) + "s" : ""}</small></div>${jobState(job)}</article>`).join("")}</div>`
        : empty(
            "No tasks yet",
            "Subtitle searches, downloads, and library updates will appear here.",
          ),
    ) +
    `<div class="shelf-head"><h2>Recent library events</h2></div><div id="history-view" class="panel">${loading()}</div>`;
  get("history")
    .then((response) => {
      const history = response.items || response;
      if (route === "activity" && $("#history-view"))
        $("#history-view").innerHTML = deckNotice(response.errors) + (history.length
          ? historyTable(history)
          : empty(
              "No recent library events",
              "Your services will report new downloads and imports here.",
            ));
    })
    .catch(error => { if (route === "activity" && $("#history-view")) $("#history-view").innerHTML = `<div class="notice">${esc(error.message)}</div>`; });
}
function historyTable(history) {
  return table(
    ["Event", "Details", "When"],
    history.map((h) =>
      row([
        esc(
          h.eventType
            ? h.eventType.replace(/([a-z])([A-Z])/g, "$1 $2")
            : {
                0: "Removed",
                1: "Downloaded",
                2: "Downloaded manually",
                3: "Upgraded",
                4: "Uploaded",
                5: "Timing synchronized",
                6: "Translated",
              }[h.action] || "Subtitle update",
        ),
        `<strong>${esc(h.sourceTitle || h.description || h.title || h.provider || "")}</strong><small>${esc(h.data?.reason || (typeof h.language === "object" ? h.language.name : h.language) || h.data?.downloadClient || "")}</small>`,
        esc(h.date ? new Date(h.date).toLocaleString() : h.timestamp || ""),
      ]),
    ),
  );
}

function subtitleLibraryView() {
  const content = viewData;
  const movies = content.movies,
    wanted = movies.filter((m) => m.missing_subtitles?.length);
  const movieCount = movies.reduce(
    (sum, m) => sum + (m.subtitles || []).filter((s) => s.path).length,
    0,
  );
  return (
    title(
      "Subtitles",
      "Every file, language, and provider. Manage a title without leaving Deck.",
    ) +
    `<div class="subtitle-intro"><div><strong>${movies.length}</strong><span>films indexed</span></div><div><strong>${movieCount}</strong><span>external subtitle tracks</span></div><div><strong>${wanted.length + content.episodes.length}</strong><span>titles missing subtitles</span></div><div class="provider-pills">${content.providers.map((p) => `<span class="provider-pill"><span class="led ${p.status === "Good" ? "" : "off"}"></span>${esc(p.name)}<small>${esc(p.status)}${p.retry !== "-" ? " · " + esc(p.retry) : ""}</small></span>`).join("")}</div></div><div class="toolbar"><input class="search" id="subtitle-query" placeholder="Find a film or series" aria-label="Find subtitles" value="${esc(subtitleQuery)}"><div class="segmented"><button data-subtitle-type="movie" class="${subtitleType === "movie" ? "selected" : ""}">Movies</button><button data-subtitle-type="series" class="${subtitleType === "series" ? "selected" : ""}">Series</button><button data-subtitle-type="episode" class="${subtitleType === "episode" ? "selected" : ""}">Missing episodes</button></div><select id="subtitle-filter" aria-label="Subtitle status"><option value="all">All subtitles</option><option value="missing" ${subtitleFilter === "missing" ? "selected" : ""}>Missing</option><option value="available" ${subtitleFilter === "available" ? "selected" : ""}>With subtitles</option></select></div><section class="panel" id="subtitle-rows"></section><p class="section-note">Choose a title to search providers, download a specific release, upload or edit a track, and synchronize timing.</p>`
  );
}
function filterSubtitles() {
  if (!$("#subtitle-rows")) return;
  const items =
    subtitleType === "movie"
      ? viewData.movies
      : subtitleType === "series"
        ? viewData.series
        : viewData.episodes;
  const filtered = items.filter(
    (item) =>
      (item.title + " " + (item.seriesTitle || ""))
        .toLowerCase()
        .includes(subtitleQuery.toLowerCase()) &&
      (subtitleFilter === "all" ||
        (subtitleFilter === "missing" && (subtitleType === "series" ? item.missingSubtitleEpisodeCount : item.missing_subtitles?.length)) ||
        (subtitleFilter === "available" && (subtitleType === "series" ? item.subtitleEpisodeCount : item.subtitles?.length || item.includedSubtitlesAccepted))),
  );
  $("#subtitle-rows").innerHTML = filtered.length
    ? table(
        ["Title", "Subtitle tracks", "Missing", "Language profile", ""],
        filtered.map((item) => {
          const kind =
            subtitleType === "movie"
              ? "movie"
              : subtitleType === "series"
                ? "series"
                : "episode";
          const id =
            kind === "movie"
              ? item.radarrId
              : kind === "series"
                ? item.sonarrSeriesId
                : item.sonarrEpisodeId;
          const languageChips = (item.subtitles || [])
            .map((track) =>
              chip(
                (track.name || track.code2 || "") +
                  (track.forced ? " · Forced" : "") +
                  (track.hi ? " · HI" : ""),
                true,
              ),
            )
            .join(" ");
          return row([
            `<button class="title-link" data-subtitle-detail="${kind}:${id}">${esc(item.seriesTitle ? item.seriesTitle + " · " + item.title : item.title)}</button><small>${esc(item.year || (item.season && "S" + item.season + " · E" + item.episode) || "")}</small>`,
            `<div class="language-chips">${(item.includedSubtitlesAccepted ? chip("Included subtitles accepted", true) : "") + languageChips || '<span class="muted">' + (kind === "series" ? `${item.subtitleEpisodeCount || 0} episodes with tracks` : "No tracks indexed") + "</span>"}</div>`,
            `<div class="language-chips">${(item.missing_subtitles || []).map((language) => chip(language.name || language.code2 || (Array.isArray(language) ? language[1] : language))).join(" ") || '<span class="muted">—</span>'}</div>`,
            esc(
              viewData.profiles.find((p) => p.profileId === item.profileId)
                ?.name || "None",
            ),
            button("Manage", `data-subtitle-detail="${kind}:${id}"`),
          ]);
        }),
      )
    : empty(
        "No matching titles",
        "Try another filter or sync Bazarr’s library from Services.",
      );
}
function subtitleBackups(backups) {
  return backups?.length
    ? panel(
        "Saved subtitle versions",
        table(
          ["File", "Saved", ""],
          backups.map((entry) =>
            row([
              esc(entry.filename),
              new Date(entry.createdAt).toLocaleString(),
              button("Restore", `data-subtitle-restore="${entry.backupId}"`),
            ]),
          ),
        ),
      )
    : "";
}
function subtitlePage(kind, id) {
  const { item, profiles, languages, history } = viewData;
  const movie = data.library.find(
    (m) => m.service === "radarr" && m.id === Number(id),
  );
  const name = item.seriesTitle
    ? item.seriesTitle + " · " + item.title
    : item.title;
  const key = kind + ":" + id;
  const search = subtitleSearches.get(key);
  const external = (item.subtitles || []).filter((s) => s.path);
  const embedded = (item.subtitles || []).filter((s) => !s.path);
  return (
    `<a class="text-link back-link" href="#subtitles">${icon("back")}All subtitles</a>` +
    title(
      esc(name),
      `${esc(item.year || "")}${item.season ? " · S" + item.season + " · E" + item.episode : ""} · ${external.length} external ${external.length === 1 ? "track" : "tracks"}`,
      `${button("Scan files", 'data-subtitle-operation="scan"')}${button("Find subtitles", 'data-subtitle-operation="search"', true)}`,
    ) +
    `<div class="media-workspace"><div class="media-rail">${movie ? `<div class="poster"><img src="/hub/api/poster?service=radarr&id=${id}" alt=""></div>` : ""}<div class="rail-label">FILE</div><p class="file-path">${esc(item.path)}</p><div class="rail-label">LANGUAGE PROFILE</div><form id="subtitle-profile-form">${select("profileId", [{ value: "none", label: "No profile" }, ...profiles.map((p) => ({ value: p.profileId, label: p.name }))], item.profileId)}${button("Save profile", 'type="submit"')}</form><div class="rail-label">MISSING</div><div class="language-chips">${(item.missing_subtitles || []).map((s) => chip(s.name || s.code2 || s[1] || s)).join(" ") || chip("Up to date", true)}</div></div><div class="media-content">${item.includedSubtitlesAccepted ? '<div class="notice">Included subtitles accepted for your selected release. Burned-in subtitles may not appear as separate tracks; external subtitle tools remain available.</div>' : ""}${tabs(
      [
        ["tracks", "Tracks"],
        [
          "search",
          `Provider results${search ? " · " + search.results.length : ""}`,
        ],
        ["history", "History"],
      ],
      detailTab,
    )}<div id="subtitle-pane">${detailTab === "history" ? panel("Subtitle history", history.length ? historyTable(history) : empty("No subtitle history", "New downloads and changes will appear here.")) : detailTab === "search" ? subtitleResults(search, kind, id) : `<div class="native-tools">${button("Upload subtitle", 'data-subtitle-upload="true"')}${button("Find missing automatically", 'data-subtitle-operation="automatic"')}</div>${panel("External tracks", external.length ? external.map((track, index) => `<article class="subtitle-track"><div class="track-language"><strong>${esc(track.name || track.code2)}</strong><span>${track.forced ? "Forced · " : ""}${track.hi ? "Hearing impaired · " : ""}${bytes(track.file_size)}</span></div><div class="track-file"><p>${esc(track.path.split(/[\\/]/).pop())}</p><small>${track.path.toLowerCase().endsWith(".srt") ? "SubRip" : esc(track.path.split(".").pop().toUpperCase())}</small></div><div class="inline-actions">${button("Edit", `data-subtitle-edit="${index}"`)}${button("Preview", `data-subtitle-preview="${index}"`)}${button("Shift timing", `data-subtitle-shift="${index}"`)}${button("Sync with audio", `data-subtitle-sync="${index}"`)}${button("Replace", 'data-subtitle-operation="search"')}${button("Remove", `data-subtitle-delete="${index}"`)}</div></article>`).join("") : empty("No external subtitles", "Search your providers or upload a subtitle file."))}${embedded.length ? panel("Embedded tracks", `<div class="panel-body"><div class="language-chips">${embedded.map((track) => chip((track.name || track.code2) + " · Embedded", true)).join(" ")}</div><p class="section-note">These tracks are inside the video file.</p></div>`) : ""}<div id="subtitle-editor"></div>`}</div></div></div>${subtitleBackups(viewData.backups)}`
  );
}
function subtitleResults(search, kind, id) {
  if (!search)
    return panel(
      "Choose a subtitle release",
      `<div class="panel-body"><p class="muted">Search the providers you already configured. Results show match score, language, and the exact release.</p>${button("Search providers", 'data-subtitle-operation="search"', true)}</div>`,
    );
  const results = search.results
    .filter((r) => (!detailQuery || r.language === detailQuery) && (!window.subtitleProviderFilter || r.provider === window.subtitleProviderFilter))
    .sort((a, b) => b.score - a.score);
  return panel(
    "Provider results",
    results.length
      ? `<div class="subtitle-results">${results.map((result) => `<article class="subtitle-result"><div class="match-score ${result.score >= 90 ? "excellent" : ""}"><strong>${Math.round(result.score)}</strong><small>match</small></div><div class="result-description"><h3>${esc((result.release_info || []).join(" · ") || "Subtitle release")}</h3><p>${esc(result.provider)} · ${esc(result.language.toUpperCase())}${String(result.hearing_impaired).toLowerCase() === "true" ? " · Hearing impaired" : ""}${String(result.forced).toLowerCase() === "true" ? " · Forced" : ""}</p><div class="small muted">${result.dont_matches?.length ? "Does not match: " + esc(result.dont_matches.join(", ")) : "Matches: " + esc((result.matches || []).join(", "))}</div></div>${button("Download", `data-subtitle-download="${result.index}"`, result.score >= 90)}</article>`).join("")}</div>`
      : empty(
          "No subtitles found",
          "Check provider status, language profile, and the film’s file path.",
        ),
    `<div class="inline-actions"><select id="subtitle-result-language" aria-label="Result language"><option value="">All languages</option>${[...new Set(search.results.map(r => r.language))].map(l => `<option value="${esc(l)}" ${detailQuery === l ? "selected" : ""}>${esc(l.toUpperCase())}</option>`).join("")}</select><select id="subtitle-result-provider" aria-label="Result provider"><option value="">All providers</option>${[...new Set(search.results.map(r => r.provider))].map(l => `<option value="${esc(l)}" ${window.subtitleProviderFilter === l ? "selected" : ""}>${esc(l)}</option>`).join("")}</select><span class="small muted">${results.length} results</span></div>`,
  );
}
async function runSubtitle(operation, buttonElement, extra = {}) {
  const [, kind, id] = route.split("/");
  if (operation === "search") {
    detailTab = "search";
    $("#subtitle-pane").innerHTML = panel(
      "Searching providers",
      `<div class="loading"><span class="spinner"></span> Finding subtitle releases…</div><p class="panel-note">You can leave this page. Progress remains in Activity.</p>`,
    );
  }
  const result = await action(
    {
      action: "subtitle",
      kind,
      id: Number(id),
      operation,
      label: `${viewData.item.title} · ${operation === "search" ? "Search subtitles" : operation === "download" ? "Download subtitle" : operation === "edit" ? "Save subtitle" : operation}`,
      ...extra,
    },
    "",
    buttonElement,
  );
  if (result && operation === "search")
    subtitleSearches.set(kind + ":" + id, result);
  if (result && operation === "download") detailTab = "tracks";
  if (route === `subtitles/${kind}/${id}`) await render();
  return result;
}
async function subtitleEditor(index) {
  const [, kind, id] = route.split("/");
  const track = viewData.item.subtitles.filter((x) => x.path)[index];
  const response = await get(
    "subtitle-content?" + new URLSearchParams({ kind, id, path: track.path }),
  );
  const content =
    typeof response === "string"
      ? response
      : response.content || response.data?.content || response.data || "";
  showDialog(
    `<h2 class="dialog-title">Edit ${esc(track.name)} subtitle</h2><p class="muted small">${esc(track.path.split(/[\\/]/).pop())}</p><form id="subtitle-edit-form" data-path="${esc(track.path)}"><textarea name="content" class="subtitle-text" spellcheck="false" aria-label="Subtitle contents">${esc(content)}</textarea><div class="inline-actions">${button("Save subtitle", 'type="submit"', true)}${button("Cancel", 'type="button" data-dialog-close="true"')}</div></form>`,
  );
}
function uploadSubtitleDialog() {
  showDialog(
    `<h2 class="dialog-title">Upload subtitle</h2><form id="subtitle-upload-form"><div class="form-row">${field(
      "Language",
      select(
        "language",
        viewData.languages.map((l) => ({ value: l.code2, label: l.name })),
        "en",
      ),
    )}${field("Subtitle file", '<input type="file" name="file" accept=".srt,.ass,.ssa,.vtt,.sub" required>')}</div><label class="checkbox"><input name="forced" type="checkbox"> Forced subtitles</label><label class="checkbox"><input name="hi" type="checkbox"> Hearing impaired</label><p class="section-note">Saves beside this video using Bazarr’s naming rules. A track with the same language and flags may be replaced.</p>${button("Upload subtitle", 'type="submit"', true)}</form>`,
  );
}

function mediaPage(name, id) {
  const { item, files, profiles, episodes, history } = viewData;
  const summary = data.library.find(
    (m) => m.service === name && m.id === Number(id),
  );
  return (
    `<section class="media-hero" style="--backdrop:url('/hub/api/poster?service=${name}&id=${id}&kind=fanart')"><a class="back-link" href="#library">${icon("back")}Library</a>` +
    title(
      esc(item.title),
      `${item.year} · ${name === "radarr" ? "Film" : "Series"} · ${esc(item.status)}`,
      `${button("Refresh metadata", `data-command="${name}:${name === "radarr" ? "RefreshMovie" : "RefreshSeries"}" data-id="${id}"`)}${button("Search releases", 'data-media-releases="true"', true)}`,
    ) +
    `</section>` +
    releaseChoiceNotice(viewData.releaseChoice) +
    `<div class="media-workspace"><div class="media-rail"><div class="poster"><img src="/hub/api/poster?service=${name}&id=${id}" alt=""></div><div class="rail-label">Location</div><p class="file-path">${esc(item.path)}</p><div class="rail-label">On disk</div><strong>${bytes(summary?.size || 0)}</strong>${name === "radarr" ? `<a class="button" href="#subtitles/movie/${id}">Subtitles</a>` : ""}</div><div class="media-content"><p class="media-description">${esc(item.overview || "")}</p>${tabs([["journey", "Journey"], ["settings", "Monitoring & quality"], ...(name === "sonarr" ? [["episodes", "Episodes"]] : []), ["files", "Files"], ["releases", "Releases"], ["history", "History"]], detailTab)}<div id="media-pane">${
      detailTab === "journey"
        ? journeyView(name, id, viewData.journey)
        : detailTab === "episodes"
        ? episodesView(episodes || [], files)
        : detailTab === "files"
          ? panel(
              "Media files",
              files.length
                ? table(
                    ["File", "Quality", "Size", "Media"],
                    files.map((file) =>
                      row([
                        esc(file.relativePath || file.path),
                        esc(file.quality?.quality?.name),
                        bytes(file.size),
                        `${esc(file.mediaInfo?.videoCodec || "")}<small>${esc(file.mediaInfo?.audioCodec || "")} · ${esc(file.mediaInfo?.resolution || "")}</small>`,
                      ]),
                    ),
                  )
                : empty(
                    "No files imported",
                    "Search for releases to complete this title.",
                  ),
            )
          : detailTab === "history"
            ? panel(
                "Library history",
                history.records?.length
                  ? historyTable(history.records)
                  : empty(
                      "No history",
                      "Imports and downloads will appear here.",
                    ),
              )
            : detailTab === "releases"
              ? '<div id="release-results" class="panel">' +
                empty(
                  "Choose a release",
                  "Search your indexers to compare quality, size, and availability.",
                ) +
                "</div>"
              : panel(
                  "Monitoring & quality",
                  `<form id="media-settings-form" class="panel-body settings-form"><label class="checkbox"><input name="monitored" type="checkbox" ${item.monitored ? "checked" : ""} ${viewData.releaseChoice ? "disabled" : ""}> Monitor for new releases</label><div class="form-row">${field(
                    "Quality profile",
                    select(
                      "profileId",
                      profiles.map((p) => ({ value: p.id, label: p.name })),
                      item.qualityProfileId,
                    ),
                  )}${
                    name === "radarr"
                      ? field(
                          "Minimum availability",
                          select(
                            "minimumAvailability",
                            [
                              { value: "announced", label: "Announced" },
                              { value: "inCinemas", label: "In cinemas" },
                              { value: "released", label: "Released" },
                            ],
                            item.minimumAvailability,
                          ),
                        )
                      : field(
                          "Series type",
                          select(
                            "seriesType",
                            [
                              { value: "standard", label: "Standard" },
                              { value: "daily", label: "Daily" },
                              { value: "anime", label: "Anime" },
                            ],
                            item.seriesType,
                          ),
                        )
                  }</div>${name === "sonarr" ? `<div class="season-controls">${item.seasons.map((s) => `<label class="checkbox"><input type="checkbox" name="season-${s.seasonNumber}" ${s.monitored ? "checked" : ""}> ${s.seasonNumber === 0 ? "Specials" : "Season " + s.seasonNumber}</label>`).join("")}</div>` : ""}${button("Save changes", 'type="submit"', true)}${button("Rescan files", `type="button" data-command="${name}:${name === "radarr" ? "RescanMovie" : "RescanSeries"}" data-id="${id}"`)}<p class="section-note">Uses your existing folders, indexers, and quality rules.</p></form>`,
                )
    }</div></div></div>`
  );
}
function episodesView(episodes, files) {
  const seasons = [...new Set(episodes.map((e) => e.seasonNumber))].sort(
    (a, b) => a - b,
  );
  return seasons
    .map((season) =>
      panel(
        season === 0 ? "Specials" : "Season " + season,
        table(
          ["Episode", "Status", "Monitored", ""],
          episodes
            .filter((e) => e.seasonNumber === season)
            .map((e) => {
              const file = files.find((f) => f.id === e.episodeFileId);
              return row([
                `<strong>E${String(e.episodeNumber).padStart(2, "0")} · ${esc(e.title)}</strong><small>${esc(e.airDate || "Unaired")}</small>`,
                chip(
                  file
                    ? file.quality?.quality?.name || "Available"
                    : e.hasFile
                      ? "Available"
                      : "Missing",
                  e.hasFile,
                ),
                `<input type="checkbox" data-episode-monitor="${e.id}" ${e.monitored ? "checked" : ""} aria-label="Monitor ${esc(e.title)}">`,
                `<div class="inline-actions">${button("Find release", `data-episode-releases="${e.id}"`)}${e.hasFile ? button("Subtitles", `data-subtitle-detail="episode:${e.id}"`) : ""}</div>`,
              ]);
            }),
        ),
        button("Search missing", `data-season-search="${season}"`),
      ),
    )
    .join("");
}
function releaseChoiceNotice(choice) {
  if (!choice) return "";
  return `<section class="panel selected-release"><div class="panel-body"><div class="inline-actions"><strong>Selected release</strong>${chip(choice.imported ? "Imported & verified" : choice.status === "selected" ? "Following download" : "Needs verification", choice.imported)}</div><p>${esc(choice.releaseTitle)}</p><p class="section-note">This release is assigned to ${esc(choice.title)}. Automatic replacement is paused for this movie.${choice.includedSubtitles ? " Included subtitles are accepted once this exact download is imported." : ""}</p>${choice.acceptedRejections.length ? `<details><summary>Accepted rejection reasons</summary><p>${esc(choice.acceptedRejections.join("; "))}</p></details>` : ""}${button("Clear selection", `data-release-clear="${choice.id}"`)}</div></section>`;
}
let forceRelease = null;
function forceReleaseDialog(index) {
  const [, serviceName, id] = route.split("/");
  const release = viewData.releases?.results.find(r => r.index === Number(index));
  if (!release || serviceName !== "radarr") throw Error("Search movie releases again");
  forceRelease = { action: "grabRelease", service: serviceName, id: Number(id), token: viewData.releases.token, index: release.index, force: true, label: "Select release · " + viewData.item.title };
  const hasSubs = /esub|hardcod|burned.in|hardsub/i.test(release.title + " " + (release.rejections || []).join(" "));
  showDialog(`<h2 class="dialog-title">Use this release for ${esc(viewData.item.title)}?</h2><p class="release-name">${esc(release.title)}</p><p class="small muted">${esc(release.indexer)} · ${esc(release.quality?.quality?.name || "Unknown quality")} · ${bytes(release.size)}</p>${release.rejections?.length ? `<div class="notice"><strong>Override these rejections</strong><ul>${release.rejections.map(reason => `<li>${esc(reason)}</li>`).join("")}</ul></div>` : ""}<p class="section-note">Deck will download this release, assign it to this movie, remember your choice through import and playback, and pause automatic replacement for this movie. You can clear the selection to restore its previous monitoring. A lower-quality replacement may need a manual import; Deck will prefill the chosen movie and release metadata.</p><form id="force-release-form"><label class="checkbox"><input name="includedSubtitles" type="checkbox" ${hasSubs ? "checked" : ""}> Accept the subtitles included in this release (for example ESub)</label><p class="section-note">This records your acceptance; it does not claim to inspect or extract burned-in subtitles.</p><div class="inline-actions">${button("Force select & download", 'type="submit"', true)}${button("Cancel", 'type="button" data-dialog-close="true"')}</div></form>`);
}
async function mediaReleases(episodeId) {
  const [, name, id] = route.split("/");
  detailTab = "releases";
  $("#media-pane").innerHTML = panel("Searching indexers", loading());
  try {
    const result = await get(
      "releases?" +
        new URLSearchParams({
          service: name,
          id,
          ...(episodeId ? { episodeId } : {}),
        }),
    );
    if (route !== `media/${name}/${id}`) return;
    viewData.releases = result;
    $("#media-pane").innerHTML = panel(
      "Release results",
      result.results.length
        ? table(
            ["Release", "Quality", "Size", "Peers", "Decision"],
            result.results.map((r) =>
              row([
                `<strong>${esc(r.title)}</strong><small>${esc(r.indexer)} · ${esc(r.ageHours ? Math.floor(r.ageHours / 24) + " days old" : "")}</small>`,
                esc(r.quality?.quality?.name || r.quality?.name || "—"),
                bytes(r.size),
                `${r.seeders ?? "—"}<small>${r.leechers ?? "—"} leechers</small>`,
                r.rejected
                  ? `<span class="state error">Rejected</span><small>${esc((r.rejections || []).join("; "))}</small>${name === "radarr" ? button("Force select", `data-release-force="${r.index}"`) : ""}`
                  : button(
                      "Download",
                      `data-release-download="${r.index}"`,
                      true,
                    ) + (name === "radarr" ? button("Select & keep", `data-release-force="${r.index}"`) : ""),
              ]),
            ),
          )
        : empty("No releases found", "Check the indexer warnings in Services."),
    );
  } catch (error) {
    $("#media-pane").innerHTML =
      `<div class="error-box">${esc(error.message)}</div>`;
  }
}

async function torrentDialog(hash) {
  const torrent = data.torrents.find((t) => t.hash === hash);
  showDialog(
    `<h2 class="dialog-title">${esc(torrent?.name || "Download")}</h2>${loading()}`,
  );
  const detail = await get("torrent?hash=" + hash);
  showDialog(
    `<h2 class="dialog-title">${esc(torrent?.name || "Download")}</h2><div class="detail-data"><div><small>Status</small>${downloadState(torrent || {})[0]}</div><div><small>Downloaded</small>${bytes(detail.properties.total_downloaded)} · ${Math.round((torrent?.progress || 0) * 100)}%</div><div><small>Save path</small><span class="file-path">${esc(detail.properties.save_path)}</span></div><div><small>Ratio</small>${(torrent?.ratio || 0).toFixed(2)}</div></div><div class="inline-actions">${button("Reannounce", `data-torrent="${hash}" data-operation="reannounce"`)}${button("Force start", `data-torrent="${hash}" data-operation="force"`)}${button("Remove torrent", `data-remove-torrent="${hash}"`)}</div><form id="torrent-settings-form" data-hash="${hash}"><div class="form-row">${field("Download limit · KiB/s (0 = unlimited)", input("downloadLimit", Math.max(0, detail.downloadLimit) / 1024, "number", 'min="0"'))}${field("Upload limit · KiB/s (0 = unlimited)", input("uploadLimit", Math.max(0, detail.uploadLimit) / 1024, "number", 'min="0"'))}</div>${button("Save speed limits", 'type="submit"', true)}</form><form id="torrent-category-form" data-hash="${hash}" class="toolbar">${select("category", [{ value: "", label: "Uncategorized" }, ...Object.keys(detail.categories).map((c) => ({ value: c, label: c }))], torrent?.category)}${button("Set category", 'type="submit"')}</form><h3 class="subheading">Files</h3>${table(
      ["File", "Size", "Progress", "Priority"],
      detail.files.map((f) =>
        row([
          esc(f.name),
          bytes(f.size),
          Math.round(f.progress * 100) + "%",
          `<select data-file-priority="${hash}:${f.index}" aria-label="Priority for ${esc(f.name)}">${[
            { value: 0, label: "Do not download" },
            { value: 1, label: "Normal" },
            { value: 6, label: "High" },
            { value: 7, label: "Maximum" },
          ]
            .map(
              (p) =>
                `<option value="${p.value}" ${p.value === f.priority ? "selected" : ""}>${p.label}</option>`,
            )
            .join("")}</select>`,
        ]),
      ),
    )}<h3 class="subheading">Trackers</h3>${table(
      ["Tracker", "Status", "Peers"],
      detail.trackers.map((t) =>
        row([
          `<span class="file-path">${esc(t.url)}</span>`,
          esc(
            t.msg ||
              [
                "Disabled",
                "Not contacted",
                "Working",
                "Updating",
                "Not working",
              ][t.status] ||
              t.status,
          ),
          t.num_peers ?? "—",
        ]),
      ),
    )} `,
  );
}
function limitsDialog() {
  showDialog(
    `<h2 class="dialog-title">Global transfer limits</h2><form id="transfer-limits-form"><div class="form-row">${field("Download · KiB/s", input("downloadLimit", (data.transfer.dl_rate_limit || 0) / 1024, "number", 'min="0"'))}${field("Upload · KiB/s", input("uploadLimit", (data.transfer.up_rate_limit || 0) / 1024, "number", 'min="0"'))}</div><p class="section-note">Use 0 for unlimited. Existing per-torrent seeding rules remain in effect.</p>${button("Save limits", 'type="submit"', true)}</form>`,
  );
}
function queueDialog(key) {
  const [name, id] = key.split(":");
  const item = data.queue.find(
    (q) => q.service === name && q.id === Number(id),
  );
  showDialog(
    `<h2 class="dialog-title">Resolve import</h2><h3>${esc(item.title)}</h3><p class="section-note">${esc((item.statusMessages || []).flatMap((m) => m.messages || []).join("; ") || item.status)}</p><div class="inline-actions">${button("Retry import scan", `data-command="${name}:${name === "radarr" ? "DownloadedMoviesScan" : "DownloadedEpisodesScan"}"`)}${button("Remove from queue", `data-queue-remove="${key}"`)}</div><p class="section-note">Removing the queue entry leaves the download client and files untouched.</p>`,
  );
}

function requestsView() {
  const list = viewData.results || [];
  const requestStatus = { 1: "Pending", 2: "Approved", 3: "Declined", 4: "Failed", 5: "Completed" };
  const mediaStatus = {
    1: "Unknown",
    2: "Pending",
    3: "Processing",
    4: "Partially available",
    5: "Available",
    6: "Blocked",
    7: "Deleted",
  };
  return (
    title(
      "Requests",
      "Review requests and follow them into the library.",
      button("Request media", 'data-new-request="true"', true),
    ) +
    deckNotice(viewData.errors) +
    `<div class="toolbar"><div class="segmented">${[
      ["all", "All"],
      ["pending", "Pending"],
      ["approved", "Approved"],
      ["available", "Available"],
      ["failed", "Failed"],
      ["declined", "Declined"],
    ]
      .map(
        ([key, label]) =>
          `<button data-request-filter="${key}" class="${requestFilter === key ? "selected" : ""}">${label}</button>`,
      )
      .join(
        "",
      )}</div><span class="small muted">${viewData.pageInfo?.results || list.length} requests</span></div>` +
    panel(
      "Requests",
      list.length
        ? list
            .map(
              (r) =>
                `<article class="request-card"><div><h2>${esc(r.title)}</h2><p>${esc(r.year)} · ${r.type === "tv" ? "Series" : "Movie"} · Requested by ${esc(r.requestedBy)}</p><p class="request-description">${esc(r.overview)}</p><div class="language-chips">${chip(requestStatus[r.status] || "Unknown")}${chip(mediaStatus[r.mediaStatus] || "Unknown", r.mediaStatus === 5)}</div></div><div class="inline-actions">${r.status === 1 ? button("Approve", `data-request="${r.id}" data-operation="approve"`, true) + button("Decline", `data-request="${r.id}" data-operation="decline"`) : r.status === 4 ? button("Retry", `data-request="${r.id}" data-operation="retry"`) : ""}</div></article>`,
            )
            .join("")
        : empty(
            "No requests here",
            "Add media directly with the button above.",
          ),
    )
  );
}

function connectionRows(items, type, name) {
  return table(
    ["Connection", "Status", ""],
    (items || []).map((item) =>
      row([
        `<strong>${esc(item.name)}</strong><small>${esc(item.implementation || item.protocol || "")}</small>`,
        item.enable === undefined
          ? chip("Configured", true)
          : chip(item.enable ? "Enabled" : "Disabled", item.enable),
        `<div class="inline-actions">${button("Test", `data-connection-test="${name}:${type}:${item.id}"`)}${button("Edit", `data-connection-edit="${name}:${type}:${item.id}"`)}</div>`,
      ]),
    ),
  );
}
function serviceDetail(name) {
  const detail = viewData,
    live = service(name);
  let content = "";
  if (["radarr", "sonarr", "prowlarr"].includes(name)) {
    content = (detail.errors || [])
      .map(
        (error) =>
          `<div class="notice">${esc(error.section)}: ${esc(error.message)}</div>`,
      )
      .join("");
    content += panel(
      "Health checks",
      detail.health?.length
        ? detail.health
            .map(
              (h) =>
                `<div class="health-row"><span class="health-icon">!</span><div><h3>${esc(h.type)}</h3><p>${esc(h.message)}</p></div></div>`,
            )
            .join("")
        : empty("No warnings", "This service reports healthy configuration."),
    );
    content += `<div class="shelf-head"><h2>Connections</h2></div><div class="settings-grid">${panel("Indexers", connectionRows(detail.indexers, "indexer", name))}${panel("Download clients", connectionRows(detail.connections, "downloadclient", name))}</div>`;
    if (name === "prowlarr")
      content += `<div class="shelf-head"><h2>Applications</h2></div>${panel("Library connections", connectionRows(detail.applications, "applications", name), button("Sync indexers", 'data-command="prowlarr:ApplicationIndexerSync"'))}`;
    if (detail.profiles)
      content += `<div class="shelf-head"><h2>Library configuration</h2></div><div class="settings-grid">${panel(
        "Quality profiles",
        table(
          ["Profile", "Upgrades", ""],
          detail.profiles.map((p) =>
            row([
              esc(p.name),
              p.upgradeAllowed ? "Allowed" : "Disabled",
              button("Edit", `data-profile-edit="${name}:${p.id}"`),
            ]),
          ),
        ),
      )}${panel(
        "Root folders",
        table(
          ["Folder", "Free space"],
          (detail.roots || []).map((root) =>
            row([
              `<span class="file-path">${esc(root.path)}</span>`,
              bytes(root.freeSpace),
            ]),
          ),
        ),
      )}</div>`;
    content += `<div class="shelf-head"><h2>Scheduled work</h2></div>${panel(
      "Tasks",
      table(
        ["Task", "Last run", "Next run", ""],
        (detail.tasks || []).map((task) =>
          row([
            esc(task.name),
            task.lastExecution ? ago(task.lastExecution) : "—",
            task.nextExecution
              ? new Date(task.nextExecution).toLocaleString()
              : "—",
            task.canRun
              ? button(
                  "Run now",
                  `data-command="${name}:${esc(task.taskName)}"`,
                )
              : '<span class="muted small">Scheduled</span>',
          ]),
        ),
      ),
    )}`;
    content += `<div class="shelf-head"><h2>Recent service commands</h2></div>${panel(
      "Commands",
      table(
        ["Command", "Status", "Details"],
        (detail.commands || [])
          .slice(-20)
          .reverse()
          .map((c) =>
            row([
              esc(c.name),
              chip(c.status, c.status === "completed"),
              esc(c.message || (c.started ? ago(c.started) : "")),
            ]),
          ),
      ),
    )}`;
    content += `<div class="shelf-head"><h2>Service log</h2></div>${panel(
      "Recent entries",
      table(
        ["Level", "Message", "When"],
        (detail.logs?.records || []).map((log) =>
          row([
            esc(log.level),
            `<span class="log-message">${esc(log.message)}</span>`,
            esc(new Date(log.time).toLocaleString()),
          ]),
        ),
      ),
    )}`;
  } else if (name === "bazarr") {
    content =
      panel(
        "Live Bazarr queue",
        table(
          ["Job", "Status", "Progress"],
          (detail.queue || [])
            .slice(-20)
            .reverse()
            .map((job) =>
              row([
                esc(job.job_name),
                chip(job.status, job.status === "completed"),
                `${esc(job.progress_message || "")}${job.progress_max ? "<small>" + Math.round((job.progress_value / job.progress_max) * 100) + "%</small>" : ""}`,
              ]),
            ),
        ),
      ) +
      '<div class="shelf-head"><h2>Providers</h2></div>' +
      panel(
        "Subtitle providers",
        table(
          ["Provider", "Status", "Retry"],
          detail.providers.map((p) =>
            row([
              esc(p.name),
              chip(p.status, p.status === "Good"),
              esc(p.retry),
            ]),
          ),
        ),
      ) +
      `<div class="shelf-head"><h2>Scheduled work</h2></div>` +
      panel(
        "Subtitle tasks",
        table(
          ["Task", "Schedule", "Status", ""],
          detail.tasks.map((t) =>
            row([
              esc(t.name),
              `${esc(t.interval)}<small>${esc(t.next_run_time)}</small>`,
              chip(t.job_running ? "Running" : "Idle"),
              button("Run now", `data-bazarr-task="${esc(t.job_id)}"`),
            ]),
          ),
        ),
      ) +
      `<div class="shelf-head"><h2>Language profiles</h2></div>` +
      panel(
        "Configured profiles",
        table(
          ["Profile", "Languages", "Cutoff"],
          detail.profiles.map((p) =>
            row([
              esc(p.name),
              p.items
                .map((i) =>
                  chip(
                    i.language.toUpperCase() +
                      (i.forced === "True" ? " · Forced" : "") +
                      (i.hi === "True" ? " · HI" : ""),
                  ),
                )
                .join(" "),
              esc(p.cutoff ?? "All required languages"),
            ]),
          ),
        ),
      ) +
      `<div class="shelf-head"><h2>Recent subtitles</h2></div>` +
      panel("History", historyTable(detail.history));
  } else if (name === "qbittorrent") {
    content =
      `<div class="metrics"><div class="metric"><div class="metric-label">Download</div><div class="metric-number">${speed(detail.transfer.dl_info_speed)}</div></div><div class="metric"><div class="metric-label">Upload</div><div class="metric-number">${speed(detail.transfer.up_info_speed)}</div></div><div class="metric"><div class="metric-label">Connection</div><div class="metric-number small-metric">${esc(detail.transfer.connection_status)}</div></div></div>` +
      panel(
        "Transfer limits",
        `<form id="transfer-limits-form" class="panel-body"><div class="form-row">${field("Download · KiB/s (0 = unlimited)", input("downloadLimit", detail.preferences.dl_limit / 1024, "number", 'min="0"'))}${field("Upload · KiB/s (0 = unlimited)", input("uploadLimit", detail.preferences.up_limit / 1024, "number", 'min="0"'))}</div>${button("Save limits", 'type="submit"', true)}</form>`,
      ) +
      `<div class="shelf-head"><h2>Categories & seeding</h2></div>` +
      panel(
        "Categories",
        table(
          ["Category", "Save path"],
          Object.entries(detail.categories).map(([name, c]) =>
            row([esc(name), esc(c.savePath)]),
          ),
        ),
      ) +
      `<div class="panel-note">Global seeding ratio: ${detail.preferences.max_ratio} · Time limit: ${detail.preferences.max_seeding_time} minutes · Maximum active downloads: ${detail.preferences.max_active_downloads}</div><div class="shelf-head"><h2>Recent events</h2></div>` +
      panel(
        "Download client log",
        table(
          ["Event", "When"],
          detail.logs.map((log) =>
            row([
              esc(log.message),
              esc(new Date(log.timestamp * 1000).toLocaleString()),
            ]),
          ),
        ),
      );
  } else if (name === "seerr") {
    content =
      `<div class="activity-stats">${Object.entries(detail.count)
        .filter(([, v]) => typeof v === "number")
        .map(
          ([key, value]) =>
            `<div><strong>${value}</strong><span>${esc(key)}</span></div>`,
        )
        .join("")}</div>` +
      panel(
        "Manage requests",
        `<div class="panel-body"><p class="muted">Approve, decline, and follow requests through processing and availability.</p><a class="button primary" href="#requests">View requests</a></div>`,
      );
  } else if (name === "jellyfin") {
    content = !detail.configured
      ? `<div class="notice">${esc(detail.message)}</div>`
      : panel(
          "Libraries",
          table(
            ["Library", "Folders"],
            detail.libraries.map((l) =>
              row([esc(l.Name), l.Locations.map(esc).join("<br>")]),
            ),
          ),
          button("Scan libraries", 'data-jellyfin-scan="true"'),
        ) +
        `<div class="shelf-head"><h2>Playback & devices</h2></div>` +
        panel(
          "Active sessions",
          detail.sessions.length
            ? table(
                ["User", "Device", "Playing", "Controls"],
                detail.sessions.map((s) =>
                  row([
                    esc(s.UserName),
                    `${esc(s.DeviceName)}<small>${esc(s.Client)}</small>`,
                    esc(s.NowPlayingItem?.Name || "Idle"),
                    s.NowPlayingItem
                      ? button(
                          s.PlayState?.IsPaused ? "Resume" : "Pause",
                          `data-playback="${s.Id}" data-operation="${s.PlayState?.IsPaused ? "Unpause" : "Pause"}"`,
                        ) +
                        button(
                          "Stop",
                          `data-playback="${s.Id}" data-operation="Stop"`,
                        )
                      : "—",
                  ]),
                ),
              )
            : empty(
                "No active sessions",
                "Connected devices and playback appear here.",
              ),
        ) +
        `<div class="shelf-head"><h2>Scheduled work</h2></div>` +
        panel(
          "Jellyfin tasks",
          table(
            ["Task", "Status", ""],
            detail.tasks.map((t) =>
              row([
                esc(t.Name),
                chip(t.State),
                button("Run now", `data-jellyfin-task="${esc(t.Id)}"`),
              ]),
            ),
          ),
        ) +
        `<div class="shelf-head"><h2>Activity</h2></div>` +
        panel(
          "Server activity",
          table(
            ["Event", "When"],
            (detail.activity.Items || []).map((a) =>
              row([esc(a.Name), esc(new Date(a.Date).toLocaleString())]),
            ),
          ),
        );
  }
  return (
    `<a class="text-link back-link" href="#services">${icon("back")}Services</a>` +
    title(
      esc(live.name),
      `${esc(live.version)} · ${live.latency || "—"}ms response`,
      status(live),
    ) +
    content
  );
}
async function connectionDialog(key) {
  const [name, type, id] = key.split(":");
  const item = await get(
    "connection?" + new URLSearchParams({ service: name, type, id }),
  );
  const fields = item.fields.filter(
    (f) => !["hidden", "info", "button"].includes(f.type),
  );
  showDialog(
    `<h2 class="dialog-title">${esc(item.name)}</h2><form id="connection-form" data-key="${key}"><div class="form-row">${field("Name", input("name", item.name))}${item.priority !== undefined ? field("Priority", input("priority", item.priority, "number", 'min="1" max="50"')) : ""}</div>${item.enable !== undefined ? `<label class="checkbox"><input name="enable" type="checkbox" ${item.enable ? "checked" : ""}> Enabled</label>` : ""}<div class="connection-fields">${fields
      .map((f) => {
        const value = f.value ?? "";
        let html;
        if (f.secret)
          html = input(
            "field-" + f.name,
            "",
            "password",
            'placeholder="Leave blank to keep existing value" autocomplete="off"',
          );
        else if (f.type === "checkbox")
          html = `<input type="checkbox" name="field-${esc(f.name)}" ${value ? "checked" : ""}>`;
        else if (f.type === "select" && f.selectOptions)
          html = select(
            "field-" + f.name,
            f.selectOptions.map((o) => ({ value: o.value, label: o.name })),
            value,
          );
        else if (Array.isArray(value))
          html = input(
            "field-" + f.name,
            value.join(","),
            "text",
            'data-array="true"',
          );
        else
          html = input(
            "field-" + f.name,
            value,
            f.type === "number" ? "number" : "text",
          );
        return field(esc(f.label || f.name), html);
      })
      .join(
        "",
      )}</div>${button("Save connection", 'type="submit"', true)}<p class="section-note">Existing secrets are preserved when left blank.</p></form>`,
  );
}
function qualityProfileDialog(key) {
  const [name, id] = key.split(":");
  const profile = viewData.profiles.find((p) => p.id === Number(id));
  const options = profile.items
    .map((i) => ({
      value: i.items?.length ? i.id : i.quality?.id,
      label: i.name || i.quality?.name,
    }))
    .filter((i) => i.value !== undefined);
  showDialog(
    `<h2 class="dialog-title">Quality profile</h2><form id="quality-profile-form" data-key="${key}"><div class="form-row">${field("Name", input("name", profile.name))}${field("Upgrade cutoff", select("cutoff", options, profile.cutoff))}</div><label class="checkbox"><input type="checkbox" name="upgradeAllowed" ${profile.upgradeAllowed ? "checked" : ""}> Allow quality upgrades</label><div class="rail-label">CURRENT QUALITY ORDER</div><div class="language-chips">${profile.items
      .filter((i) => i.allowed)
      .map((i) => chip(i.name || i.quality?.name, true))
      .join(
        " ",
      )}</div><p class="section-note">Applies to every title using this profile. The existing quality order and custom format rules are retained.</p>${button("Save profile", 'type="submit"', true)}</form>`,
  );
}

async function render() {
  const id = ++renderId;
  renderNav();
  if (!data) return;
  const main = $("#main");
  const parts = route.split("/");
  if (route === "overview") {
    main.innerHTML = overview();
    hideBrokenImages();
    return;
  }
  if (route === "library") {
    main.innerHTML = libraryView();
    filterLibrary();
    hideBrokenImages();
    return;
  }
  if (route === "downloads") {
    main.innerHTML = downloads();
    return;
  }
  if (route === "services") {
    main.innerHTML = servicesView();
    return;
  }
  if (route === "activity") {
    renderActivity();
    return;
  }
  const endpoints = {
    subtitles: "subtitle-library",
    requests: "requests?filter=" + requestFilter,
    calendar: "calendar",
  };
  let endpoint = endpoints[route];
  if (parts[0] === "media")
    endpoint =
      "media?" + new URLSearchParams({ service: parts[1], id: parts[2] });
  if (parts[0] === "service") endpoint = "service-detail?service=" + parts[1];
  if (parts[0] === "subtitles" && parts[1])
    endpoint =
      parts[1] === "series"
        ? "subtitle-episodes?id=" + parts[2]
        : "subtitle-detail?" +
          new URLSearchParams({ kind: parts[1], id: parts[2] });
  if (!endpoint) {
    location.hash = "overview";
    return;
  }
  main.innerHTML = loading();
  try {
    const result = await get(endpoint);
    if (id !== renderId) return;
    viewData = result;
    if (parts[0] === "subtitles" && ["movie", "episode"].includes(parts[1]) && !subtitleSearches.has(parts[1] + ":" + parts[2])) {
      const saved = await get("subtitle-search?" + new URLSearchParams({ kind: parts[1], id: parts[2] }));
      if (id !== renderId) return;
      if (saved) subtitleSearches.set(parts[1] + ":" + parts[2], saved);
    }
    if (route === "subtitles") {
      main.innerHTML = subtitleLibraryView();
      filterSubtitles();
    } else if (parts[0] === "subtitles" && parts[1] === "series") {
      const show = data.library.find(
        (m) => m.service === "sonarr" && m.id === Number(parts[2]),
      );
      main.innerHTML =
        `<a class="text-link back-link" href="#subtitles">${icon("back")}All subtitles</a>` +
        title(
          esc(show?.title || "Series subtitles"),
          "Choose an episode to manage its subtitle tracks.",
        ) +
        panel(
          "Episodes",
          table(
            ["Episode", "Tracks", "Missing", ""],
            (result.data || []).map((e) =>
              row([
                `S${e.season} · E${e.episode} · ${esc(e.title)}`,
                (e.subtitles || [])
                  .map((t) => chip(t.name || t.code2, true))
                  .join(" "),
                (e.missing_subtitles || [])
                  .map((t) => chip(t.name || t.code2))
                  .join(" "),
                button(
                  "Manage",
                  `data-subtitle-detail="episode:${e.sonarrEpisodeId}"`,
                ),
              ]),
            ),
          ),
        );
    } else if (parts[0] === "subtitles")
      main.innerHTML = subtitlePage(parts[1], parts[2]);
    else if (parts[0] === "media")
      main.innerHTML = mediaPage(parts[1], parts[2]);
    else if (parts[0] === "service") main.innerHTML = serviceDetail(parts[1]);
    else if (route === "requests") main.innerHTML = requestsView();
    else if (route === "calendar") {
      const groups = {};
      const calendar = result.items || result;
      calendar.forEach((item) =>
        (groups[new Date(item.date).toDateString()] ??= []).push(item),
      );
      main.innerHTML =
        title("Calendar", "Upcoming episodes and releases · next 14 days") + deckNotice(result.errors) +
        panel(
          "Upcoming",
          calendar.length
            ? Object.entries(groups)
                .map(
                  ([day, items]) =>
                    `<div class="calendar-day"><div class="calendar-date">${date(day)}<div class="small muted">${new Date(day).toLocaleDateString(undefined, { weekday: "long" })}</div></div><div class="calendar-items">${items.map((item) => `<div class="calendar-item"><div><h3>${esc(item.title)}</h3><p>${esc(item.detail)}</p></div><button class="text-link" data-detail="${item.service}:${item.id}">Manage</button></div>`).join("")}</div></div>`,
                )
                .join("")
            : empty(
                "A quiet fortnight",
                "No upcoming releases in your tracked collection.",
              ),
        );
    }
    hideBrokenImages();
  } catch (error) {
    if (id === renderId)
      main.innerHTML = `<div class="error-box"><h2>Could not load these details</h2><p>${esc(error.message)}</p>${button("Try again", 'data-retry-view="true"')}</div>`;
  }
}
async function refresh(showToast = true) {
  if (refreshing) return;
  refreshing = true;
  $("#refresh").disabled = true;
  try {
    [data, monitorData] = await Promise.all([get("overview"), get("monitor")]);
    $("#updated").textContent =
      "Live · " +
      new Date(data.updated).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      });
    $("#host-led").className =
      "led" + (data.services.every((s) => !s.online) ? " off" : "");
    await render();
    if (showToast) toast("Stack updated");
  } catch (error) {
    if (!data)
      $("#main").innerHTML =
        `<div class="error-box"><h2>Could not reach your stack</h2><p>${esc(error.message)}</p>${button("Try again", 'id="retry"')}</div>`;
    else toast(error.message, true);
  } finally {
    refreshing = false;
    $("#refresh").disabled = false;
  }
}
let requestSearchState = { query: "", page: 1, pages: 1, results: [] }, selectedRequest = null;
function requestDialog(reset = true) {
  if (reset) requestSearchState = { query: "", page: 1, pages: 1, results: [] };
  selectedRequest = null;
  showDialog(`<h2 class="dialog-title">Request media</h2><p class="muted">Find a movie or series to request through Seerr.</p><form id="request-search-form" class="toolbar"><input class="search" name="query" id="request-query" placeholder="Search movies and series" aria-label="Search movies and series" required minlength="2" maxlength="200" value="${esc(requestSearchState.query)}"><button class="button primary" type="submit">Search</button></form><div id="request-search-results" class="search-results"></div>`);
  renderRequestSearch();
  $("#request-query").focus();
}
function renderRequestSearch() {
  const root = $("#request-search-results");
  if (!root) return;
  root.innerHTML = requestSearchState.results.map(m => `<button class="search-result" data-request-title="${m.type}:${m.id}"><span>${esc(m.title)}<small>${esc(m.year)} · ${m.type === "tv" ? "Series" : "Movie"}</small></span><span class="small muted">${esc(m.status)} · Select</span></button>`).join("") + (requestSearchState.query && !requestSearchState.results.length ? '<p class="muted">No titles on this page. Try another search or page.</p>' : "") + (requestSearchState.pages > 1 ? `<div class="inline-actions"><button class="button" data-request-page="${requestSearchState.page - 1}" ${requestSearchState.page <= 1 ? "disabled" : ""}>Previous</button><span class="small muted">Page ${requestSearchState.page} of ${requestSearchState.pages}</span><button class="button" data-request-page="${requestSearchState.page + 1}" ${requestSearchState.page >= requestSearchState.pages ? "disabled" : ""}>Next</button></div>` : "");
}
async function searchRequests(query, page = 1) {
  const root = $("#request-search-results");
  if (!root) return;
  root.innerHTML = '<p class="muted">Searching…</p>';
  const result = await get("request-search?" + new URLSearchParams({ q: query, page }));
  if (!root.isConnected) return;
  requestSearchState = { ...result, query };
  renderRequestSearch();
}
async function requestTitle(key, target) {
  target.disabled = true;
  try {
    const [type, id] = key.split(":");
    const item = await get("request-details?" + new URLSearchParams({ type, id }));
    if (!target.isConnected || !$("#dialog").open) return;
    selectedRequest = item;
    const requestable = item.type === "tv" ? item.seasons.some(s => s.canRequest) : item.canRequest;
    showDialog(`<h2 class="dialog-title">${esc(item.title)}</h2><p class="small muted">${esc(item.year)} · ${item.type === "tv" ? "Series" : "Movie"} · ${esc(item.status)}</p><p class="request-description">${esc(item.overview)}</p><form id="request-create-form">${item.type === "tv" ? `<h3 class="subheading">Choose seasons</h3><div class="episode-choices">${item.seasons.map(s => `<label class="checkbox"><input type="checkbox" name="season" value="${s.number}" ${s.canRequest ? s.number > 0 ? "checked" : "" : "disabled"}> ${esc(s.name)} · ${s.episodes} episodes · ${esc(s.status)}</label>`).join("")}</div>` : ""}<p class="section-note">Requested as ${esc(item.requester)}. Uses your Seerr approval rules, quality profiles, and library folders. Approved requests may start downloads.</p>${requestable ? button(item.type === "tv" ? "Request selected seasons" : "Request movie", 'type="submit"', true) : '<p class="notice">Already requested or available.</p>'}${button("Back to search", 'type="button" data-request-back="true"')}<div id="request-form-error" role="alert"></div></form>`);
  } finally { if (target.isConnected) target.disabled = false; }
}
function addDialog() {
  selectedAdd = null;
  showDialog(
    `<h2 class="dialog-title">Add to your collection</h2><div class="segmented"><button data-add-type="radarr" class="${addService === "radarr" ? "selected" : ""}">Movie</button><button data-add-type="sonarr" class="${addService === "sonarr" ? "selected" : ""}">Series</button></div><form id="lookup-form" class="toolbar" style="margin:20px 0 0"><input class="search" id="lookup-query" placeholder="Search for a title" aria-label="Search for a title" required minlength="2"><button class="button primary">Search</button></form><div id="lookup-results" class="search-results"></div>`,
  );
  $("#lookup-query").focus();
}
async function lookup(e) {
  e.preventDefault();
  const q = $("#lookup-query").value.trim();
  if (q.length < 2) return;
  $("#lookup-results").innerHTML = '<p class="muted small">Searching…</p>';
  try {
    const found = await get(
      `lookup?service=${addService}&q=${encodeURIComponent(q)}`,
    );
    window.lookupResults = found;
    $("#lookup-results").innerHTML = found.length
      ? found
          .slice(0, 15)
          .map(
            (m, i) =>
              `<button class="search-result" data-add-result="${i}"><span>${esc(m.title)}<small>${esc(m.year || "")}</small></span><span class="small muted">${m.id ? "In library" : "Select"}</span></button>`,
          )
          .join("")
      : empty(
          "No titles found",
          "Try the original title or include the year.",
          "⌕",
        );
  } catch (e) {
    $("#lookup-results").innerHTML = `<p class="notice">${esc(e.message)}</p>`;
  }
}
async function selectAdd(i) {
  selectedAdd = window.lookupResults[Number(i)];
  if (selectedAdd.id) {
    details(addService + ":" + selectedAdd.id);
    return;
  }
  try {
    const options = await get("options?service=" + addService);
    if (!options.roots.length || !options.profiles.length)
      throw Error(
        "Set a root folder and quality profile in " +
          service(addService).name +
          " first",
      );
    showDialog(
      `<h2 class="dialog-title">Add ${addService === "radarr" ? "movie" : "series"}</h2><div class="result-selected"><h3>${esc(selectedAdd.title)}</h3><p class="small muted">${esc(selectedAdd.year || "")}</p></div><form id="add-form"><div class="form-row"><label>Quality profile<select id="add-profile">${options.profiles.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("")}</select></label><label>Library folder<select id="add-root">${options.roots.map((p) => `<option value="${esc(p.path)}">${esc(p.path)} · ${bytes(p.freeSpace)} free</option>`).join("")}</select></label></div><label class="checkbox"><input id="add-search" type="checkbox" checked> Search for releases after adding</label><p class="small muted" style="margin-bottom:20px">Uses your existing ${esc(service(addService).name)} profiles, indexers, and download client.</p><button class="button primary">Add to library</button><button type="button" class="button" id="back-add">Back</button></form>`,
    );
  } catch (e) {
    toast(e.message, true);
  }
}

function formObject(form) {
  return Object.fromEntries(
    [...new FormData(form)].map(([key, value]) => [key, value]),
  );
}
async function afterAction(body, buttonElement, rerender = true) {
  if (!body.label && body.id && body.service) {
    const item = data.library.find(
      (m) => m.service === body.service && m.id === Number(body.id),
    );
    if (item)
      body.label =
        item.title +
        " · " +
        (body.action === "mediaSettings"
          ? "Save library settings"
          : body.name?.replace(/([a-z])([A-Z])/g, "$1 $2") || body.action);
  }
  const result = await action(body, "", buttonElement);
  if (result) viewDirty = false;
  if (result && rerender) await render();
  return result;
}
document.addEventListener("click", async (event) => {
  const target = event.target.closest("button,a");
  if (!target) return;
  const values = target.dataset;
  try {
    if (values.newRequest) requestDialog();
    else if (values.requestBack) requestDialog(false);
    else if (values.requestTitle) await requestTitle(values.requestTitle, target);
    else if (values.requestPage) await searchRequests(requestSearchState.query, Number(values.requestPage));
    else if (values.dialogClose) $("#dialog").close();
    else if (values.app) {
      $("#dialog").close();
      location.hash = "service/" + values.app;
    } else if (values.detail) details(values.detail);
    else if (values.subtitleDetail) {
      detailTab = "tracks";
      location.hash = "subtitles/" + values.subtitleDetail.replace(":", "/");
    } else if (values.filter) {
      libraryFilter = values.filter;
      document.querySelectorAll("[data-filter]").forEach((x) => {
        x.classList.toggle("selected", x === target);
        x.setAttribute("aria-pressed", x === target);
      });
      filterLibrary();
      hideBrokenImages();
    } else if (values.subtitleType) {
      subtitleType = values.subtitleType;
      await render();
    } else if (values.tab) {
      detailTab = values.tab;
      $("#main").innerHTML = route.startsWith("subtitles/")
        ? subtitlePage(...route.split("/").slice(1))
        : mediaPage(...route.split("/").slice(1));
      hideBrokenImages();
    } else if (values.subtitleOperation)
      await runSubtitle(values.subtitleOperation, target);
    else if (values.subtitleDownload !== undefined) {
      const [, kind, id] = route.split("/");
      const search = subtitleSearches.get(kind + ":" + id);
      await runSubtitle("download", target, {
        token: search.token,
        index: Number(values.subtitleDownload),
      });
    } else if (values.subtitleRestore)
      await runSubtitle("restore", target, {
        backupId: values.subtitleRestore,
      });
    else if (values.subtitleEdit !== undefined)
      await subtitleEditor(Number(values.subtitleEdit));
    else if (values.subtitleUpload) uploadSubtitleDialog();
    else if (values.subtitleSync !== undefined) {
      const track = viewData.item.subtitles.filter((t) => t.path)[
        Number(values.subtitleSync)
      ];
      showDialog(
        `<h2 class="dialog-title">Synchronize timing</h2><p class="muted">Align ${esc(track.name)} subtitles with this video’s audio.</p><form id="subtitle-sync-form" data-path="${esc(track.path)}"><div class="form-row">${field("Maximum offset · seconds", input("maxOffset", 60, "number", 'min="1" max="600"'))}</div>${button("Synchronize subtitle", 'type="submit"', true)}</form>`,
      );
    } else if (values.subtitleDelete !== undefined) {
      const track = viewData.item.subtitles.filter((t) => t.path)[
        Number(values.subtitleDelete)
      ];
      showDialog(
        `<h2 class="dialog-title">Remove subtitle?</h2><p class="muted">This removes ${esc(track.path.split(/[\\/]/).pop())} from disk. The video stays in your library.</p>${button("Remove subtitle", `data-confirm-subtitle-delete="${esc(track.path)}"`)}`,
      );
    } else if (values.confirmSubtitleDelete) {
      $("#dialog").close();
      await runSubtitle("delete", target, {
        path: values.confirmSubtitleDelete,
      });
    } else if (values.command) {
      const [service, name] = values.command.split(":");
      await afterAction(
        {
          action: "command",
          service,
          name,
          ...(values.id ? { id: Number(values.id) } : {}),
        },
        target,
      );
    } else if (values.mediaReleases) await mediaReleases();
    else if (values.episodeReleases)
      await mediaReleases(values.episodeReleases);
    else if (values.releaseForce !== undefined) forceReleaseDialog(values.releaseForce);
    else if (values.releaseClear) {
      showDialog(`<h2 class="dialog-title">Clear selected release?</h2><p class="section-note">This keeps your files and downloads. It restores the movie’s monitoring setting from before the selection, allowing automatic searches again if monitoring was enabled.</p>${button("Clear selection", `data-confirm-release-clear="${values.releaseClear}"`, true)}${button("Keep selection", 'data-dialog-close="true"')}`);
    } else if (values.confirmReleaseClear) {
      if (await afterAction({ action: "clearReleaseChoice", service: "radarr", id: Number(values.confirmReleaseClear) }, target, false)) { $("#dialog").close(); await render(); }
    } else if (values.releaseDownload !== undefined) {
      await afterAction(
        {
          action: "grabRelease",
          service: route.split("/")[1],
          token: viewData.releases.token,
          id: Number(route.split("/")[2]),
          index: Number(values.releaseDownload),
        },
        target,
        false,
      );
    } else if (values.seasonSearch !== undefined)
      await afterAction(
        {
          action: "command",
          service: "sonarr",
          name: "SeasonSearch",
          id: Number(route.split("/")[2]),
          seasonNumber: Number(values.seasonSearch),
        },
        target,
      );
    else if (values.torrentDetail) await torrentDialog(values.torrentDetail);
    else if (values.torrent)
      await afterAction(
        {
          action: "torrent",
          operation: values.operation,
          hash: values.torrent,
        },
        target,
        !$("#dialog").open,
      );
    else if (values.limits) limitsDialog();
    else if (values.removeTorrent)
      showDialog(
        `<h2 class="dialog-title">Remove torrent?</h2><p class="muted">Choose whether to keep the downloaded files.</p><label class="checkbox"><input id="delete-torrent-files" type="checkbox"> Also delete downloaded files</label>${button("Remove torrent", `data-confirm-torrent-delete="${values.removeTorrent}"`)}`,
      );
    else if (values.confirmTorrentDelete) {
      const deleteFiles = $("#delete-torrent-files").checked;
      $("#dialog").close();
      await afterAction(
        {
          action: "torrent",
          operation: "delete",
          hash: values.confirmTorrentDelete,
          deleteFiles,
        },
        target,
      );
    } else if (values.queue) queueDialog(values.queue);
    else if (values.queueRemove) {
      const [service, id] = values.queueRemove.split(":");
      $("#dialog").close();
      await afterAction(
        {
          action: "queueRemove",
          service,
          id: Number(id),
          removeFromClient: false,
          blocklist: false,
        },
        target,
      );
    } else if (values.imports) location.hash = "downloads";
    else if (values.requestFilter) {
      requestFilter = values.requestFilter;
      await render();
    } else if (values.request)
      await afterAction(
        {
          action: "request",
          id: Number(values.request),
          operation: values.operation,
        },
        target,
      );
    else if (values.connectionEdit)
      await connectionDialog(values.connectionEdit);
    else if (values.connectionTest) {
      const [service, type, id] = values.connectionTest.split(":");
      await afterAction(
        {
          action: "connection",
          service,
          type,
          id: Number(id),
          operation: "test",
        },
        target,
        false,
      );
    } else if (values.profileEdit) qualityProfileDialog(values.profileEdit);
    else if (values.bazarrTask)
      await afterAction(
        { action: "bazarrTask", taskId: values.bazarrTask },
        target,
      );
    else if (values.playback)
      await afterAction(
        {
          action: "jellyfinPlayback",
          service: "jellyfin",
          id: values.playback,
          operation: values.operation,
        },
        target,
      );
    else if (values.jellyfinScan)
      await afterAction(
        { action: "jellyfinScan", service: "jellyfin" },
        target,
      );
    else if (values.jellyfinTask)
      await afterAction(
        {
          action: "jellyfinTask",
          service: "jellyfin",
          id: values.jellyfinTask,
        },
        target,
      );
    else if (values.retryView) await render();
    else if (values.addType) {
      addService = values.addType;
      addDialog();
    } else if (values.addResult !== undefined) selectAdd(values.addResult);
    else if (["add", "add-native", "back-add"].includes(target.id)) addDialog();
    else if (["refresh", "retry"].includes(target.id)) await refresh();
    else if (target.id === "menu" || target.id === "menu-more") {
      const open = $(".sidebar").classList.toggle("open");
      $("#menu").setAttribute("aria-expanded", String(open));
    } else if (target.classList.contains("close-dialog")) $("#dialog").close();
  } catch (error) {
    toast(error.message, true);
  }
});
document.addEventListener("input", (event) => {
  if (event.target.closest("form")) viewDirty = true;
  if (event.target.id === "library-search") {
    libraryQuery = event.target.value;
    filterLibrary();
    hideBrokenImages();
  }
  if (event.target.id === "subtitle-query") {
    subtitleQuery = event.target.value;
    filterSubtitles();
  }
});
document.addEventListener("change", async (event) => {
  const target = event.target;
  if (target.closest("form")) viewDirty = true;
  if (target.id === "library-status") {
    libraryStatus = target.value;
    filterLibrary();
    hideBrokenImages();
  } else if (target.id === "library-sort") {
    librarySort = target.value;
    filterLibrary();
    hideBrokenImages();
  } else if (target.id === "subtitle-filter") {
    subtitleFilter = target.value;
    filterSubtitles();
  } else if (target.dataset.episodeMonitor) {
    const value = target.checked;
    if (
      !(await afterAction(
        {
          action: "episodeMonitor",
          service: "sonarr",
          ids: [Number(target.dataset.episodeMonitor)],
          monitored: value,
        },
        target,
        false,
      ))
    )
      target.checked = !value;
  } else if (target.dataset.filePriority) {
    const [hash, fileId] = target.dataset.filePriority.split(":");
    const previous = target.dataset.previousPriority || target.querySelector("option[selected]")?.value;
    const changed = await afterAction(
      {
        action: "torrent",
        operation: "priority",
        hash,
        fileId: Number(fileId),
        priority: Number(target.value),
      },
      target,
      false,
    );
    if (!changed) target.value = previous; else target.dataset.previousPriority = target.value;
  }
});
document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (form.id === "lookup-form") return lookup(event);
  if (form.id === "request-search-form") {
    event.preventDefault();
    const submit = form.querySelector("button"); submit.disabled = true;
    try { await searchRequests(form.elements.query.value.trim()); }
    catch (error) { if ($("#request-search-results")) $("#request-search-results").innerHTML = `<p class="error-text">${esc(error.message)}</p>`; }
    finally { if (submit.isConnected) submit.disabled = false; }
    return;
  }
  event.preventDefault();
  const values = formObject(form),
    submit =
      form.querySelector('button[type="submit"]') ||
      form.querySelector("button");
  try {
    if (form.id === "force-release-form") {
      if (!forceRelease) throw Error("Search releases again");
      if (await afterAction({ ...forceRelease, includedSubtitles: form.elements.includedSubtitles.checked }, submit, false)) { $("#dialog").close(); forceRelease = null; detailTab = "journey"; await render(); }
    } else if (form.id === "request-create-form") {
      if (!selectedRequest) throw Error("Select a title first");
      const seasons = [...form.querySelectorAll('input[name="season"]:checked')].map(e => Number(e.value));
      if (selectedRequest.type === "tv" && !seasons.length) { $("#request-form-error").innerHTML = '<p class="error-text">Select at least one season.</p>'; return; }
      const saved = await afterAction({ action: "requestCreate", mediaType: selectedRequest.type, mediaId: selectedRequest.id, seasons, label: "Request · " + selectedRequest.title }, submit, false);
      if (saved) { $("#dialog").close(); requestFilter = "all"; location.hash = "requests"; await render(); }
    } else if (form.id === "add-form") {
      if (
        await afterAction(
          {
            action: "add",
            service: addService,
            externalId:
              addService === "radarr" ? selectedAdd.tmdbId : selectedAdd.tvdbId,
            root: $("#add-root").value,
            profile: Number($("#add-profile").value),
            search: $("#add-search").checked,
          },
          submit,
          false,
        )
      ) {
        $("#dialog").close();
        location.hash = "library";
      }
    } else if (form.id === "subtitle-profile-form")
      await runSubtitle("profile", submit, { profileId: values.profileId });
    else if (form.id === "subtitle-edit-form") {
      const content = values.content,
        path = form.dataset.path;
      if (await runSubtitle("edit", submit, { path, content })) { sessionStorage.removeItem(form.dataset.draftKey || ""); $("#dialog").close(); }
    } else if (form.id === "subtitle-upload-form") {
      const file = form.elements.file.files[0];
      const content = await file.text();
      const saved = await runSubtitle("upload", submit, {
        filename: file.name,
        content,
        language: values.language,
        forced: !!values.forced,
        hi: !!values.hi,
      });
      if (saved) $("#dialog").close();
    } else if (form.id === "subtitle-sync-form") {
      const path = form.dataset.path;
      $("#dialog").close();
      await runSubtitle("sync", submit, {
        path,
        maxOffset: Number(values.maxOffset),
      });
    } else if (form.id === "media-settings-form") {
      const [, service, id] = route.split("/");
      const seasons = Object.fromEntries(
        [...form.querySelectorAll('[name^="season-"]')].map((input) => [
          input.name.slice(7),
          input.checked,
        ]),
      );
      await afterAction(
        {
          action: "mediaSettings",
          service,
          id: Number(id),
          monitored: !!values.monitored,
          profileId: Number(values.profileId),
          minimumAvailability: values.minimumAvailability,
          seriesType: values.seriesType,
          seasons,
        },
        submit,
      );
    } else if (form.id === "torrent-settings-form") {
      if (
        await afterAction(
          {
            action: "torrent",
            operation: "limits",
            hash: form.dataset.hash,
            downloadLimit: Number(values.downloadLimit),
            uploadLimit: Number(values.uploadLimit),
          },
          submit,
          false,
        )
      )
        await torrentDialog(form.dataset.hash);
    } else if (form.id === "torrent-category-form")
      await afterAction(
        {
          action: "torrent",
          operation: "category",
          hash: form.dataset.hash,
          category: values.category,
        },
        submit,
        false,
      );
    else if (form.id === "transfer-limits-form") {
      if (
        await afterAction(
          {
            action: "transferLimits",
            downloadLimit: Number(values.downloadLimit),
            uploadLimit: Number(values.uploadLimit),
          },
          submit,
          false,
        )
      ) {
        $("#dialog").close();
        await render();
      }
    } else if (form.id === "connection-form") {
      const [service, type, id] = form.dataset.key.split(":");
      const fields = {};
      for (const input of form.querySelectorAll('[name^="field-"]')) {
        fields[input.name.slice(6)] =
          input.type === "checkbox"
            ? input.checked
            : input.dataset.array
              ? input.value
                  .split(",")
                  .filter(Boolean)
                  .map((value) => (/^\d+$/.test(value) ? Number(value) : value))
              : input.type === "number"
                ? Number(input.value)
                : input.value;
      }
      if (
        await afterAction(
          {
            action: "connection",
            service,
            type,
            id: Number(id),
            name: values.name,
            ...(form.elements.enable ? { enable: !!values.enable } : {}),
            ...(values.priority ? { priority: Number(values.priority) } : {}),
            fields,
          },
          submit,
          false,
        )
      ) {
        $("#dialog").close();
        await render();
      }
    } else if (form.id === "quality-profile-form") {
      const [service, id] = form.dataset.key.split(":");
      if (
        await afterAction(
          {
            action: "qualityProfile",
            service,
            id: Number(id),
            name: values.name,
            upgradeAllowed: !!values.upgradeAllowed,
            cutoff: Number(values.cutoff),
          },
          submit,
          false,
        )
      ) {
        $("#dialog").close();
        await render();
      }
    }
  } catch (error) {
    toast(error.message, true);
  }
});
$("#dialog").addEventListener("click", (event) => {
  if (event.target !== $("#dialog")) return;
  const rect = $("#dialog").getBoundingClientRect();
  if (
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom
  )
    $("#dialog").close();
});
$("#scrim").addEventListener("click", () => {
  $(".sidebar").classList.remove("open");
  $("#menu").setAttribute("aria-expanded", "false");
});
window.addEventListener("scroll", () => document.body.classList.toggle("scrolled", window.scrollY > 4), { passive: true });
window.addEventListener("hashchange", () => {
  route = location.hash.slice(1) || "overview";
  viewDirty = false;
  detailTab = route.startsWith("media/") ? "journey" : "tracks";
  $(".sidebar").classList.remove("open");
  $("#menu").setAttribute("aria-expanded", "false");
  render();
  window.scrollTo(0, 0);
});
window.addEventListener("DOMContentLoaded", () => {
$("#host-address").textContent = location.host;
route = location.hash.slice(1) || "overview";
detailTab = route.startsWith("media/") ? "journey" : "tracks";
renderNav();
refresh(false);
pollJobs();
});
setInterval(() => {
  if (!document.hidden) pollJobs();
}, 3000);
setInterval(async () => {
  if (document.hidden || $("#dialog").open || refreshing)
    return;
  if (
    !viewDirty &&
    !document.activeElement?.matches("input,select,textarea") &&
    (["overview", "downloads", "services", "subtitles", "requests"].includes(
      route,
    ) ||
      route.startsWith("service/"))
  )
    refresh(false);
  else if (route === "activity") pollJobs();
}, 20000);
