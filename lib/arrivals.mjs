import fs from "node:fs";
import path from "node:path";

// Films that have just arrived in the library, for the TV to announce ("Central Station is in your
// library."). Radarr's import webhook adds them; the TV dismisses each once it's been played or waved
// away. Kept on disk for a few days, so a TV that was off when the film landed still hears about it.
const KEEP = 3 * 86400e3, MAX = 20;

/** The new film a Radarr webhook reports: a first import, not an upgrade of a file already there. */
export function arrival(payload) {
  if (payload?.eventType !== "Download" || payload.isUpgrade) return null;
  const m = payload.movie || {};
  const id = Number(m.id);
  if (!Number.isInteger(id) || id < 1 || !m.title) return null;
  return { id, title: String(m.title), year: Number(m.year) || null, tmdbId: Number(m.tmdbId) || null };
}

export function createArrivals({ directory, now = Date.now } = {}) {
  const file = directory && path.join(directory, "data", "arrivals.json");
  let films = (() => {
    try { return JSON.parse(fs.readFileSync(file, "utf8")).films || []; } catch { return []; }
  })();
  const save = () => {
    if (!file) return;
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ films })); } catch {}
  };
  const fresh = () => films.filter(f => now() - f.at < KEEP);

  return {
    /** Records a Radarr import; returns the arrival, or null when it isn't a new film. */
    add(payload) {
      const film = arrival(payload);
      if (!film) return null;
      films = [{ ...film, at: now(), dismissed: false }, ...fresh().filter(f => f.id !== film.id)].slice(0, MAX);
      save();
      return film;
    },
    /** Arrivals the TV hasn't dismissed, newest first. */
    list() {
      return fresh().filter(f => !f.dismissed).map(({ dismissed, ...f }) => ({ ...f, at: new Date(f.at).toISOString() }));
    },
    dismiss(id) {
      const film = films.find(f => f.id === Number(id));
      if (!film) return false;
      film.dismissed = true;
      save();
      return true;
    },
  };
}
