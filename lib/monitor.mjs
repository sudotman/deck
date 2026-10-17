import fs from "node:fs";
import path from "node:path";

export function createMonitor(directory, collect) {
  const filename = path.join(directory, "data", "monitor.json");
  let samples = [];
  try {
    samples = JSON.parse(fs.readFileSync(filename, "utf8"));
  } catch {}
  let sampling = false;
  async function sample() {
    if (sampling) return;
    sampling = true;
    try {
      const snapshot = await collect();
      samples.push({
        at: Date.now(),
        services: Object.fromEntries(
          snapshot.services.map((s) => [
            s.id,
            { online: s.online, latency: s.latency || 0 },
          ]),
        ),
        download: snapshot.transfer.dl_info_speed || 0,
        upload: snapshot.transfer.up_info_speed || 0,
        warnings: snapshot.health.length,
        disks: snapshot.disks.map((d) => ({
          path: d.path,
          free: d.freeSpace,
          total: d.totalSpace,
        })),
      });
      samples = samples
        .filter((s) => s.at > Date.now() - 86400000)
        .slice(-4320);
      fs.writeFileSync(filename + ".tmp", JSON.stringify(samples), {
        mode: 0o600,
      });
      fs.renameSync(filename + ".tmp", filename);
    } catch (error) {
      console.error("Monitoring sample failed:", error.message);
    } finally {
      sampling = false;
    }
  }
  sample();
  setInterval(sample, 20000).unref();
  return {
    get: () => ({
      samples,
      intervalSeconds: 20,
      startedAt: samples[0]?.at,
      services: Object.fromEntries(
        Object.keys(samples.at(-1)?.services || {}).map((name) => {
          const relevant = samples.filter((s) => s.services[name]);
          return [
            name,
            {
              checks: relevant.length,
              online: relevant.filter((s) => s.services[name].online).length,
              uptime: relevant.length
                ? relevant.filter((s) => s.services[name].online).length /
                  relevant.length
                : null,
            },
          ];
        }),
      ),
    }),
  };
}
