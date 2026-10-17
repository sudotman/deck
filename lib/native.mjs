import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { tokenStore, actionKey } from "./storage.mjs";
import { shiftSubtitles } from "./subtitles.mjs";
import { mediaRequests } from "./requests.mjs";
import { releaseChoices } from "./release-choices.mjs";

const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const query = (values) =>
  new URLSearchParams(
    Object.entries(values).filter(([, value]) => value !== undefined),
  ).toString();
const bool = (value) =>
  value === true || String(value).toLowerCase() === "true";
const positive = (value) => {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw Error("Choose a valid item");
  return id;
};
const arrService = (name) => {
  if (!["radarr", "sonarr"].includes(name))
    throw Error("Choose movies or series");
  return name;
};
const secretField = (field) =>
  (field.privacy !== undefined && field.privacy !== 0) ||
  /password|apikey|token|passkey|secret/i.test(field.name);
const cleanConnection = (item) => ({
  id: item.id,
  name: item.name,
  enable: item.enable,
  protocol: item.protocol,
  priority: item.priority,
  implementation: item.implementation,
  fields: (item.fields || []).map((field) => ({
    name: field.name,
    label: field.label,
    type: field.type,
    value: secretField(field) ? "" : field.value,
    secret: !!secretField(field),
    selectOptions: field.selectOptions,
  })),
});

