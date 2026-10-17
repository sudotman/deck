import crypto from "node:crypto";
import { tokenStore, actionKey } from "./storage.mjs";
import { configuration } from "./configuration.mjs";
import { imports } from "./imports.mjs";
import { watch } from "./watch.mjs";
import { workflows } from "./workflows.mjs";

const wait = ms => new Promise(r => setTimeout(r, ms));
export function operations(context) {
  const { api, native, jobs, directory, cache, config, alerts } = context;
  const tokens = tokenStore(directory, "connection-options");
  const settings = configuration({ ...context, tokens });
  const player = watch(context);
  const flow = workflows(context);
  const secretsActions = new Set(["connectionCreate", "connectionSave", "bazarrProvider"]);
  async function followCommand(service, id, update) {
    const prefix = service === "prowlarr" ? "/api/v1" : "/api/v3";
    const deadline = Date.now() + 30 * 60000;
    while (Date.now() < deadline) {
      const current = await api(service, prefix + "/command/" + id);
      if (current.status === "completed") { cache.clear(); return { commandId: id, message: current.message || "Task completed" }; }
      if (["failed", "aborted", "cancelled"].includes(current.status)) throw Error(current.message || "Service task failed");
      update(current.message || current.name + " · " + current.status, { commandId: id, commandService: service }); await wait(2000);
    }
    throw Error("The service is still working. Use Check service status in Activity to follow it again.");
  }
  async function runCommand(service, payload, update) {
    const command = await api(service, (service === "prowlarr" ? "/api/v1" : "/api/v3") + "/command", "POST", payload);
    update("Following the service task…", { commandId: command.id, commandService: service });
    return followCommand(service, command.id, update);
  }
  const importer = imports({ ...context, runCommand });
  async function reconcile(job, update) {
    if (job._payload?.action === "bulk" && Number.isInteger(job.bulkIndex)) {
      const prior = [...(job.bulkResults || [])];
      try {
        const verified = await reconcile({ ...job, _payload: undefined }, update);
        if (job.bulkEpisodeIds && Number.isInteger(job.bulkEpisodeIndex)) return execute(job._payload, update, { index: job.bulkIndex, results: prior, episodes: { ids: job.bulkEpisodeIds, next: job.bulkEpisodeIndex + 1 } });
        prior.push({ item: job.bulkItem?.title || job.bulkItem?.id, success: true, message: verified.message });
      } catch (error) { prior.push({ item: job.bulkItem?.title || job.bulkItem?.id, success: false, message: error.message }); }
      return execute(job._payload, update, { index: job.bulkIndex + 1, results: prior });
    }
    if (job.commandId) return followCommand(job.commandService || job.service, job.commandId, update);
    if (job.bazarrJobIds) {
      const ids = new Set(job.bazarrJobIds), deadline = Date.now() + 30 * 60000;
      while (Date.now() < deadline) {
        const queue = await api("bazarr", "/api/system/jobs"), current = (queue.data || []).filter(j => ids.has(j.job_id));
        if (current.length !== ids.size) throw Error("Bazarr no longer has a record of this task. Inspect subtitle files and history before repeating it.");
        const failed = current.find(j => j.status === "failed"); if (failed) throw Error(failed.error || failed.progress_message || "Bazarr task failed");
        if (current.every(j => j.status === "completed")) { cache.clear(); return { message: "Bazarr task completed · verified after restart" }; }
        update(current.map(j => j.job_name + " · " + j.status).join("; ")); await wait(1500);
      }
      throw Error("Bazarr is still working. Check service status again later.");
    }
    if (job.jellyfinTaskId) {
      const deadline = Date.now() + 30 * 60000;
      while (Date.now() < deadline) {
        const tasks = await api("jellyfin", "/ScheduledTasks"); const task = tasks.find(t => t.Id === job.jellyfinTaskId);
        if (!task) throw Error("Jellyfin no longer reports this task");
        if (task.State === "Idle") { if (task.LastExecutionResult?.Status !== "Completed") throw Error("Jellyfin task finished with " + task.LastExecutionResult?.Status); return { message: "Jellyfin task completed" }; }
        update(task.Name + " · " + (task.CurrentProgressPercentage || 0).toFixed(0) + "%"); await wait(2000);
      }
      throw Error("Jellyfin is still working. Check service status again later.");
    }
    throw Error("This task has no upstream command to follow. Inspect the service before repeating it.");
  }
  const names = { bulk: "Bulk update", manualImport: "Manual import", connectionCreate: "Create connection", connectionSave: "Save connection", hosts: "Allowed hostnames", profileAdvanced: "Quality profile", customFormat: "Custom format", rootCreate: "Add library folder", bazarrProvider: "Subtitle provider", languageProfile: "Language profile", subtitleDefaults: "Default subtitle profiles", alertAcknowledge: "Acknowledge alert", alertSettings: "Alert settings", watchStart: "Open player", watchProgress: "Watch progress" };
  async function execute(body, update = () => {}, resume = {}) {
    let result;
    if (body.action === "bulk") {
      if (!Array.isArray(body.items) || !body.items.length || body.items.length > 500) throw Error("Select between 1 and 500 items");
      const results = [...(resume.results || [])];
      for (const [index, item] of body.items.entries()) {
        if (index < (resume.index || 0)) continue;
        update(`${index + 1} of ${body.items.length} · ${item.title || item.id || item.hash}`, { commandId: undefined, bazarrJobIds: undefined, bulkEpisodeIds: undefined, bulkEpisodeIndex: undefined, bulkIndex: index, bulkItem: item, bulkResults: [...results] });
        try {
          let mutation;
          if (body.kind === "monitor") mutation = { action: "mediaSettings", service: item.service, id: item.id, monitored: !!body.monitored };
          else if (body.kind === "profile") mutation = { action: "mediaSettings", service: item.service, id: item.id, profileId: Number(body.profiles?.[item.service]) };
          else if (body.kind === "subtitles" && item.kind === "series") {
            const continuing = index === resume.index && resume.episodes;
            const ids = continuing ? continuing.ids : ((await api("bazarr", "/api/episodes?seriesid[]=" + item.id + "&length=10000")).data || []).filter(e => e.missing_subtitles?.length).map(e => e.sonarrEpisodeId);
            for (const [episodeIndex, id] of ids.entries()) {
              if (episodeIndex < (continuing?.next || 0)) continue;
              update(`Episode ${episodeIndex + 1} of ${ids.length} · ${item.title || item.id}`, { bazarrJobIds: undefined, bulkEpisodeIds: ids, bulkEpisodeIndex: episodeIndex });
              await native.execute({ action: "subtitle", operation: "automatic", kind: "episode", id }, update);
            }
            results.push({ item: item.title || item.id, success: true, message: "Missing episode subtitles searched" }); continue;
          }
          else if (body.kind === "subtitles") mutation = { action: "subtitle", operation: "automatic", kind: item.kind, id: item.id };
          else if (body.kind === "subtitleProfile" && item.kind === "series") {
            const profiles = await api("bazarr", "/api/system/languages/profiles");
            if (body.profileId !== "none" && !profiles.some(p => p.profileId === Number(body.profileId))) throw Error("Choose an existing language profile");
            await api("bazarr", "/api/series?" + new URLSearchParams({ seriesid: item.id, profileid: body.profileId }), "POST");
            results.push({ item: item.title || item.id, success: true, message: "Series language profile updated" }); continue;
          }
          else if (body.kind === "subtitleProfile") mutation = { action: "subtitle", operation: "profile", kind: item.kind, id: item.id, profileId: body.profileId };
          else if (body.kind === "torrent" && ["pause", "resume", "recheck", "reannounce"].includes(body.operation)) mutation = { action: "torrent", hash: item.hash, operation: body.operation };
          else throw Error("Choose a supported bulk operation");
          const result = await native.execute(mutation, (message, metadata) => update(message, { ...metadata, bulkIndex: index, bulkItem: item }));
          results.push({ item: item.title || item.id || item.hash, success: true, message: result.message });
        } catch (error) { results.push({ item: item.title || item.id || item.hash, success: false, message: error.message }); }
      }
      const failed = results.filter(r => !r.success).length;
      result = { results, partial: !!failed, message: `${results.length - failed} updated${failed ? " · " + failed + " failed — inspect the results in Activity" : ""}` };
    } else if (body.action === "manualImport") result = await importer.execute(body, update);
    else if (body.action === "alertAcknowledge") result = alerts.acknowledge(body.id);
    else if (body.action === "alertSettings") result = alerts.configure(body);
    else if (body.action === "watchStart" || body.action === "watchProgress") result = await player.execute(body);
    else if (names[body.action]) result = await settings.execute(body, update);
    else if (body.action === "jellyfinTask") {
      const tasks = await api("jellyfin", "/ScheduledTasks"); const task = tasks.find(t => t.Id === body.id); if (!task) throw Error("Choose an existing Jellyfin task");
      await api("jellyfin", "/ScheduledTasks/Running/" + body.id, "POST"); update("Following " + task.Name, { jellyfinTaskId: body.id }); result = await reconcile({ jellyfinTaskId: body.id }, update);
    } else result = await native.execute(body, update);
    cache.clear(); return result;
  }
  return {
    execute, reconcile, stream: player.stream, playback: body => player.execute({ ...body, action: "watchProgress" }),
    async read(route, params) {
      if (route === "alerts") return alerts.get();
      if (route === "media") return flow.title(params.get("service"), Number(params.get("id")), params.get("user"));
      for (const extension of [settings, importer, player]) { const result = await extension.read(route, params); if (result !== undefined) return result; }
    },
    start(body) {
      if (body.action === "recoverJob") {
        const job = jobs.get(body.id); if (!job || ["queued", "running"].includes(job.status)) throw Error("Choose an interrupted or failed task");
        return jobs.start("Check service status · " + job.label, job.service, "recover:" + job.id, update => reconcile(job, update));
      }
      if (!names[body.action] && body.action !== "jellyfinTask") return native.start(body);
      const service = body.action === "bulk" ? ["subtitles", "subtitleProfile"].includes(body.kind) ? "bazarr" : body.kind === "torrent" ? "qbittorrent" : "bulk" : body.action.startsWith("watch") ? "jellyfin" : body.action.startsWith("alert") ? "deck" : ["bazarrProvider", "languageProfile", "subtitleDefaults"].includes(body.action) ? "bazarr" : body.service || "deck";
      return jobs.start(body.label || names[body.action] || "Jellyfin task", service, actionKey(body), update => execute(body, update), secretsActions.has(body.action) || body.action.startsWith("watch") ? undefined : body);
    },
  };
}
