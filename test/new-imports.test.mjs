import test from "node:test";
import assert from "node:assert/strict";
import { importChecks, importedFilm } from "../lib/new-imports.mjs";

test("only Radarr's import events name a film to check", () => {
  assert.equal(importedFilm({ eventType: "Download", movie: { id: 25, title: "Belladonna of Sadness" } }), 25);
  assert.equal(importedFilm({ eventType: "Test", movie: { id: 1 } }), null);
  assert.equal(importedFilm({ eventType: "Grab", movie: { id: 25 } }), null);
  assert.equal(importedFilm({ eventType: "Download" }), null);
});

test("each reported film is checked straight away", async () => {
  const checked = [];
  const checks = importChecks({ check: async id => { checked.push(id); }, log: () => {} });
  await checks.add(25);
  await checks.add(25);
  assert.deepEqual(checked, [25, 25], "each report is checked; a film already waiting isn't queued twice");
  assert.deepEqual(checks.pending(), []);
});

test("a film Bazarr hasn't indexed yet waits and is retried, then given up on", async () => {
  let clock = 0, ready = false, attempts = 0;
  const logs = [];
  const checks = importChecks({
    check: async () => { attempts++; if (!ready) throw Error("This file is not indexed by Bazarr yet."); },
    now: () => clock, log: m => logs.push(m), retryEvery: 60e3, giveUpAfter: 30 * 60e3,
  });
  await checks.add(7);
  assert.deepEqual(checks.pending(), [7]);
  ready = true;
  await checks.run();
  assert.equal(attempts, 2);
  assert.deepEqual(checks.pending(), []);

  ready = false;
  await checks.add(8);
  clock = 31 * 60e3;
  await checks.run();
  assert.deepEqual(checks.pending(), []);
  assert.match(logs.at(-1), /gave up on Radarr film 8/);
});
