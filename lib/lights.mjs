// Lights: validated access to the local lights bridge (LED strips over Bluetooth,
// WiZ bulbs over Wi-Fi) and whole-room scenes. The bridge lives in lights-bridge/.
const bulbs = ["bulbs"], strips = ["strips"];
export const scenes = [
  { id: "movie", name: "Movie", detail: "Bulbs low and warm, strips deep blue", steps: [{ targets: bulbs, temp: 2200, brightness: 10 }, { targets: strips, color: [0, 40, 255], brightness: 35 }] },
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
  if (step.temp !== undefined) out.temp = integer(step.temp, 2200, 6500, "White temperature must be between 2200 K and 6500 K");
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
        return { bridge: { online: true, version: result.version }, devices: result.devices, effects: result.effects, wizScenes: result.wizScenes, scenes: publicScenes };
      } catch (error) {
        return { bridge: { online: false, error: error.message }, devices: [], effects: [], wizScenes: {}, scenes: publicScenes };
      }
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
      const failed = Object.entries(result.results || {}).filter(([, r]) => !r.ok);
      return { results: result.results, message: failed.length ? `${failed.length} of ${Object.keys(result.results).length} lights did not respond` : "Lights updated" };
    },
  };
}
