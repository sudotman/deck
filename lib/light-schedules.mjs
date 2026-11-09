// Light schedules, run by Deck itself: the media PC is always on, so wake-up fades, wind-downs and
// timed scenes don't need the WiZ app or its cloud. A manual change to the lights stops a running fade.
import path from "node:path";
import crypto from "node:crypto";
import { readJSON, writeJSON } from "./storage.mjs";
import { scenes } from "./lights.mjs";

export const scheduleKinds = [
  { id: "scene", name: "Set a scene" },
  { id: "wake", name: "Wake up", detail: "Fade on from a faint warm glow to bright daylight" },
  { id: "wind-down", name: "Wind down", detail: "Dim the lights that are on, warmer, then off" },
];
const WAKE = { from: { brightness: 1, temp: 2200 }, to: { brightness: 100, temp: 4000 } };
const STEP_SECONDS = 30;
const MAX_SCHEDULES = 30;

function invalid(message) {
  const error = Error(message);
  error.status = 400;
  return error;
}
const target = t => typeof t === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(t);

/** A schedule as sent from the page, checked and trimmed to what Deck keeps. */
export function scheduleEntry(body) {
  if (!body || typeof body !== "object") throw invalid("Describe the schedule");
  const name = String(body.name ?? "").replace(/\s+/g, " ").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 40);
  if (!name) throw invalid("Give the schedule a name");
  if (typeof body.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.time)) throw invalid("Choose a time");
  const days = [...new Set(Array.isArray(body.days) ? body.days : [])].sort();
  if (!days.length || days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) throw invalid("Choose at least one day");
  const kind = body.action?.kind;
  let action;
  if (kind === "scene") {
    if (!scenes.some(s => s.id === body.action.scene)) throw invalid("Choose a scene");
    action = { kind, scene: body.action.scene };
  } else if (kind === "wake" || kind === "wind-down") {
    const targets = [...new Set(Array.isArray(body.action.targets) ? body.action.targets : [])];
    if (!targets.length || targets.length > 20 || !targets.every(target)) throw invalid("Choose which lights");
    const minutes = body.action.minutes;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 90) throw invalid("Fades last 1 to 90 minutes");
    action = { kind, targets, minutes };
  } else throw invalid("Choose what the schedule does");
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") throw invalid("Choose on or off");
  return { name, time: body.time, days, action, enabled: body.enabled !== false };
}

/** The devices a target list covers, as the bridge resolves groups. */
export function covered(devices, targets) {
  return devices.filter(d => targets.some(t => t === "all" || t === d.name || (t === "strips" && d.kind === "strip") || (t === "bulbs" && d.kind === "wiz" && d.inScenes !== false)));
}

const stamp = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
const mix = (a, b, f) => a + (b - a) * f;

