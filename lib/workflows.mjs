const samePath = (a, b) => String(a || "").replaceAll("\\", "/").toLowerCase() === String(b || "").replaceAll("\\", "/").toLowerCase();
export function workflows({ api, native, library }) {
  const read = async (name, endpoint, errors, fallback) => { try { return await api(name, endpoint); } catch (e) { errors.push({ service: name, message: e.message }); return fallback; } };
  return {
    async title(service, id, user) {
      if (!["radarr", "sonarr"].includes(service)) throw Error("Choose movies or series");
      const details = await native.read("media", new URLSearchParams({ service, id: String(id) }));
      const item = details.item, errors = [];
      const [queue, requests, subs, jellyfin, providers] = await Promise.all([
        read(service, "/api/v3/queue/details?includeUnknownMovieItems=true&includeUnknownSeriesItems=true", errors, []),
        read("seerr", "/api/v1/request?take=100&filter=all", errors, { results: [] }),
        read("bazarr", service === "radarr" ? "/api/movies?radarrid[]=" + id : "/api/episodes?seriesid[]=" + id + "&length=10000", errors, { data: [] }),
        read("jellyfin", "/Items?" + new URLSearchParams({ Recursive: "true", IncludeItemTypes: service === "radarr" ? "Movie" : "Series", AnyProviderIdEquals: service === "radarr" ? "tmdb." + item.tmdbId : "tvdb." + item.tvdbId, Fields: "ProviderIds,Path,MediaSources", ...(user ? { UserId: user, EnableUserData: "true" } : {}) }), errors, { Items: [] }),
        read("bazarr", "/api/providers", errors, { data: [] }),
      ]);
      const entries = (Array.isArray(queue) ? queue : queue.records || []).filter(q => service === "radarr" ? q.movieId === Number(id) : q.seriesId === Number(id));
      const request = (requests.results || []).filter(r => service === "radarr" ? r.type === "movie" && r.media.tmdbId === item.tmdbId : r.type === "tv" && (r.media.tvdbId === item.tvdbId || r.media.externalServiceId === Number(id)));
      const files = details.files || [], subtitleItems = subs.data || [];
      const missingEpisodes = service === "sonarr" ? (details.episodes || []).filter(e => e.monitored && !e.hasFile && e.airDateUtc && Date.parse(e.airDateUtc) <= Date.now()).length : 0;
      const completeFiles = files.length > 0 && !missingEpisodes;
      const choice = details.releaseChoice;
      const chosenFile = choice?.imported && files.find(f => f.id === choice.fileId);
      const media = (jellyfin.Items || []).filter(j => choice ? chosenFile && (samePath(chosenFile.path, j.Path) || j.MediaSources?.some(s => samePath(chosenFile.path, s.Path))) : service === "radarr" ? Number(j.ProviderIds?.Tmdb) === item.tmdbId || files.some(f => samePath(f.path, j.Path)) : Number(j.ProviderIds?.Tvdb) === item.tvdbId || samePath(j.Path, item.path));
      const missing = chosenFile && choice.includedSubtitles ? 0 : subtitleItems.reduce((sum, s) => sum + (s.missing_subtitles?.length ? 1 : 0), 0);
      const importBlocked = entries.some(q => q.trackedDownloadStatus === "warning" || q.trackedDownloadStatus === "error" || q.statusMessages?.length);
      const stage = (key, label, state, detail, route, action) => ({ key, label, state, detail, route, action });
      const stages = [
        stage("request", "Requested", request.length ? request.some(r => [1, 3, 4].includes(r.status)) ? "blocked" : "complete" : "optional", request.length ? request.map(r => ({ 1: "Pending approval", 2: "Approved", 3: "Declined", 4: "Failed", 5: "Completed" })[r.status] || "Unknown status").join(" · ") : "Added directly to the library", "requests"),
        stage("search", "Find release", completeFiles || entries.length ? "complete" : item.monitored ? "pending" : "blocked", missingEpisodes ? `${missingEpisodes} monitored episodes still need a release` : files.length ? "Release found and imported" : entries.length ? "Release sent to the download client" : item.monitored ? "No release downloaded yet" : "Monitoring is disabled", `media/${service}/${id}`, { kind: "search", label: "Search releases" }),
        stage("download", "Download", completeFiles && !entries.length ? "complete" : entries.length ? importBlocked ? "blocked" : "active" : "pending", entries.length ? entries.map(q => `${q.title} · ${q.status}${q.size ? " · " + Math.round((1 - (q.sizeleft || 0) / q.size) * 100) + "%" : ""}`).join("; ") : missingEpisodes ? `${missingEpisodes} episodes still missing` : files.length ? "Download completed" : "Waiting for a release", "downloads"),
        stage("import", "Import", importBlocked ? "blocked" : files.length ? "complete" : "pending", importBlocked ? entries.flatMap(q => (q.statusMessages || []).flatMap(m => m.messages || [])).join("; ") || "The import needs review" : files.length ? `${files.length} ${files.length === 1 ? "media file" : "media files"} in the library` : "Waiting for downloaded files", "imports", importBlocked ? { kind: "import", label: "Repair import", queueId: entries.find(q => q.statusMessages?.length)?.id || entries[0]?.id } : undefined),
        stage("subtitles", "Subtitles", errors.some(e => e.service === "bazarr") ? "unknown" : !subtitleItems.length ? "pending" : missing ? "blocked" : "complete", !subtitleItems.length ? "Waiting for Bazarr to index the file" : missing ? `${missing} ${missing === 1 ? "file needs" : "files need"} subtitles` : "Language profile requirements are satisfied", service === "radarr" ? `subtitles/movie/${id}` : `subtitles/series/${id}`),
        stage("watch", "Watch", errors.some(e => e.service === "jellyfin") ? "unknown" : media.length ? "complete" : files.length ? "blocked" : "pending", media.length ? "Available in Jellyfin" : files.length ? "Imported files have not appeared in Jellyfin yet" : "Waiting for media files", "watch", media.length ? { kind: "watch", label: service === "radarr" ? "Watch now" : "Find next episode", id: media[0].Id } : files.length ? { kind: "scan", label: "Scan Jellyfin" } : undefined),
      ];
      if (choice) {
        stages[1].state = choice.status === "selected" ? "complete" : "blocked";
        stages[1].detail = `Your selected release: ${choice.releaseTitle} · automatic replacement paused${choice.status !== "selected" ? " · verify the download in Radarr" : ""}`;
        if (!chosenFile && !entries.length) { stages[2].state = "pending"; stages[2].detail = "Waiting for the selected download; an existing copy does not verify this release."; }
        if (files.length && !chosenFile) { stages[3].state = "blocked"; stages[3].detail = "The current file has not been verified as your selected release. Inspect the import queue before replacing it."; }
        if (chosenFile && choice.includedSubtitles) { stages[4].state = "complete"; stages[4].detail = "Included subtitles accepted for your selected release. Burned-in subtitles may not appear as separate tracks."; }
        if (!chosenFile) { stages[5].state = "pending"; stages[5].detail = "Waiting for your selected release to be imported and verified."; stages[5].action = undefined; }
      }
      for (const step of stages) if (errors.some(e => step.key === "request" && e.service === "seerr" || ["search", "download", "import"].includes(step.key) && e.service === service)) { step.state = "unknown"; step.detail = "Could not read this service’s current state"; }
      return { ...details, journey: { stages, queue: entries, requests: request.map(r => ({ id: r.id, status: r.status, mediaStatus: r.media.status, seasons: r.seasons })), missingSubtitles: missing, providers: providers.data || [], errors, jellyfin: media.map(j => ({ id: j.Id, title: j.Name, position: j.UserData?.PlaybackPositionTicks || 0 })) } };
    },
  };
}
