// Lights: validated access to the local lights bridge (LED strips over Bluetooth,
// WiZ bulbs over Wi-Fi) and whole-room scenes. The bridge lives in lights-bridge/.
const bulbs = ["bulbs"], strips = ["strips"];
export const scenes = [
  { id: "movie", name: "Movie", detail: "Bulbs low and warm, strips a faint amber glow", steps: [{ targets: bulbs, temp: 2200, brightness: 10 }, { targets: strips, color: [255, 64, 12], brightness: 6 }] },
  { id: "chill", name: "Chill", detail: "Warm and soft everywhere", steps: [{ targets: bulbs, temp: 2700, brightness: 40 }, { targets: strips, color: [255, 90, 0], brightness: 60 }] },
  { id: "gaming", name: "Gaming", detail: "Purple bulbs, rainbow strips", steps: [{ targets: bulbs, color: [90, 0, 255], brightness: 35 }, { targets: strips, effect: "rainbow", speed: 60, brightness: 100 }] },
  { id: "party", name: "Party", detail: "Party bulbs, strips dance to the room", steps: [{ targets: bulbs, scene: 4, brightness: 100 }, { targets: strips, music: 1, sensitivity: 70, brightness: 100 }] },
  { id: "bright", name: "Bright", detail: "Daylight white everywhere", steps: [{ targets: bulbs, temp: 5000, brightness: 100 }, { targets: strips, temp: 5000, brightness: 100 }] },
  { id: "night", name: "Night", detail: "Bulbs off, a faint red glow", steps: [{ targets: bulbs, on: false }, { targets: strips, color: [255, 20, 0], brightness: 8 }] },
  { id: "off", name: "All off", detail: "Every light off", steps: [{ targets: ["all"], on: false }] },
];

function invalid(message) {
  const error = Error(message);
  error.status = 400;
  return error;
}
const integer = (value, min, max, message) => {
  if (!Number.isInteger(value) || value < min || value > max) throw invalid(message);
  return value;
};

export function lightStep(step) {
  if (!step || typeof step !== "object") throw invalid("Choose a light to change");
  const targets = Array.isArray(step.targets) ? step.targets : [step.target];
  if (!targets.length || targets.some(t => typeof t !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(t))) throw invalid("Choose a light to change");
  const out = { targets: [...new Set(targets)] };
  if (step.on !== undefined) {
    if (typeof step.on !== "boolean") throw invalid("Choose on or off");
    out.on = step.on;
  }
  if (step.color !== undefined) {
    if (!Array.isArray(step.color) || step.color.length !== 3) throw invalid("Choose a valid colour");
    out.color = step.color.map(v => integer(v, 0, 255, "Choose a valid colour"));
  }
  if (step.brightness !== undefined) out.brightness = integer(step.brightness, 1, 100, "Brightness must be between 1 and 100");
  // Each bulb's own range is applied by the bridge; strips take any white as RGB.
  if (step.temp !== undefined) out.temp = integer(step.temp, 1000, 10000, "White temperature must be between 1000 K and 10000 K");
  if (step.scene !== undefined) out.scene = integer(step.scene, 1, 1000, "Choose a valid WiZ scene");
  if (step.speed !== undefined) out.speed = integer(step.speed, 0, 100, "Speed must be between 0 and 100");
  if (step.music !== undefined) out.music = integer(step.music, 0, 8, "Choose a music mode from 1 to 8, or 0 to stop");
  if (step.sensitivity !== undefined) out.sensitivity = integer(step.sensitivity, 0, 100, "Sensitivity must be between 0 and 100");
  if (step.pattern !== undefined) out.pattern = integer(step.pattern, 0, 212, "Pattern numbers run from 0 to 212");
  if (step.timer !== undefined) out.timer = integer(step.timer, 0, 1080, "Sleep timers run up to 18 hours");
  if (step.effect !== undefined) {
    if (typeof step.effect !== "string" || !/^[a-z0-9-]{1,32}$/.test(step.effect)) throw invalid("Choose a valid effect");
    out.effect = step.effect;
  }
  if (Object.keys(out).length === 1) throw invalid("Nothing to change");
  return out;
}

/** A device name from a label ("Desk lamp" → "desk-lamp"), unlike every name in known and the groups. */
export function lightName(label, known = []) {
  const taken = new Set([...known, "strips", "bulbs", "all"]);
  let base = String(label).normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^[^a-z]+|-+$/g, "").slice(0, 28).replace(/-+$/, "") || "bulb";
  let name = base, n = 2;
  while (taken.has(name)) name = `${base}-${n++}`;
  return name;
}

