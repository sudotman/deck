// Lights: LED strips (Bluetooth via the lights bridge) and WiZ bulbs, plus whole-room scenes.
navs.splice(navs.findIndex(n => n[0] === "calendar"), 0, ["lights", "Lights"]);
icons.lights = '<path d="M9 18h6m-5 3h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>';

const deckLightColors = [
  ["Warm orange", [255, 90, 0]], ["Red", [255, 0, 0]], ["Pink", [255, 0, 120]], ["Purple", [120, 0, 255]],
  ["Blue", [0, 40, 255]], ["Cyan", [0, 200, 255]], ["Green", [0, 255, 60]], ["White", [255, 255, 255]],
];
const deckEffectNames = { jump3: "3-colour jump", jump7: "7-colour jump", fade3: "3-colour fade", "rainbow-fade": "Rainbow fade", strobe7: "7-colour strobe" };
let deckLights = null, deckLightScenes = [];
const deckLightsBusy = new Set(), deckStripTab = new Map();
const deckTimers = [[0, "No sleep timer"], [30, "Off in 30 minutes"], [60, "Off in 1 hour"], [120, "Off in 2 hours"], [240, "Off in 4 hours"], [480, "Off in 8 hours"]];

const deckHex = c => "#" + c.map(v => v.toString(16).padStart(2, "0")).join("");
const deckRgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const deckEffectName = (e, d) => d?.effects?.find(x => x.name === e)?.label || deckEffectNames[e] || (/^pattern-\d+$/.test(e) ? "Pattern " + e.slice(8) : e[0].toUpperCase() + e.slice(1).replace(/-/g, " "));
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
    : `Wi-Fi · ${esc(d.ip || "address unknown")}${d.rssi ? ` · signal ${d.rssi} dBm` : ""}`;
  const stateText = unreachable ? "Not answering" : d.on == null ? "State unknown" : !on ? "Off" : d.music ? `Music · rhythm ${d.music}` : d.effect ? deckEffectName(d.effect, d) : d.sceneName || (d.temp ? d.temp + " K white" : "On");
  const power = ["On", "Off"].map(label => `<button data-light-set="${d.name}" data-field="on" data-value="${label === "On"}" class="${d.on === (label === "On") ? "selected" : ""}" ${busy ? "disabled" : ""}>${label}</button>`).join("");
  const colours = deckLightColors.map(([name, c]) => `<button class="light-color" style="--swatch:rgb(${c})" title="${name}" aria-label="${name}" data-light-color="${d.name}" data-rgb="${c}"></button>`).join("")
    + `<input type="color" class="light-picker" value="${deckHex(d.color || [255, 90, 0])}" data-light-picker="${d.name}" aria-label="Custom colour for ${esc(d.label)}" title="Custom colour">`;
  const slider = (label, field, min, max, step, value, shown) => `<label class="light-slider">${label}<output>${shown}</output><input type="range" min="${min}" max="${max}" step="${step}" value="${value}" data-light-range="${d.name}" data-field="${field}"></label>`;
  const colourRow = `<div class="light-colors" role="group" aria-label="Colours for ${esc(d.label)}">${colours}</div>`;
  let extra;
  if (d.kind === "wiz") {
    extra = colourRow + slider("White", "temp", 2200, 6500, 100, d.temp || 2700, d.temp ? d.temp + " K" : "—")
      + `<label class="field light-field">WiZ scene<select data-light-select="${d.name}" data-field="scene"><option value="">Choose a scene…</option>${Object.entries(wizScenes).map(([id, n]) => `<option value="${id}" ${Number(id) === d.scene ? "selected" : ""}>${esc(n)}</option>`).join("")}</select></label>`;
  } else {
    const tab = deckStripTab.get(d.name) || (d.music ? "music" : d.effect ? "pattern" : "colour");
    const tabs = [["colour", "Colour"], ["pattern", "Pattern"], ["music", "Music"]].map(([key, label]) => `<button data-light-tab="${d.name}:${key}" class="${tab === key ? "selected" : ""}" aria-pressed="${tab === key}">${label}</button>`).join("");
    const list = d.effects || (effects || []).map(name => ({ name, label: deckEffectName(name) }));
    const panes = {
      colour: colourRow,
      pattern: `<label class="field light-field">Pattern<select data-light-select="${d.name}" data-field="effect"><option value="" disabled ${d.effect ? "" : "selected"}>Choose a pattern…</option>${list.map(e => `<option value="${esc(e.name)}" ${e.name === d.effect ? "selected" : ""}>${esc(e.label)}</option>`).join("")}</select></label>`
        + slider("Speed", "speed", 0, 100, 1, d.speed ?? 50, d.speed ?? "—")
        + (d.patternNumbers ? `<div class="light-explore"><label class="field light-field">Pattern number<input type="number" min="0" max="255" value="${/^pattern-\d+$/.test(d.effect || "") ? d.effect.slice(8) : 0}" data-light-pattern-input="${d.name}"></label><button class="button small-button" data-light-pattern="${d.name}">Try it</button></div><p class="light-hint">The controller has more built-in patterns than have names. Step through numbers 0–255 to find them.</p>` : ""),
      music: `<div class="light-music" role="group" aria-label="Music modes">${Array.from({ length: d.musicModes || 8 }, (_, i) => `<button data-light-music="${d.name}:${i + 1}" class="${d.music === i + 1 ? "selected" : ""}">${i + 1}</button>`).join("")}</div>`
        + slider("Mic sensitivity", "sensitivity", 0, 100, 1, d.sensitivity ?? 70, d.sensitivity ?? "—")
        + `<p class="light-hint">Rhythm modes 1–8 listen through the strip’s own microphone, like the remote’s music buttons.${d.music ? "" : " Pick one to start."}</p>${d.music ? `<button class="button small-button" data-light-music="${d.name}:0">Stop music mode</button>` : ""}`,
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
  const head = title("Lights", "Room scenes, and every light the media server can reach.", button("Refresh", 'data-lights-refresh="true"'));
  const scenes = panel("Scenes", `<div class="light-scenes">${r.scenes.map(deckSceneButton).join("")}</div>`);
  if (!r.bridge.online)
    return head + `<div class="error-box"><h2>Lights bridge offline</h2><p>${esc(r.bridge.error)}</p>${button("Try again", 'data-lights-refresh="true"')}</div>`;
  return head + scenes
    + `<div class="light-grid">${r.devices.map(d => deckLightCard(d, r.effects, r.wizScenes)).join("")}</div>`
    + `<p class="small muted light-footnote">Bluetooth strips can’t report their state, so Deck shows what it last sent. A strip accepts one Bluetooth connection at a time; the bridge lets go after 90 seconds idle so its phone app can connect.</p>`;
}

function deckLightsPaint() {
  if (route === "lights" && deckLights) $("#main").innerHTML = deckLightsView(deckLights);
}
async function deckLightsLoad(id) {
  const result = await get("lights");
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
    if (change.pattern !== undefined) Object.assign(d, { effect: "pattern-" + change.pattern, music: null });
    if (change.music !== undefined) Object.assign(d, { music: change.music || null, effect: change.music ? null : d.effect });
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
  const target = event.target.closest("[data-light-scene],[data-light-set],[data-light-color],[data-lights-refresh],[data-light-tab],[data-light-music],[data-light-pattern]");
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
  if (v.lightPattern) {
    const value = Number(document.querySelector(`[data-light-pattern-input="${v.lightPattern}"]`)?.value);
    if (!Number.isInteger(value) || value < 0 || value > 255) return toast("Enter a pattern number from 0 to 255", true);
    return deckLightsSend({ targets: [v.lightPattern], pattern: value }, v.lightPattern);
  }
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
