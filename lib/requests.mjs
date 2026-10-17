const type = value => {
  if (!["movie", "tv"].includes(value)) throw Error("Choose a movie or series");
  return value;
};
const id = value => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw Error("Choose a valid title");
  return n;
};
const statusLabel = status => ({ 2: "Requested", 3: "Processing", 4: "Partially available", 5: "Available" }[status] || "Not requested");
const active = status => [2, 3, 5].includes(status);

export function mediaRequests({ api }) {
  async function details(mediaType, mediaId) {
    type(mediaType); id(mediaId);
    const item = await api("seerr", `/api/v1/${mediaType}/${mediaId}`);
    const info = item.mediaInfo || {};
    const pendingSeasons = new Set((info.requests || []).filter(r => !r.is4k && [1, 2].includes(r.status)).flatMap(r => (r.seasons || []).filter(s => [1, 2].includes(s.status)).map(s => s.seasonNumber)));
    return {
      id: item.id, type: mediaType, title: item.title || item.name,
      year: (item.releaseDate || item.firstAirDate || "").slice(0, 4), overview: item.overview,
      status: statusLabel(info.status), canRequest: mediaType === "tv" || !active(info.status),
      seasons: (item.seasons || []).map(s => {
        const status = (info.seasons || []).find(x => x.seasonNumber === s.seasonNumber)?.status;
        const blocked = active(status) || pendingSeasons.has(s.seasonNumber);
        return { number: s.seasonNumber, name: s.name, episodes: s.episodeCount, status: pendingSeasons.has(s.seasonNumber) && !active(status) ? "Requested" : statusLabel(status), canRequest: !blocked && s.episodeCount > 0 };
      }),
    };
  }
  return {
    async read(route, params) {
      if (route === "request-search") {
        const q = (params.get("q") || "").trim();
        if (q.length < 2 || q.length > 200) throw Error("Enter between 2 and 200 characters");
        const page = id(params.get("page") || 1);
        // Seerr's query validator requires percent escapes for spaces, rather than form-style '+'.
        const result = await api("seerr", "/api/v1/search?query=" + encodeURIComponent(q) + "&page=" + page);
        return { page: result.page, pages: result.totalPages, results: (result.results || []).filter(m => ["movie", "tv"].includes(m.mediaType)).map(m => ({ id: m.id, type: m.mediaType, title: m.title || m.name, year: (m.releaseDate || m.firstAirDate || "").slice(0, 4), status: statusLabel(m.mediaInfo?.status) })) };
      }
      if (route === "request-details") {
        const [item, user] = await Promise.all([details(params.get("type"), id(params.get("id"))), api("seerr", "/api/v1/auth/me")]);
        return { ...item, requester: user.displayName || user.username || "Seerr account" };
      }
    },
    async create(body) {
      const mediaType = type(body.mediaType), mediaId = id(body.mediaId);
      const item = await details(mediaType, mediaId);
      if (!item.canRequest) throw Error("This title is already requested or available");
      const payload = { mediaType, mediaId, is4k: false };
      if (mediaType === "tv") {
        if (!Array.isArray(body.seasons) || !body.seasons.length) throw Error("Select at least one season");
        const seasons = [...new Set(body.seasons.map(Number))];
        if (seasons.some(n => !Number.isInteger(n) || n < 0 || !item.seasons.some(s => s.number === n && s.canRequest))) throw Error("Choose seasons that are not already requested or available");
        payload.seasons = seasons.sort((a, b) => a - b);
      }
      const request = await api("seerr", "/api/v1/request", "POST", payload);
      return { requestId: request.id, message: `${item.title} · ${request.status === 2 ? "Request approved" : "Request submitted"}` };
    },
  };
}
