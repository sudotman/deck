import test from "node:test";
import assert from "node:assert/strict";
import { createTvLink, tvEvent } from "../lib/tv.mjs";

test("sends are validated: full http links, short searches, tonight", () => {
  assert.deepEqual(tvEvent({ kind: "link", url: " https://youtu.be/abc " }), { kind: "link", url: "https://youtu.be/abc" });
  assert.throws(() => tvEvent({ kind: "link", url: "javascript:alert(1)" }), /full link/);
  assert.throws(() => tvEvent({ kind: "link", url: "youtu.be/abc" }), /full link/);
  assert.deepEqual(tvEvent({ kind: "search", text: "  Heat " }), { kind: "search", text: "Heat" });
  assert.throws(() => tvEvent({ kind: "search", text: " " }), /search/);
  assert.throws(() => tvEvent({ kind: "reboot" }), /Choose what/);
  assert.deepEqual(tvEvent({ kind: "arrived" }), { kind: "arrived" });
});

test("a TV first learns where the queue stands, then gets each send once, and waits for the next", async () => {
  let clock = 1000;
  const tv = createTvLink({ now: () => clock });
  tv.send({ kind: "search", text: "sent before the TV connected" });
  const hello = await tv.next({ from: "" });
  assert.deepEqual(hello.events, []);
  assert.equal(hello.latest, 1);

  const waiting = tv.next({ from: hello.epoch, after: hello.latest, wait: 5000 });
  tv.send({ kind: "link", url: "https://youtu.be/x" });
  const got = await waiting;
  assert.deepEqual(got.events, [{ kind: "link", url: "https://youtu.be/x", id: 2 }]);
  assert.deepEqual((await tv.next({ from: hello.epoch, after: got.latest, wait: 0 })).events, []);

  clock += 3 * 60e3; // stale sends are dropped
  tv.send({ kind: "tonight" });
  clock += 3 * 60e3;
  assert.deepEqual((await tv.next({ from: hello.epoch, after: 2, wait: 0 })).events, []);
});

test("a waiting TV is released when it hangs up", async () => {
  const tv = createTvLink();
  const { epoch } = await tv.next();
  const gone = new AbortController();
  const waiting = tv.next({ from: epoch, wait: 20000, signal: gone.signal });
  gone.abort();
  assert.deepEqual((await waiting).events, []);
});
