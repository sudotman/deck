// Newly imported films, as Radarr's webhook reports them, each checked once Bazarr knows it. Radarr
// calls as soon as it imports; Bazarr may take a few minutes to index the file, so a film that isn't
// ready yet is retried for a while. Nothing runs while nothing is waiting.
export function importChecks({ check, log = console.log, now = Date.now, retryEvery = 120e3, giveUpAfter = 45 * 60e3 }) {
  const pending = new Map(); // movieId → when Radarr reported it
  let timer = null;

  async function run() {
    timer = null;
    for (const [id, reported] of pending) {
      try {
        await check(id);
        pending.delete(id);
      } catch (error) {
        // Usually Bazarr hasn't indexed the new file yet.
        if (now() - reported > giveUpAfter) {
          pending.delete(id);
          log(`New import check: gave up on Radarr film ${id} (${error.message})`);
        }
      }
    }
    if (pending.size && !timer) {
      timer = setTimeout(run, retryEvery);
      timer.unref?.();
    }
  }

  return {
    /** Radarr imported this film: check it now, and again later if Bazarr doesn't know it yet. */
    add(movieId) {
      if (!Number.isInteger(movieId) || movieId < 1 || pending.has(movieId)) return Promise.resolve();
      pending.set(movieId, now());
      if (timer) { clearTimeout(timer); timer = null; }
      return run();
    },
    run,
    pending: () => [...pending.keys()],
  };
}

/** The film a Radarr webhook is about, when it's an import or upgrade; null for tests and other events. */
export function importedFilm(payload) {
  if (payload?.eventType !== "Download") return null;
  const id = Number(payload.movie?.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}
