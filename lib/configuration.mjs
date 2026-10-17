import { redact } from "./storage.mjs";

const providerCatalog = ["addic7ed", "animekalesi", "animetosho", "animetosho_xyz", "tsukihime", "animesubinfo", "avistaz", "bayflix", "assrt", "betaseries", "bsplayer", "cinemaz", "embeddedsubtitles", "gestdown", "greeksubs", "greeksubtitles", "hdbits", "jimaku", "karagarga", "ktuvit", "pipocas", "legendasdivx", "legendasnet", "napiprojekt", "napisy24", "opensubtitlescom", "prijevodionline", "regielive", "soustitreseu", "subclub", "subdl", "subf2m", "subsource", "subsarr", "subsdump", "subssabbz", "subs4free", "subs4series", "subsro", "subsunacs", "subtis", "subtitrarinoi", "subtitriid", "subtitulamostv", "subx", "subtitlecat", "titlovi", "titrari", "titulky", "turkcealtyaziorg", "whisperai", "xsubs", "yavkanet", "vladoonmooo", "zimuku"];
export const privateField = f => f.privacy !== undefined && f.privacy !== 0 || /password|apikey|api_key|token|passkey|secret|cookie/i.test(f.name);
export function publicConnection(item) {
  return { id: item.id, name: item.name, implementation: item.implementation, enable: item.enable,
    enableRss: item.enableRss, enableAutomaticSearch: item.enableAutomaticSearch, enableInteractiveSearch: item.enableInteractiveSearch,
    priority: item.priority, syncLevel: item.syncLevel,
    fields: (item.fields || []).map(f => ({ name: f.name, label: f.label || f.name, type: f.type,
      value: privateField(f) ? "" : f.value, secret: !!privateField(f), selectOptions: f.selectOptions,
      helpText: redact(f.helpText || ""), advanced: !!f.advanced })) };
}
const prefix = n => n === "prowlarr" ? "/api/v1/" : "/api/v3/";
const validate = (n, type) => {
  if (!["radarr", "sonarr", "prowlarr"].includes(n) || !["indexer", "downloadclient", "applications"].includes(type) || type === "applications" && n !== "prowlarr") throw Error("Choose an indexer, download client, or Prowlarr application");
};
function applyConnection(item, body) {
  if (!body.name?.trim()) throw Error("Enter a connection name");
  item.name = body.name.trim();
  for (const k of ["enable", "enableRss", "enableAutomaticSearch", "enableInteractiveSearch"]) if (body[k] !== undefined) item[k] = !!body[k];
  if (body.priority !== undefined) item.priority = Math.max(1, Math.min(50, Number(body.priority)));
  if (body.syncLevel !== undefined && ["disabled", "addOnly", "fullSync"].includes(body.syncLevel)) item.syncLevel = body.syncLevel;
  item.fields = (item.fields || []).map(f => {
    let value = body.fields?.[f.name];
    if (value === undefined || privateField(f) && value === "") return f;
    if (f.type === "number") value = value === "" ? null : Number(value);
    if (f.type === "checkbox") value = !!value;
    if (Array.isArray(f.value) && !Array.isArray(value)) throw Error("Choose valid values for " + f.label);
    return { ...f, value };
  });
  return item;
}
export function configuration({ api, tokens, cache }) {
  return {
    async read(route, params) {
      const n = params.get("service"), type = params.get("type");
      if (route === "connection") { validate(n, type); return publicConnection(await api(n, prefix(n) + type + "/" + Number(params.get("id")))); }
      if (route === "connection-schemas") {
        validate(n, type);
        const schemas = await api(n, prefix(n) + type + "/schema");
        const token = crypto.randomUUID(); tokens.set(token, { service: n, type, schemas, expires: Date.now() + 1800000 });
        return { token, schemas: schemas.map((s, index) => ({ ...publicConnection(s), index, presets: (s.presets || []).map(publicConnection) })) };
      }
      if (route === "configuration") {
        if (!["radarr", "sonarr", "prowlarr"].includes(n)) throw Error("Choose a library service");
        const result = { errors: [] };
        const paths = { host: "config/host" };
        if (n !== "prowlarr") Object.assign(paths, { profiles: "qualityprofile", formats: "customformat", formatSchemas: "customformat/schema", roots: "rootfolder", qualities: "qualitydefinition" });
        await Promise.all(Object.entries(paths).map(async ([key, endpoint]) => {
          try { const v = await api(n, prefix(n) + endpoint); result[key] = key === "host" ? { allowedHosts: v.allowedHosts } : v; }
          catch (e) { result.errors.push({ section: key, message: e.message }); }
        }));
        return result;
      }
      if (route === "bazarr-configuration") {
        const [settings, profiles, languages] = await Promise.all([api("bazarr", "/api/system/settings"), api("bazarr", "/api/system/languages/profiles"), api("bazarr", "/api/system/languages")]);
        const enabled = settings.general.enabled_providers || [];
        // Only provider settings are exposed. Auth, database, and other integration secrets stay server-side.
        const excluded = new Set(["general", "auth", "analytics", "anidb", "sonarr", "radarr", "jellyfin", "plex", "postgresql", "proxy", "cors", "log", "backup", "notifications", "subsync", "translator", "anticaptcha", "captchaai", "deathbycaptcha"]);
        const providers = Object.entries(settings).filter(([k]) => !excluded.has(k)).map(([name, values]) => ({ name, enabled: enabled.includes(name), fields: Object.entries(values).map(([key, value]) => ({ name: key, label: key.replaceAll("_", " "), type: typeof value === "boolean" ? "checkbox" : typeof value === "number" ? "number" : "textbox", value: /password|key|token|secret|cookie/i.test(key) ? "" : value, secret: /password|key|token|secret|cookie/i.test(key) })) }));
        for (const name of new Set([...providerCatalog, ...enabled])) if (!providers.some(p => p.name === name)) providers.push({ name, enabled: enabled.includes(name), fields: [] });
        return { providers, profiles, languages, defaults: { movie: settings.general.movie_default_profile, series: settings.general.serie_default_profile, movieEnabled: settings.general.movie_default_enabled, seriesEnabled: settings.general.serie_default_enabled } };
      }
    },
    async execute(body) {
      const n = body.service, type = body.type;
      if (body.action === "connectionCreate") {
        validate(n, type);
        const stored = tokens.get(body.token);
        if (!stored || stored.expires < Date.now() || stored.service !== n || stored.type !== type) throw Error("Connection options expired. Open the form again.");
        const schema = stored.schemas[Number(body.index)]; if (!schema) throw Error("Choose a connection type");
        const chosen = Number.isInteger(Number(body.preset)) && Number(body.preset) >= 0 ? schema.presets?.[Number(body.preset)] : schema;
        if (!chosen) throw Error("Choose an existing connection preset");
        const item = applyConnection(structuredClone({ ...schema, ...chosen }), body); delete item.id; delete item.presets;
        await api(n, prefix(n) + type + "/test", "POST", item);
        if (body.operation !== "test") await api(n, prefix(n) + type, "POST", item);
        cache.clear(); return { message: body.operation === "test" ? "Connection test passed" : "Connection created" };
      }
      if (body.action === "connectionSave") {
        validate(n, type); const item = applyConnection(await api(n, prefix(n) + type + "/" + Number(body.id)), body);
        await api(n, prefix(n) + type + "/" + item.id, "PUT", item); cache.clear(); return { message: "Connection saved" };
      }
      if (body.action === "hosts") {
        if (!["radarr", "sonarr", "prowlarr"].includes(n)) throw Error("Choose a library service");
        const hosts = String(body.hosts).split(/[\s,]+/).filter(Boolean);
        if (!hosts.length || hosts.some(h => !/^[a-z0-9._:-]+$/i.test(h))) throw Error("Enter hostnames or IP addresses separated by commas");
        const item = await api(n, prefix(n) + "config/host");
        item.allowedHosts = hosts.join(",");
        await api(n, prefix(n) + "config/host/" + item.id, "PUT", item); cache.clear(); return { message: "Allowed hostnames saved" };
      }
      if (body.action === "profileAdvanced") {
        if (!["radarr", "sonarr"].includes(n)) throw Error("Choose movies or series");
        const profile = await api(n, "/api/v3/qualityprofile/" + Number(body.id));
        if (!body.name?.trim()) throw Error("Enter a profile name");
        const identity = i => String(i.items?.length ? "group:" + i.id : "quality:" + i.quality.id);
        if (!Array.isArray(body.order) || body.order.length !== profile.items.length || new Set(body.order).size !== profile.items.length || body.order.some(k => !profile.items.some(i => identity(i) === k))) throw Error("The quality order is incomplete. Reload the profile.");
        const allowed = new Set((body.allowed || []).map(Number));
        const qualities = profile.items.flatMap(i => i.items?.length ? i.items : [i]);
        if (!allowed.size || [...allowed].some(id => !qualities.some(q => q.quality.id === id))) throw Error("Enable at least one existing quality");
        profile.items = body.order.map(key => {
          const item = profile.items.find(i => identity(i) === key);
          if (item.items?.length) { item.items = item.items.map(q => ({ ...q, allowed: allowed.has(q.quality.id) })); item.allowed = item.items.some(q => q.allowed); }
          else item.allowed = allowed.has(item.quality.id);
          return item;
        });
        const cutoff = Number(body.cutoff);
        if (!profile.items.some(i => i.allowed && (i.items?.length ? i.id === cutoff || i.items.some(q => q.allowed && q.quality.id === cutoff) : i.quality.id === cutoff))) throw Error("The upgrade cutoff must be an enabled quality");
        Object.assign(profile, { name: body.name.trim(), cutoff, upgradeAllowed: !!body.upgradeAllowed });
        for (const k of ["minFormatScore", "cutoffFormatScore", "minUpgradeFormatScore"]) if (body[k] !== undefined) { const v = Number(body[k]); if (!Number.isFinite(v)) throw Error("Enter valid custom format thresholds"); profile[k] = v; }
        profile.formatItems = (profile.formatItems || []).map(f => ({ ...f, score: body.scores?.[f.format] === undefined ? f.score : Number(body.scores[f.format]) }));
        if (profile.formatItems.some(f => !Number.isFinite(f.score))) throw Error("Enter a valid custom format score");
        await api(n, "/api/v3/qualityprofile/" + profile.id, "PUT", profile); cache.clear(); return { message: "Quality order and custom format scores saved" };
      }
      if (body.action === "rootCreate") {
        if (!["radarr", "sonarr"].includes(n) || !String(body.path || "").trim()) throw Error("Enter an existing library folder on the media PC");
        await api(n, "/api/v3/rootfolder", "POST", { path: body.path.trim() }); cache.clear(); return { message: "Library folder added" };
      }
      if (body.action === "customFormat") {
        if (!["radarr", "sonarr"].includes(n) || !body.name?.trim() || !Array.isArray(body.conditions) || !body.conditions.length) throw Error("Name the custom format and add at least one condition");
        const schemas = await api(n, "/api/v3/customformat/schema");
        const original = body.id ? await api(n, "/api/v3/customformat/" + Number(body.id)) : {};
        const specifications = body.conditions.map(condition => {
          const schema = schemas.find(s => s.implementation === condition.implementation);
          if (!schema) throw Error("Choose a supported format condition");
          const item = { ...structuredClone(schema), id: condition.id || 0, name: condition.name || schema.implementationName || schema.name, negate: !!condition.negate, required: !!condition.required };
          delete item.presets;
          item.fields = (item.fields || []).map(f => ({ ...f, value: condition.fields?.[f.name] === undefined ? f.value : f.type === "number" ? Number(condition.fields[f.name]) : condition.fields[f.name] }));
          return item;
        });
        const payload = { ...original, name: body.name.trim(), includeCustomFormatWhenRenaming: !!body.includeWhenRenaming, specifications };
        await api(n, "/api/v3/customformat" + (body.id ? "/" + Number(body.id) : ""), body.id ? "PUT" : "POST", payload);
        cache.clear(); return { message: body.id ? "Custom format saved" : "Custom format created" };
      }
      if (body.action === "bazarrProvider") {
        const settings = await api("bazarr", "/api/system/settings");
        const name = body.provider;
        const available = await this.read("bazarr-configuration", new URLSearchParams());
        if (!available.providers.some(p => p.name === name)) throw Error("Choose an available subtitle provider");
        const enabled = new Set(settings.general.enabled_providers || []);
        body.enabled ? enabled.add(name) : enabled.delete(name);
        const form = new URLSearchParams();
        if (!enabled.size) form.append("settings-general-enabled_providers", "");
        else for (const value of enabled) form.append("settings-general-enabled_providers", value);
        for (const [key, value] of Object.entries(body.fields || {})) {
          if (!(key in (settings[name] || {}))) throw Error("Unknown provider option");
          if (/password|key|token|secret|cookie/i.test(key) && value === "") continue;
          form.append("settings-" + name + "-" + key, String(value));
        }
        await api("bazarr", "/api/system/settings", "POST", form); cache.clear(); return { message: "Subtitle provider saved" };
      }
      if (body.action === "languageProfile") {
        const [profiles, languages] = await Promise.all([api("bazarr", "/api/system/languages/profiles"), api("bazarr", "/api/system/languages")]);
        const id = body.id ? Number(body.id) : Math.max(0, ...profiles.map(p => p.profileId)) + 1;
        if (body.id && !profiles.some(p => p.profileId === id)) throw Error("Language profile no longer exists");
        if (!body.name?.trim() || !Array.isArray(body.items) || !body.items.length) throw Error("Name the profile and choose at least one language");
        const items = body.items.map((item, i) => {
          if (!languages.some(l => l.code2 === item.language)) throw Error("Choose a valid subtitle language");
          return { id: i + 1, language: item.language, forced: item.forced ? "True" : "False", hi: item.hi ? "True" : "False", audio_exclude: item.audio_exclude ? "True" : "False", audio_only_include: item.audio_only_include ? "True" : "False" };
        });
        const original = profiles.find(p => p.profileId === id) || {};
        const profile = { ...original, profileId: id, name: body.name.trim(), items, cutoff: body.cutoff ? Number(body.cutoff) : null, mustContain: body.mustContain || [], mustNotContain: body.mustNotContain || [], originalFormat: body.originalFormat ? 1 : 0 };
        if (profile.cutoff !== null && !items.some(i => i.id === profile.cutoff)) throw Error("The cutoff must be a row in this language profile");
        const next = profiles.filter(p => p.profileId !== id).concat(profile);
        const form = new URLSearchParams({ "languages-profiles": JSON.stringify(next) });
        const enabled = new Set(languages.filter(l => l.enabled).map(l => l.code2)); items.forEach(i => enabled.add(i.language)); enabled.forEach(l => form.append("languages-enabled", l));
        await api("bazarr", "/api/system/settings", "POST", form); cache.clear(); return { message: "Language profile saved" };
      }
      if (body.action === "subtitleDefaults") {
        const profiles = await api("bazarr", "/api/system/languages/profiles");
        if (![body.movie, body.series].every(id => !id || profiles.some(p => p.profileId === Number(id)))) throw Error("Choose existing language profiles");
        await api("bazarr", "/api/system/settings", "POST", new URLSearchParams({ "settings-general-movie_default_enabled": String(!!body.movieEnabled), "settings-general-serie_default_enabled": String(!!body.seriesEnabled), "settings-general-movie_default_profile": body.movie || "", "settings-general-serie_default_profile": body.series || "" })); cache.clear(); return { message: "Default subtitle profiles saved" };
      }
    },
  };
}
