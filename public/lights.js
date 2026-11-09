// Lights: LED strips (Bluetooth via the lights bridge) and WiZ bulbs, plus whole-room scenes.
navs.splice(navs.findIndex(n => n[0] === "calendar"), 0, ["lights", "Lights"]);
icons.lights = '<path d="M9 18h6m-5 3h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>';

const deckLightColors = [
  ["Warm orange", [255, 90, 0]], ["Red", [255, 0, 0]], ["Pink", [255, 0, 120]], ["Purple", [120, 0, 255]],
  ["Blue", [0, 40, 255]], ["Cyan", [0, 200, 255]], ["Green", [0, 255, 60]], ["White", [255, 255, 255]],
];
const deckEffectNames = { jump3: "3-colour jump", jump7: "7-colour jump", fade3: "3-colour fade", "rainbow-fade": "Rainbow fade", strobe7: "7-colour strobe" };
let deckLights = null, deckLightScenes = [], deckSchedules = null;
const deckLightsBusy = new Set(), deckStripTab = new Map();
const deckTimers = [[0, "No sleep timer"], [30, "Off in 30 minutes"], [60, "Off in 1 hour"], [120, "Off in 2 hours"], [240, "Off in 4 hours"], [480, "Off in 8 hours"]];

const deckHex = c => "#" + c.map(v => v.toString(16).padStart(2, "0")).join("");
const deckRgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const deckEffectName = (e, d) => d?.effects?.find(x => x.name === e)?.label || deckEffectNames[e] || e[0].toUpperCase() + e.slice(1).replace(/-/g, " ");
const deckMusicModes = d => Array.isArray(d.musicModes) ? d.musicModes : Array.from({ length: d.musicModes || 8 }, (_, i) => "Rhythm " + (i + 1));
// Group a strip's patterns into <optgroup>s by family when the bridge names one.
function deckEffectOptions(list, current) {
  const option = e => `<option value="${esc(e.name)}" ${e.name === current ? "selected" : ""}>${esc(e.label)}</option>`;
  if (!list.some(e => e.group)) return list.map(option).join("");
  const groups = new Map();
  for (const e of list) groups.set(e.group || "Other", [...(groups.get(e.group || "Other") || []), e]);
  return [...groups].map(([group, items]) => `<optgroup label="${esc(group)}">${items.map(option).join("")}</optgroup>`).join("");
}
const deckClock = iso => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
function deckKelvinCss(kelvin) {
  const t = kelvin / 100;
  const r = t <= 66 ? 255 : 329.7 * (t - 60) ** -0.1332;
  const g = t <= 66 ? 99.47 * Math.log(t) - 161.12 : 288.12 * (t - 60) ** -0.0755;
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.52 * Math.log(t - 10) - 305.04;
  return `rgb(${[r, g, b].map(v => Math.round(Math.max(0, Math.min(255, v)))).join(",")})`;
}

const deckSceneGlow = { movie: "#2f5bff", chill: "#ff8a2a", gaming: "#8a3cff", party: "#ff3ca0", bright: "#fff1d6", night: "#ff3b1f", off: "#6b655d" };
function deckSceneButton(s) {
  return `<button class="light-scene" style="--scene:${deckSceneGlow[s.id] || "var(--accent)"}" data-light-scene="${esc(s.id)}" ${deckLightsBusy.size ? "disabled" : ""}><strong>${esc(s.name)}</strong><small>${esc(s.detail)}</small></button>`;
}

