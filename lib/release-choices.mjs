import path from "node:path";
import crypto from "node:crypto";
import { readJSON, writeJSON } from "./storage.mjs";

const digest = value => crypto.createHash("sha256").update(String(value || "")).digest("hex");
const sameTitle = (a, b) => !!a && !!b && a.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase() === b.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
const samePath = (a, b) => !!a && !!b && a.replaceAll("\\", "/").toLowerCase() === b.replaceAll("\\", "/").toLowerCase();
export function releaseChoices({ api, directory }) {
  const filename = directory && path.join(directory, "data", "release-choices.json");
  const choices = filename ? readJSON(filename, {}) : {};
  const save = () => { if (filename) writeJSON(filename, choices); };
  const get = (service, id) => choices[`${service}:${Number(id)}`];
  const publicChoice = choice => {
    if (!choice) return null;
    const { guidDigest, originalMonitored, ...visible } = choice;
    return visible;
  };
  async function resolve(service, id, files, history = []) {
    const choice = get(service, id);
    if (!choice) return null;
    const grab = history.find(h => h.eventType === "grabbed" && (h.data?.guid ? digest(h.data.guid) === choice.guidDigest : sameTitle(h.sourceTitle, choice.releaseTitle)) && (!h.date || Date.parse(h.date) >= Date.parse(choice.selectedAt) - 10000));
    if (grab?.downloadId) { choice.downloadId = grab.downloadId; if (["sending", "uncertain"].includes(choice.status)) choice.status = "selected"; }
    const imported = history.find(h => ["downloadFolderImported", "movieFileImported"].includes(h.eventType) && choice.downloadId && h.downloadId?.toLowerCase() === choice.downloadId.toLowerCase());
    const importedId = Number(imported?.data?.fileId || imported?.data?.importedMovieFileId || imported?.data?.movieFileId);
    const file = files?.find(f => f.id === importedId || choice.fileId && f.id === choice.fileId || sameTitle(f.sceneName, choice.releaseTitle) || choice.downloadId && f.downloadId?.toLowerCase() === choice.downloadId.toLowerCase());
    if (files) { choice.fileId = file?.id || null; choice.filePath = file?.path || null; choice.imported = !!file; }
    if (file && ["selected", "sending", "uncertain"].includes(choice.status)) choice.status = "selected";
    save();
    return publicChoice(choice);
  }
  return {
    get: (service, id) => publicChoice(get(service, id)),
    resolve,
    async verify(service, id) {
      if (!get(service, id)) return null;
      const [files, history] = await Promise.all([api(service, `/api/v3/moviefile?movieId=${Number(id)}`), api(service, `/api/v3/history?movieId=${Number(id)}&pageSize=100&sortKey=date&sortDirection=descending`)]);
      return resolve(service, id, files, history.records || []);
    },
    async forMedia(item) {
      const choice = Object.values(choices).find(c => c.service === "radarr" && (c.tmdbId && Number(item.ProviderIds?.Tmdb) === c.tmdbId || samePath(c.filePath, item.Path)));
      if (!choice) return null;
      const verified = await this.verify("radarr", choice.id);
      const source = verified.imported && item.MediaSources?.find(s => samePath(s.Path || item.Path, verified.filePath));
      const matches = verified.imported && (source || samePath(item.Path, verified.filePath));
      return { ...verified, playbackMatches: !!matches, sourceId: source?.Id };
    },
    async forDownload(service, downloadId) {
      if (!downloadId) return null;
      for (const choice of Object.values(choices).filter(c => c.service === service)) {
        if (!choice.downloadId) {
          const h = await api(service, `/api/v3/history?movieId=${choice.id}&pageSize=100&sortKey=date&sortDirection=descending`);
          await resolve(service, choice.id, undefined, h.records || []);
        }
        if (choice.downloadId?.toLowerCase() === downloadId.toLowerCase()) return publicChoice(choice);
      }
      return null;
    },
    async choose(selected, release, body, update = () => {}) {
      if (selected.service !== "radarr" || !selected.id) throw Error("Pinned release choices are available for movies");
      if (!release.quality?.quality?.id || !Array.isArray(release.languages) || !release.languages.length) throw Error("This release has incomplete quality or language metadata. Search again or use manual import.");
      const key = `radarr:${selected.id}`, previous = choices[key];
      if (previous && ["sending", "uncertain"].includes(previous.status)) throw Error("The previous selection needs checking in Radarr before another release can be sent");
      if (previous?.guidDigest === digest(release.guid) && previous.status === "selected") throw Error("This release is already selected. Check Downloads or clear the selection before requesting it again.");
      const movie = await api("radarr", `/api/v3/movie/${selected.id}`);
      const choice = {
        service: "radarr", id: Number(selected.id), tmdbId: movie.tmdbId, title: movie.title, releaseTitle: release.title,
        indexer: release.indexer, quality: release.quality, languages: release.languages,
        acceptedRejections: release.rejections || [], includedSubtitles: body.includedSubtitles === true,
        selectedAt: new Date().toISOString(), status: "sending", imported: false,
        guidDigest: digest(release.guid), originalMonitored: previous?.originalMonitored ?? movie.monitored,
      };
      // Pause this movie's automatic searches; manual grabs and completed-download imports still run.
      if (movie.monitored) await api("radarr", `/api/v3/movie/${selected.id}`, "PUT", { ...movie, monitored: false });
      choices[key] = choice; save();
      update("Sending your selected release to Radarr…");
      try {
        await api("radarr", "/api/v3/release", "POST", { guid: release.guid, indexerId: release.indexerId, movieId: Number(selected.id), shouldOverride: true, quality: release.quality, languages: release.languages });
      } catch (error) {
        // A timeout may occur after the client accepted the download. Do not re-enable automatic grabs.
        if (/timeout|timed out|fetch failed|abort|ECONN/i.test(error.message)) { choice.status = "uncertain"; save(); throw Error("The download response was interrupted. Your choice is saved; check Downloads and Radarr before retrying."); }
        choices[key] = previous;
        if (!previous) delete choices[key];
        save();
        try { if (movie.monitored) await api("radarr", `/api/v3/movie/${selected.id}`, "PUT", movie); }
        catch { choices[key] = { ...choice, status: "restore-needed" }; save(); throw Error("Download failed, and monitoring could not be restored. Clear the selected release to restore monitoring."); }
        throw error;
      }
      choice.status = "selected"; save();
      return { choice: publicChoice(choice), message: "Selected release sent to the download client · automatic replacement paused for this movie" };
    },
    async clear(service, id) {
      const choice = get(service, id);
      if (!choice) throw Error("No selected release for this title");
      const movie = await api(service, `/api/v3/movie/${Number(id)}`);
      await api(service, `/api/v3/movie/${Number(id)}`, "PUT", { ...movie, monitored: !!choice.originalMonitored });
      delete choices[`${service}:${Number(id)}`]; save();
      return { message: "Release choice cleared · previous monitoring restored" };
    },
  };
}
