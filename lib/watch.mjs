import crypto from "node:crypto";
import { Readable } from "node:stream";

const validId = v => { if (!/^[a-f0-9-]{32,36}$/i.test(String(v))) throw Error("Choose a valid Jellyfin item or user"); return v; };
// Artwork ids for /hub/api/watch-image: a portrait poster and a 16:9 still.
const art = i => ({
  poster: i.Type === "Episode" ? (i.SeriesId && i.SeriesPrimaryImageTag ? i.SeriesId : null) : i.ImageTags?.Primary ? i.Id : null,
  wide: i.Type === "Episode"
    ? (i.ImageTags?.Primary ? { id: i.Id, kind: "Primary" } : i.ParentBackdropItemId ? { id: i.ParentBackdropItemId, kind: "Backdrop" } : null)
    : (i.BackdropImageTags?.length ? { id: i.Id, kind: "Backdrop" } : i.ImageTags?.Thumb ? { id: i.Id, kind: "Thumb" } : null),
});
const itemView = i => ({ id: i.Id, title: i.Name, series: i.SeriesName, season: i.ParentIndexNumber, episode: i.IndexNumber, type: i.Type, year: i.ProductionYear, overview: i.Overview, runtime: i.RunTimeTicks, position: i.UserData?.PlaybackPositionTicks || 0, played: !!i.UserData?.Played, percentage: i.UserData?.PlayedPercentage || 0, tmdbId: i.ProviderIds?.Tmdb, tvdbId: i.ProviderIds?.Tvdb, path: i.Path, sourceId: i.MediaSources?.[0]?.Id, art: art(i) });
export function watch({ api, config, native }) {
  const sessions = new Map();
  const device = "deck-" + crypto.randomUUID();
  const users = async () => (await api("jellyfin", "/Users")).filter(u => !u.Policy?.IsDisabled).map(u => ({ id: u.Id, name: u.Name }));
  async function checkUser(id) { validId(id); if (!(await users()).some(u => u.id === id)) throw Error("Choose an active Jellyfin user"); }
  async function view(item) { return { ...itemView(item), releaseChoice: await native?.releaseChoices?.forMedia(item) }; }
  return {
    users,
    async read(route, params) {
      if (route === "watch-users") return users();
      if (route === "watch") {
        const list = await users(), user = list.some(u => u.id === params.get("user")) ? params.get("user") : list[0]?.id;
        if (!user || !list.some(u => u.id === user)) throw Error("Choose an active Jellyfin user");
        const query = new URLSearchParams({ UserId: user, Fields: "Overview,ProviderIds,MediaSources,Path", EnableUserData: "true", Limit: "40" });
        const [resume, next, latest] = await Promise.all([api("jellyfin", "/UserItems/Resume?" + query), api("jellyfin", "/Shows/NextUp?" + query), api("jellyfin", "/Items?" + query + "&Recursive=true&IncludeItemTypes=Movie&SortBy=DateCreated&SortOrder=Descending")]);
        return { users: list, user, resume: await Promise.all((resume.Items || []).map(view)), next: await Promise.all((next.Items || []).map(view)), latest: await Promise.all((latest.Items || []).map(view)) };
      }
      if (route === "watch-item") {
        const id = validId(params.get("id")), user = params.get("user"); await checkUser(user);
        const result = await api("jellyfin", "/Items?" + new URLSearchParams({ Ids: id, UserId: user, Fields: "Overview,ProviderIds,MediaSources,Path", EnableUserData: "true" }));
        if (!result.Items?.length) throw Error("This title is not available for this Jellyfin user");
        const item = result.Items[0];
        const resultView = await view(item), source = item.MediaSources?.find(s => s.Id === resultView.releaseChoice?.sourceId) || item.MediaSources?.[0];
        return { ...resultView, audioTracks: (source?.MediaStreams || []).filter(s => s.Type === "Audio").map(s => ({ index: s.Index, name: s.DisplayTitle, language: s.Language })), subtitleTracks: (source?.MediaStreams || []).filter(s => s.Type === "Subtitle").map(s => ({ index: s.Index, name: s.DisplayTitle, language: s.Language })) };
      }
    },
    async execute(body) {
      if (body.action === "watchStart") {
        const id = validId(body.id), user = validId(body.user); await checkUser(user);
        let choice;
        if (native?.releaseChoices) {
          const result = await api("jellyfin", "/Items?" + new URLSearchParams({ Ids: id, UserId: user, Fields: "ProviderIds,MediaSources,Path" }));
          if (!result.Items?.length) throw Error("This title is not available for this Jellyfin user");
          choice = await native.releaseChoices.forMedia(result.Items[0]);
          if (choice && !choice.playbackMatches) throw Error("Your selected release is not available for playback yet. Verify its import and scan Jellyfin, or clear the release selection.");
        }
        const info = await api("jellyfin", "/Items/" + id + "/PlaybackInfo?UserId=" + user);
        if (info.ErrorCode || !info.MediaSources?.length) throw Error("Jellyfin could not open this media file: " + (info.ErrorCode || "No source"));
        const source = choice ? info.MediaSources.find(s => choice.sourceId ? s.Id === choice.sourceId : s.Path?.replaceAll("\\", "/").toLowerCase() === choice.filePath?.replaceAll("\\", "/").toLowerCase()) : info.MediaSources[0];
        if (!source) throw Error("Jellyfin has not opened the selected release. Scan its library and try again.");
        const token = crypto.randomUUID(), playId = info.PlaySessionId || crypto.randomUUID().replaceAll("-", "");
        const audio = source.MediaStreams?.find(s => s.Type === "Audio" && (body.audio === undefined || body.audio === "" || s.Index === Number(body.audio)));
        const video = source.MediaStreams?.find(s => s.Type === "Video");
        const direct = source.Container?.split(",").some(c => ["mp4", "mov", "m4v"].includes(c)) && video?.Codec === "h264" && ["aac", "mp3"].includes(audio?.Codec) && Number(body.subtitle ?? -1) === -1;
        for (const [key, session] of sessions) if (Date.now() - session.at > 86400000) sessions.delete(key);
        sessions.set(token, { id, user, sourceId: source.Id, playId, audio: body.audio, subtitle: body.subtitle, direct, resources: new Map(), at: Date.now() });
        return { message: "Player ready", token, source: "/hub/api/watch-stream?token=" + token, hls: !direct, playId, duration: source.RunTimeTicks / 10000000 };
      }
      if (body.action === "watchProgress") {
        const session = sessions.get(body.token); if (!session) throw Error("Playback session expired. Reopen the player.");
        session.at = Date.now();
        if (!["start", "progress", "stop"].includes(body.event)) throw Error("Choose a valid playback event");
        const position = Number(body.position); if (!Number.isFinite(position) || position < 0) throw Error("Invalid playback position");
        const payload = { ItemId: session.id, UserId: session.user, MediaSourceId: session.sourceId, PlaySessionId: session.playId, PositionTicks: Math.round(position * 10000000), IsPaused: !!body.paused, CanSeek: true, PlayMethod: session.direct ? "DirectPlay" : "Transcode", SessionId: undefined };
        const endpoint = body.event === "start" ? "/Sessions/Playing" : body.event === "stop" ? "/Sessions/Playing/Stopped" : "/Sessions/Playing/Progress";
        await api("jellyfin", endpoint + "?" + new URLSearchParams({ DeviceId: device, UserId: session.user }), "POST", payload);
        // Explicitly persist watch position for the chosen profile, including API-key sessions.
        const previous = await api("jellyfin", `/UserItems/${session.id}/UserData?UserId=${session.user}`);
        await api("jellyfin", `/UserItems/${session.id}/UserData?UserId=${session.user}`, "POST", { ...previous, PlaybackPositionTicks: body.ended ? 0 : payload.PositionTicks, ...(body.ended ? { Played: true } : {}) });
        return { message: "Watch progress saved" };
      }
    },
    async stream(req, res, params) {
      const session = sessions.get(params.get("token"));
      if (!session || Date.now() - session.at > 86400000) { res.writeHead(404); res.end("Playback session expired"); return; }
      const query = new URLSearchParams({ UserId: session.user, DeviceId: device, MediaSourceId: session.sourceId, PlaySessionId: session.playId, Static: session.direct ? "true" : "false", VideoCodec: "h264", AudioCodec: "aac", MaxAudioChannels: "2", VideoBitrate: "10000000", AudioBitrate: "192000", AllowVideoStreamCopy: "true", AllowAudioStreamCopy: "true", EnableAutoStreamCopy: "true", SegmentContainer: "ts", MinSegments: "1", BreakOnNonKeyFrames: "true", EnableAdaptiveBitrateStreaming: "false" });
      if (session.audio !== undefined && session.audio !== "") query.set("AudioStreamIndex", String(session.audio));
      if (session.subtitle !== undefined && session.subtitle !== "") { query.set("SubtitleStreamIndex", String(session.subtitle)); query.set("SubtitleMethod", "Encode"); }
      const controller = new AbortController(); res.on("close", () => controller.abort());
      try {
        const base = `http://${config.host || "127.0.0.1"}:${config.services.jellyfin.port}`;
        const resource = params.get("resource");
        const target = resource ? session.resources.get(resource) : `/Videos/${session.id}/${session.direct ? "stream.mp4" : "master.m3u8"}?${query}`;
        if (!target) { res.writeHead(404); res.end("Stream resource expired"); return; }
        const upstream = await fetch(base + target, { headers: { "X-Emby-Token": config.services.jellyfin.key, "X-Emby-Authorization": `MediaBrowser Client="Deck", Device="Browser", DeviceId="${device}", Version="3.2.0"`, ...(req.headers.range ? { Range: req.headers.range } : {}) }, signal: controller.signal });
        const headers = { "Content-Type": upstream.headers.get("content-type") || "video/mp4", "Cache-Control": "no-store" };
        for (const key of ["content-length", "content-range", "accept-ranges"]) if (upstream.headers.has(key)) headers[key] = upstream.headers.get(key);
        if (!upstream.ok) { res.writeHead(upstream.status, { "Content-Type": "text/plain" }); res.end("Jellyfin could not stream this file. Check its transcoding log."); return; }
        if (target.split("?")[0].endsWith(".m3u8")) {
          const playlist = await upstream.text();
          const convert = value => {
            const parsed = new URL(value, base + target);
            if (parsed.origin !== base || !parsed.pathname.startsWith("/Videos/")) throw Error("Unexpected Jellyfin stream location");
            parsed.searchParams.delete("api_key"); parsed.searchParams.delete("ApiKey");
            const localId = crypto.createHash("sha256").update(parsed.pathname + parsed.search).digest("hex").slice(0, 24);
            session.resources.set(localId, parsed.pathname + parsed.search);
            return "/hub/api/watch-stream?" + new URLSearchParams({ token: params.get("token"), resource: localId });
          };
          const rewritten = playlist.split("\n").map(line => line.startsWith("#") ? line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${convert(uri)}"`) : line.trim() ? convert(line.trim()) : line).join("\n");
          res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-store" }); res.end(rewritten); return;
        }
        if (req.method === "HEAD") { res.writeHead(upstream.status, headers); res.end(); await upstream.body?.cancel(); return; }
        res.writeHead(upstream.status, headers);
        const stream = Readable.fromWeb(upstream.body); stream.on("error", () => res.destroy()); stream.pipe(res);
      } catch (e) { if (!res.headersSent) { res.writeHead(502); res.end("Jellyfin stream unavailable"); } else res.destroy(); }
    },
  };
}