function deckLightCard(d, effects, wizScenes) {
  const busy = deckLightsBusy.has(d.name) || deckLightsBusy.has("*");
  const unreachable = d.kind === "wiz" && !d.reachable;
  const on = d.on === true;
  const swatch = !on ? "var(--raised)" : d.color ? `rgb(${d.color.join(",")})` : d.temp ? deckKelvinCss(d.temp) : "var(--amber)";
  const meta = d.kind === "strip"
    ? `Bluetooth · ${d.connected ? "connected" : "connects when used"}${d.updatedAt ? " · last set " + ago(d.updatedAt).toLowerCase() : ""}`
    : `${d.capabilities ? deckBulbKinds[d.capabilities.kind] + " · " : ""}Wi-Fi · ${esc(d.ip || "address unknown")}${d.rssi ? ` · signal ${d.rssi} dBm` : ""}${d.inScenes === false ? " · not in room scenes" : ""}`;
  const stateText = unreachable ? "Not answering" : d.on == null ? "State unknown" : !on ? "Off" : d.music ? `Music · ${esc(deckMusicModes(d)[d.music - 1] || "mode " + d.music)}` : d.effect ? deckEffectName(d.effect, d) : d.sceneName || (d.temp ? d.temp + " K white" : "On");
  const power = ["On", "Off"].map(label => `<button data-light-set="${d.name}" data-field="on" data-value="${label === "On"}" class="${d.on === (label === "On") ? "selected" : ""}" ${busy ? "disabled" : ""}>${label}</button>`).join("");
  const colours = deckLightColors.map(([name, c]) => `<button class="light-color" style="--swatch:rgb(${c})" title="${name}" aria-label="${name}" data-light-color="${d.name}" data-rgb="${c}"></button>`).join("")
    + `<input type="color" class="light-picker" value="${deckHex(d.color || [255, 90, 0])}" data-light-picker="${d.name}" aria-label="Custom colour for ${esc(d.label)}" title="Custom colour">`;
  const slider = (label, field, min, max, step, value, shown) => `<label class="light-slider">${label}<output>${shown}</output><input type="range" min="${min}" max="${max}" step="${step}" value="${value}" data-light-range="${d.name}" data-field="${field}"></label>`;
  const colourRow = `<div class="light-colors" role="group" aria-label="Colours for ${esc(d.label)}">${colours}</div>`;
  let extra;
  if (d.kind === "wiz") {
    // What the bulb said it can do; until it has, every control shows.
    const caps = d.capabilities, range = caps ? caps.temp : [2200, 6500];
    extra = (!caps || caps.color ? colourRow : "")
      + (range ? slider("White", "temp", range[0], range[1], 100, Math.min(range[1], Math.max(range[0], d.temp || 2700)), d.temp ? d.temp + " K" : "—") : "")
      + (!caps || caps.scenes ? `<label class="field light-field">WiZ scene<select data-light-select="${d.name}" data-field="scene"><option value="">Choose a scene…</option>${Object.entries(wizScenes).map(([id, n]) => `<option value="${id}" ${Number(id) === d.scene ? "selected" : ""}>${esc(n)}</option>`).join("")}</select></label>` : "")
      + `<div class="inline-actions light-actions">${button("Identify", `data-light-identify="${d.name}" ${busy ? "disabled" : ""}`)}${button("Settings", `data-light-settings="${d.name}"`)}</div>`;
  } else {
    const tab = deckStripTab.get(d.name) || (d.music ? "music" : d.effect ? "pattern" : "colour");
    const tabs = [["colour", "Colour"], ["pattern", "Pattern"], ["music", "Music"]].map(([key, label]) => `<button data-light-tab="${d.name}:${key}" class="${tab === key ? "selected" : ""}" aria-pressed="${tab === key}">${label}</button>`).join("");
    const list = d.effects || (effects || []).map(name => ({ name, label: deckEffectName(name) }));
    const panes = {
      colour: colourRow,
      pattern: `<label class="field light-field">Pattern<select data-light-select="${d.name}" data-field="effect"><option value="" disabled ${d.effect ? "" : "selected"}>Choose a pattern…</option>${deckEffectOptions(list, d.effect)}</select></label>`
        + slider("Speed", "speed", 0, 100, 1, d.speed ?? 50, d.speed ?? "—")
        + (list.length > 100 ? `<p class="light-hint">The controller’s ${list.length} built-in patterns, under the names its phone app uses.</p>` : ""),
      music: `<div class="light-music" role="group" aria-label="Music modes">${deckMusicModes(d).map((label, i) => `<button data-light-music="${d.name}:${i + 1}" class="${d.music === i + 1 ? "selected" : ""}" aria-label="${esc(label)}"><span>${i + 1}</span><small>${esc(label)}</small></button>`).join("")}</div>`
        + slider("Mic sensitivity", "sensitivity", 0, 100, 1, d.sensitivity ?? 70, d.sensitivity ?? "—")
        + `<p class="light-hint">These listen through the strip’s own microphone, like the remote’s music buttons.${d.music ? "" : " Pick one to start."}</p>${d.music ? `<button class="button small-button" data-light-music="${d.name}:0">Stop music mode</button>` : ""}`,
    };
    extra = `<div class="segmented light-tabs" role="group" aria-label="${esc(d.label)} mode">${tabs}</div>${panes[tab]}`
      + `<label class="field light-field">Sleep timer<select data-light-select="${d.name}" data-field="timer">${d.offAt ? `<option selected disabled>Turns off at ${deckClock(d.offAt)}</option>` : ""}${deckTimers.map(([m, label]) => `<option value="${m}" ${!d.offAt && m === 0 ? "selected" : ""}>${m === 0 && d.offAt ? "Cancel sleep timer" : label}</option>`).join("")}</select></label>`;
  }
  return `<section class="panel light-card${on ? " is-on" : ""}${busy ? " is-busy" : ""}" style="--swatch:${swatch}">
    <div class="light-head"><span class="light-swatch"></span><div class="light-title"><h2>${esc(d.label)}</h2><p>${meta}</p></div><div class="segmented" role="group" aria-label="${esc(d.label)} power">${power}</div></div>
    <div class="light-body">
      <div class="light-state">${chip(stateText, on && !unreachable)}${busy ? '<span class="spinner"></span><span class="small muted">Sending…</span>' : ""}</div>
      ${unreachable && d.lastError ? `<div class="notice light-notice">${esc(d.lastError)}</div>` : ""}
      ${d.kind === "strip" && d.lastError ? `<div class="notice light-notice">${esc(d.lastError)}</div>` : ""}
      ${slider("Brightness", "brightness", 1, 100, 1, d.brightness ?? 100, d.brightness != null ? d.brightness + "%" : "—")}
      ${extra}
    </div>
  </section>`;
}

