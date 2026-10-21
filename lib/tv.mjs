// The TV link: things sent from a phone (a link to play, a search, a new film for tonight) waiting
// for the TV launcher, which long-polls for them. Held in memory and short-lived: a send that no TV
// picks up within a couple of minutes is stale, and nothing here needs to survive a restart.
const KINDS = new Set(["link", "search", "tonight", "arrived"]);
const KEEP = 120e3, MAX_WAIT = 25e3;

function invalid(message) {
  return Object.assign(Error(message), { status: 400 });
}

export function tvEvent(body) {
  if (!body || !KINDS.has(body.kind)) throw invalid("Choose what to send to the TV");
  if (body.kind === "link") {
    let url;
    try { url = new URL(String(body.url || "").trim()); } catch { throw invalid("Paste a full link, starting with https://"); }
    if (!["http:", "https:"].includes(url.protocol) || url.href.length > 2000) throw invalid("Paste a full link, starting with https://");
    return { kind: "link", url: url.href };
  }
  if (body.kind === "search") {
    const text = String(body.text || "").trim();
    if (!text || text.length > 200) throw invalid("Type something to search for");
    return { kind: "search", text };
  }
  return { kind: body.kind };
}

export function createTvLink({ now = Date.now } = {}) {
  // A new epoch each start, so a TV that remembers ids from before a restart starts over cleanly.
  const epoch = String(now());
  let seq = 0;
  const events = [];
  const waiters = new Set();

  const fresh = after => {
    while (events.length && now() - events[0].at > KEEP) events.shift();
    return events.filter(e => e.id > after).map(({ at, ...e }) => e);
  };

  return {
    send(body) {
      const event = { ...tvEvent(body), id: ++seq, at: now() };
      events.push(event);
      for (const wake of waiters) wake();
      return { id: event.id, epoch };
    },

    /** Events after `after` from this epoch; waits up to `wait` ms for one if there are none yet. */
    async next({ after = 0, from = "", wait = MAX_WAIT, signal } = {}) {
      // A different epoch means Deck restarted: everything it holds is new to this TV, but anything
      // sent before the TV connected is old news, so a first call only learns where the queue stands.
      if (from !== epoch) return { epoch, latest: seq, events: [] };
      const ready = fresh(after);
      if (ready.length || wait <= 0) return { epoch, latest: seq, events: ready };
      await new Promise(resolve => {
        const done = () => { clearTimeout(timer); waiters.delete(done); signal?.removeEventListener?.("abort", done); resolve(); };
        const timer = setTimeout(done, Math.min(wait, MAX_WAIT));
        waiters.add(done);
        signal?.addEventListener?.("abort", done);
      });
      return { epoch, latest: seq, events: fresh(after) };
    },
  };
}