export function createLightSchedules({ directory, lights, now = () => new Date(), every = 20000, stepSeconds = STEP_SECONDS, later = setTimeout, log = console.log }) {
  const file = path.join(directory, "data", "light-schedules.json");
  let schedules = readJSON(file, []);
  if (!Array.isArray(schedules)) schedules = [];
  let fade = null, ticker = null;
  const save = () => writeJSON(file, schedules);
  const find = id => {
    const schedule = schedules.find(s => s.id === id);
    if (!schedule) throw Object.assign(Error("That schedule no longer exists"), { status: 404 });
    return schedule;
  };

  function stop() {
    if (!fade) return false;
    clearTimeout(fade.timer);
    fade = null;
    return true;
  }

  // A fade is a list of moments, each a set of light steps; one is sent every stepSeconds.
  async function plan(schedule) {
    const { kind, targets, minutes } = schedule.action;
    const count = Math.max(2, Math.round((minutes * 60) / stepSeconds));
    const at = (from, to, f) => {
      const step = { brightness: Math.max(1, Math.round(mix(from.brightness, to.brightness, f))) };
      if (from.temp && to.temp) step.temp = Math.round(mix(from.temp, to.temp, f) / 100) * 100;
      return step;
    };
    if (kind === "wake")
      return Array.from({ length: count + 1 }, (_, i) => [{ targets, ...at(WAKE.from, WAKE.to, i / count) }]);
    // Wind down starts from where each light is now, and leaves lights that are off alone.
    const state = await lights.state();
    const on = covered(state.devices || [], targets).filter(d => d.on === true);
    if (!on.length) return [];
    const moments = Array.from({ length: count }, (_, i) => on.map(d => {
      const from = { brightness: d.brightness ?? 60, temp: d.temp || null };
      return { targets: [d.name], ...at(from, { brightness: 1, temp: from.temp ? 2200 : null }, (i + 1) / count) };
    }));
    moments.push([{ targets: on.map(d => d.name), on: false }]);
    return moments;
  }

  async function send(steps) {
    for (let i = 0; i < steps.length; i += 20) {
      try {
        await lights.set({ steps: steps.slice(i, i + 20) });
      } catch (error) {
        log(`Light schedule: ${error.message}`);
      }
    }
  }

  async function run(schedule) {
    if (schedule.action.kind === "scene") {
      stop();
      return lights.set({ scene: schedule.action.scene });
    }
    stop();
    const moments = await plan(schedule);
    if (!moments.length) return { message: "No lights to wind down" };
    const current = (fade = { id: schedule.id, name: schedule.name, kind: schedule.action.kind, endsAt: new Date(Date.now() + (moments.length - 1) * stepSeconds * 1000).toISOString(), timer: null });
    const next = async i => {
      if (fade !== current) return;
      await send(moments[i]);
      if (fade !== current) return;
      if (i + 1 < moments.length) current.timer = later(() => next(i + 1), stepSeconds * 1000);
      else fade = null;
    };
    await next(0);
    return { message: `${schedule.name} started` };
  }

  async function tick() {
    const date = now(), key = stamp(date), time = key.slice(11);
    for (const schedule of schedules) {
      if (!schedule.enabled || schedule.time !== time || !schedule.days.includes(date.getDay()) || schedule.lastRun === key) continue;
      schedule.lastRun = key;
      save();
      log(`Light schedule: ${schedule.name}`);
      run(schedule).catch(error => log(`Light schedule ${schedule.name}: ${error.message}`));
    }
  }

  return {
    list: () => ({
      schedules: schedules.map(({ lastRun, ...s }) => ({ ...s, lastRun: lastRun || null })),
      running: fade && { id: fade.id, name: fade.name, kind: fade.kind, endsAt: fade.endsAt },
      kinds: scheduleKinds,
      scenes: scenes.map(({ id, name }) => ({ id, name })),
    }),
    /** {action: "save", schedule} | {action: "remove" | "run", id} | {action: "stop"} */
    async act(body) {
      if (body?.action === "save") {
        const entry = scheduleEntry(body.schedule);
        const id = body.schedule.id;
        if (id !== undefined) Object.assign(find(id), entry);
        else {
          if (schedules.length >= MAX_SCHEDULES) throw invalid(`Keep to ${MAX_SCHEDULES} schedules`);
          schedules.push({ id: crypto.randomBytes(6).toString("hex"), ...entry });
        }
        save();
        return { message: "Schedule saved" };
      }
      if (body?.action === "remove") {
        find(body.id);
        if (fade?.id === body.id) stop();
        schedules = schedules.filter(s => s.id !== body.id);
        save();
        return { message: "Schedule removed" };
      }
      if (body?.action === "run") return { message: "Done", ...(await run(find(body.id))) };
      if (body?.action === "stop") return { message: stop() ? "Fade stopped" : "Nothing was running" };
      throw invalid("Choose save, remove, run or stop");
    },
    /** A manual change wins over a fade in progress. */
    interrupt: stop,
    tick,
    start() {
      if (ticker) return;
      ticker = setInterval(() => tick().catch(error => log(`Light schedules: ${error.message}`)), every);
      ticker.unref?.();
    },
    close() {
      clearInterval(ticker);
      ticker = null;
      stop();
    },
  };
}
