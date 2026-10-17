import path from "node:path";
import crypto from "node:crypto";
import { readJSON, writeJSON } from "./storage.mjs";

const offlineHints = {
  seerr: "Seerr runs in Docker Desktop on the media PC. The “Media - Docker watchdog” task restarts Docker if its engine stays down for two checks.",
};
// Failed tasks stay in Activity, but stop alerting once they are this old or a later run succeeded.
const JOB_ALERT_DAYS = 7;

export function failedJobAlerts(jobs, now = Date.now()) {
  const finished = j => Date.parse(j.finishedAt || j.createdAt) || 0;
  const superseded = j => jobs.some(o => o !== j && o.key && o.key === j.key && o.status === "completed" && finished(o) > finished(j));
  return jobs
    .filter(j => j.status === "failed" || j.status === "interrupted" || j.result?.partial)
    .filter(j => !superseded(j) && now - finished(j) < JOB_ALERT_DAYS * 86400000)
    .map(j => ({ key: "job:" + j.id, title: j.label + " · " + (j.result?.partial ? "partially completed" : j.status), detail: j.message, services: [j.service], route: "activity", severity: "error" }));
}

export function collectAlerts(snapshot, now = Date.now(), settings = {}) {
  const groups = new Map();
  const add = (key, title, detail, service, route, severity = "warning") => {
    const old = groups.get(key);
    if (old) { if (!old.services.includes(service)) old.services.push(service); return; }
    groups.set(key, { key, title, detail, services: [service], route, severity });
  };
  for (const s of snapshot.services || []) if (!s.online) add("offline:" + s.id, s.name + " is unavailable", [s.error, offlineHints[s.id]].filter(Boolean).join(" · "), s.id, "service/" + s.id, "error");
  for (const h of snapshot.health || []) {
    const source = h.source === "AllowedHostsCheck" ? "hosts" : (h.source || "health") + ":" + h.message.replace(/\s*\(Prowlarr\)/g, "");
    add(source, h.source === "AllowedHostsCheck" ? "Allowed hostnames need configuring" : h.source === "IndexerLongTermStatusCheck" ? "An indexer is failing" : "Service configuration needs attention", h.message, h.service, "service/" + h.service, h.type === "error" ? "error" : "warning");
  }
  for (const e of snapshot.dataErrors || []) add("read:" + e.service + ":" + e.section, "Could not update " + e.section, e.message + (e.staleAt ? " · Showing the last successful response." : ""), e.service, "service/" + e.service);
  const lowPercent = settings.lowDiskPercent ?? 10, lowBytes = (settings.lowDiskGB ?? 20) * 1024 ** 3;
  for (const d of snapshot.disks || []) if (d.freeSpace < lowBytes || d.totalSpace > 0 && d.freeSpace / d.totalSpace * 100 < lowPercent)
    add("disk:" + d.path, "Low free space on " + d.path, `${(d.freeSpace / 1024 ** 3).toFixed(1)} GB remains. Free space or choose a different library folder.`, "radarr", "service/radarr", "error");
  for (const t of snapshot.torrents || []) if (/error|missingFiles/i.test(t.state) || /stalledDL/i.test(t.state) && now / 1000 - (t.last_activity || t.added_on || now / 1000) > (settings.stalledMinutes ?? 30) * 60)
    add("torrent:" + t.hash, /error|missingFiles/i.test(t.state) ? "Download needs repair" : "Download has stalled", t.name + " · " + t.state, "qbittorrent", "downloads");
  for (const q of snapshot.queue || []) if (q.trackedDownloadStatus === "warning" || q.trackedDownloadStatus === "error" || q.statusMessages?.length)
    add("import:" + q.service + ":" + q.id, "Import blocked · " + q.title, (q.statusMessages || []).flatMap(m => m.messages || []).join("; ") || q.trackedDownloadStatus, q.service, "imports");
  for (const p of snapshot.providers || []) if (!["Good", "History"].includes(p.status)) add("provider:" + p.name, "Subtitle provider unavailable · " + p.name, p.status + (p.retry && p.retry !== "-" ? " · Retry " + p.retry : ""), "bazarr", "service/bazarr");
  return [...groups.values()];
}
export function createAlerts(directory) {
  const filename = path.join(directory, "data", "alerts.json");
  const state = readJSON(filename, { records: [], settings: { lowDiskPercent: 10, lowDiskGB: 20, stalledMinutes: 30 } });
  const save = () => writeJSON(filename, state);
  return {
    update(snapshot, jobs = []) {
      const current = [...collectAlerts(snapshot, Date.now(), state.settings), ...failedJobAlerts(jobs)];
      const active = new Set(current.map(a => a.key));
      for (const record of state.records) if (!record.resolvedAt && !active.has(record.key)) record.resolvedAt = new Date().toISOString();
      for (const item of current) {
        const existing = state.records.find(r => r.key === item.key && !r.resolvedAt);
        if (existing) Object.assign(existing, item, { lastSeen: new Date().toISOString() });
        else state.records.unshift({ ...item, id: crypto.randomUUID(), createdAt: new Date().toISOString(), lastSeen: new Date().toISOString(), acknowledged: false });
      }
      state.records = state.records.filter(r => !r.resolvedAt || Date.now() - Date.parse(r.resolvedAt) < 30 * 86400000).slice(0, 500);
      save();
    },
    get: () => state,
    acknowledge(id) { const r = state.records.find(r => r.id === id); if (!r) throw Error("Alert no longer exists"); r.acknowledged = true; save(); return { message: "Alert acknowledged" }; },
    configure(settings) {
      const ranges = { lowDiskPercent: [1, 50], lowDiskGB: [1, 1000], stalledMinutes: [1, 1440] };
      for (const [key, [min, max]] of Object.entries(ranges)) { const v = Number(settings[key]); if (!Number.isFinite(v) || v < min || v > max) throw Error("Enter a valid " + key + " threshold"); }
      state.settings = Object.fromEntries(Object.keys(ranges).map(k => [k, Number(settings[k])])); save(); return { message: "Alert thresholds saved" };
    },
  };
}
