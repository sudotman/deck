import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function createJobs(directory) {
  const filename = path.join(directory, "data", "activity.json");
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  let jobs = [];
  try {
    jobs = JSON.parse(fs.readFileSync(filename, "utf8"));
  } catch {}
  for (const job of jobs) {
    if (["queued", "running"].includes(job.status)) {
      job._previousStatus = job.status;
      job.status = "interrupted";
      job.message =
        "Deck restarted. Check the service before running this again.";
      job.finishedAt = new Date().toISOString();
    }
  }
  const queue = [];
  let active = 0;
  const activeServices = new Set();
  const save = () => {
    fs.writeFileSync(
      filename + ".tmp",
      JSON.stringify([...jobs.filter(j => ["queued", "running"].includes(j.status)), ...jobs.filter(j => !["queued", "running"].includes(j.status)).slice(0, Math.max(0, 250 - jobs.filter(j => ["queued", "running"].includes(j.status)).length))], null, 2),
      { mode: 0o600 },
    );
    fs.renameSync(filename + ".tmp", filename);
  };
  save();
  async function drain() {
    if (active >= 2 || !queue.length) return;
    const index = queue.findIndex(
      (entry) => (entry.job._locks || [entry.job.service]).every(s => !activeServices.has(s)),
    );
    if (index === -1) return;
    const [{ job, operation }] = queue.splice(index, 1);
    for (const s of job._locks || [job.service]) activeServices.add(s);
    active++;
    job.status = "running";
    job.startedAt = new Date().toISOString();
    job.message = "Working…";
    save();
    try {
      job.result = await operation((message, metadata = {}) => {
        job.message = message;
        Object.assign(job, metadata);
        save();
      });
      job.status = "completed";
      job.message = job.result?.message || "Completed";
    } catch (error) {
      job.status = "failed";
      job.message = error.message;
    } finally {
      job.finishedAt = new Date().toISOString();
      save();
      active--;
      for (const s of job._locks || [job.service]) activeServices.delete(s);
      drain();
    }
  }
  return {
    list: () => jobs,
    get: (id) => jobs.find((job) => job.id === id),
    async recover(reconcile, replay) {
      for (const job of jobs.filter(j => j._previousStatus)) {
        const previous = job._previousStatus;
        delete job._previousStatus;
        const operation = previous === "queued" && job._payload
          ? (update) => replay(job._payload, update)
          : job.commandId || job.bazarrJobIds || job.jellyfinTaskId
            ? (update) => reconcile(job, update)
            : null;
        if (!operation) continue;
        job.status = "queued";
        job.message = previous === "queued" ? "Resuming queued task" : "Checking the service after restart";
        delete job.finishedAt;
        queue.push({ job, operation });
      }
      save();
      drain();
      drain();
    },
    start(label, service, key, operation, payload) {
      const existing = jobs.find(
        (job) => job.key === key && ["queued", "running"].includes(job.status),
      );
      if (existing) return existing;
      const job = {
        id: crypto.randomUUID(),
        label,
        service,
        key,
        status: "queued",
        message: "Waiting to start",
        createdAt: new Date().toISOString(),
        ...(payload ? { _payload: payload } : {}),
        ...(payload?.action === "bulk" ? { _locks: ["subtitles", "subtitleProfile"].includes(payload.kind) ? ["bazarr"] : payload.kind === "torrent" ? ["qbittorrent"] : [...new Set(payload.items.map(i => i.service))] } : {}),
      };
      jobs.unshift(job);
      // Never evict a running/queued operation just because history is full.
      jobs = jobs.filter((j, i) => i < 250 || ["queued", "running"].includes(j.status));
      queue.push({ job, operation });
      save();
      drain();
      return job;
    },
  };
}