export function nativeControls({
  api,
  safe,
  cache,
  jobs,
  services,
  media,
  directory,
}) {
  const requests = mediaRequests({ api });
  const choices = releaseChoices({ api, directory });
  const backupDirectory = directory
    ? path.join(directory, "data", "subtitle-backups")
    : null;
  if (backupDirectory) fs.mkdirSync(backupDirectory, { recursive: true });
  function backups(kind, id) {
    if (!backupDirectory) return [];
    return fs
      .readdirSync(backupDirectory)
      .filter((name) => name.endsWith(".json"))
      .flatMap((name) => {
        try {
          const entry = JSON.parse(
            fs.readFileSync(path.join(backupDirectory, name), "utf8"),
          );
          return entry.kind === kind && entry.mediaId === Number(id)
            ? [entry]
            : [];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 20);
  }
  function backupTracks(kind, id, item) {
    if (!backupDirectory) return;
    for (const track of item.subtitles || []) {
      if (!track.path || !fs.existsSync(track.path)) continue;
      const backupId = crypto.randomUUID();
      const filename = track.path.split(/[\\/]/).pop();
      fs.copyFileSync(
        track.path,
        path.join(backupDirectory, backupId + ".bin"),
      );
      fs.writeFileSync(
        path.join(backupDirectory, backupId + ".json"),
        JSON.stringify({
          backupId,
          kind,
          mediaId: Number(id),
          filename,
          language: track.code2,
          forced: track.forced,
          hi: track.hi,
          createdAt: new Date().toISOString(),
          size: fs.statSync(track.path).size,
        }),
        { mode: 0o600 },
      );
    }
  }
  const candidates = tokenStore(directory, "subtitle-searches");
  const releases = tokenStore(directory, "release-searches");
  const scheduledCommands = [
    "CheckHealth",
    "RssSync",
    "RefreshMonitoredDownloads",
    "Backup",
    "UpdateSceneMapping",
    "RefreshCollections",
    "ApplicationUpdateCheck",
    "ApplicationCheckUpdate",
    "IndexerDefinitionUpdate",
  ];
  const arrPath = (name) =>
    "/api/v3/" + (name === "radarr" ? "movie" : "series");
  async function bazarrItem(kind, id) {
    positive(id);
    const route =
      kind === "movie"
        ? "/api/movies?radarrid[]="
        : "/api/episodes?episodeid[]=";
    const response = await api("bazarr", route + id);
    const item = response.data?.[0];
    if (!item)
      throw Error(
        "This file is not indexed by Bazarr yet. Sync its library from Services.",
      );
    return item;
  }
  function subtitleParams(kind, item, values = {}) {
    return kind === "movie"
      ? { radarrid: item.radarrId, ...values }
      : {
          seriesid: item.sonarrSeriesId,
          episodeid: item.sonarrEpisodeId,
          ...values,
        };
  }
  const subtitleRoute = (kind) =>
    "/api/" + (kind === "movie" ? "movies" : "episodes") + "/subtitles";
  async function subtitleDetail(kind, id) {
    const item = await bazarrItem(kind, id);
    if (kind === "movie") {
      const choice = await choices.verify("radarr", id);
      if (choice?.imported && choice.includedSubtitles) { item.includedSubtitlesAccepted = true; item.releaseChoice = choice; item.missing_subtitles = []; }
    }
    const [history, profiles, languages] = await Promise.all([
      api(
        "bazarr",
        "/api/" +
          (kind === "movie" ? "movies" : "episodes") +
          "/history?" +
          query(
            kind === "movie"
              ? { radarrid: id, length: 30 }
              : { episodeid: id, length: 30 },
          ),
      ),
      api("bazarr", "/api/system/languages/profiles"),
      api("bazarr", "/api/system/languages"),
    ]);
    return {
      item,
      backups: backups(kind, id),
      history: history.data || [],
      profiles,
      languages: languages.filter((x) => x.enabled),
    };
  }
  async function subtitleTrack(body) {
    const item = await bazarrItem(body.kind, positive(body.id));
    const track = item.subtitles.find((x) => x.path === body.path && x.path);
    if (!track)
      throw Error("That subtitle track no longer exists. Refresh the film.");
    return { item, track };
  }
  async function bazarrOperation(
    endpoint,
    method,
    body,
    update,
    timeout = 240000,
    expectedTitle = "",
  ) {
    const readQueue = async () => {
      try {
        const payload = await api("bazarr", "/api/system/jobs");
        return Array.isArray(payload?.data) &&
          payload.data.every((job) => Number.isInteger(job.job_id))
          ? payload.data
          : null;
      } catch {
        return null;
      }
    };
    const before = await readQueue();
    const previousIds = new Set((before || []).map((job) => job.job_id));
    const response = await api(
      "bazarr",
      endpoint,
      method,
      body,
      false,
      timeout,
    );
    if (before === null) return response;
    let tracked = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = await readQueue();
      const added = (current || []).filter(
        (job) => !previousIds.has(job.job_id),
      );
      tracked = expectedTitle
        ? added.filter((job) =>
            job.job_name.toLowerCase().includes(expectedTitle.toLowerCase()),
          )
        : added;
      if (!tracked.length && added.length === 1) tracked = added;
      if (tracked.length) break;
      if (attempt < 4) await wait(500);
    }
    if (!tracked.length) return response;
    const ids = new Set(tracked.map((job) => job.job_id));
    update("Following Bazarr’s background task…", { bazarrJobIds: [...ids] });
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const queue = await readQueue();
      const current = (queue || []).filter((job) => ids.has(job.job_id));
      const failed = current.find((job) => job.status === "failed");
      if (failed)
        throw Error(
          failed.error ||
            failed.job_error ||
            failed.progress_message ||
            failed.job_name + " failed",
        );
      if (
        current.length === ids.size &&
        current.every((job) => job.status === "completed")
      )
        return response;
      const running =
        current.find((job) => job.status === "running") || current[0];
      update(
        running
          ? `${running.job_name} · ${running.status}${running.progress_message ? " · " + running.progress_message : ""}${running.progress_max ? " · " + Math.round((running.progress_value / running.progress_max) * 100) + "%" : ""}`
          : "Waiting for Bazarr to report completion…",
      );
      await wait(1500);
    }
    throw Error(
      "Bazarr is still working after the time limit. Check its live queue in Services before retrying.",
    );
  }
  async function searchSubtitles(kind, id, update) {
    update("Searching your subtitle providers. This can take a few minutes.");
    const response = await api(
      "bazarr",
      "/api/providers/" +
        (kind === "movie" ? "movies" : "episodes") +
        "?" +
        query(
          kind === "movie"
            ? { radarrid: positive(id) }
            : { episodeid: positive(id) },
        ),
      "GET",
      undefined,
      false,
      240000,
    );
    const token = crypto.randomUUID();
    // Bazarr returns opaque, serialized subtitle objects. Only download objects returned by a search.
    candidates.set(token, {
      kind,
      id: Number(id),
      results: response.data || [],
      expires: Date.now() + 1800000,
    });
    for (const [key, value] of candidates)
      if (value.expires < Date.now()) candidates.delete(key);
    return {
      token,
      results: (response.data || []).map(({ subtitle, ...result }, index) => ({
        ...result,
        index,
      })),
      message: `${response.data?.length || 0} matching subtitles found`,
    };
  }
  async function command(name, body, update) {
    if (name === "radarr" && body.name === "MoviesSearch" && choices.get(name, body.id)) throw Error("Clear this movie's selected release before running an automatic search");
    const allowed = {
      radarr: [
        "RefreshMovie",
        "MoviesSearch",
        "RescanMovie",
        "DownloadedMoviesScan",
        "RenameMovie",
      ],
      sonarr: [
        "RefreshSeries",
        "SeriesSearch",
        "RescanSeries",
        "EpisodeSearch",
        "SeasonSearch",
        "DownloadedEpisodesScan",
        "RenameSeries",
      ],
      prowlarr: ["ApplicationIndexerSync"],
    };
    if (
      !allowed[name]?.includes(body.name) &&
      !scheduledCommands.includes(body.name)
    )
      throw Error("Unsupported library task");
    const payload = { name: body.name };
    if (body.id) {
      if (name === "radarr") payload.movieIds = [positive(body.id)];
      if (name === "sonarr") payload.seriesId = positive(body.id);
    }
    if (body.episodeIds) payload.episodeIds = body.episodeIds.map(positive);
    if (body.seasonNumber !== undefined)
      payload.seasonNumber = Number(body.seasonNumber);
    const prefix = name === "prowlarr" ? "/api/v1" : "/api/v3";
    const task = await api(name, prefix + "/command", "POST", payload);
    update("Task running in " + name + "…", { commandId: task.id, commandService: name });
    for (let attempt = 0; attempt < 900; attempt++) {
      const current = await api(name, prefix + "/command/" + task.id);
      if (current.status === "completed") {
        cache.clear();
        return {
          commandId: task.id,
          message: current.message || "Task completed",
        };
      }
      if (["failed", "aborted", "cancelled"].includes(current.status))
        throw Error(current.message || "Service task failed");
      update(current.message || `${body.name} · ${current.status}`);
      await wait(2000);
    }
    throw Error(
      "The task is still running in the service after thirty minutes. Check Activity before retrying.",
    );
  }
  async function subtitleMutation(body, update) {
    const kind = body.kind === "movie" ? "movie" : "episode";
    const id = positive(body.id);
    if (body.operation === "search") return searchSubtitles(kind, id, update);
    if (body.operation === "restore") {
      const entry = backups(kind, id).find((x) => x.backupId === body.backupId);
      if (!entry) throw Error("Choose a backup belonging to this title");
      const item = await bazarrItem(kind, id);
      backupTracks(kind, id, item);
      const form = new FormData();
      form.append(
        "file",
        new Blob(
          [
            fs.readFileSync(
              path.join(backupDirectory, entry.backupId + ".bin"),
            ),
          ],
          { type: "text/plain" },
        ),
        entry.filename,
      );
      await bazarrOperation(
        subtitleRoute(kind) +
          "?" +
          query(
            subtitleParams(kind, item, {
              language: entry.language,
              forced: String(!!entry.forced),
              hi: String(!!entry.hi),
            }),
          ),
        "POST",
        form,
        update,
        120000,
        item.title,
      );
      return { message: "Subtitle backup restored" };
    }
    if (body.operation === "download") {
      const selected = candidates.get(body.token);
      if (
        !selected ||
        selected.expires < Date.now() ||
        selected.kind !== kind ||
        selected.id !== id
      )
        throw Error("Search results expired. Search again.");
      const result = selected.results[Number(body.index)];
      if (!result) throw Error("Choose a subtitle result");
      const item = await bazarrItem(kind, id);
      backupTracks(kind, id, item);
      update(
        "Downloading from " +
          result.provider +
          " and checking the saved track…",
      );
      await bazarrOperation(
        "/api/providers/" +
          (kind === "movie" ? "movies" : "episodes") +
          "?" +
          query(
            subtitleParams(kind, item, {
              provider: result.provider,
              subtitle: result.subtitle,
              hi: String(bool(result.hearing_impaired)),
              forced: String(bool(result.forced)),
              original_format: String(bool(result.original_format)),
            }),
          ),
        "POST",
        undefined,
        update,
        240000,
        item.title,
      );
      const after = await bazarrItem(kind, id);
      const history = await api(
        "bazarr",
        "/api/" +
          (kind === "movie" ? "movies" : "episodes") +
          "/history?" +
          query(
            kind === "movie"
              ? { radarrid: id, length: 5 }
              : { episodeid: id, length: 5 },
          ),
      );
      if (!after.subtitles.some((x) => x.path))
        throw Error(
          "Bazarr finished the request but no external subtitle was indexed. Check provider status and path mapping.",
        );
      return {
        message: "Subtitle downloaded · " + result.provider,
        item: after,
        history: history.data || [],
      };
    }
    if (body.operation === "profile") {
      const profiles = await api("bazarr", "/api/system/languages/profiles");
      if (
        !profiles.some((x) => Number(x.profileId) === Number(body.profileId)) &&
        body.profileId !== "none"
      )
        throw Error("Choose an existing language profile");
      const item = await bazarrItem(kind, id);
      const q =
        kind === "movie"
          ? { radarrid: id, profileid: body.profileId }
          : { seriesid: item.sonarrSeriesId, profileid: body.profileId };
      await bazarrOperation(
        "/api/" + (kind === "movie" ? "movies" : "series") + "?" + query(q),
        "POST",
        undefined,
        update,
        240000,
        item.title,
      );
      return { message: "Language profile updated" };
    }
    if (body.operation === "scan" || body.operation === "automatic") {
      const item = await bazarrItem(kind, id);
      if (kind === "episode" && body.operation === "automatic") {
        for (const missing of item.missing_subtitles || []) {
          await bazarrOperation(
            subtitleRoute(kind) +
              "?" +
              query(
                subtitleParams(kind, item, {
                  language: missing.code2 || missing[0],
                  forced: String(!!missing.forced),
                  hi: String(!!missing.hi),
                }),
              ),
            "PATCH",
            undefined,
            update,
            240000,
            item.title,
          );
        }
        return {
          message: item.missing_subtitles?.length
            ? "Episode subtitle search completed"
            : "No missing subtitles for this episode",
        };
      }
      const q =
        kind === "movie"
          ? {
              radarrid: id,
              action:
                body.operation === "scan" ? "scan-disk" : "search-missing",
            }
          : {
              seriesid: item.sonarrSeriesId,
              action:
                body.operation === "scan" ? "scan-disk" : "search-missing",
            };
      await bazarrOperation(
        "/api/" + (kind === "movie" ? "movies" : "series") + "?" + query(q),
        "PATCH",
        undefined,
        update,
        240000,
        item.title,
      );
      return {
        message:
          body.operation === "scan"
            ? "Subtitle scan completed"
            : "Missing subtitle search completed",
      };
    }
    if (["upload", "edit", "shift"].includes(body.operation)) {
      const item = await bazarrItem(kind, id);
      let language = body.language,
        forced = !!body.forced,
        hi = !!body.hi,
        filename = body.filename,
        content = body.content;
      if (["edit", "shift"].includes(body.operation)) {
        const { track } = await subtitleTrack(body);
        language = track.code2;
        forced = track.forced;
        hi = track.hi;
        filename = track.path.split(/[\\/]/).pop();
        if (body.operation === "shift") {
          const existing = await read("subtitle-content", new URLSearchParams({ kind, id: String(id), path: track.path }));
          content = shiftSubtitles(existing.content, Number(body.seconds), existing.format);
        }
      }
      if (!/^[a-z]{2,3}$/.test(language))
        throw Error("Choose a subtitle language");
      if (!/\.(srt|ass|ssa|vtt|sub)$/i.test(filename || ""))
        throw Error("Choose an SRT, ASS, SSA, VTT, or SUB subtitle file");
      if (
        typeof content !== "string" ||
        !content.trim() ||
        Buffer.byteLength(content) > 3000000
      )
        throw Error("Subtitle content must be between 1 byte and 3 MB");
      backupTracks(kind, id, item);
      if (
        /\.srt$/i.test(filename) &&
        !/\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.]\d{3}/.test(
          content,
        )
      )
        throw Error("The SRT file needs valid subtitle timestamps");
      const form = new FormData();
      form.append(
        "file",
        new Blob([content], { type: "text/plain" }),
        filename,
      );
      await bazarrOperation(
        subtitleRoute(kind) +
          "?" +
          query(
            subtitleParams(kind, item, {
              language,
              forced: String(!!forced),
              hi: String(!!hi),
            }),
          ),
        "POST",
        form,
        update,
        120000,
        item.title,
      );
      return {
        message:
          ["edit", "shift"].includes(body.operation)
            ? "Subtitle changes saved"
            : "Subtitle uploaded",
        item: await bazarrItem(kind, id),
      };
    }
    const { item, track } = await subtitleTrack(body);
    const values = {
      language: track.code2,
      path: track.path,
      forced: String(track.forced),
      hi: String(track.hi),
    };
    if (["delete", "sync"].includes(body.operation))
      backupTracks(kind, id, item);
    if (body.operation === "delete") {
      await bazarrOperation(
        subtitleRoute(kind) + "?" + query(subtitleParams(kind, item, values)),
        "DELETE",
        undefined,
        update,
        240000,
        item.title,
      );
      return { message: "Subtitle removed" };
    }
    if (body.operation === "sync") {
      update("Synchronizing subtitle timing with the video…");
      await bazarrOperation(
        "/api/subtitles?" +
          query({
            ...values,
            forced: values.forced === "true" ? "True" : "False",
            hi: values.hi === "true" ? "True" : "False",
            type: kind,
            id,
            action: "sync",
            max_offset_seconds: Number(body.maxOffset) || 60,
          }),
        "PATCH",
        undefined,
        update,
        300000,
        item.title,
      );
      return { message: "Subtitle timing synchronized" };
    }
    throw Error("Unsupported subtitle operation");
  }
  async function mutation(body, update) {
    const name = body.service;
    let result;
    if (body.action === "subtitle")
      result = await subtitleMutation(body, update);
    else if (body.action === "command")
      result = await command(name, body, update);
    else if (body.action === "monitor" || body.action === "mediaSettings") {
      arrService(name);
      const item = await api(name, arrPath(name) + "/" + positive(body.id));
      if (body.monitored === true && choices.get(name, body.id)) throw Error("Clear the selected release before enabling automatic monitoring");
      if (body.monitored !== undefined) item.monitored = !!body.monitored;
      if (body.profileId !== undefined) {
        const profiles = await api(name, "/api/v3/qualityprofile");
        if (!profiles.some((p) => p.id === Number(body.profileId)))
          throw Error("Choose an existing quality profile");
        item.qualityProfileId = Number(body.profileId);
      }
      if (name === "sonarr" && body.seasons)
        item.seasons = item.seasons.map((season) => ({
          ...season,
          monitored:
            body.seasons[String(season.seasonNumber)] ?? season.monitored,
        }));
      if (
        name === "sonarr" &&
        ["standard", "daily", "anime"].includes(body.seriesType)
      )
        item.seriesType = body.seriesType;
      if (
        name === "radarr" &&
        ["announced", "inCinemas", "released"].includes(
          body.minimumAvailability,
        )
      )
        item.minimumAvailability = body.minimumAvailability;
      await api(name, arrPath(name) + "/" + item.id, "PUT", item);
      result = { message: "Library settings saved" };
    } else if (body.action === "episodeMonitor") {
      const ids = body.ids.map(positive);
      await api("sonarr", "/api/v3/episode/monitor", "PUT", {
        episodeIds: ids,
        monitored: !!body.monitored,
      });
      result = { message: "Episode monitoring updated" };
    } else if (body.action === "grabRelease") {
      const selected = releases.get(body.token);
      if (!selected || selected.expires < Date.now())
        throw Error("Release search expired. Search again.");
      if (body.service !== selected.service) throw Error("Choose a release from this library");
      const index = Number(body.index);
      if (!Number.isInteger(index) || index < 0) throw Error("Choose a valid release");
      const release = selected.results[index];
      if (!release || release.rejected && body.force !== true)
        throw Error("Choose an accepted release");
      if (body.force === true) {
        if (Number(body.id) !== selected.id) throw Error("Choose a release for this title");
        result = await choices.choose(selected, release, body, update);
      } else {
      if (choices.get(selected.service, selected.id)) throw Error("This movie has a selected release. Clear it or explicitly force-select a replacement.");
      await api(selected.service, "/api/v3/release", "POST", {
        guid: release.guid,
        indexerId: release.indexerId,
      });
      result = { message: "Release sent to the download client" };
      }
    } else if (body.action === "clearReleaseChoice") {
      result = await choices.clear(arrService(name), positive(body.id));
    } else if (body.action === "add") {
      arrService(name);
      const [roots, profiles] = await Promise.all([
        api(name, "/api/v3/rootfolder"),
        api(name, "/api/v3/qualityprofile"),
      ]);
      if (
        !roots.some((x) => x.path === body.root) ||
        !profiles.some((x) => x.id === Number(body.profile))
      )
        throw Error("Choose an existing folder and quality profile");
      const found = await api(
        name,
        arrPath(name) +
          "/lookup?term=" +
          encodeURIComponent(
            (name === "radarr" ? "tmdb:" : "tvdb:") + positive(body.externalId),
          ),
      );
      const item = found.find(
        (x) =>
          (name === "radarr" ? x.tmdbId : x.tvdbId) === Number(body.externalId),
      );
      if (!item) throw Error("Title not found");
      Object.assign(item, {
        rootFolderPath: body.root,
        qualityProfileId: Number(body.profile),
        monitored: true,
        seasonFolder: true,
        addOptions: {
          searchForMovie: !!body.search,
          searchForMissingEpisodes: !!body.search,
        },
      });
      await api(name, arrPath(name), "POST", item);
      result = { message: "Added to your library" };
    } else if (body.action === "torrent") {
      const hash = body.hash;
      if (!/^[a-f0-9]{40}$/i.test(hash)) throw Error("Choose a valid torrent");
      const operation = body.operation;
      const version = await api("qbittorrent", "/api/v2/app/version");
      const modern = parseInt(String(version).replace(/^v/i, ""), 10) >= 5;
      const operations = {
        pause: modern ? "stop" : "pause",
        resume: modern ? "start" : "resume",
        recheck: "recheck",
        reannounce: "reannounce",
        force: "setForceStart",
        category: "setCategory",
        limits: "setDownloadLimit",
        priority: "filePrio",
        delete: "delete",
      };
      if (!operations[operation]) throw Error("Unsupported download operation");
      const values = { hashes: hash };
      if (operation === "force") values.value = "true";
      if (operation === "category")
        values.category = String(body.category || "");
      if (operation === "delete")
        values.deleteFiles = String(!!body.deleteFiles);
      if (operation === "priority") {
        values.hash = hash;
        values.id = body.fileId;
        values.priority = Number(body.priority);
        if (![0, 1, 6, 7].includes(values.priority))
          throw Error("Choose a valid file priority");
      }
      if (operation === "limits") {
        const download = Number(body.downloadLimit),
          upload = Number(body.uploadLimit);
        if (![download, upload].every((x) => Number.isFinite(x) && x >= 0))
          throw Error("Speed limits must be positive or zero for unlimited");
        values.limit = Math.round(download * 1024);
        await api(
          "qbittorrent",
          "/api/v2/torrents/setUploadLimit",
          "POST",
          new URLSearchParams({
            hashes: hash,
            limit: Math.round(upload * 1024),
          }),
        );
      }
      await api(
        "qbittorrent",
        "/api/v2/torrents/" + operations[operation],
        "POST",
        new URLSearchParams(values),
      );
      result = {
        message:
          operation === "delete" ? "Torrent removed" : "Download updated",
      };
    } else if (body.action === "transferLimits") {
      for (const [field, endpoint] of [
        ["downloadLimit", "setDownloadLimit"],
        ["uploadLimit", "setUploadLimit"],
      ]) {
        const limit = Number(body[field]);
        if (!Number.isFinite(limit) || limit < 0)
          throw Error("Enter a valid speed limit");
        await api(
          "qbittorrent",
          "/api/v2/transfer/" + endpoint,
          "POST",
          new URLSearchParams({ limit: Math.round(limit * 1024) }),
        );
      }
      result = { message: "Global speed limits saved" };
    } else if (body.action === "queueRemove") {
      arrService(name);
      await api(
        name,
        "/api/v3/queue/" +
          positive(body.id) +
          "?" +
          query({
            removeFromClient: !!body.removeFromClient,
            blocklist: !!body.blocklist,
          }),
        "DELETE",
      );
      result = { message: "Import queue item removed" };
    } else if (body.action === "requestCreate") {
      result = await requests.create(body);
    } else if (body.action === "request") {
      if (!["approve", "decline", "retry"].includes(body.operation))
        throw Error("Unsupported request action");
      await api(
        "seerr",
        "/api/v1/request/" + positive(body.id) + "/" + body.operation,
        "POST",
        {},
      );
      result = { message: "Request updated" };
    } else if (body.action === "bazarrTask") {
      const tasks = await api("bazarr", "/api/system/tasks");
      if (!(tasks.data || []).some((t) => t.job_id === body.taskId))
        throw Error("Choose an existing subtitle task");
      await bazarrOperation(
        "/api/system/tasks?taskid=" + encodeURIComponent(body.taskId),
        "POST",
        undefined,
        update,
      );
      result = {
        message: "Subtitle task completed",
      };
    } else if (body.action === "indexer" || body.action === "connection") {
      const allowed = ["indexer", "downloadclient", "applications"];
      const type = body.action === "indexer" ? "indexer" : body.type;
      if (
        !allowed.includes(type) ||
        !["radarr", "sonarr", "prowlarr"].includes(name)
      )
        throw Error("Choose a valid connection");
      const prefix = name === "prowlarr" ? "/api/v1/" : "/api/v3/";
      const item = await api(name, prefix + type + "/" + positive(body.id));
      if (body.operation === "test") {
        await api(name, prefix + type + "/test", "POST", item);
        result = { message: "Connection test passed" };
      } else {
        if (body.enable !== undefined) item.enable = !!body.enable;
        if (body.name !== undefined) item.name = String(body.name);
        if (body.priority !== undefined)
          item.priority = Math.max(1, Math.min(50, Number(body.priority)));
        if (body.fields)
          item.fields = item.fields.map((field) => {
            const value = body.fields[field.name];
            return value === undefined || (secretField(field) && value === "")
              ? field
              : { ...field, value };
          });
        await api(name, prefix + type + "/" + item.id, "PUT", item);
        result = { message: "Connection settings saved" };
      }
    } else if (body.action === "qualityProfile") {
      arrService(name);
      const item = await api(
        name,
        "/api/v3/qualityprofile/" + positive(body.id),
      );
      if (body.name?.trim()) item.name = body.name.trim();
      item.upgradeAllowed = !!body.upgradeAllowed;
      const validCutoffs = item.items.flatMap((x) =>
        x.items?.length
          ? [x.id, ...x.items.map((y) => y.quality?.id)]
          : [x.quality?.id],
      );
      if (!validCutoffs.includes(Number(body.cutoff)))
        throw Error("Choose a quality from this profile");
      item.cutoff = Number(body.cutoff);
      await api(name, "/api/v3/qualityprofile/" + item.id, "PUT", item);
      result = { message: "Quality profile saved" };
    } else if (body.action === "jellyfinTask") {
      const tasks = await api("jellyfin", "/ScheduledTasks");
      if (!tasks.some((task) => task.Id === body.id))
        throw Error("Choose an existing Jellyfin task");
      await api(
        "jellyfin",
        "/ScheduledTasks/Running/" + encodeURIComponent(body.id),
        "POST",
      );
      result = { message: "Jellyfin task started" };
    } else if (body.action === "jellyfinPlayback") {
      if (!["Pause", "Unpause", "Stop"].includes(body.operation))
        throw Error("Choose a playback control");
      await api(
        "jellyfin",
        "/Sessions/" +
          encodeURIComponent(body.id) +
          "/Playing/" +
          body.operation,
        "POST",
      );
      result = { message: "Playback command sent" };
    } else if (body.action === "jellyfinScan") {
      await api("jellyfin", "/Library/Refresh", "POST");
      result = { message: "Jellyfin library scan started" };
    } else throw Error("Unsupported action");
    cache.clear();
    return result;
  }
  async function read(route, params) {
    if (["request-search", "request-details"].includes(route)) return requests.read(route, params);
    const name = params.get("service"),
      id = params.get("id");
    if (route === "media") {
      arrService(name);
      const item = await api(name, arrPath(name) + "/" + positive(id));
      const calls = {
        profiles: ["/api/v3/qualityprofile"],
        roots: ["/api/v3/rootfolder"],
        history: [
          "/api/v3/history?" +
            query(
              name === "radarr"
                ? {
                    movieId: id,
                    pageSize: 30,
                    sortKey: "date",
                    sortDirection: "descending",
                  }
                : {
                    seriesId: id,
                    pageSize: 30,
                    sortKey: "date",
                    sortDirection: "descending",
                  },
            ),
        ],
        files: [
          name === "radarr"
            ? "/api/v3/moviefile?movieId=" + id
            : "/api/v3/episodefile?seriesId=" + id,
        ],
      };
      if (name === "sonarr")
        calls.episodes = ["/api/v3/episode?seriesId=" + id];
      const response = { item };
      await Promise.all(
        Object.entries(calls).map(async ([key, [p]]) => {
          response[key] = await api(name, p);
        }),
      );
      response.releaseChoice = await choices.resolve(name, id, response.files || [], response.history?.records || []);
      return response;
    }
    if (route === "releases") {
      arrService(name);
      const q =
        name === "radarr"
          ? { movieId: positive(id) }
          : params.get("episodeId")
            ? { episodeId: positive(params.get("episodeId")) }
            : { seriesId: positive(id) };
      const results = await api(
        name,
        "/api/v3/release?" + query(q),
        "GET",
        undefined,
        false,
        180000,
      );
      const token = crypto.randomUUID();
      for (const [key, value] of releases)
        if (value.expires < Date.now()) releases.delete(key);
      releases.set(token, {
        service: name,
        id: positive(id),
        results,
        expires: Date.now() + 1800000,
      });
      return {
        token,
        results: results.map(
          ({ guid, downloadUrl, magnetUrl, ...r }, index) => ({ ...r, index }),
        ),
      };
    }
    if (route === "subtitle-library") {
      const [movies, series, wanted, profiles, providers] = await Promise.all([
        api("bazarr", "/api/movies?length=10000"),
        api("bazarr", "/api/series?length=10000"),
        api("bazarr", "/api/episodes/wanted?length=10000"),
        api("bazarr", "/api/system/languages/profiles"),
        api("bazarr", "/api/providers"),
      ]);
      const episodeReads = await Promise.all((series.data || []).map(show => api("bazarr", "/api/episodes?seriesid[]=" + show.sonarrSeriesId + "&length=10000")));
      const episodes = { data: episodeReads.flatMap(r => r.data || []) };
      for (const movie of movies.data || []) {
        const choice = await choices.verify("radarr", movie.radarrId);
        if (choice?.imported && choice.includedSubtitles) { movie.includedSubtitlesAccepted = true; movie.releaseChoice = choice; movie.missing_subtitles = []; }
      }
      return {
        movies: movies.data || [],
        series: (series.data || []).map(show => {
          const items = (episodes.data || []).filter(e => e.sonarrSeriesId === show.sonarrSeriesId);
          return { ...show, subtitleEpisodeCount: items.filter(e => e.subtitles?.length).length,
            missingSubtitleEpisodeCount: items.filter(e => e.missing_subtitles?.length).length };
        }),
        episodes: wanted.data || [],
        profiles,
        providers: providers.data || [],
      };
    }
    if (route === "subtitle-episodes")
      return api("bazarr", "/api/episodes?seriesid[]=" + positive(id));
    if (route === "subtitle-detail")
      return subtitleDetail(
        params.get("kind") === "movie" ? "movie" : "episode",
        positive(id),
      );
    if (route === "subtitle-content") {
      const { track } = await subtitleTrack({
        kind: params.get("kind"),
        id,
        path: params.get("path"),
      });
      if (fs.existsSync(track.path))
        return {
          content: fs.readFileSync(track.path, "utf8"),
          format: track.path.split(".").pop(),
        };
      if (!track.path.toLowerCase().endsWith(".srt"))
        throw Error(
          "Editing styled subtitles requires Deck to run on the media PC. You can upload a replacement file instead.",
        );
      const response = await api(
        "bazarr",
        "/api/subtitles/contents?subtitlePath=" +
          encodeURIComponent(track.path),
      );
      const time = (t) =>
        [t.hours, t.minutes, t.seconds]
          .map((n) => String(n).padStart(2, "0"))
          .join(":") +
        "," +
        String(Math.round(t.microseconds / 1000)).padStart(3, "0");
      return {
        content: response.data
          .map(
            (cue, i) =>
              `${cue.index || i + 1}\n${time(cue.start)} --> ${time(cue.end)}${cue.proprietary ? " " + cue.proprietary : ""}\n${cue.content}\n`,
          )
          .join("\n"),
        format: "srt",
      };
    }
    if (route === "subtitle-search") {
      const kind = params.get("kind"), id = Number(params.get("id"));
      const match = [...candidates].filter(([, value]) => value.kind === kind && value.id === id && value.expires > Date.now()).at(-1);
      if (!match) return null;
      const [token, value] = match;
      return { token, expires: value.expires, results: value.results.map(({ subtitle, ...r }, index) => ({ ...r, index })) };
    }
    if (route === "torrent") {
      const hash = params.get("hash");
      if (!/^[a-f0-9]{40}$/i.test(hash)) throw Error("Choose a valid torrent");
      const [properties, files, trackers, categories, dlLimit, upLimit] =
        await Promise.all([
          api("qbittorrent", "/api/v2/torrents/properties?hash=" + hash),
          api("qbittorrent", "/api/v2/torrents/files?hash=" + hash),
          api("qbittorrent", "/api/v2/torrents/trackers?hash=" + hash),
          api("qbittorrent", "/api/v2/torrents/categories"),
          api("qbittorrent", "/api/v2/torrents/downloadLimit?hashes=" + hash),
          api("qbittorrent", "/api/v2/torrents/uploadLimit?hashes=" + hash),
        ]);
      return {
        properties,
        files,
        trackers: trackers.map(({ url, ...t }) => ({
          ...t,
          url: url.replace(/([?&](?:passkey|apikey|token)=)[^&]+/gi, "$1••••"),
        })),
        categories,
        downloadLimit: dlLimit[hash],
        uploadLimit: upLimit[hash],
      };
    }
    if (route === "requests") {
      const requests = await api(
        "seerr",
        "/api/v1/request?take=100&sort=added&filter=" +
          encodeURIComponent(params.get("filter") || "all"),
      );
      // One title Seerr cannot look up (for example while it warms up after a restart)
      // should not hide every other request.
      const lookupErrors = [];
      return {
        ...requests,
        errors: lookupErrors,
        results: await Promise.all(
          (requests.results || []).map(async (r) => {
            const item = await api(
              "seerr",
              "/api/v1/" +
                (r.type === "tv" ? "tv" : "movie") +
                "/" +
                r.media.tmdbId,
            ).catch((error) => {
              lookupErrors.push({ service: "seerr", section: `Request ${r.id}`, message: error.message });
              return { title: `${r.type === "tv" ? "Series" : "Movie"} · TMDB ${r.media.tmdbId}` };
            });
            return {
              id: r.id,
              type: r.type,
              title: item.title || item.name,
              year: (item.releaseDate || item.firstAirDate || "").slice(0, 4),
              overview: item.overview,
              status: r.status,
              tmdbId: r.media.tmdbId,
              tvdbId: item.externalIds?.tvdbId,
              libraryId: r.type === "tv" ? r.media.externalServiceId : r.media.externalServiceId,
              mediaStatus: r.media.status,
              requestedBy:
                r.requestedBy?.displayName || r.requestedBy?.username,
              createdAt: r.createdAt,
              seasons: r.seasons,
            };
          }),
        ),
      };
    }
    if (route === "service-detail") {
      if (["radarr", "sonarr", "prowlarr"].includes(name)) {
        const prefix = name === "prowlarr" ? "/api/v1/" : "/api/v3/";
        const result = { errors: [] };
        const paths = {
          health: "health",
          tasks: "system/task",
          commands: "command",
          indexers: "indexer",
          connections: "downloadclient",
          logs: "log?pageSize=40&sortDirection=descending",
        };
        if (name !== "prowlarr") {
          paths.profiles = "qualityprofile";
          paths.roots = "rootfolder";
        } else {
          paths.applications = "applications";
          paths.indexerStatus = "indexerstatus";
        }
        await Promise.all(
          Object.entries(paths).map(async ([key, p]) => {
            try {
              const response = await api(name, prefix + p);
              result[key] = [
                "indexers",
                "connections",
                "applications",
              ].includes(key)
                ? response.map(cleanConnection)
                : key === "tasks"
                  ? response.map((task) => ({
                      ...task,
                      canRun:
                        scheduledCommands.includes(task.taskName) ||
                        [
                          "RefreshMovie",
                          "RefreshSeries",
                          "ApplicationIndexerSync",
                        ].includes(task.taskName),
                    }))
                  : response;
            } catch (error) {
              result.errors.push({ section: key, message: error.message });
            }
          }),
        );
        return result;
      }
      if (name === "bazarr") {
        const [tasks, providers, profiles, history, queue] = await Promise.all([
          api(name, "/api/system/tasks"),
          api(name, "/api/providers"),
          api(name, "/api/system/languages/profiles"),
          api(name, "/api/movies/history?length=30"),
          api(name, "/api/system/jobs"),
        ]);
        return {
          tasks: tasks.data,
          providers: providers.data,
          profiles,
          history: history.data,
          queue: queue.data || [],
        };
      }
      if (name === "qbittorrent") {
        const [transfer, preferences, categories, log] = await Promise.all([
          api(name, "/api/v2/transfer/info"),
          api(name, "/api/v2/app/preferences"),
          api(name, "/api/v2/torrents/categories"),
          api(
            name,
            "/api/v2/log/main?normal=true&info=true&warning=true&critical=true",
          ),
        ]);
        return {
          transfer,
          categories,
          preferences: {
            dl_limit: preferences.dl_limit,
            up_limit: preferences.up_limit,
            max_active_downloads: preferences.max_active_downloads,
            max_active_torrents: preferences.max_active_torrents,
            max_ratio: preferences.max_ratio,
            max_seeding_time: preferences.max_seeding_time,
          },
          logs: log.slice(-30),
        };
      }
      if (name === "seerr") {
        const [status, count] = await Promise.all([
          api(name, "/api/v1/status"),
          api(name, "/api/v1/request/count"),
        ]);
        return { status, count };
      }
      if (name === "jellyfin") {
        if (!services.jellyfin.key)
          return {
            configured: false,
            message:
              "An existing Jellyfin API key is needed for library and playback management.",
          };
        const [tasks, libraries, sessions, activity] = await Promise.all([
          api(name, "/ScheduledTasks"),
          api(name, "/Library/VirtualFolders"),
          api(name, "/Sessions"),
          api(name, "/System/ActivityLog/Entries?limit=30"),
        ]);
        return { configured: true, tasks, libraries, sessions, activity };
      }
    }
    if (route === "connection") {
      if (
        !["radarr", "sonarr", "prowlarr"].includes(name) ||
        !["indexer", "downloadclient", "applications"].includes(
          params.get("type"),
        )
      )
        throw Error("Choose a valid connection");
      return cleanConnection(
        await api(
          name,
          (name === "prowlarr" ? "/api/v1/" : "/api/v3/") +
            params.get("type") +
            "/" +
            positive(id),
        ),
      );
    }
    return undefined;
  }
  const labels = {
    subtitle: "Subtitle",
    command: "Library task",
    monitor: "Monitoring",
    mediaSettings: "Library settings",
    episodeMonitor: "Episode monitoring",
    torrent: "Download",
    transferLimits: "Speed limits",
    grabRelease: "Download release",
    clearReleaseChoice: "Clear selected release",
    add: "Add media",
    queueRemove: "Import queue",
    request: "Request",
    requestCreate: "Request media",
    bazarrTask: "Subtitle task",
    indexer: "Indexer",
    connection: "Connection",
    qualityProfile: "Quality profile",
    jellyfinTask: "Jellyfin task",
    jellyfinScan: "Jellyfin library scan",
    jellyfinPlayback: "Playback",
  };
  return {
    releaseChoices: choices,
    read,
    start(body) {
      if (!labels[body.action]) throw Error("Unsupported action");
      const service =
        body.action === "subtitle" || body.action === "bazarrTask"
          ? "bazarr"
          : body.action === "torrent" || body.action === "transferLimits"
            ? "qbittorrent"
            : ["request", "requestCreate"].includes(body.action)
              ? "seerr"
              : body.service || "deck";
      const label =
        body.label ||
        `${labels[body.action]}${body.operation ? " · " + body.operation : ""}${body.name ? " · " + body.name : ""}`;
      const key = actionKey(body);
      return jobs.start(label, service, key, (update) =>
        mutation(body, update),
        ["connection", "indexer"].includes(body.action) ? undefined : body,
      );
    },
    execute: mutation,
  };
}
