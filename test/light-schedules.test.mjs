import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { covered, createLightSchedules, scheduleEntry } from "../lib/light-schedules.mjs";

const devices = [
  { name: "neon", kind: "strip", on: true, brightness: 80 },
  { name: "bedroom", kind: "wiz", on: true, brightness: 50, temp: 3000 },
  { name: "corridor", kind: "wiz", on: false, brightness: 40 },
  { name: "kitchen", kind: "wiz", on: true, brightness: 100, temp: 4000, inScenes: false },
];

function setup(now = new Date(2026, 10, 10, 7, 0, 5)) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "deck-schedules-"));
  const sent = [];
  const lights = { set: async body => (sent.push(body), { message: "ok" }), state: async () => ({ devices }) };
  const clock = { now };
  const schedules = createLightSchedules({ directory, lights, now: () => clock.now, later: fn => setTimeout(fn, 1), log: () => {} });
  return { directory, sent, schedules, clock };
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test("schedules are checked before they are kept", () => {
  assert.deepEqual(scheduleEntry({ name: " Morning\n", time: "07:00", days: [5, 1, 1], action: { kind: "wake", targets: ["bulbs"], minutes: 20 } }),
    { name: "Morning", time: "07:00", days: [1, 5], action: { kind: "wake", targets: ["bulbs"], minutes: 20 }, enabled: true });
  assert.deepEqual(scheduleEntry({ name: "Film", time: "21:30", days: [5], action: { kind: "scene", scene: "movie", junk: 1 }, enabled: false }).action, { kind: "scene", scene: "movie" });
  for (const bad of [
    { name: "", time: "07:00", days: [1], action: { kind: "scene", scene: "movie" } },
    { name: "x", time: "24:00", days: [1], action: { kind: "scene", scene: "movie" } },
    { name: "x", time: "07:00", days: [], action: { kind: "scene", scene: "movie" } },
    { name: "x", time: "07:00", days: [7], action: { kind: "scene", scene: "movie" } },
    { name: "x", time: "07:00", days: [1], action: { kind: "scene", scene: "disco" } },
    { name: "x", time: "07:00", days: [1], action: { kind: "wake", targets: ["Bulbs!"], minutes: 10 } },
    { name: "x", time: "07:00", days: [1], action: { kind: "wake", targets: ["bulbs"], minutes: 0 } },
    { name: "x", time: "07:00", days: [1], action: { kind: "reboot" } },
  ]) assert.throws(() => scheduleEntry(bad), error => error.status === 400, JSON.stringify(bad));
});

test("groups cover the lights the bridge would change", () => {
  assert.deepEqual(covered(devices, ["bulbs"]).map(d => d.name), ["bedroom", "corridor"]);
  assert.deepEqual(covered(devices, ["strips", "kitchen"]).map(d => d.name), ["neon", "kitchen"]);
  assert.equal(covered(devices, ["all"]).length, 4);
});

test("a schedule runs once at its minute, on its days, and survives a restart", async () => {
  const { directory, sent, schedules, clock } = setup();
  await schedules.act({ action: "save", schedule: { name: "Film night", time: "07:00", days: [2], action: { kind: "scene", scene: "movie" } } });
  await schedules.act({ action: "save", schedule: { name: "Weekends", time: "07:00", days: [0, 6], action: { kind: "scene", scene: "bright" } } });
  await schedules.tick();
  await schedules.tick();
  assert.deepEqual(sent, [{ scene: "movie" }], "Tuesday only, and not twice in the same minute");
  const reopened = createLightSchedules({ directory, lights: { set: async body => sent.push(body) }, now: () => clock.now, log: () => {} });
  await reopened.tick();
  assert.equal(sent.length, 1, "the last run is remembered across a restart");
  clock.now = new Date(2026, 10, 17, 7, 0, 0);
  await reopened.tick();
  assert.equal(sent.length, 2, "and it runs again next week");
  const { schedules: list } = reopened.list();
  assert.equal(list[0].lastRun, "2026-11-17 07:00");
  await reopened.act({ action: "save", schedule: { ...list[0], enabled: false } });
  clock.now = new Date(2026, 10, 24, 7, 0, 0);
  await reopened.tick();
  assert.equal(sent.length, 2, "a paused schedule doesn't run");
  await reopened.act({ action: "remove", id: list[0].id });
  assert.equal(reopened.list().schedules.length, 1);
  await assert.rejects(reopened.act({ action: "run", id: list[0].id }), error => error.status === 404);
  schedules.close();
  reopened.close();
});

test("wake up fades on from a warm glow to daylight", async () => {
  const { sent, schedules } = setup();
  await schedules.act({ action: "save", schedule: { name: "Wake", time: "06:30", days: [2], action: { kind: "wake", targets: ["bulbs"], minutes: 1 } } });
  const [wake] = schedules.list().schedules;
  await schedules.act({ action: "run", id: wake.id });
  assert.equal(schedules.list().running.name, "Wake");
  await wait(200);
  const steps = sent.map(body => body.steps[0]);
  assert.equal(steps.length, 3, "one step every 30 seconds, plus the start");
  assert.deepEqual(steps[0], { targets: ["bulbs"], brightness: 1, temp: 2200 });
  assert.deepEqual(steps.at(-1), { targets: ["bulbs"], brightness: 100, temp: 4000 });
  assert.ok(steps.every((s, i) => i === 0 || s.brightness >= steps[i - 1].brightness));
  assert.equal(schedules.list().running, null);
  schedules.close();
});

test("wind down starts from each light's own brightness, leaves dark lights alone, and ends off", async () => {
  const { sent, schedules } = setup();
  await schedules.act({ action: "save", schedule: { name: "Bed", time: "23:00", days: [2], action: { kind: "wind-down", targets: ["all"], minutes: 1 } } });
  await schedules.act({ action: "run", id: schedules.list().schedules[0].id });
  await wait(200);
  const first = sent[0].steps;
  assert.deepEqual(first.map(s => s.targets[0]), ["neon", "bedroom", "kitchen"], "the corridor was off");
  assert.ok(first[0].brightness < 80 && first[0].temp === undefined, "strips keep their colour");
  assert.ok(first[1].brightness < 50 && first[1].temp <= 3000);
  assert.deepEqual(sent.at(-2).steps[1], { targets: ["bedroom"], brightness: 1, temp: 2200 });
  assert.deepEqual(sent.at(-1).steps, [{ targets: ["neon", "bedroom", "kitchen"], on: false }]);
  schedules.close();
});

test("a manual change stops a fade in progress", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "deck-schedules-"));
  const sent = [];
  const schedules = createLightSchedules({ directory, lights: { set: async body => sent.push(body) }, later: fn => setTimeout(fn, 50), log: () => {} });
  await schedules.act({ action: "save", schedule: { name: "Wake", time: "06:30", days: [2], action: { kind: "wake", targets: ["bulbs"], minutes: 1 } } });
  await schedules.act({ action: "run", id: schedules.list().schedules[0].id });
  assert.equal(schedules.interrupt(), true);
  await wait(150);
  assert.equal(sent.length, 1);
  assert.equal(schedules.list().running, null);
  assert.equal((await schedules.act({ action: "stop" })).message, "Nothing was running");
  schedules.close();
});