function deckLightsView(r) {
  const head = title("Lights", "Room scenes, schedules, and every light the media server can reach.", button("Find lights", 'data-lights-find="true"') + button("Refresh", 'data-lights-refresh="true"'));
  const scenes = panel("Scenes", `<div class="light-scenes">${r.scenes.map(deckSceneButton).join("")}</div>`);
  if (!r.bridge.online)
    return head + `<div class="error-box"><h2>Lights bridge offline</h2><p>${esc(r.bridge.error)}</p>${button("Try again", 'data-lights-refresh="true"')}</div>`;
  return head + scenes + deckSchedulesPanel(r)
    + `<div class="light-grid">${r.devices.map(d => deckLightCard(d, r.effects, r.wizScenes)).join("")}</div>`
    + `<p class="small muted light-footnote">${r.bridge.push?.listening ? "WiZ bulbs report each change as it happens, and announce a new address when they start. " : r.devices.some(d => d.kind === "wiz") ? "WiZ bulbs are asked for their state each time (the bridge can’t listen on UDP 38900). " : ""}Bluetooth strips can’t report their state, so Deck shows what it last sent. A strip accepts one Bluetooth connection at a time; the bridge lets go after 90 seconds idle so its phone app can connect.</p>`;
}

function deckLightsPaint() {
  if (route === "lights" && deckLights) $("#main").innerHTML = deckLightsView(deckLights);
}
async function deckLightsLoad(id) {
  const [result, schedules] = await Promise.all([get("lights"), get("lights/schedules").catch(() => null)]);
  if (schedules) deckSchedules = schedules;
  if (id !== undefined && id !== renderId) return;
  deckLights = result;
  if (result.scenes?.length) deckLightScenes = result.scenes;
  if (route === "lights" && !document.activeElement?.matches("#main input,#main select")) deckLightsPaint();
}

// Apply the change locally straight away; the bridge's reply settles the real state.
function deckLightsGuess(names, change) {
  for (const d of deckLights?.devices || []) {
    if (!names.includes(d.name)) continue;
    if (change.on !== undefined) d.on = change.on;
    else d.on = true;
    if (change.color) Object.assign(d, { color: change.color, temp: null, scene: null, sceneName: null, effect: null, music: null });
    if (change.temp) Object.assign(d, { temp: change.temp, color: null, scene: null, sceneName: null });
    if (change.brightness) d.brightness = change.brightness;
    if (change.effect) Object.assign(d, { effect: change.effect, music: null });
    if (change.music !== undefined) d.music = change.music || null;
    if (change.sensitivity !== undefined) d.sensitivity = change.sensitivity;
    if (change.timer !== undefined) d.offAt = change.timer ? new Date(Date.now() + change.timer * 60000).toISOString() : null;
    if (change.speed !== undefined) d.speed = change.speed;
    if (change.scene) Object.assign(d, { scene: change.scene, sceneName: deckLights.wizScenes[change.scene], color: null, temp: null });
  }
}

