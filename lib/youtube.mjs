import fs from "node:fs";
import path from "node:path";

// YouTube subscriptions for the TV launcher. The TV's own YouTube row is published signed out, so it
// isn't the viewer's; this is. The channel list comes once, either from a Google Takeout
// subscriptions.csv or from signing in with a code (OAuth for TVs, which needs a Google Cloud OAuth
// client in config.youtube). Latest uploads come from each channel's public feed: no key, no quota.
const FEED = "https://www.youtube.com/feeds/videos.xml?channel_id=";
const SCOPE = "https://www.googleapis.com/auth/youtube.readonly";
const LATEST_TTL = 20 * 60e3, LIST_TTL = 24 * 3600e3, PER_CHANNEL = 2;
const CHANNEL = /^UC[\w-]{22}$/;

const decode = s => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");

/** Channels from Takeout's subscriptions.csv ("Channel Id,Channel Url,Channel Title", any language). */
export function parseTakeout(csv) {
  const seen = new Map();
  for (const line of String(csv || "").split(/\r?\n/)) {
    const id = line.match(/\b(UC[\w-]{22})\b/)?.[1];
    if (!id || seen.has(id)) continue;
    const cells = line.split(",");
    const title = cells.slice(2).join(",").trim().replace(/^"|"$/g, "").replace(/""/g, '"') || id;
    seen.set(id, { id, title });
  }
  return [...seen.values()];
}

/** A channel feed's uploads; Shorts are marked so they can be left out. */
export function parseFeed(xml) {
  const channel = decode(xml.match(/<author>\s*<name>([^<]*)<\/name>/)?.[1] || "");
  return xml.split("<entry>").slice(1).map(e => {
    const id = e.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1];
    return {
      id,
      title: decode(e.match(/<title>([^<]*)<\/title>/)?.[1] || ""),
      channel,
      published: e.match(/<published>([^<]+)<\/published>/)?.[1] || null,
      short: /\/shorts\//.test(e.match(/<link rel="alternate" href="([^"]+)"/)?.[1] || ""),
    };
  }).filter(v => v.id);
}

/** Newest first, at most a couple per channel so one prolific channel can't fill the room. */
export function pickLatest(videos, count) {
  const perChannel = new Map();
  return [...videos]
    .filter(v => !v.short)
    .sort((a, b) => String(b.published).localeCompare(String(a.published)))
    .filter(v => {
      const n = perChannel.get(v.channel) || 0;
      perChannel.set(v.channel, n + 1);
      return n < PER_CHANNEL;
    })
    .slice(0, count);
}

