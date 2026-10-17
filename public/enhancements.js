// Native workflows shared by the existing views and the new workspaces.
const deckSelection = { library: new Map(), downloads: new Map(), subtitles: new Map() };
let deckImportPlan = null, deckConfig = null, deckConnection = null, deckQuality = null, deckFormat = null;
let deckUser = localStorage.getItem("deck-watch-user") || "", deckPlayback = null;
let deckAlertIds = new Set(), deckAlertsPrimed = false, deckPendingNavigation = null;
const deckBool = v => v === true || String(v).toLowerCase() === "true";
const deckNotice = errors => (errors || []).map(e => `<div class="notice"><strong>${esc(e.section || e.service || "Connection")}</strong> · ${esc(e.message)}${e.staleAt ? `<small>Last successful response: ${esc(new Date(e.staleAt).toLocaleString())}</small>` : ""}</div>`).join("");
const deckCheckbox = (name, label, checked = false, extra = "") => `<label class="checkbox"><input type="checkbox" name="${esc(name)}" ${checked ? "checked" : ""} ${extra}> ${esc(label)}</label>`;
const deckOptions = (items, value, placeholder = "Choose…") => [{ value: "", label: placeholder }, ...items.map(i => ({ value: i.id ?? i.value, label: i.title ? i.title + (i.year ? " · " + i.year : "") : i.name ?? i.label }))];
const deckTime = seconds => { const n = Math.max(0, Math.floor(seconds || 0)); return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`; };
navs.splice(navs.findIndex(n => n[0] === "calendar"), 0, ["imports", "Imports"], ["watch", "Watch"]);
navs.push(["alerts", "Alerts"]);
icons.alerts = '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>';

function journeyView(name, id, journey) {
  if (!journey) return empty("Journey unavailable", "Refresh this title to check its progress.");
  return deckNotice(journey.errors) + `<div class="journey-list">${journey.stages.map(step => `<article class="journey-step ${step.state}"><div class="journey-marker">${step.state === "complete" ? "✓" : step.state === "blocked" ? "!" : step.state === "active" ? "↓" : "·"}</div><div><div class="journey-heading"><h2>${esc(step.label)}</h2>${chip({ complete: "Complete", blocked: "Needs attention", active: "In progress", pending: "Waiting", optional: "Direct add", unknown: "Unavailable" }[step.state], step.state === "complete")}</div><p>${esc(step.detail)}</p><div class="inline-actions">${step.action ? step.action.kind === "search" ? button(step.action.label, 'data-media-releases="true"') : step.action.kind === "watch" ? `<a class="button small-button" href="#${name === "radarr" ? "player/" + step.action.id : "watch"}">${esc(step.action.label)}</a>` : step.action.kind === "scan" ? button(step.action.label, 'data-jellyfin-scan="true"') : `<a class="button small-button" href="#imports/${name}/${step.action.queueId}">${esc(step.action.label)}</a>` : `<a class="text-link" href="#${step.route}">Open ${esc(step.label.toLowerCase())}</a>`}</div></div></article>`).join("")}</div>`;
}

const deckOriginalPoster = poster;
poster = m => route !== "library" ? deckOriginalPoster(m) : `<div class="selectable-poster"><label class="poster-select"><input type="checkbox" data-select-kind="library" data-select-key="${m.service}:${m.id}" ${deckSelection.library.has(m.service + ":" + m.id) ? "checked" : ""} aria-label="Select ${esc(m.title)}"></label>${deckOriginalPoster(m)}</div>`;
function deckBulkToolbar(kind) {
  return `<div class="bulk-toolbar"><span id="bulk-count">${deckSelection[kind].size} selected</span>${button("Select shown", `data-select-shown="${kind}"`)}${button("Clear", `data-clear-selection="${kind}"`)}<div class="bulk-actions">${kind === "library" ? button("Monitoring", 'data-bulk-dialog="monitor"') + button("Quality profile", 'data-bulk-dialog="profile"') : kind === "downloads" ? ["pause", "resume", "recheck", "reannounce"].map(operation => button(operation[0].toUpperCase() + operation.slice(1), `data-bulk-torrent="${operation}"`)).join("") : button("Find missing subtitles", 'data-bulk-subtitles="true"', true) + button("Language profile", 'data-bulk-dialog="subtitleProfile"')}</div></div>`;
}
const deckOriginalLibrary = libraryView;
libraryView = () => deckOriginalLibrary().replace('<div class="library-grid"', deckBulkToolbar("library") + '<div class="library-grid"');
const deckOriginalDownloads = downloads;
downloads = () => {
  let i = 0;
  return deckNotice((data.dataErrors || []).filter(e => ["qbittorrent", "radarr", "sonarr"].includes(e.service))) + deckOriginalDownloads().replace('<section class="panel">', deckBulkToolbar("downloads") + '<section class="panel">').replace('<th>Title</th>', '<th class="selection-cell">Select</th><th>Title</th>').replaceAll('<tr><td class="title-cell">', () => { const t = data.torrents[i++]; return `<tr><td class="selection-cell"><input type="checkbox" data-select-kind="downloads" data-select-key="${t.hash}" ${deckSelection.downloads.has(t.hash) ? "checked" : ""} aria-label="Select ${esc(t.name)}"></td><td class="title-cell">`; });
};
const deckOriginalSubtitleLibrary = subtitleLibraryView;
subtitleLibraryView = () => deckOriginalSubtitleLibrary().replace('<section class="panel" id="subtitle-rows">', deckBulkToolbar("subtitles") + '<section class="panel" id="subtitle-rows">');
const deckOriginalFilterSubtitles = filterSubtitles;
filterSubtitles = () => {
  deckOriginalFilterSubtitles();
  const head = $("#subtitle-rows thead tr"); if (!head) return;
  head.insertAdjacentHTML("afterbegin", '<th class="selection-cell">Select</th>');
  for (const tr of document.querySelectorAll("#subtitle-rows tbody tr")) {
    const key = tr.querySelector("[data-subtitle-detail]").dataset.subtitleDetail;
    const name = tr.querySelector(".title-link").textContent;
    tr.insertAdjacentHTML("afterbegin", `<td class="selection-cell"><input type="checkbox" data-select-kind="subtitles" data-select-key="${esc(key)}" ${deckSelection.subtitles.has(key) ? "checked" : ""} aria-label="Select ${esc(name)}"></td>`);
  }
};
const deckOriginalHealth = health;
health = limit => !(data.health.length || data.services.some(s => !s.online)) && data.dataErrors?.some(e => e.section === "health") ? empty("Health checks unavailable", "Could not fetch current warnings. Review the connection errors above.", "!") : deckOriginalHealth(limit);
const deckOriginalOverview = overview;
overview = () => deckNotice([...(data.dataErrors || []), ...(data.libraryErrors || [])]) + deckOriginalOverview();
const deckOriginalRequests = requestsView;
requestsView = () => {
  let html = deckOriginalRequests();
  for (const r of viewData.results || []) {
    const match = data.library.find(m => r.type === "movie" ? m.service === "radarr" && m.tmdbId === r.tmdbId : m.service === "sonarr" && (m.tvdbId === r.tvdbId || m.id === r.libraryId));
    if (match) html = html.replace(`<h2>${esc(r.title)}</h2>`, `<h2><a class="title-link" href="#media/${match.service}/${match.id}">${esc(r.title)}</a></h2>`);
  }
  return html;
};
const deckOriginalServiceDetail = serviceDetail;
serviceDetail = name => {
  let html = deckOriginalServiceDetail(name);
  if (!["radarr", "sonarr", "prowlarr", "bazarr"].includes(name)) return html;
  const tools = `<div class="native-tools"><a class="button primary" href="#configure/${name}">Configure ${esc(service(name)?.name)}</a>${["radarr", "sonarr", "prowlarr"].includes(name) ? button("Add indexer", `data-create-connection="${name}:indexer"`) + button("Add download client", `data-create-connection="${name}:downloadclient"`) : ""}${name === "prowlarr" ? button("Add application", 'data-create-connection="prowlarr:applications"') : ""}</div>`;
  const page = document.createElement("template");
  page.innerHTML = html;
  const heading = page.content.querySelector(".page-title");
  if (heading) heading.insertAdjacentHTML("afterend", tools); else page.content.prepend(document.createRange().createContextualFragment(tools));
  return page.innerHTML;
};
const deckOriginalActivity = renderActivity;
renderActivity = () => {
  deckOriginalActivity();
  if (route !== "activity") return;
  const rows = document.querySelectorAll(".job-row");
  for (const [i, rowElement] of [...rows].entries()) {
    const job = jobs[i];
    if (["failed", "interrupted"].includes(job.status) && (job.commandId || job.bazarrJobIds || job.jellyfinTaskId)) rowElement.querySelector("div:nth-child(2)").insertAdjacentHTML("beforeend", button("Check service status", `data-recover-job="${job.id}"`));
    if (job.result?.results) rowElement.querySelector("div:nth-child(2)").insertAdjacentHTML("beforeend", `<details class="job-results"><summary>${job.result.partial ? "Some updates need attention" : "View results"}</summary>${job.result.results.map(r => `<p class="${r.success ? "" : "error-text"}">${r.success ? "✓" : "!"} ${esc(r.item)} · ${esc(r.message)}</p>`).join("")}</details>`);
  }
};

function deckImportView(result) {
  return title("Imports", "Inspect downloaded files, assign the correct title, and repair blocked imports.") + deckNotice(result.errors) + panel("Inspect a folder", `<form id="inspect-import-form" class="panel-body"><div class="form-row">${field("Library", select("service", [{ value: "radarr", label: "Movies" }, { value: "sonarr", label: "Series" }], "radarr"))}${field("Download folder on the media PC", input("folder", "", "text", 'placeholder="D:\\Downloads\\Title" required'))}</div>${button("Inspect files", 'type="submit"', true)}<p class="section-note">Inspection does not move files. You’ll review every assignment before importing.</p></form>`) + panel("Import queue", result.queues.length ? result.queues.map(q => `<article class="import-queue-card"><div><h3>${esc(q.title)}</h3><p>${esc(service(q.service)?.name)} · ${esc(q.status)} · ${esc(q.trackedDownloadStatus || "")}</p><p class="error-text">${esc((q.statusMessages || []).flatMap(m => m.messages || []).join("; "))}</p></div><div class="inline-actions"><a class="button primary" href="#imports/${q.service}/${q.id}">Inspect & assign</a>${button("Retry scan", `data-command="${q.service}:${q.service === "radarr" ? "DownloadedMoviesScan" : "DownloadedEpisodesScan"}"`)}${button("Remove queue entry", `data-queue-remove="${q.service}:${q.id}"`)}</div></article>`).join("") : empty("No queued imports", "Inspect a download folder above to import files manually."));
}
async function deckShowImport(serviceName, params) {
  const main = $("#main"), myRoute = route;
  main.innerHTML = title("Inspect import", "Checking files and existing library matches…") + loading();
  try {
    const result = await get("import-plan?" + new URLSearchParams({ service: serviceName, ...params }));
    if (myRoute !== route) return;
    deckImportPlan = { ...result, service: serviceName };
    const assignments = await Promise.all(result.files.map(async f => {
      const titleId = serviceName === "radarr" ? f.movie?.id : f.series?.id;
      return { ...f, titleId, matchedEpisodeIds: (f.episodes || []).map(e => e.id), episodes: serviceName === "sonarr" && titleId ? await get(`import-episodes?service=sonarr&id=${titleId}`) : [] };
    }));
    if (myRoute !== route) return;
    deckImportPlan.files = assignments;
    main.innerHTML = `<a href="#imports" class="text-link back-link">${icon("back")}Imports</a>` + title("Assign downloaded files", "Select files, confirm their quality, and choose the title they belong to.") + (result.files.length ? `<form id="manual-import-form"><div class="import-files">${assignments.map(f => `<section class="panel import-file" data-import-id="${f.id}"><div class="panel-body"><label class="checkbox"><input type="checkbox" name="include-${f.id}" checked> <strong>${esc(f.relativePath || f.name || f.path)}</strong></label><p class="file-path small">${esc(f.path)} · ${bytes(f.size)}</p>${f.releaseChoice ? `<div class="notice">Using your selected release for ${esc(f.releaseChoice.title)}. Movie, quality, and language are prefilled from that release.</div>` : ""}${f.rejections?.length ? `<div class="notice">${esc(f.rejections.map(r => r.reason).join("; "))}</div>` : ""}<div class="form-row">${field(serviceName === "radarr" ? "Movie" : "Series", select("title-" + f.id, deckOptions(result.titles, f.titleId, "Choose a library title"), f.titleId))}${field("Quality", select("quality-" + f.id, deckOptions(result.qualities, f.quality?.quality?.id, "Choose quality"), f.quality?.quality?.id))}${field("Language", select("language-" + f.id, deckOptions(result.languages, f.languages?.[0]?.id, "Choose language"), f.languages?.[0]?.id))}</div>${serviceName === "sonarr" ? `<div class="import-episode-options" data-import-episodes="${f.id}">${deckEpisodeChoices(f.episodes, f.matchedEpisodeIds, f.id, (f.episodes || []).map(e => e.id))}</div>` : ""}</div></section>`).join("")}</div><div class="import-confirm panel"><div class="panel-body">${field("Import method", select("mode", [{ value: "copy", label: "Copy / hardlink — keep source files" }, { value: "move", label: "Move — remove files from download folder" }], "copy"))}<p class="section-note">Copy keeps the source available for seeding. Importing may replace an existing library file according to your quality rules.</p>${button("Import selected files", 'type="submit"', true)}</div></div></form>` : empty("No video files found", "Check the folder path and whether the download has finished."));
  } catch (e) { if (myRoute === route) main.innerHTML = `<a href="#imports" class="text-link">← Imports</a><div class="error-box">${esc(e.message)}</div>`; }
}
function deckEpisodeChoices(episodes, selected = [], id) {
  return episodes.length ? `<h3 class="subheading">Assign episodes</h3><div class="episode-choices">${episodes.map(e => deckCheckbox(`episode-${id}-${e.id}`, `S${e.seasonNumber} · E${e.episodeNumber} · ${e.title}`, selected.includes(e.id))).join("")}</div>` : '<p class="section-note">Choose a series to list its episodes.</p>';
}

function deckAlertsView(result) {
  const active = result.records.filter(r => !r.resolvedAt), resolved = result.records.filter(r => r.resolvedAt);
  const alertsHTML = items => items.map(r => `<article class="alert-card ${r.severity}"><div><div class="inline-actions"><h3>${esc(r.title)}</h3>${r.acknowledged ? chip("Acknowledged") : r.resolvedAt ? chip("Resolved", true) : chip(r.severity)}</div><p>${esc(r.detail)}</p><small>${esc(r.services.map(n => service(n)?.name || n).join(" · "))} · ${ago(r.createdAt)}${r.resolvedAt ? " · resolved " + ago(r.resolvedAt) : ""}</small></div><div class="inline-actions"><a class="button small-button" href="#${r.route}">Review</a>${!r.acknowledged && !r.resolvedAt ? button("Acknowledge", `data-ack-alert="${r.id}"`) : ""}</div></article>`).join("");
  const browserOn = localStorage.getItem("deck-notifications") === "true";
  return title("Alerts", "Failures and blockers are grouped by cause. Resolved issues stay in your history.") + panel("Needs attention", active.length ? alertsHTML(active) : empty("No active alerts", "Deck monitors the stack even while this page is closed.")) + panel("Alert preferences", `<form id="alert-settings-form" class="panel-body"><div class="form-row">${field("Low disk space · GB remaining", input("lowDiskGB", result.settings.lowDiskGB, "number", 'min="1" max="1000"'))}${field("Low disk space · % remaining", input("lowDiskPercent", result.settings.lowDiskPercent, "number", 'min="1" max="50"'))}${field("Stalled download · minutes", input("stalledMinutes", result.settings.stalledMinutes, "number", 'min="1" max="1440"'))}</div>${button("Save thresholds", 'type="submit"', true)}</form><div class="panel-body notification-controls">${button(browserOn ? "Disable browser notifications" : "Enable browser notifications", 'data-browser-notifications="true"')}<p class="section-note">The inbox is always collected on the server. Browser notifications require this page to stay open and browser permission.</p></div>`) + (resolved.length ? `<details class="panel resolved-alerts"><summary>${resolved.length} resolved alerts</summary>${alertsHTML(resolved)}</details>` : "");
}

const deckArt = (ref, kind, width) => ref ? `/hub/api/watch-image?id=${encodeURIComponent(ref)}&kind=${kind}&w=${width}` : "";
const deckMinutesLeft = item => item.runtime && item.position ? Math.max(1, Math.round((item.runtime - item.position) / 600000000)) : null;
function deckWatchMeta(item) {
  const left = deckMinutesLeft(item);
  return [item.series ? `S${item.season} · E${item.episode} · ${item.title}` : item.year ? String(item.year) : item.type, left ? `${left} min left` : ""].filter(Boolean).join(" · ");
}
function deckStillCard(item) {
  const wide = item.art?.wide, pct = item.position ? Math.min(100, item.runtime ? item.position / item.runtime * 100 : item.percentage) : 0;
  const blocked = item.releaseChoice && !item.releaseChoice.playbackMatches;
  return `<a class="still-card" href="${blocked ? `#media/radarr/${item.releaseChoice.id}` : `#player/${item.id}`}"><div class="still${!wide && item.art?.poster ? " poster-mode" : ""}"><div class="still-fallback">${esc(item.series || item.title)}</div>${wide ? `<img src="${deckArt(wide.id, wide.kind, 640)}" alt="" loading="lazy">` : item.art?.poster ? `<img class="still-blur" src="${deckArt(item.art.poster, "Primary", 360)}" alt="" loading="lazy"><img class="still-poster" src="${deckArt(item.art.poster, "Primary", 360)}" alt="" loading="lazy">` : ""}${blocked ? "" : `<span class="still-play">${icon("play")}</span>`}${pct ? `<div class="progress"><span style="width:${pct}%"></span></div>` : ""}</div><h3>${esc(item.series || item.title)}</h3><p>${blocked ? "Waiting for your selected release" : esc(deckWatchMeta(item))}</p></a>`;
}
function deckWatchCard(item) {
  const blocked = item.releaseChoice && !item.releaseChoice.playbackMatches;
  return `<a class="poster-card" href="${blocked ? `#media/radarr/${item.releaseChoice.id}` : `#player/${item.id}`}" aria-label="${blocked ? "View selected release for" : "Watch"} ${esc(item.title)}"><div class="poster"><div class="poster-fallback">${esc(item.title)}</div>${item.art?.poster ? `<img src="${deckArt(item.art.poster, "Primary", 360)}" alt="" loading="lazy">` : ""}${blocked ? `<span class="badge">Waiting for release</span>` : ""}</div><h3>${esc(item.title)}</h3><p>${esc(item.year ? String(item.year) : item.type)}${item.played ? " · Watched" : ""}</p></a>`;
}
function deckWatchView(result) {
  const profile = `<label class="watch-user">Profile ${select("watchUser", result.users.map(u => ({ value: u.id, label: u.name })), result.user)}</label>`;
  const rail = (heading, items) => items.length ? `<section class="home-section"><div class="section-head"><h2>${heading}</h2></div><div class="rail">${items.map(deckStillCard).join("")}</div></section>` : "";
  return title("Watch", "Your Jellyfin library, played right here in Deck.", profile) +
    rail("Continue watching", result.resume) + rail("Next up", result.next) +
    `<section class="home-section"><div class="section-head"><h2>Films</h2></div>${result.latest.length ? `<div class="watch-grid">${result.latest.map(deckWatchCard).join("")}</div>` : empty("No films yet", "Scan Jellyfin after importing your media.")}</section>`;
}
// Continue watching on Home: cached for a minute so the 20-second refresh stays cheap.
let deckHomeWatchData = null, deckHomeWatchAt = 0, deckHomeWatchLoading = false;
function deckHomeWatch(section) {
  if (!deckHomeWatchLoading && Date.now() - deckHomeWatchAt > 60000) {
    deckHomeWatchLoading = true;
    get("watch?user=" + encodeURIComponent(deckUser))
      .then(result => { const fresh = !deckHomeWatchData; deckHomeWatchData = result; if (fresh && route === "overview") render(); })
      .catch(() => { deckHomeWatchData ||= { resume: [], next: [] }; })
      .finally(() => { deckHomeWatchLoading = false; deckHomeWatchAt = Date.now(); });
  }
  const items = [...(deckHomeWatchData?.resume || []), ...(deckHomeWatchData?.next || [])].slice(0, 8);
  return items.length ? section("Continue watching", '<a href="#watch" class="text-link">Watch</a>', `<div class="rail">${items.map(deckStillCard).join("")}</div>`) : "";
}
async function deckPlayerView(id) {
  const myRoute = route, main = $("#main");
  if (!deckUser) { const users = await get("watch-users"); deckUser = users[0]?.id; }
  const item = await get("watch-item?" + new URLSearchParams({ id, user: deckUser }));
  if (myRoute !== route) return;
  if (item.releaseChoice && !item.releaseChoice.playbackMatches) {
    deckPlayback = null;
    main.innerHTML = `<a class="text-link back-link" href="#watch">${icon("back")}Watch</a>` + releaseChoiceNotice(item.releaseChoice) + title(esc(item.title), "Waiting for your selected release") + empty("Selected release is not ready", "Verify its import and scan Jellyfin, or clear the selection to use the existing copy.") + `<a class="button" href="#media/radarr/${item.releaseChoice.id}">View title journey</a>`;
    return;
  }
  deckPlayback = { item, token: null, lastSaved: 0 };
  main.innerHTML = `<a class="text-link back-link" href="#watch">${icon("back")}Watch</a>` + releaseChoiceNotice(item.releaseChoice) + title(esc(item.title), `${item.series ? esc(item.series) + ` · S${item.season} E${item.episode}` : esc(item.year || "")} · Your watch progress is saved to Jellyfin`) + `<div class="player-shell"><video id="deck-player" controls playsinline preload="metadata"></video><div id="player-message" class="panel-body"><p>Ready to watch${item.position ? " from " + deckTime(item.position / 10000000) : ""}.</p>${button(item.position ? "Continue watching" : "Start playback", 'data-start-player="true"', true)}</div></div><form id="player-tracks-form" class="panel"><div class="panel-body form-row">${field("Audio", select("audio", item.audioTracks.map(t => ({ value: t.index, label: t.name || t.language })), item.audioTracks[0]?.index))}${field("Subtitles", select("subtitle", [{ value: "-1", label: "Off" }, ...item.subtitleTracks.map(t => ({ value: t.index, label: t.name || t.language }))], "-1"))}${button("Apply & play", 'type="submit"')}</div></form><p class="section-note">Jellyfin converts audio and video when needed for your browser.</p>`;
  const video = $("#deck-player");
  video.addEventListener("loadedmetadata", () => { if (item.position && video.duration > item.position / 10000000) video.currentTime = item.position / 10000000; });
  video.addEventListener("timeupdate", () => { if (Date.now() - (deckPlayback?.lastSaved || 0) > 15000) deckSavePlayback("progress"); });
  video.addEventListener("pause", () => deckSavePlayback("progress"));
  video.addEventListener("ended", () => deckSavePlayback("stop", true));
  video.addEventListener("error", () => { $("#player-message").innerHTML = '<div class="notice">Playback could not start. Check Jellyfin’s transcoding log, then try again.</div>' + button("Try playback again", 'data-start-player="true"'); });
}
async function deckStartPlayer(buttonElement) {
  const state = deckPlayback; if (!state) return;
  const form = $("#player-tracks-form"), values = formObject(form);
  const result = await action({ action: "watchStart", id: state.item.id, user: deckUser, audio: values.audio, subtitle: values.subtitle }, "", buttonElement);
  if (!result || deckPlayback !== state || !$("#deck-player")) return;
  state.token = result.token;
  const video = $("#deck-player");
  state.hls?.destroy();
  if (result.hls && !video.canPlayType("application/vnd.apple.mpegurl") && window.Hls?.isSupported()) {
    state.hls = new Hls({ startPosition: state.item.position / 10000000 || 0, enableWorker: false });
    state.hls.loadSource(result.source); state.hls.attachMedia(video);
    state.hls.on(Hls.Events.ERROR, (_, error) => { if (error.fatal) $("#player-message").innerHTML = '<p class="notice">Jellyfin could not deliver the video. Check its transcoding log and try again.</p>'; });
  } else video.src = result.source;
  $("#player-message").innerHTML = '<p class="small muted">Opening the media file…</p>';
  try { await video.play(); $("#player-message").innerHTML = ""; await deckSavePlayback("start"); }
  catch (e) { $("#player-message").innerHTML = `<p>${esc(e.message)}</p>${button("Play", 'data-player-play="true"')}`; }
}
async function deckSavePlayback(event = "progress", ended = false, old = null) {
  const state = old || deckPlayback, video = $("#deck-player"); if (!state?.token) return;
  state.lastSaved = Date.now();
  const body = { token: state.token, event, position: old ? state.position || 0 : video?.currentTime || 0, paused: old ? true : !!video?.paused, ended };
  try { const r = await fetch("/hub/api/watch-progress", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), keepalive: event === "stop" }); if (!r.ok && event !== "stop") toast("Could not save watch progress. Check Jellyfin’s connection.", true); }
  catch { if (event !== "stop") toast("Could not save watch progress", true); }
}

function deckConfigView(name, result) {
  deckConfig = result;
  if (name === "bazarr") return deckBazarrConfig(result);
  return `<a class="text-link back-link" href="#service/${name}">${icon("back")}${esc(service(name)?.name)}</a>` + title("Configure " + esc(service(name)?.name), "Manage library rules and connections.") + deckNotice(result.errors) + panel("Connections", `<div class="panel-body inline-actions">${button("Add indexer", `data-create-connection="${name}:indexer"`, true)}${button("Add download client", `data-create-connection="${name}:downloadclient"`)}${name === "prowlarr" ? button("Add application", 'data-create-connection="prowlarr:applications"') : ""}</div>`) + (result.profiles ? panel("Quality profiles", table(["Profile", "Custom formats", ""], result.profiles.map(p => row([esc(p.name), String((p.formatItems || []).length), button("Edit quality & scores", `data-advanced-profile="${name}:${p.id}"`)])))) + panel("Custom formats", table(["Format", "Conditions", ""], (result.formats || []).map(f => row([esc(f.name), String(f.specifications.length), button("Edit", `data-custom-format="${name}:${f.id}"`)]))), button("New custom format", `data-custom-format="${name}:new"`, true)) + panel("Library folders", table(["Folder", "Free space"], (result.roots || []).map(r => row([`<span class="file-path">${esc(r.path)}</span>`, bytes(r.freeSpace)]))) + `<form id="root-create-form" class="panel-body toolbar" data-service="${name}">${field("Existing folder on the media PC", input("path", "", "text", 'required placeholder="D:\\Movies"'))}${button("Add folder", 'type="submit"', true)}</form>`) : "") + panel("Allowed hostnames", `<form id="allowed-hosts-form" class="panel-body" data-service="${name}">${field("Names and IP addresses allowed to reach this service", input("hosts", result.host?.allowedHosts || "", "text", 'required placeholder="localhost,127.0.0.1,192.168.0.10"'))}<p class="section-note">Include the media PC address and any hostname you use. This changes only the hostname restriction.</p>${button("Save hostnames", 'type="submit"', true)}</form>`);
}
function deckBazarrConfig(result) {
  return `<a class="text-link back-link" href="#service/bazarr">${icon("back")}Bazarr</a>` + title("Configure subtitles", "Providers, language profiles, and defaults for newly added titles.") + panel("Providers", table(["Provider", "Enabled", ""], result.providers.map(p => row([esc(p.name), chip(p.enabled ? "Enabled" : "Disabled", p.enabled), button("Edit", `data-edit-provider="${p.name}"`)])))) + panel("Language profiles", table(["Profile", "Languages", ""], result.profiles.map(p => row([esc(p.name), esc(p.items.map(i => i.language.toUpperCase() + (deckBool(i.forced) ? " · Forced" : "") + (deckBool(i.hi) ? " · HI" : "")).join("; ")), button("Edit", `data-language-profile="${p.profileId}"`)]))), button("New profile", 'data-language-profile="new"', true)) + panel("Default profiles", `<form id="subtitle-defaults-form" class="panel-body"><div class="form-row">${field("New movies", select("movie", [{ value: "", label: "No default" }, ...result.profiles.map(p => ({ value: p.profileId, label: p.name }))], result.defaults.movie))}${field("New series", select("series", [{ value: "", label: "No default" }, ...result.profiles.map(p => ({ value: p.profileId, label: p.name }))], result.defaults.series))}</div>${deckCheckbox("movieEnabled", "Apply default to new movies", result.defaults.movieEnabled)}${deckCheckbox("seriesEnabled", "Apply default to new series", result.defaults.seriesEnabled)}${button("Save defaults", 'type="submit"', true)}</form>`);
}

function deckConnectionFields(fields) {
  return fields.filter(f => !["hidden", "info", "button"].includes(f.type)).map(f => {
    let html;
    if (f.secret) html = input("field-" + f.name, "", "password", 'placeholder="Leave blank to keep an existing secret" autocomplete="off"');
    else if (f.type === "checkbox") return deckCheckbox("field-" + f.name, f.label, !!f.value);
    else if ((f.type === "select" || f.type === "tagSelect") && f.selectOptions?.length && Array.isArray(f.value)) html = `<select name="field-${esc(f.name)}" multiple data-array="true">${f.selectOptions.map(o => `<option value="${esc(o.value)}" ${f.value.map(String).includes(String(o.value)) ? "selected" : ""}>${esc(o.name)}</option>`).join("")}</select>`;
    else if (f.type === "select" && f.selectOptions?.length) html = select("field-" + f.name, f.selectOptions.map(o => ({ value: o.value, label: o.name })), f.value);
    else if (Array.isArray(f.value)) html = input("field-" + f.name, f.value.join(","), "text", 'data-array="true"');
    else html = input("field-" + f.name, f.value ?? "", f.type === "number" ? "number" : "text", f.type === "number" ? 'step="any"' : "");
    return field(esc(f.label), html + (f.helpText ? `<small>${esc(f.helpText)}</small>` : ""));
  }).join("");
}
function deckConnectionControls(item) {
  return `${field("Name", input("name", item.name || "", "text", "required"))}${item.priority !== undefined ? field("Priority", input("priority", item.priority, "number", 'min="1" max="50"')) : ""}${["enable", "enableRss", "enableAutomaticSearch", "enableInteractiveSearch"].filter(k => item[k] !== undefined).map(k => deckCheckbox(k, { enable: "Enabled", enableRss: "Use RSS feeds", enableAutomaticSearch: "Use automatic searches", enableInteractiveSearch: "Use interactive searches" }[k], item[k])).join("")}${item.syncLevel !== undefined ? field("Synchronization", select("syncLevel", [{ value: "disabled", label: "Disabled" }, { value: "addOnly", label: "Add only" }, { value: "fullSync", label: "Full sync" }], item.syncLevel)) : ""}`;
}
async function deckCreateConnection(key) {
  const [name, type] = key.split(":");
  const result = await get("connection-schemas?" + new URLSearchParams({ service: name, type }));
  deckConnection = { ...result, service: name, type };
  deckConnectionForm(0);
}
function deckConnectionForm(index, preset = -1) {
  const state = deckConnection, schema = state.schemas[index], item = preset >= 0 ? schema.presets[preset] : schema;
  state.index = index; state.preset = preset; state.item = item;
  showDialog(`<h2 class="dialog-title">Add ${state.type === "downloadclient" ? "download client" : state.type === "applications" ? "application" : "indexer"}</h2><form id="new-connection-form">${field("Connection type", select("schema", state.schemas.map((s, i) => ({ value: i, label: s.name || s.implementation })), index))}${schema.presets?.length ? field("Preset", select("preset", [{ value: -1, label: "Default settings" }, ...schema.presets.map((p, i) => ({ value: i, label: p.name }))], preset)) : ""}<div class="connection-fields">${deckConnectionControls(item)}${deckConnectionFields(item.fields)}</div><div class="inline-actions">${button("Test connection", 'type="button" data-test-new-connection="true"')}${button("Create connection", 'type="submit"', true)}</div><p class="section-note">The connection must pass its test before it is created.</p></form>`);
}
connectionDialog = async key => {
  const [name, type, id] = key.split(":");
  const item = await get("connection?" + new URLSearchParams({ service: name, type, id }));
  showDialog(`<h2 class="dialog-title">${esc(item.name)}</h2><form id="edit-native-connection" data-service="${name}" data-type="${type}" data-id="${id}"><div class="connection-fields">${deckConnectionControls(item)}${deckConnectionFields(item.fields)}</div>${button("Save connection", 'type="submit"', true)}<p class="section-note">Blank secret fields preserve existing credentials.</p></form>`);
};
function deckConnectionValues(form) {
  const values = formObject(form), fields = {};
  for (const el of form.querySelectorAll('[name^="field-"]')) fields[el.name.slice(6)] = el.type === "checkbox" ? el.checked : el.multiple ? [...el.selectedOptions].map(o => /^\d+$/.test(o.value) ? Number(o.value) : o.value) : el.dataset.array ? el.value.split(",").map(v => v.trim()).filter(Boolean).map(v => /^\d+$/.test(v) ? Number(v) : v) : el.type === "number" ? el.value === "" ? "" : Number(el.value) : el.value;
  const result = { name: values.name, fields };
  for (const k of ["enable", "enableRss", "enableAutomaticSearch", "enableInteractiveSearch"]) if (form.elements[k]) result[k] = form.elements[k].checked;
  for (const k of ["priority", "syncLevel"]) if (form.elements[k]) result[k] = k === "priority" ? Number(values[k]) : values[k];
  return result;
}

function deckQualityDialog(key) {
  const [name, id] = key.split(":"), original = deckConfig.profiles.find(p => p.id === Number(id));
  deckQuality = { ...structuredClone(original), service: name };
  deckRenderQuality();
}
function deckRenderQuality() {
  const p = deckQuality, identity = i => i.items?.length ? "group:" + i.id : "quality:" + i.quality.id;
  const qualities = p.items.flatMap(i => i.items?.length ? [{ value: i.id, label: i.name }, ...i.items.map(q => ({ value: q.quality.id, label: q.quality.name }))] : [{ value: i.quality.id, label: i.quality.name }]);
  showDialog(`<h2 class="dialog-title">Quality order & custom formats</h2><form id="advanced-quality-form"><div class="form-row">${field("Profile name", input("name", p.name, "text", "required"))}${field("Upgrade cutoff", select("cutoff", qualities, p.cutoff))}</div>${deckCheckbox("upgradeAllowed", "Allow quality upgrades", p.upgradeAllowed)}<p class="section-note">Higher priorities are at the bottom, matching the library’s quality order.</p><div class="quality-order">${p.items.map((i, index) => `<div class="quality-order-row" data-quality-key="${identity(i)}"><div>${i.items?.length ? `<strong>${esc(i.name)}</strong><div class="quality-group">${i.items.map(q => deckCheckbox("allow-" + q.quality.id, q.quality.name, q.allowed)).join("")}</div>` : deckCheckbox("allow-" + i.quality.id, i.quality.name, i.allowed)}</div><div class="inline-actions">${button("↑", `type="button" data-quality-move="${index}" data-direction="-1" aria-label="Move ${esc(i.name || i.quality.name)} up" ${index === 0 ? "disabled" : ""}`)}${button("↓", `type="button" data-quality-move="${index}" data-direction="1" aria-label="Move ${esc(i.name || i.quality.name)} down" ${index === p.items.length - 1 ? "disabled" : ""}`)}</div></div>`).join("")}</div><h3 class="subheading">Custom format thresholds</h3><div class="form-row">${field("Minimum score", input("minFormatScore", p.minFormatScore || 0, "number"))}${field("Upgrade until score", input("cutoffFormatScore", p.cutoffFormatScore || 0, "number"))}${field("Minimum upgrade gain", input("minUpgradeFormatScore", p.minUpgradeFormatScore || 0, "number"))}</div>${(p.formatItems || []).length ? table(["Custom format", "Score"], p.formatItems.map(f => row([esc(f.name), input("score-" + f.format, f.score, "number")]))): '<p class="section-note">No custom formats are configured in this library.</p>'}${button("Save quality & scores", 'type="submit"', true)}</form>`);
}
function deckCaptureQuality() {
  const form = $("#advanced-quality-form"), values = formObject(form), p = deckQuality;
  Object.assign(p, { name: values.name, cutoff: Number(values.cutoff), upgradeAllowed: form.elements.upgradeAllowed.checked, minFormatScore: Number(values.minFormatScore), cutoffFormatScore: Number(values.cutoffFormatScore), minUpgradeFormatScore: Number(values.minUpgradeFormatScore) });
  for (const i of p.items) for (const q of i.items?.length ? i.items : [i]) q.allowed = !!form.elements["allow-" + q.quality.id]?.checked;
  for (const f of p.formatItems || []) f.score = Number(form.elements["score-" + f.format].value);
}


function deckFormatDialog(key) {
  const [name, id] = key.split(":");
  const original = deckConfig.formats.find(f => f.id === Number(id));
  deckFormat = { ...(original ? structuredClone(original) : { name: "", includeCustomFormatWhenRenaming: false, specifications: [structuredClone(deckConfig.formatSchemas[0])] }), service: name };
  deckFormatRender();
}
function deckFormatRender() {
  const f = deckFormat;
  showDialog(`<h2 class="dialog-title">${f.id ? "Edit" : "New"} custom format</h2><form id="custom-format-form">${field("Format name", input("name", f.name, "text", "required"))}${deckCheckbox("rename", "Include when renaming files", f.includeCustomFormatWhenRenaming)}<div class="format-conditions">${f.specifications.map((c, i) => `<section class="panel" data-condition-row="${i}"><div class="panel-body">${field("Condition", `<select data-format-condition="${i}">${deckConfig.formatSchemas.map(s => `<option value="${esc(s.implementation)}" ${s.implementation === c.implementation ? "selected" : ""}>${esc(s.implementationName || s.name)}</option>`).join("")}</select>`)}${field("Condition name", input("conditionName", c.name || ""))}${deckCheckbox("required", "Required", c.required)}${deckCheckbox("negate", "Invert this condition", c.negate)}<div class="connection-fields">${deckConnectionFields(c.fields || [])}</div>${button("Remove condition", `type="button" data-remove-format-condition="${i}"`)}</div></section>`).join("")}</div><div class="inline-actions">${button("Add condition", 'type="button" data-add-format-condition="true"')}${button("Save custom format", 'type="submit"', true)}</div><p class="section-note">Set this format’s score in the quality profiles that should use it.</p></form>`);
}
function deckFormatCapture() {
  const form = $("#custom-format-form"); deckFormat.name = form.elements.name.value; deckFormat.includeCustomFormatWhenRenaming = form.elements.rename.checked;
  for (const row of form.querySelectorAll("[data-condition-row]")) {
    const i = Number(row.dataset.conditionRow), condition = deckFormat.specifications[i];
    condition.name = row.querySelector('[name="conditionName"]').value;
    condition.required = row.querySelector('[name="required"]').checked; condition.negate = row.querySelector('[name="negate"]').checked;
    for (const field of condition.fields || []) { const el = [...row.querySelectorAll('[name^="field-"]')].find(e => e.name === "field-" + field.name); if (el) field.value = el.type === "checkbox" ? el.checked : el.type === "number" ? Number(el.value) : el.value; }
  }
}

function deckProviderDialog(name) {
  const p = deckConfig.providers.find(p => p.name === name);
  showDialog(`<h2 class="dialog-title">${esc(p.name)}</h2><form id="subtitle-provider-form" data-provider="${esc(p.name)}">${deckCheckbox("enabled", "Enabled", p.enabled)}<div class="connection-fields">${deckConnectionFields(p.fields)}</div>${button("Save provider", 'type="submit"', true)}<p class="section-note">Existing passwords and API keys are kept when their fields are blank.</p></form>`);
}
function deckLanguageProfile(id) {
  const p = deckConfig.profiles.find(p => p.profileId === Number(id)) || { name: "", items: [{ language: "en", forced: "False", hi: "False" }], cutoff: null, mustContain: [], mustNotContain: [], originalFormat: 0 };
  showDialog(`<h2 class="dialog-title">${id === "new" ? "New" : "Edit"} language profile</h2><form id="language-profile-form" data-id="${id === "new" ? "" : id}">${field("Profile name", input("name", p.name, "text", "required"))}<div id="language-profile-items">${p.items.map((i, index) => deckLanguageRow(i, index)).join("")}</div>${button("Add language", 'type="button" data-add-profile-language="true"')}<div class="form-row">${field("Stop searching after language row (blank = all)", input("cutoff", p.cutoff || "", "number", 'min="1"'))}${field("Release must contain (comma separated)", input("mustContain", (p.mustContain || []).join(", ")))}${field("Release must not contain", input("mustNotContain", (p.mustNotContain || []).join(", ")))}</div>${deckCheckbox("originalFormat", "Keep original subtitle format", !!p.originalFormat)}${button("Save language profile", 'type="submit"', true)}</form>`);
}
function deckLanguageRow(item, index) {
  return `<div class="language-profile-row">${field("Language", select("language-" + index, deckConfig.languages.map(l => ({ value: l.code2, label: l.name })), item.language))}${deckCheckbox("forced-" + index, "Forced", deckBool(item.forced))}${deckCheckbox("hi-" + index, "Hearing impaired", deckBool(item.hi))}${deckCheckbox("audio-exclude-" + index, "Skip when audio matches", deckBool(item.audio_exclude))}${deckCheckbox("audio-include-" + index, "Only when audio matches", deckBool(item.audio_only_include))}${button("Remove", 'type="button" data-remove-language-row="true"')}</div>`;
}

function deckParseCues(content) {
  return String(content).replaceAll("\r", "").split(/\n\s*\n/).flatMap(block => {
    const lines = block.split("\n"), i = lines.findIndex(l => l.includes("-->"));
    return i < 0 ? [] : [{ time: lines[i], text: lines.slice(i + 1).join("\n") }];
  });
}
function deckCuePreview(content) {
  const cues = deckParseCues(content);
  return cues.length ? `<div class="cue-preview">${cues.slice(0, 150).map((c, i) => `<div class="subtitle-cue"><small>${i + 1} · ${esc(c.time)}</small><p>${esc(c.text)}</p></div>`).join("")}</div><small class="muted">${cues.length} cues${cues.length > 150 ? " · showing the first 150" : ""}</small>` : '<p class="section-note">Cue preview supports SRT and VTT. Styled formats remain editable as text.</p>';
}
subtitleEditor = async index => {
  const [, kind, id] = route.split("/"), track = viewData.item.subtitles.filter(t => t.path)[index];
  const response = await get("subtitle-content?" + new URLSearchParams({ kind, id, path: track.path }));
  const key = "deck-subtitle-draft:" + kind + ":" + id + ":" + track.path, draft = sessionStorage.getItem(key), content = draft ?? response.content;
  showDialog(`<h2 class="dialog-title">Edit ${esc(track.name)} subtitle</h2><p class="small file-path">${esc(track.path.split(/[\\/]/).pop())}</p>${draft ? '<p class="notice">Your unsaved draft has been restored.</p>' : ""}<form id="subtitle-edit-form" data-path="${esc(track.path)}" data-draft-key="${esc(key)}"><div class="subtitle-edit-layout"><div>${field("Subtitle text", `<textarea name="content" class="subtitle-text" spellcheck="false">${esc(content)}</textarea>`)}</div><div><h3 class="subheading">Edited preview</h3><div id="edited-cue-preview">${deckCuePreview(content)}</div><details><summary>Compare with saved version</summary>${deckCuePreview(response.content)}</details></div></div><div class="inline-actions">${button("Save subtitle", 'type="submit"', true)}${button("Cancel", 'type="button" data-dialog-close="true"')}</div></form>`);
};
async function deckPreviewTrack(index, shift = false) {
  const [, kind, id] = route.split("/"), track = viewData.item.subtitles.filter(t => t.path)[index];
  const response = await get("subtitle-content?" + new URLSearchParams({ kind, id, path: track.path }));
  showDialog(`<h2 class="dialog-title">${shift ? "Shift timing" : "Preview subtitle"}</h2><p class="small file-path">${esc(track.path.split(/[\\/]/).pop())}</p>${shift ? `<form id="subtitle-shift-form" data-path="${esc(track.path)}">${field("Offset · seconds", input("seconds", "0", "number", 'step="0.1" min="-600" max="600" required'))}<p class="section-note">Positive values show subtitles later; negative values show them earlier. Deck saves a backup before applying the shift.</p>${button("Apply timing shift", 'type="submit"', true)}</form>` : ""}${deckCuePreview(response.content)}`);
}

const deckOriginalRender = render;
render = async () => {
  const parts = route.split("/"), custom = ["imports", "watch", "player", "alerts", "configure"].includes(parts[0]);
  if (!custom) { await deckOriginalRender(); return; }
  const id = ++renderId; renderNav(); if (!data) return;
  $("#crumb").textContent = { imports: "Imports", watch: "Watch", player: "Watch", alerts: "Alerts", configure: "Configuration" }[parts[0]];
  $("#main").innerHTML = loading();
  try {
    if (parts[0] === "imports" && parts[1]) return await deckShowImport(parts[1], { queueId: parts[2] });
    if (parts[0] === "player") return await deckPlayerView(parts[1]);
    const endpoint = parts[0] === "configure" ? parts[1] === "bazarr" ? "bazarr-configuration" : "configuration?service=" + parts[1] : parts[0] === "watch" ? "watch?user=" + encodeURIComponent(deckUser) : parts[0];
    const result = await get(endpoint); if (id !== renderId) return; viewData = result;
    $("#main").innerHTML = parts[0] === "imports" ? deckImportView(result) : parts[0] === "alerts" ? deckAlertsView(result) : parts[0] === "watch" ? deckWatchView(result) : deckConfigView(parts[1], result);
  } catch (e) { if (id === renderId) $("#main").innerHTML = `<div class="error-box"><h2>Could not load this workspace</h2><p>${esc(e.message)}</p>${button("Try again", 'data-retry-view="true"')}</div>`; }
};

function deckSelect(kind, key, checked) {
  if (!checked) deckSelection[kind].delete(key);
  else if (kind === "library") { const [n, id] = key.split(":"); const m = data.library.find(m => m.service === n && m.id === Number(id)); if (m) deckSelection[kind].set(key, { service: n, id: Number(id), title: m.title }); }
  else if (kind === "downloads") { const t = data.torrents.find(t => t.hash === key); if (t) deckSelection[kind].set(key, { hash: key, title: t.name }); }
  else { const [type, id] = key.split(":"); deckSelection[kind].set(key, { kind: type, id: Number(id), title: document.querySelector(`[data-select-key="${key}"]`)?.getAttribute("aria-label")?.replace(/^Select /, "") || key }); }
  if ($("#bulk-count")) $("#bulk-count").textContent = deckSelection[kind].size + " selected";
}
async function deckBulkDialog(kind) {
  const selection = [...deckSelection[kind === "subtitleProfile" ? "subtitles" : "library"].values()];
  if (!selection.length) return toast("Select titles first", true);
  let content = "";
  if (kind === "monitor") content = field("Monitoring", select("monitored", [{ value: "true", label: "Monitor selected titles" }, { value: "false", label: "Stop monitoring selected titles" }], "true"));
  else if (kind === "profile") {
    for (const n of [...new Set(selection.map(i => i.service))]) { const options = await get("options?service=" + n); content += field(service(n).name + " quality profile", select("profile-" + n, options.profiles.map(p => ({ value: p.id, label: p.name })), options.profiles[0]?.id)); }
  } else { const config = await get("bazarr-configuration"); content = field("Language profile", select("profileId", [{ value: "none", label: "No profile" }, ...config.profiles.map(p => ({ value: p.profileId, label: p.name }))], config.profiles[0]?.profileId)); }
  showDialog(`<h2 class="dialog-title">Update ${selection.length} titles</h2><form id="bulk-settings-form" data-kind="${kind}">${content}${button("Apply to selected titles", 'type="submit"', true)}</form>`);
}
async function deckRunBulk(body, kind, buttonElement) {
  const items = [...deckSelection[kind].values()]; if (!items.length) return toast("Select items first", true);
  const result = await afterAction({ action: "bulk", ...body, items, label: `${items.length} items · ${body.kind === "torrent" ? body.operation : body.kind}` }, buttonElement, false);
  if (result) { deckSelection[kind].clear(); if ($("#dialog").open) $("#dialog").close(); await render(); }
}

document.addEventListener("click", async event => {
  const target = event.target.closest("button,a"); if (!target) return;
  const v = target.dataset;
  try {
    if (v.discardNavigation) {
      const next = deckPendingNavigation; deckPendingNavigation = null; viewDirty = false;
      for (const form of document.querySelectorAll("#main form[data-dirty]")) form.dataset.dirty = "false";
      $("#dialog").close();
      if (next.hash) location.hash = next.hash;
      else if (next.tab) { detailTab = next.tab; await render(); }
      else await refresh();
    }
    else if (v.selectShown) for (const el of document.querySelectorAll(`[data-select-kind="${v.selectShown}"]`)) { el.checked = true; deckSelect(v.selectShown, el.dataset.selectKey, true); }
    else if (v.clearSelection) { deckSelection[v.clearSelection].clear(); for (const el of document.querySelectorAll(`[data-select-kind="${v.clearSelection}"]`)) el.checked = false; if ($("#bulk-count")) $("#bulk-count").textContent = "0 selected"; }
    else if (v.bulkDialog) await deckBulkDialog(v.bulkDialog);
    else if (v.bulkTorrent) await deckRunBulk({ kind: "torrent", operation: v.bulkTorrent }, "downloads", target);
    else if (v.bulkSubtitles) await deckRunBulk({ kind: "subtitles" }, "subtitles", target);
    else if (v.createConnection) await deckCreateConnection(v.createConnection);
    else if (v.testNewConnection) await afterAction({ action: "connectionCreate", operation: "test", service: deckConnection.service, type: deckConnection.type, token: deckConnection.token, index: deckConnection.index, preset: deckConnection.preset, ...deckConnectionValues($("#new-connection-form")) }, target, false);
    else if (v.advancedProfile) deckQualityDialog(v.advancedProfile);
    else if (v.customFormat) deckFormatDialog(v.customFormat);
    else if (v.addFormatCondition) { deckFormatCapture(); const schema = deckConfig.formatSchemas[0]; deckFormat.specifications.push(structuredClone(schema)); deckFormatRender(); }
    else if (v.removeFormatCondition !== undefined) { deckFormatCapture(); deckFormat.specifications.splice(Number(v.removeFormatCondition), 1); deckFormatRender(); }
    else if (v.qualityMove !== undefined) { deckCaptureQuality(); const i = Number(v.qualityMove), j = i + Number(v.direction); [deckQuality.items[i], deckQuality.items[j]] = [deckQuality.items[j], deckQuality.items[i]]; deckRenderQuality(); }
    else if (v.editProvider) deckProviderDialog(v.editProvider);
    else if (v.languageProfile) deckLanguageProfile(v.languageProfile);
    else if (v.addProfileLanguage) { const i = $("#language-profile-items").children.length; $("#language-profile-items").insertAdjacentHTML("beforeend", deckLanguageRow({ language: "en" }, i)); }
    else if (v.removeLanguageRow) target.closest(".language-profile-row").remove();
    else if (v.ackAlert) await afterAction({ action: "alertAcknowledge", id: v.ackAlert }, target);
    else if (v.recoverJob) await afterAction({ action: "recoverJob", id: v.recoverJob }, target);
    else if (v.subtitlePreview !== undefined) await deckPreviewTrack(Number(v.subtitlePreview));
    else if (v.subtitleShift !== undefined) await deckPreviewTrack(Number(v.subtitleShift), true);
    else if (v.startPlayer) await deckStartPlayer(target);
    else if (v.playerPlay) { await $("#deck-player").play(); $("#player-message").innerHTML = ""; await deckSavePlayback("start"); }
    else if (v.browserNotifications) {
      if (localStorage.getItem("deck-notifications") === "true") localStorage.setItem("deck-notifications", "false");
      else { if (!("Notification" in window)) throw Error("Browser notifications are unavailable. The Alerts inbox still works."); const permission = await Notification.requestPermission(); if (permission !== "granted") throw Error("Browser permission was not granted. The Alerts inbox still works."); localStorage.setItem("deck-notifications", "true"); }
      await render();
    }
  } catch (e) { toast(e.message, true); }
});
document.addEventListener("change", async event => {
  const t = event.target;
  try {
    if (t.dataset.selectKind) deckSelect(t.dataset.selectKind, t.dataset.selectKey, t.checked);
    else if (t.id === "subtitle-result-language" || t.id === "subtitle-result-provider") { if (t.id === "subtitle-result-language") detailQuery = t.value; else window.subtitleProviderFilter = t.value; const [, kind, id] = route.split("/"); $("#subtitle-pane").innerHTML = subtitleResults(subtitleSearches.get(kind + ":" + id), kind, id); }
    else if (t.name === "schema" && t.closest("#new-connection-form")) deckConnectionForm(Number(t.value));
    else if (t.name === "preset" && t.closest("#new-connection-form")) { deckConnection.preset = Number(t.value); deckConnectionForm(deckConnection.index, Number(t.value)); }
    else if (t.dataset.formatCondition !== undefined) { const i = Number(t.dataset.formatCondition), implementation = t.value; deckFormatCapture(); deckFormat.specifications[i] = structuredClone(deckConfig.formatSchemas.find(s => s.implementation === implementation)); deckFormatRender(); }
    else if (t.name === "watchUser") { deckUser = t.value; localStorage.setItem("deck-watch-user", deckUser); await render(); }
    else if (t.name?.startsWith("title-") && t.closest("#manual-import-form") && deckImportPlan.service === "sonarr") { const id = t.name.slice(6), episodes = t.value ? await get(`import-episodes?service=sonarr&id=${t.value}`) : []; document.querySelector(`[data-import-episodes="${id}"]`).innerHTML = deckEpisodeChoices(episodes, [], id); }
    else if (t.name === "file" && t.closest("#subtitle-upload-form")) {
      const file = t.files[0]; if (!file) return;
      const content = await file.text(); let container = $("#upload-cue-preview"); if (!container) { container = document.createElement("div"); container.id = "upload-cue-preview"; t.closest("form").append(container); }
      const form = t.closest("form"), lang = form.elements.language.value, forced = form.elements.forced.checked, hi = form.elements.hi.checked;
      const existing = viewData.item.subtitles.find(s => s.path && s.code2 === lang && !!s.forced === forced && !!s.hi === hi);
      let old = "";
      if (existing) { const [, kind, id] = route.split("/"); const original = await get("subtitle-content?" + new URLSearchParams({ kind, id, path: existing.path })); old = `<div><h3>Current subtitle</h3>${deckCuePreview(original.content)}</div>`; }
      container.innerHTML = `<div class="subtitle-compare">${old}<div><h3>Replacement preview</h3>${deckCuePreview(content)}</div></div>`;
    }
  } catch (e) { toast(e.message, true); }
});
document.addEventListener("input", event => {
  const form = event.target.closest("form");
  if (form?.id === "subtitle-edit-form") { sessionStorage.setItem(form.dataset.draftKey, form.elements.content.value); $("#edited-cue-preview").innerHTML = deckCuePreview(form.elements.content.value); }
  if (form && $("#main").contains(form)) form.dataset.dirty = "true";
});
document.addEventListener("submit", async event => {
  const form = event.target, supported = ["inspect-import-form", "manual-import-form", "bulk-settings-form", "new-connection-form", "edit-native-connection", "advanced-quality-form", "root-create-form", "allowed-hosts-form", "subtitle-provider-form", "language-profile-form", "subtitle-defaults-form", "alert-settings-form", "subtitle-shift-form", "player-tracks-form", "custom-format-form"];
  if (!supported.includes(form.id)) return;
  event.preventDefault();
  const values = formObject(form), submit = form.querySelector('button[type="submit"]');
  let body;
  try {
    if (form.id === "inspect-import-form") { viewDirty = false; return await deckShowImport(values.service, { folder: values.folder }); }
    if (form.id === "player-tracks-form") return await deckStartPlayer(submit);
    if (form.id === "manual-import-form") {
      const files = [...form.querySelectorAll("[data-import-id]")].filter(el => form.elements["include-" + el.dataset.importId].checked).map(el => { const id = el.dataset.importId; return { id: Number(id), titleId: Number(values["title-" + id]), qualityId: Number(values["quality-" + id]), languageId: Number(values["language-" + id]), episodeIds: [...el.querySelectorAll('[name^="episode-"]:checked')].map(i => Number(i.name.split("-").at(-1))) }; });
      body = { action: "manualImport", service: deckImportPlan.service, token: deckImportPlan.token, files, mode: values.mode };
    } else if (form.id === "bulk-settings-form") return await deckRunBulk({ kind: form.dataset.kind, monitored: values.monitored === "true", profiles: { radarr: values["profile-radarr"], sonarr: values["profile-sonarr"] }, profileId: values.profileId }, form.dataset.kind === "subtitleProfile" ? "subtitles" : "library", submit);
    else if (form.id === "new-connection-form") body = { action: "connectionCreate", service: deckConnection.service, type: deckConnection.type, token: deckConnection.token, index: deckConnection.index, preset: deckConnection.preset, ...deckConnectionValues(form) };
    else if (form.id === "edit-native-connection") body = { action: "connectionSave", service: form.dataset.service, type: form.dataset.type, id: Number(form.dataset.id), ...deckConnectionValues(form) };
    else if (form.id === "advanced-quality-form") {
      deckCaptureQuality(); const p = deckQuality;
      body = { action: "profileAdvanced", service: p.service, id: p.id, name: p.name, cutoff: p.cutoff, upgradeAllowed: p.upgradeAllowed, minFormatScore: p.minFormatScore, cutoffFormatScore: p.cutoffFormatScore, minUpgradeFormatScore: p.minUpgradeFormatScore, order: p.items.map(i => i.items?.length ? "group:" + i.id : "quality:" + i.quality.id), allowed: p.items.flatMap(i => i.items?.length ? i.items : [i]).filter(i => i.allowed).map(i => i.quality.id), scores: Object.fromEntries((p.formatItems || []).map(f => [f.format, f.score])) };
    } else if (form.id === "custom-format-form") { deckFormatCapture(); body = { action: "customFormat", service: deckFormat.service, id: deckFormat.id, name: deckFormat.name, includeWhenRenaming: deckFormat.includeCustomFormatWhenRenaming, conditions: deckFormat.specifications.map(s => ({ id: s.id, name: s.name, implementation: s.implementation, required: s.required, negate: s.negate, fields: Object.fromEntries(s.fields.map(f => [f.name, f.value])) })) }; }
    else if (form.id === "root-create-form") body = { action: "rootCreate", service: form.dataset.service, path: values.path };
    else if (form.id === "allowed-hosts-form") body = { action: "hosts", service: form.dataset.service, hosts: values.hosts };
    else if (form.id === "subtitle-provider-form") body = { action: "bazarrProvider", provider: form.dataset.provider, enabled: !!values.enabled, fields: deckConnectionValues(form).fields };
    else if (form.id === "language-profile-form") {
      const rows = [...form.querySelectorAll(".language-profile-row")];
      body = { action: "languageProfile", id: form.dataset.id || undefined, name: values.name, cutoff: values.cutoff, items: rows.map(el => ({ language: el.querySelector("select").value, forced: el.querySelector('[name^="forced-"]').checked, hi: el.querySelector('[name^="hi-"]').checked, audio_exclude: el.querySelector('[name^="audio-exclude-"]').checked, audio_only_include: el.querySelector('[name^="audio-include-"]').checked })), originalFormat: !!values.originalFormat, mustContain: values.mustContain.split(",").map(s => s.trim()).filter(Boolean), mustNotContain: values.mustNotContain.split(",").map(s => s.trim()).filter(Boolean) };
    } else if (form.id === "subtitle-defaults-form") body = { action: "subtitleDefaults", movie: values.movie, series: values.series, movieEnabled: !!values.movieEnabled, seriesEnabled: !!values.seriesEnabled };
    else if (form.id === "alert-settings-form") body = { action: "alertSettings", ...values };
    else if (form.id === "subtitle-shift-form") { const result = await runSubtitle("shift", submit, { path: form.dataset.path, seconds: Number(values.seconds) }); if (result) $("#dialog").close(); return; }
    const result = await afterAction(body, submit, false);
    if (result) { form.dataset.dirty = "false"; if ($("#dialog").contains(form)) $("#dialog").close(); if (body.action === "manualImport") { location.hash = "imports"; if (route === "imports") await render(); } else await render(); }
  } catch (e) { toast(e.message, true); }
});

document.addEventListener("click", event => {
  const target = event.target.closest("a,button");
  if (!target || $("#dialog").open || !viewDirty || !$("#main form[data-dirty='true']")) return;
  const hash = target.getAttribute("href"), tab = target.dataset.tab;
  if (!(hash?.startsWith("#") && hash !== location.hash || tab || target.id === "refresh")) return;
  event.preventDefault(); event.stopImmediatePropagation();
  deckPendingNavigation = { hash, tab, refresh: target.id === "refresh" };
  showDialog(`<h2 class="dialog-title">Unsaved changes</h2><p class="section-note">Save this form before leaving, or discard the edits.</p><div class="inline-actions">${button("Keep editing", 'data-dialog-close="true"', true)}${button("Discard & continue", 'data-discard-navigation="true"')}</div>`);
}, { capture: true });

$("#dialog").addEventListener("close", () => { viewDirty = !!$("#main form[data-dirty='true']"); });
window.addEventListener("hashchange", () => { if (deckPlayback && location.hash !== "#player/" + deckPlayback.item.id) { const old = { ...deckPlayback, position: $("#deck-player")?.currentTime || 0 }; old.hls?.destroy(); deckPlayback = null; deckSavePlayback("stop", false, old); } }, { capture: true });
window.addEventListener("pagehide", () => deckSavePlayback("stop"));
window.addEventListener("beforeunload", event => { if (viewDirty) { event.preventDefault(); event.returnValue = ""; } });
async function deckPollAlerts() {
  try {
    const state = await get("alerts"), active = state.records.filter(r => !r.resolvedAt && !r.acknowledged);
    if (deckAlertsPrimed && localStorage.getItem("deck-notifications") === "true" && "Notification" in window && Notification.permission === "granted") for (const alert of active.filter(a => !deckAlertIds.has(a.id))) { const notification = new Notification(alert.title, { body: alert.detail, tag: alert.key }); notification.onclick = () => { location.hash = alert.route; window.focus(); }; }
    deckAlertIds = new Set(active.map(a => a.id)); deckAlertsPrimed = true;
    const link = document.querySelector('a[href="#alerts"]'); if (link) { link.querySelector(".count")?.remove(); if (active.length) link.insertAdjacentHTML("beforeend", `<span class="count attention-count">${active.length}</span>`); }
  } catch {}
}
window.addEventListener("DOMContentLoaded", deckPollAlerts);
setInterval(() => { if (!document.hidden) deckPollAlerts(); }, 20000);