export function createLights(config = {}) {
  const base = (config.lights?.bridge || "http://127.0.0.1:8183").replace(/\/$/, "");
  const publicScenes = scenes.map(({ id, name, detail }) => ({ id, name, detail }));
  async function bridge(path, body, timeout) {
    let response;
    try {
      response = await fetch(base + path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) } : { signal: AbortSignal.timeout(timeout) });
    } catch (error) {
      const failure = Error(error.name === "TimeoutError" ? "The lights bridge did not answer in time." : "The lights bridge is not running on the media PC. Start the “Deck Lights bridge” task.");
      failure.status = 503;
      throw failure;
    }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const failure = Error(result.error || `The lights bridge returned ${response.status}`);
      failure.status = response.status === 400 ? 400 : 502;
      throw failure;
    }
    return result;
  }
  return {
    scenes: () => publicScenes,
    async state() {
      try {
        const result = await bridge("/state", null, 15000);
        return { bridge: { online: true, version: result.version, push: result.push || null }, devices: result.devices, effects: result.effects, wizScenes: result.wizScenes, scenes: publicScenes };
      } catch (error) {
        return { bridge: { online: false, error: error.message }, devices: [], effects: [], wizScenes: {}, scenes: publicScenes };
      }
    },
    /** Whether the TV is awake, or (with an action) wakes it or sends it to standby, through the bridge. */
    async tv(action) {
      if (action === undefined) return bridge("/tv", null, 20000).catch(() => ({ configured: false, awake: null }));
      if (!["wake", "sleep"].includes(action)) throw invalid("Choose wake or sleep");
      return bridge("/tv", { action }, 40000);
    },
    /** WiZ bulbs on the network that aren't listed yet (the bridge sweeps the subnet: a few seconds). */
    discover: () => bridge("/discover", null, 30000),
    /** Blink a listed bulb (by name) or a discovered one (by MAC), to tell which one it is. */
    async identify(body) {
      if (typeof body?.name === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(body.name)) return bridge("/identify", { name: body.name }, 20000);
      if (typeof body?.mac === "string" && /^[0-9a-f]{12}$/i.test(body.mac.replace(/:/g, ""))) return bridge("/identify", { mac: body.mac.replace(/:/g, "").toLowerCase() }, 20000);
      throw invalid("Choose a light to identify");
    },
    /** Add a discovered bulb, change a bulb's label, scene membership or patience, or remove it. */
    async editBulb(body) {
      const action = body?.action;
      const label = body?.label === undefined ? undefined : String(body.label).replace(/\s+/g, " ").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 60);
      if (label === "") throw invalid("Give the light a name");
      if (action === "add") {
        const mac = typeof body.mac === "string" ? body.mac.replace(/:/g, "").toLowerCase() : "";
        if (!/^[0-9a-f]{12}$/.test(mac)) throw invalid("Choose a bulb to add");
        if (!label) throw invalid("Give the light a name");
        const known = ((await bridge("/state", null, 15000)).devices || []).map(d => d.name);
        return bridge("/bulbs", { action, mac, label, name: lightName(label, known), scenes: body.scenes !== false }, 20000);
      }
      if (action !== "update" && action !== "remove") throw invalid("Choose add, update or remove");
      if (typeof body.name !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(body.name)) throw invalid("Choose a light");
      if (action === "remove") return bridge("/bulbs", { action, name: body.name }, 20000);
      const out = { action, name: body.name };
      if (label !== undefined) out.label = label;
      if (body.scenes !== undefined) {
        if (typeof body.scenes !== "boolean") throw invalid("Choose whether room scenes change this light");
        out.scenes = body.scenes;
      }
      if (body.timeout !== undefined) out.timeout = integer(body.timeout, 0, 30, "Keep trying for 0 to 30 seconds");
      return bridge("/bulbs", out, 20000);
    },
    async set(body) {
      let steps;
      if (body?.scene !== undefined) {
        const scene = scenes.find(s => s.id === body.scene);
        if (!scene) throw invalid("Choose a valid scene");
        steps = scene.steps;
      } else steps = (Array.isArray(body?.steps) ? body.steps : [body]).map(lightStep);
      if (!steps.length || steps.length > 20) throw invalid("Send between 1 and 20 changes");
      const result = await bridge("/set", { steps }, 60000);
      const all = Object.entries(result.results || {}), failed = all.filter(([, r]) => !r.ok);
      // A bulb that never answered has often still changed (its reply was lost on a weak link), so
      // that isn't reported as a failure; a bulb that answered with an error is.
      const silent = failed.filter(([, r]) => /^No reply/.test(r.error || ""));
      const message = !failed.length ? "Lights updated"
        : silent.length === failed.length ? `Sent, but ${failed.length} of ${all.length} lights didn't confirm`
        : `${failed.length} of ${all.length} lights did not respond`;
      return { results: result.results, message };
    },
  };
}