export function createYouTube({ directory, clientId, clientSecret, fetch = globalThis.fetch, now = Date.now, log = console.log } = {}) {
  const file = directory && path.join(directory, "data", "youtube.json");
  let state = (() => {
    try { return { channels: [], ...JSON.parse(fs.readFileSync(file, "utf8")) }; } catch { return { channels: [] }; }
  })();
  const save = () => {
    if (!file) return;
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 }); } catch {}
  };
  let latest = null, signIn = null, refreshing = null;
  const thumbs = new Map();

  async function json(url, init) {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(Error(body.error_description || body.error?.message || body.error || `YouTube answered ${r.status}`), { code: body.error });
    return body;
  }
  const form = fields => ({ method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });

  async function accessToken() {
    const t = await json("https://oauth2.googleapis.com/token", form({ client_id: clientId, client_secret: clientSecret, refresh_token: state.refreshToken, grant_type: "refresh_token" }));
    return t.access_token;
  }

  // The signed-in account's subscriptions, 50 at a time.
  async function fetchSubscriptions() {
    const token = await accessToken();
    const channels = [];
    let page = "";
    do {
      const r = await json(`https://www.googleapis.com/youtube/v3/subscriptions?part=snippet&mine=true&maxResults=50&order=alphabetical${page ? `&pageToken=${page}` : ""}`, { headers: { Authorization: `Bearer ${token}` } });
      for (const s of r.items || []) {
        const id = s.snippet?.resourceId?.channelId;
        if (CHANNEL.test(id || "")) channels.push({ id, title: s.snippet.title || id });
      }
      page = r.nextPageToken || "";
    } while (page && channels.length < 2000);
    state = { ...state, channels, listAt: now() };
    latest = null;
    save();
  }

  // hq720 is sharp and 16:9 but not every upload has one; mqdefault always exists.
  async function thumb(id) {
    if (thumbs.has(id)) return thumbs.get(id);
    const sharp = `https://i.ytimg.com/vi/${id}/hq720.jpg`;
    const ok = await fetch(sharp, { method: "HEAD", signal: AbortSignal.timeout(8000) }).then(r => r.ok).catch(() => false);
    const url = ok ? sharp : `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
    thumbs.set(id, url);
    return url;
  }

  async function mapLimit(items, limit, fn) {
    const out = [];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) { const i = next++; out[i] = await fn(items[i]).catch(() => []); }
    }));
    return out;
  }

  async function readLatest() {
    if (state.refreshToken && clientId && now() - (state.listAt || 0) > LIST_TTL)
      await fetchSubscriptions().catch(error => log(`YouTube subscriptions: ${error.message}`));
    const feeds = await mapLimit(state.channels, 6, async c => {
      const r = await fetch(FEED + c.id, { signal: AbortSignal.timeout(10000) });
      return r.ok ? parseFeed(await r.text()) : [];
    });
    const picked = pickLatest(feeds.flat(), 30);
    await mapLimit(picked, 6, async v => { v.thumb = await thumb(v.id); });
    latest = { at: now(), videos: picked.map(({ short, ...v }) => v) };
    return latest;
  }

  return {
    status() {
      return {
        connected: state.channels.length > 0,
        source: state.source || null,
        channels: state.channels.length,
        canSignIn: Boolean(clientId && clientSecret),
        signIn: signIn && now() < signIn.expiresAt ? { code: signIn.code, url: signIn.url } : null,
      };
    },

    /** The newest uploads from subscribed channels (served from a short cache while it refreshes). */
    async videos(count = 14) {
      if (!state.channels.length) return [];
      if (!latest || now() - latest.at > LATEST_TTL) {
        refreshing ||= readLatest().finally(() => { refreshing = null; });
        if (!latest) await refreshing; else refreshing.catch(() => {});
      }
      return latest.videos.slice(0, count);
    },

    importTakeout(csv) {
      const channels = parseTakeout(csv);
      if (!channels.length) throw Object.assign(Error("That file has no channels in it. Use subscriptions.csv from Google Takeout."), { status: 400 });
      state = { channels, source: "takeout" };
      latest = null;
      save();
      return channels.length;
    },

    /** Starts signing in with a code; Deck finishes it in the background once the code is entered. */
    async startSignIn() {
      if (!clientId || !clientSecret) throw Object.assign(Error("Add a Google OAuth client (TVs and limited-input devices) to config.youtube first."), { status: 400 });
      const d = await json("https://oauth2.googleapis.com/device/code", form({ client_id: clientId, scope: SCOPE }));
      signIn = { code: d.user_code, url: d.verification_url || d.verification_uri, expiresAt: now() + d.expires_in * 1000 };
      const poll = async (every) => {
        if (!signIn || now() > signIn.expiresAt) { signIn = null; return; }
        try {
          const t = await json("https://oauth2.googleapis.com/token", form({ client_id: clientId, client_secret: clientSecret, device_code: d.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }));
          state = { ...state, refreshToken: t.refresh_token, source: "account" };
          signIn = null;
          save();
          await fetchSubscriptions();
        } catch (error) {
          if (error.code === "authorization_pending" || error.code === "slow_down") return void setTimeout(() => poll(error.code === "slow_down" ? every + 5 : every), every * 1000).unref?.();
          log(`YouTube sign-in: ${error.message}`);
          signIn = null;
        }
      };
      setTimeout(() => poll(d.interval || 5), (d.interval || 5) * 1000).unref?.();
      return this.status();
    },

    disconnect() {
      state = { channels: [] };
      latest = null;
      signIn = null;
      save();
    },
  };
}
