import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nativeControls } from "../lib/native.mjs";
import { createJobs } from "../lib/jobs.mjs";

function fixture(api) {
  return nativeControls({
    api,
    cache: new Map(),
    services: { jellyfin: { key: "test" } },
    jobs: {
      start: async (label, service, key, operation) => operation(() => {}),
    },
  });
}
test("manual subtitle download uses the exact opaque object returned by the provider", async () => {
  const seen = [];
  const subtitle = { radarrId: 1, subtitles: [{ path: "movie.en.srt" }] };
  const control = fixture(async (service, endpoint, method) => {
    seen.push([endpoint, method]);
    if (endpoint.startsWith("/api/providers/movies") && method === "GET")
      return {
        data: [
          {
            subtitle: "opaque-provider-object",
            provider: "opensubtitlescom",
            hearing_impaired: "False",
            forced: "False",
            original_format: "False",
            language: "en",
            score: 100,
          },
        ],
      };
    if (endpoint.startsWith("/api/movies?")) return { data: [subtitle] };
    if (endpoint.startsWith("/api/movies/history")) return { data: [] };
  });
  const search = await control.start({
    action: "subtitle",
    kind: "movie",
    id: 1,
    operation: "search",
  });
  assert.equal(search.results[0].subtitle, undefined);
  await control.start({
    action: "subtitle",
    kind: "movie",
    id: 1,
    operation: "download",
    token: search.token,
    index: 0,
  });
  const download = seen.find(
    ([endpoint, method]) =>
      endpoint.startsWith("/api/providers/movies") && method === "POST",
  );
  const parameters = new URL("http://test" + download[0]).searchParams;
  assert.equal(parameters.get("subtitle"), "opaque-provider-object");
  assert.equal(parameters.get("radarrid"), "1");
  assert.equal(parameters.get("provider"), "opensubtitlescom");
  await assert.rejects(
    control.start({
      action: "subtitle",
      kind: "movie",
      id: 2,
      operation: "download",
      token: search.token,
      index: 0,
    }),
    /expired/,
  );
});
test("subtitle editing cannot target a path outside the selected film", async () => {
  const control = fixture(async () => ({
    data: [
      { radarrId: 1, subtitles: [{ path: "actual.en.srt", code2: "en" }] },
    ],
  }));
  await assert.rejects(
    control.start({
      action: "subtitle",
      kind: "movie",
      id: 1,
      operation: "edit",
      path: "different.srt",
      content: "changed",
    }),
    /no longer exists/,
  );
});
test("subtitle edit uploads the selected language and existing flags", async () => {
  let uploaded;
  const control = fixture(async (service, endpoint, method, body) => {
    if (method === "POST") uploaded = { endpoint, body };
    return {
      data: [
        {
          radarrId: 1,
          subtitles: [
            { path: "movie.en.srt", code2: "en", forced: true, hi: false },
          ],
        },
      ],
    };
  });
  await control.start({
    action: "subtitle",
    kind: "movie",
    id: 1,
    operation: "edit",
    path: "movie.en.srt",
    content: "1\n00:00:01,000 --> 00:00:02,000\nHello\n",
  });
  assert(uploaded.body instanceof FormData);
  const q = new URL("http://test" + uploaded.endpoint).searchParams;
  assert.equal(q.get("language"), "en");
  assert.equal(q.get("forced"), "true");
  assert.equal(q.get("hi"), "false");
  assert.equal(uploaded.body.get("file").name, "movie.en.srt");
});
test("saving a connection preserves its existing secrets and unedited fields", async () => {
  let saved;
  const control = fixture(async (service, endpoint, method, body) => {
    if (method === "PUT") saved = body;
    return {
      id: 1,
      name: "Indexer",
      fields: [
        { name: "apiKey", privacy: 1, value: "existing-secret" },
        { name: "baseUrl", value: "http://old" },
        { name: "untouched", value: 7 },
      ],
    };
  });
  await control.start({
    action: "connection",
    service: "prowlarr",
    type: "indexer",
    id: 1,
    name: "Updated",
    fields: { apiKey: "", baseUrl: "http://new" },
  });
  assert.equal(saved.fields[0].value, "existing-secret");
  assert.equal(saved.fields[1].value, "http://new");
  assert.equal(saved.fields[2].value, 7);
});
test("qBittorrent 5 pause uses the supported stop endpoint", async () => {
  let called;
  const control = fixture(async (service, endpoint) => {
    if (endpoint.endsWith("version")) return "v5.1.2";
    called = endpoint;
  });
  await control.start({
    action: "torrent",
    hash: "a".repeat(40),
    operation: "pause",
  });
  assert.equal(called, "/api/v2/torrents/stop");
});
test("library task completion waits for the upstream command, and propagates failure", async () => {
  const control = fixture(async (service, endpoint, method) =>
    method === "POST"
      ? { id: 15 }
      : { status: "failed", message: "Import failed: unmapped path" },
  );
  await assert.rejects(
    control.start({
      action: "command",
      service: "radarr",
      name: "RefreshMovie",
      id: 1,
    }),
    /unmapped path/,
  );
});
test("jobs deduplicate active operations and survive process restarts", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-jobs-"));
  try {
    let finish;
    const jobs = createJobs(dir);
    const first = jobs.start(
      "Search subtitles",
      "bazarr",
      "search:1",
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const second = jobs.start("Search subtitles", "bazarr", "search:1", () => {
      throw Error("Should not run twice");
    });
    assert.equal(first.id, second.id);
    assert.equal(createJobs(dir).get(first.id).status, "interrupted");
    finish({ message: "69 results" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(jobs.get(first.id).status, "completed");
    assert.equal(createJobs(dir).get(first.id).status, "completed");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("subtitle backups preserve original bytes and can be restored for the same film", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "deck-subtitles-"));
  try {
    const filename = path.join(directory, "movie.en.srt");
    const original = "1\r\n00:00:01,000 --> 00:00:02,000\r\nOriginal line\r\n";
    fs.writeFileSync(filename, original);
    let restored;
    const control = nativeControls({
      directory,
      cache: new Map(),
      services: {},
      jobs: {
        start: async (label, service, key, operation) => operation(() => {}),
      },
      api: async (service, endpoint, method, body) => {
        if (method === "POST") restored = body.get("file");
        if (endpoint.includes("history")) return { data: [] };
        if (endpoint.includes("languages")) return [];
        return {
          data: [
            {
              radarrId: 1,
              title: "Test film",
              subtitles: [
                { path: filename, code2: "en", forced: false, hi: false },
              ],
            },
          ],
        };
      },
    });
    await control.start({
      action: "subtitle",
      kind: "movie",
      id: 1,
      operation: "edit",
      path: filename,
      content: "1\n00:00:01,000 --> 00:00:02,000\nUpdated\n",
    });
    const detail = await control.read(
      "subtitle-detail",
      new URLSearchParams({ kind: "movie", id: 1 }),
    );
    assert.equal(detail.backups.length, 1);
    fs.writeFileSync(filename, "changed");
    await control.start({
      action: "subtitle",
      kind: "movie",
      id: 1,
      operation: "restore",
      backupId: detail.backups[0].backupId,
    });
    assert.equal(await restored.text(), original);
    await assert.rejects(
      control.start({
        action: "subtitle",
        kind: "movie",
        id: 2,
        operation: "restore",
        backupId: detail.backups[0].backupId,
      }),
      /belonging/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Bazarr HTTP acceptance is followed through its background queue before success", async () => {
  let posted = false,
    reads = 0;
  const observed = [];
  const control = nativeControls({
    cache: new Map(),
    services: {},
    jobs: {
      start: async (label, service, key, operation) =>
        operation((message) => observed.push(message)),
    },
    api: async (service, endpoint, method) => {
      if (endpoint === "/api/system/jobs") {
        if (!posted) return { data: [] };
        reads++;
        return {
          data: [
            {
              job_id: 97,
              job_name: "Manually downloaded Subtitles for Test Film",
              status: reads < 2 ? "running" : "completed",
              progress_message: "Saving subtitle file",
            },
          ],
        };
      }
      if (endpoint.startsWith("/api/providers/movies") && method === "GET")
        return {
          data: [
            {
              provider: "provider",
              subtitle: "opaque",
              language: "en",
              score: 100,
            },
          ],
        };
      if (method === "POST") {
        posted = true;
        return null;
      }
      if (endpoint.includes("/history?")) return { data: [] };
      if (endpoint.startsWith("/api/movies?"))
        return {
          data: [
            {
              radarrId: 1,
              title: "Test Film",
              subtitles: [{ path: "film.en.srt" }],
            },
          ],
        };
    },
  });
  const search = await control.start({
    action: "subtitle",
    kind: "movie",
    id: 1,
    operation: "search",
  });
  await control.start({
    action: "subtitle",
    kind: "movie",
    id: 1,
    operation: "download",
    token: search.token,
    index: 0,
  });
  assert.equal(posted, true);
  assert.equal(reads >= 2, true);
});

test("same-service jobs wait their turn while other services can run", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-lanes-"));
  try {
    const jobs = createJobs(dir);
    let finishA, finishB, finishC;
    const a = jobs.start(
      "A",
      "bazarr",
      "a",
      () =>
        new Promise((resolve) => {
          finishA = resolve;
        }),
    );
    const b = jobs.start(
      "B",
      "bazarr",
      "b",
      () =>
        new Promise((resolve) => {
          finishB = resolve;
        }),
    );
    const c = jobs.start(
      "C",
      "radarr",
      "c",
      () =>
        new Promise((resolve) => {
          finishC = resolve;
        }),
    );
    assert.equal(a.status, "running");
    assert.equal(b.status, "queued");
    assert.equal(c.status, "running");
    finishA({});
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(b.status, "running");
    finishB({});
    finishC({});
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(
      jobs.list().every((job) => job.status === "completed"),
      true,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Bazarr background failures propagate the actual provider error", async () => {
  let posted = false;
  const control = fixture(async (service, endpoint, method) => {
    if (endpoint === "/api/system/jobs")
      return {
        data: posted
          ? [
              {
                job_id: 99,
                job_name: "Subtitle download for Test Film",
                status: "failed",
                progress_message: "Provider quota exceeded",
              },
            ]
          : [],
      };
    if (endpoint.startsWith("/api/providers/movies") && method === "GET")
      return {
        data: [{ provider: "provider", subtitle: "opaque", language: "en" }],
      };
    if (method === "POST") {
      posted = true;
      return null;
    }
    return { data: [{ radarrId: 1, title: "Test Film", subtitles: [] }] };
  });
  const search = await control.start({
    action: "subtitle",
    kind: "movie",
    id: 1,
    operation: "search",
  });
  await assert.rejects(
    control.start({
      action: "subtitle",
      kind: "movie",
      id: 1,
      operation: "download",
      token: search.token,
      index: 0,
    }),
    /Provider quota exceeded/,
  );
});