async function deckLightsSend(body, busyKey) {
  deckLightsBusy.add(busyKey);
  if (body.targets) deckLightsGuess(body.targets, body);
  deckLightsPaint();
  try {
    const response = await fetch("/hub/api/lights", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || "The lights did not respond");
    const failed = Object.entries(result.results || {}).filter(([, x]) => !x.ok);
    toast(failed.length ? failed.map(([name, x]) => `${name}: ${x.error}`).join(" · ") : result.message, failed.length > 0);
  } catch (error) {
    toast(error.message, true);
  } finally {
    deckLightsBusy.delete(busyKey);
    deckLightsPaint();
    try { await deckLightsLoad(); } catch (error) { toast(error.message, true); }
  }
}

const deckLightsRender = render;
render = async () => {
  if (route !== "lights") return deckLightsRender();
  const id = ++renderId;
  renderNav();
  $("#crumb").textContent = "Lights";
  if (deckLights) deckLightsPaint();
  else $("#main").innerHTML = loading();
  try {
    await deckLightsLoad(id);
  } catch (error) {
    if (id === renderId) $("#main").innerHTML = `<div class="error-box"><h2>Could not load the lights</h2><p>${esc(error.message)}</p>${button("Try again", 'data-lights-refresh="true"')}</div>`;
  }
};

// Scene shortcuts on Home (called from overview()).
function deckLightsHome(section) {
  return deckLightScenes.length ? section("Lights", '<a class="text-link" href="#lights">All lights</a>', `<div class="light-scenes compact">${deckLightScenes.map(deckSceneButton).join("")}</div>`) : "";
}

document.addEventListener("click", async event => {
  const target = event.target.closest("[data-light-scene],[data-light-set],[data-light-color],[data-lights-refresh],[data-light-tab],[data-light-music]");
  if (!target || target.disabled) return;
  const v = target.dataset;
  if (v.lightsRefresh) { await render(); return; }
  if (v.lightScene) {
    const scene = deckLightScenes.find(s => s.id === v.lightScene);
    toast("Setting the " + (scene?.name || "scene") + " scene…");
    await deckLightsSend({ scene: v.lightScene }, "*");
    if (route === "overview") await render();
    return;
  }
  if (v.lightSet) return deckLightsSend({ targets: [v.lightSet], on: v.value === "true" }, v.lightSet);
  if (v.lightColor) return deckLightsSend({ targets: [v.lightColor], color: v.rgb.split(",").map(Number) }, v.lightColor);
  if (v.lightTab) { const [name, tab] = v.lightTab.split(":"); deckStripTab.set(name, tab); return deckLightsPaint(); }
  if (v.lightMusic) { const [name, mode] = v.lightMusic.split(":"); return deckLightsSend({ targets: [name], music: Number(mode) }, name); }
});
document.addEventListener("input", event => {
  const t = event.target;
  if (!t.dataset.lightRange) return;
  t.previousElementSibling.textContent = t.dataset.field === "brightness" ? t.value + "%" : t.dataset.field === "temp" ? t.value + " K" : t.value;
});
document.addEventListener("change", event => {
  const t = event.target, name = t.dataset.lightRange || t.dataset.lightSelect || t.dataset.lightPicker;
  if (!name) return;
  if (t.dataset.lightPicker) return deckLightsSend({ targets: [name], color: deckRgb(t.value) }, name);
  if (t.dataset.lightRange) return deckLightsSend({ targets: [name], [t.dataset.field]: Number(t.value) }, name);
  if (t.dataset.field === "scene" && t.value) return deckLightsSend({ targets: [name], scene: Number(t.value) }, name);
  if (t.dataset.field === "effect" && t.value) return deckLightsSend({ targets: [name], effect: t.value }, name);
  if (t.dataset.field === "timer") return deckLightsSend({ targets: [name], timer: Number(t.value) }, name);
});

window.addEventListener("DOMContentLoaded", async () => {
  try {
    deckLightScenes = (await get("lights-scenes")).scenes;
    if (route === "overview" && data) await render();
  } catch {}
});
setInterval(() => {
  if (route === "lights" && !document.hidden && !deckLightsBusy.size && !$("#dialog").open && !document.activeElement?.matches("#main input,#main select")) deckLightsLoad().catch(() => {});
}, 20000);

