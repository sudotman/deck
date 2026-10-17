import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createLights, lightStep, scenes } from "../lib/lights.mjs";

async function mockBridge(handler) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    calls.push({ method: req.method, path: req.url, body: body ? JSON.parse(body) : null });
    const [status, payload] = handler(req.url, body ? JSON.parse(body) : null);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise(resolve => server.close(resolve)) };
}

test("light changes are validated before they reach the bridge", () => {
  assert.deepEqual(lightStep({ targets: ["neon", "neon"], color: [255, 90, 0], brightness: 40 }), { targets: ["neon"], color: [255, 90, 0], brightness: 40 });
  assert.deepEqual(lightStep({ target: "bedroom", on: false }), { targets: ["bedroom"], on: false });
  assert.deepEqual(lightStep({ target: "neon", music: 4, sensitivity: 80, timer: 120 }), { targets: ["neon"], music: 4, sensitivity: 80, timer: 120 });
  assert.deepEqual(lightStep({ target: "neon", pattern: 207 }), { targets: ["neon"], pattern: 207 });
  for (const bad of [{ targets: ["neon"] }, { targets: ["Neon!"], on: true }, { targets: ["neon"], color: [256, 0, 0] }, { targets: ["neon"], brightness: 0 }, { targets: ["bedroom"], temp: 9000 }, { targets: ["neon"], on: "yes" }, { targets: ["neon"], effect: "<script>" }, { targets: ["neon"], music: 9 }, { targets: ["neon"], sensitivity: 101 }, { targets: ["neon"], pattern: 256 }, { targets: ["neon"], timer: 2000 }])
    assert.throws(() => lightStep(bad), error => error.status === 400);
  for (const scene of scenes) for (const step of scene.steps) assert.doesNotThrow(() => lightStep(step), scene.id);
});

test("scenes expand into bridge steps and partial failures are reported", async () => {
  const bridge = await mockBridge((path, body) => path === "/set" ? [200, { results: { neon: { ok: true }, bedroom: { ok: false, error: "No reply" }, corridor: { ok: true } } }] : [404, {}]);
  try {
    const lights = createLights({ lights: { bridge: bridge.url } });
    const result = await lights.set({ scene: "movie" });
    assert.equal(result.message, "1 of 3 lights did not respond");
    assert.deepEqual(bridge.calls[0].body.steps, scenes.find(s => s.id === "movie").steps);
    await assert.rejects(lights.set({ scene: "disco" }), error => error.status === 400);
    await assert.rejects(lights.set({ steps: [] }), error => error.status === 400);
    assert.equal(bridge.calls.length, 1);
  } finally {
    await bridge.close();
  }
});

test("an offline bridge is reported without failing the page", async () => {
  const bridge = await mockBridge(() => [200, {}]);
  const url = bridge.url;
  await bridge.close();
  const lights = createLights({ lights: { bridge: url } });
  const state = await lights.state();
  assert.equal(state.bridge.online, false);
  assert.match(state.bridge.error, /not running/);
  assert.ok(state.scenes.length > 0);
  await assert.rejects(lights.set({ targets: ["neon"], on: true }), error => error.status === 503);
});

test("bridge validation errors keep their 400 status", async () => {
  const bridge = await mockBridge(() => [400, { error: "Unknown light: kitchen" }]);
  try {
    const lights = createLights({ lights: { bridge: bridge.url } });
    await assert.rejects(lights.set({ targets: ["kitchen"], on: true }), error => error.status === 400 && /kitchen/.test(error.message));
  } finally {
    await bridge.close();
  }
});
