import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { arrival, createArrivals } from "../lib/arrivals.mjs";

const hook = (id, extra = {}) => ({ eventType: "Download", isUpgrade: false, movie: { id, title: `Film ${id}`, year: 1998, tmdbId: 100 + id }, ...extra });

test("only first imports count as arrivals, not upgrades or other events", () => {
  assert.deepEqual(arrival(hook(4)), { id: 4, title: "Film 4", year: 1998, tmdbId: 104 });
  assert.equal(arrival(hook(4, { isUpgrade: true })), null);
  assert.equal(arrival({ eventType: "Test", movie: { id: 1, title: "x" } }), null);
  assert.equal(arrival({ eventType: "Download", movie: {} }), null);
});

test("arrivals are newest first, kept on disk, dismissed by the TV, and forgotten after a few days", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "deck-arrivals-"));
  let clock = Date.UTC(2026, 9, 21, 20);
  const arrivals = createArrivals({ directory, now: () => clock });
  arrivals.add(hook(1));
  clock += 60e3;
  arrivals.add(hook(2));
  arrivals.add(hook(2, { isUpgrade: true }));
  assert.deepEqual(arrivals.list().map(f => f.id), [2, 1]);

  assert.equal(arrivals.dismiss(2), true);
  assert.equal(arrivals.dismiss(99), false);
  assert.deepEqual(createArrivals({ directory, now: () => clock }).list().map(f => f.id), [1], "survives a restart");

  clock += 4 * 86400e3;
  assert.deepEqual(arrivals.list(), []);
  fs.rmSync(directory, { recursive: true, force: true });
});
