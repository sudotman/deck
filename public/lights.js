// Lights: LED strips (Bluetooth via the lights bridge) and WiZ bulbs, plus whole-room scenes.
navs.splice(navs.findIndex(n => n[0] === "calendar"), 0, ["lights", "Lights"]);
icons.lights = '<path d="M9 18h6m-5 3h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>';

const deckLightColors = [
  ["Warm orange", [255, 90, 0]], ["Red", [255, 0, 0]], ["Pink", [255, 0, 120]], ["Purple", [120, 0, 255]],
  ["Blue", [0, 40, 255]], ["Cyan", [0, 200, 255]], ["Green", [0, 255, 60]], ["White", [255, 255, 255]],
];
const deckEffectNames = { jump3: "3-colour jump", jump7: "7-colour jump", fade3: "3-colour fade", "rainbow-fade": "Rainbow fade", strobe7: "7-colour strobe" };
let deckLights = null, deckLightScenes = [];
const deckLightsBusy = new Set();

const deckHex = c => "#" + c.map(v => v.toString(16).padStart(2, "0")).join("");
const deckRgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const deckEffectName = e => deckEffectNames[e] || e[0].toUpperCase() + e.slice(1).replace(/-/g, " ");
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
  const stateText = unreachable ? "Not answering" : d.on == null ? "State unknown" : !on ? "Off" : d.effect ? deckEffectName(d.effect) : d.sceneName || (d.temp ? d.temp + " K white" : "On");
  const power = ["On", "Off"].map(label => `<button data-light-set="${d.name}" data-field="on" data-value="${label === "On"}" class="${d.on === (label === "On") ? "selected" : ""}" ${busy ? "disabled" : ""}>${label}</button>`).join("");
  const colours = deckLightColors.map(([name, c]) => `<button class="light-color" style="--swatch:rgb(${c})" title="${name}" aria-label="${name}" data-light-color="${d.name}" data-rgb="${c}"></button>`).join("")
    + `<input type="color" class="light-picker" value="${deckHex(d.color || [255, 90, 0])}" data-light-picker="${d.name}" aria-label="Custom colour for ${esc(d.label)}" title="Custom colour">`;
  const slider = (label, field, min, max, step, value, shown) => `<label class="light-slider">${label}<output>${shown}</output><input type="range" min="${min}" max="${max}" step="${step}" value="${value}" data-light-range="${d.name}" data-field="${field}"></label>`;
  const extra = d.kind === "wiz"
    ? slider("White", "temp", 2200, 6500, 100, d.temp || 2700, d.temp ? d.temp + " K" : "—")
      + `<label class="field light-field">WiZ scene<select data-light-select="${d.name}" data-field="scene"><option value="">Choose a scene…</option>${Object.entries(wizScenes).map(([id, n]) => `<option value="${id}" ${Number(id) === d.scene ? "selected" : ""}>${esc(n)}</option>`).join("")}</select></label>`
    : `<label class="field light-field">Effect<select data-light-select="${d.name}" data-field="effect"><option value="">Solid colour</option>${effects.map(e => `<option value="${e}" ${e === d.effect ? "selected" : ""}>${esc(deckEffectName(e))}</option>`).join("")}</select></label>`
      + slider("Effect speed", "speed", 0, 100, 1, d.speed ?? 50, d.speed ?? "—");
  return `<section class="panel light-card${on ? " is-on" : ""}${busy ? " is-busy" : ""}" style="--swatch:${swatch}">
    <div class="light-head"><span class="light-swatch"></span><div class="light-title"><h2>${esc(d.label)}</h2><p>${meta}</p></div><div class="segmented" role="group" aria-label="${esc(d.label)} power">${power}</div></div>
    <div class="light-body">
      <div class="light-state">${chip(stateText, on && !unreachable)}${busy ? '<span class="spinner"></span><span class="small muted">Sending…</span>' : ""}</div>
      ${unreachable && d.lastError ? `<div class="notice light-notice">${esc(d.lastError)}</div>` : ""}
      ${d.kind === "strip" && d.lastError ? `<div class="notice light-notice">${esc(d.lastError)}</div>` : ""}
      ${slider("Brightness", "brightness", 1, 100, 1, d.brightness ?? 100, d.brightness != null ? d.brightness + "%" : "—")}
      <div class="light-colors" role="group" aria-label="Colours for ${esc(d.label)}">${colours}</div>
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
    if (change.color) Object.assign(d, { color: change.color, temp: null, scene: null, sceneName: null, effect: null });
    if (change.temp) Object.assign(d, { temp: change.temp, color: null, scene: null, sceneName: null });
    if (change.brightness) d.brightness = change.brightness;
    if (change.effect) d.effect = change.effect;
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
  const target = event.target.closest("[data-light-scene],[data-light-set],[data-light-color],[data-lights-refresh]");
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
  if (t.dataset.field === "effect") {
    const device = deckLights?.devices.find(d => d.name === name);
    return deckLightsSend(t.value ? { targets: [name], effect: t.value } : { targets: [name], color: device?.color || [255, 90, 0] }, name);
  }
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