// ---------- Finding, naming and identifying WiZ bulbs ----------
const deckBulbKinds = { color: "Colour bulb", tunable: "Tunable white", dimmable: "Dimmable white", socket: "Smart plug" };
let deckFound = null;

async function deckLightsPost(path, body) {
  const response = await fetch("/hub/api/lights/" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(result.error || "The lights bridge did not respond");
  return result;
}

function deckFoundView() {
  const head = `<h2 class="dialog-title">Find lights</h2>`;
  if (!deckFound) return head + `<p class="muted">Looking for WiZ bulbs on the network. This takes a few seconds…</p>${loading()}`;
  if (deckFound.error) return head + `<div class="error-box"><p>${esc(deckFound.error)}</p></div>`;
  if (!deckFound.bulbs.length)
    return head + `<p class="muted">Every WiZ bulb on ${esc(deckFound.subnet ? deckFound.subnet + ".x" : "the network")} is already here. A bulb that’s off at the switch, or new and not yet on your Wi-Fi, won’t show up.</p>${button("Look again", 'data-lights-find="true"')}`;
  return head + `<p class="muted">New bulbs on ${esc(deckFound.subnet)}.x. Use <strong>Identify</strong> to blink one, then name it.</p>`
    + deckFound.bulbs.map(b => `<form class="light-found" data-light-add="${esc(b.mac)}">
      <div><h3>${esc(b.capabilities ? deckBulbKinds[b.capabilities.kind] : "WiZ bulb")}</h3><p class="small muted">${esc(b.ip)} · ${esc(b.mac.match(/../g).join(":"))}${b.capabilities?.model ? " · " + esc(b.capabilities.model) : ""}</p></div>
      <div class="form-row">${field("Name", input("label", "", "text", 'required maxlength="60" placeholder="Desk lamp"'))}</div>
      <label class="checkbox"><input type="checkbox" name="scenes" checked> Room scenes change this light</label>
      <div class="inline-actions">${button("Add light", 'type="submit"', true)}${button("Identify", `type="button" data-light-identify-mac="${esc(b.mac)}"`)}</div>
    </form>`).join("");
}

function deckBulbSettings(d) {
  const caps = d.capabilities;
  return `<h2 class="dialog-title">${esc(d.label)}</h2>
    <p class="small muted">${caps ? `${esc(deckBulbKinds[caps.kind])} · ${esc(caps.model || "")}${caps.firmware ? " · firmware " + esc(caps.firmware) : ""}${caps.temp ? ` · ${caps.temp[0]}–${caps.temp[1]} K` : ""}<br>` : ""}${esc(d.mac.match(/../g).join(":"))} · ${esc(d.ip || "address unknown")}</p>
    <form id="light-settings-form" data-name="${esc(d.name)}">
      <div class="form-row">${field("Name", input("label", d.label, "text", 'required maxlength="60"'))}${field("Keep trying for · seconds", input("timeout", d.timeout || 0, "number", 'min="0" max="30"') + "<small>For a bulb that sleeps its Wi-Fi while off; 0 for most bulbs</small>")}</div>
      <label class="checkbox"><input type="checkbox" name="scenes" ${d.inScenes !== false ? "checked" : ""}> <span>Room scenes change this light <small class="muted">(turn off for a light in another room; it still goes off with All off)</small></span></label>
      <div class="inline-actions">${button("Save", 'type="submit"', true)}${button("Remove from Deck", `type="button" data-light-remove="${esc(d.name)}"`)}</div>
    </form>`;
}

async function deckFind() {
  deckFound = null;
  showDialog(deckFoundView());
  try {
    deckFound = await get("lights/discover");
    if (deckFound.error && !deckFound.bulbs?.length) deckFound = { error: deckFound.error, bulbs: [] };
  } catch (error) {
    deckFound = { error: error.message, bulbs: [] };
  }
  if ($("#dialog").open) showDialog(deckFoundView());
}

// ---------- Schedules ----------
const deckDayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function deckDays(days) {
  const key = days.join(",");
  return key === "0,1,2,3,4,5,6" ? "Every day" : key === "1,2,3,4,5" ? "Weekdays" : key === "0,6" ? "Weekends" : days.map(d => deckDayNames[d]).join(", ");
}
function deckTargetName(t, devices) {
  return { all: "every light", bulbs: "the bulbs", strips: "the strips" }[t] || devices.find(d => d.name === t)?.label || t;
}
function deckScheduleSummary(s, devices) {
  const a = s.action;
  if (a.kind === "scene") return `${deckSchedules.scenes.find(x => x.id === a.scene)?.name || a.scene} scene`;
  return `${a.kind === "wake" ? "Wake up" : "Wind down"} ${a.targets.map(t => deckTargetName(t, devices)).join(", ")} over ${a.minutes} min`;
}
function deckSchedulesPanel(r) {
  if (!deckSchedules) return "";
  const running = deckSchedules.running;
  const rows = deckSchedules.schedules.map(s => `<div class="schedule-row${s.enabled ? "" : " is-paused"}">
      <div class="schedule-time">${esc(s.time)}<small>${esc(deckDays(s.days))}</small></div>
      <div class="schedule-what"><h3>${esc(s.name)}</h3><p>${esc(deckScheduleSummary(s, r.devices))}</p></div>
      <div class="inline-actions">${button(s.enabled ? "Pause" : "Resume", `data-schedule-toggle="${s.id}"`)}${button("Run now", `data-schedule-run="${s.id}"`)}${button("Edit", `data-schedule-edit="${s.id}"`)}</div>
    </div>`).join("");
  return panel("Schedules",
    (running ? `<div class="notice schedule-running">${esc(running.name)} is fading the lights until ${deckClock(running.endsAt)}. ${button("Stop", 'data-schedule-stop="true"')}</div>` : "")
    + (rows || `<p class="muted schedule-empty">Deck can wake you with a slow fade, wind the room down at bedtime, or set a scene at a time. It runs them itself, so they don’t need the WiZ app.</p>`),
    button("Add schedule", 'data-schedule-edit="new"'));
}
function deckScheduleForm(s) {
  const devices = deckLights?.devices || [];
  const a = s?.action || { kind: "wake", targets: ["bulbs"], minutes: 20 };
  const doing = a.kind === "scene" ? "scene:" + a.scene : a.kind;
  const options = [...deckSchedules.scenes.map(x => ({ value: "scene:" + x.id, label: x.name + " scene" })), { value: "wake", label: "Wake up: fade on to daylight" }, { value: "wind-down", label: "Wind down: dim the lights that are on, then off" }];
  const targets = [{ value: "all", label: "Every light" }, { value: "bulbs", label: "The bulbs (room scenes)" }, { value: "strips", label: "The strips" }, ...devices.map(d => ({ value: d.name, label: d.label }))];
  const days = s?.days || [1, 2, 3, 4, 5];
  return `<h2 class="dialog-title">${s ? "Edit schedule" : "Add schedule"}</h2>
    <form id="schedule-form" data-id="${s ? esc(s.id) : ""}">
      <div class="form-row">${field("Name", input("name", s?.name || "", "text", 'required maxlength="40" placeholder="Weekday mornings"'))}${field("Time", input("time", s?.time || "07:00", "time", "required"))}</div>
      <div class="schedule-days" role="group" aria-label="Days">${[1, 2, 3, 4, 5, 6, 0].map(d => `<label class="checkbox"><input type="checkbox" name="day" value="${d}" ${days.includes(d) ? "checked" : ""}> ${deckDayNames[d]}</label>`).join("")}</div>
      <div class="form-row">${field("Do", select("doing", options, doing))}${field("Lights", select("target", targets, a.targets?.[0] || "bulbs"))}${field("Over · minutes", input("minutes", a.minutes || 20, "number", 'min="1" max="90"'))}</div>
      <p class="section-note">Fades send a small change every 30 seconds. Changing the lights yourself stops a fade.</p>
      <div class="inline-actions">${button("Save schedule", 'type="submit"', true)}${s ? button("Delete", `type="button" data-schedule-remove="${esc(s.id)}"`) : ""}</div>
      <div id="schedule-error" role="alert"></div>
    </form>`;
}
async function deckScheduleAct(body) {
  const result = await deckLightsPost("schedules", body);
  toast(result.message || "Done");
  deckSchedules = await get("lights/schedules");
  deckLightsPaint();
  return result;
}

document.addEventListener("click", async event => {
  const target = event.target.closest("[data-lights-find],[data-light-identify],[data-light-identify-mac],[data-light-settings],[data-light-remove],[data-schedule-edit],[data-schedule-run],[data-schedule-toggle],[data-schedule-remove],[data-schedule-stop]");
  if (!target || target.disabled) return;
  const v = target.dataset;
  try {
    if (v.lightsFind) return await deckFind();
    if (v.lightIdentify || v.lightIdentifyMac) {
      target.disabled = true;
      toast("Blinking the light…");
      await deckLightsPost("identify", v.lightIdentify ? { name: v.lightIdentify } : { mac: v.lightIdentifyMac });
      target.disabled = false;
      return toast("That was the one that blinked");
    }
    if (v.lightSettings) return showDialog(deckBulbSettings(deckLights.devices.find(d => d.name === v.lightSettings)));
    if (v.lightRemove) {
      if (!confirm("Remove this light from Deck? The bulb itself is untouched, and Find lights can add it again.")) return;
      await deckLightsPost("bulbs", { action: "remove", name: v.lightRemove });
      $("#dialog").close();
      toast("Light removed");
      return await deckLightsLoad();
    }
    if (v.scheduleEdit) {
      showDialog(deckScheduleForm(deckSchedules.schedules.find(s => s.id === v.scheduleEdit)));
      return deckScheduleFields($("#schedule-form"));
    }
    if (v.scheduleRun) { target.disabled = true; return await deckScheduleAct({ action: "run", id: v.scheduleRun }); }
    if (v.scheduleToggle) {
      const s = deckSchedules.schedules.find(x => x.id === v.scheduleToggle);
      return await deckScheduleAct({ action: "save", schedule: { ...s, enabled: !s.enabled } });
    }
    if (v.scheduleRemove) {
      if (!confirm("Delete this schedule?")) return;
      $("#dialog").close();
      return await deckScheduleAct({ action: "remove", id: v.scheduleRemove });
    }
    if (v.scheduleStop) return await deckScheduleAct({ action: "stop" });
  } catch (error) {
    target.disabled = false;
    toast(error.message, true);
  }
});

document.addEventListener("submit", async event => {
  const form = event.target;
  if (!form.matches("[data-light-add],#light-settings-form,#schedule-form")) return;
  event.preventDefault();
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    if (form.dataset.lightAdd) {
      await deckLightsPost("bulbs", { action: "add", mac: form.dataset.lightAdd, label: form.label.value, scenes: form.scenes.checked });
      toast(`${form.label.value.trim()} added`);
      deckFound.bulbs = deckFound.bulbs.filter(b => b.mac !== form.dataset.lightAdd);
      showDialog(deckFoundView());
      await deckLightsLoad();
    } else if (form.id === "light-settings-form") {
      await deckLightsPost("bulbs", { action: "update", name: form.dataset.name, label: form.label.value, scenes: form.scenes.checked, timeout: Number(form.timeout.value) || 0 });
      $("#dialog").close();
      toast("Light saved");
      await deckLightsLoad();
    } else {
      const f = form.elements, doing = f.doing.value;
      const action = doing.startsWith("scene:") ? { kind: "scene", scene: doing.slice(6) } : { kind: doing, targets: [f.target.value], minutes: Number(f.minutes.value) };
      const days = [...form.querySelectorAll('[name="day"]:checked')].map(i => Number(i.value));
      const existing = deckSchedules.schedules.find(s => s.id === form.dataset.id);
      await deckScheduleAct({ action: "save", schedule: { ...(existing ? { id: existing.id, enabled: existing.enabled } : {}), name: f.name.value, time: f.time.value, days, action } });
      $("#dialog").close();
    }
  } catch (error) {
    if (form.id === "schedule-form") $("#schedule-error").innerHTML = `<p class="notice">${esc(error.message)}</p>`;
    else toast(error.message, true);
  } finally {
    submit.disabled = false;
  }
});
// Lights and minutes only matter for fades.
function deckScheduleFields(form) {
  const scene = form.elements.doing.value.startsWith("scene:");
  for (const name of ["target", "minutes"]) form.elements[name].closest(".field").hidden = scene;
}
document.addEventListener("change", event => {
  const form = event.target.closest("#schedule-form");
  if (form && event.target.name === "doing") deckScheduleFields(form);
});
