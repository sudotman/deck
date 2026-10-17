import crypto from "node:crypto";
import { tokenStore } from "./storage.mjs";

const choose = n => { if (!["radarr", "sonarr"].includes(n)) throw Error("Choose movies or series"); return n; };
export function imports({ api, directory, runCommand, native }) {
  const plans = tokenStore(directory, "import-plans");
  return {
    async read(route, params) {
      const n = params.get("service");
      if (route === "imports") {
        const result = { queues: [], errors: [] };
        await Promise.all(["radarr", "sonarr"].map(async s => { try { let page = 1, response; do { response = await api(s, `/api/v3/queue?pageSize=100&page=${page++}&includeUnknownMovieItems=true&includeUnknownSeriesItems=true`); result.queues.push(...(response.records || []).map(q => ({ ...q, service: s }))); } while (page <= Math.ceil((response.totalRecords || 0) / 100)); } catch (e) { result.errors.push({ service: s, message: e.message }); } }));
        return result;
      }
      if (route === "import-plan") {
        choose(n);
        const folder = params.get("folder"), queueId = params.get("queueId");
        const q = new URLSearchParams({ filterExistingFiles: "false" });
        let downloadId;
        if (queueId) {
          const queue = await api(n, "/api/v3/queue/details?includeUnknownMovieItems=true&includeUnknownSeriesItems=true");
          const selected = (Array.isArray(queue) ? queue : queue.records || []).find(i => i.id === Number(queueId));
          if (!selected?.downloadId) throw Error("That queue item is no longer available. Refresh the queue.");
          downloadId = selected.downloadId; q.set("downloadId", downloadId);
        } else if (folder?.trim()) q.set("folder", folder.trim());
        else throw Error("Enter the download folder on the media PC or select an import queue entry");
        const [files, titles, definitions, languages] = await Promise.all([api(n, "/api/v3/manualimport?" + q), api(n, n === "radarr" ? "/api/v3/movie" : "/api/v3/series"), api(n, "/api/v3/qualitydefinition"), api(n, "/api/v3/language")]);
        const token = crypto.randomUUID();
        const choice = await native?.releaseChoices?.forDownload(n, downloadId);
        for (const file of files) {
          const matched = choice || await native?.releaseChoices?.forDownload(n, file.downloadId);
          if (matched) { file.releaseChoice = matched; if (n === "radarr") file.movie = titles.find(t => t.id === matched.id); file.quality = matched.quality; file.languages = matched.languages; }
        }
        plans.set(token, { service: n, files, folder, downloadId, choice, expires: Date.now() + 1800000 });
        return { token, files, titles: titles.map(t => ({ id: t.id, title: t.title, year: t.year })), qualities: definitions.map(q => q.quality), languages };
      }
      if (route === "import-episodes") { choose(n); if (n !== "sonarr") throw Error("Choose a series"); return api(n, "/api/v3/episode?seriesId=" + Number(params.get("id"))); }
    },
    async execute(body, update) {
      if (body.action !== "manualImport") return undefined;
      const n = choose(body.service), plan = plans.get(body.token);
      if (!plan || plan.expires < Date.now() || plan.service !== n) throw Error("Import inspection expired. Inspect the folder again.");
      if (!Array.isArray(body.files) || !body.files.length) throw Error("Select at least one file to import");
      if (!["copy", "move"].includes(body.mode)) throw Error("Choose copy or move");
      const [titles, definitions, languages] = await Promise.all([api(n, n === "radarr" ? "/api/v3/movie" : "/api/v3/series"), api(n, "/api/v3/qualitydefinition"), api(n, "/api/v3/language")]);
      const items = [];
      for (const chosen of body.files) {
        const file = plan.files.find(f => f.id === Number(chosen.id));
        if (!file) throw Error("Choose a file from the inspected folder");
        const titleId = Number(chosen.titleId);
        const choice = file.releaseChoice && native?.releaseChoices?.get(n, file.releaseChoice.id);
        if (choice && titleId !== choice.id) throw Error("This download is assigned to your selected movie. Clear its release choice before assigning it elsewhere.");
        if (!titles.some(t => t.id === titleId)) throw Error("Select a title already in your library");
        const quality = definitions.find(d => d.quality.id === Number(chosen.qualityId))?.quality;
        if (!quality) throw Error("Choose a valid file quality");
        const language = languages.find(l => l.id === Number(chosen.languageId));
        if (!language) throw Error("Choose a valid language");
        const item = { path: file.path, folderName: file.folderName, quality: { ...file.quality, quality }, languages: [language], releaseGroup: file.releaseGroup, indexerFlags: file.indexerFlags || 0, downloadId: plan.downloadId || file.downloadId };
        if (n === "radarr") item.movieId = titleId;
        else {
          const episodes = await api(n, "/api/v3/episode?seriesId=" + titleId);
          const ids = (chosen.episodeIds || []).map(Number);
          if (!ids.length || ids.some(id => !episodes.some(e => e.id === id))) throw Error("Assign at least one episode from the selected series to each file");
          Object.assign(item, { seriesId: titleId, episodeIds: ids, releaseType: file.releaseType || "singleEpisode" });
        }
        items.push(item);
      }
      const result = await runCommand(n, { name: "ManualImport", files: items, importMode: body.mode }, update);
      plans.delete(body.token);
      return { ...result, message: `${items.length} ${items.length === 1 ? "file" : "files"} imported` };
    },
  };
}
