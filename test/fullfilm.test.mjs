import assert from "node:assert/strict";
import test from "node:test";
import { candidates, createFullFilm, minutes, namesFilm, parsePlayable, parseResults } from "../lib/fullfilm.mjs";

// Titles as they appeared in real searches.
const video = (title, length, { channel = "Someone", views = 1000, verified = false, snippet = "" } = {}) =>
  ({ id: title.slice(0, 11), title, channel, minutes: minutes(length), views, verified, snippet, live: false });

const ourLand = { title: "Our Land", year: 1979, runtime: 152, director: "Goutam Ghose", originalTitle: "మా భూమి", alternativeTitles: ["Maabhoomi", "The Motherland", "Maa Bhoomi", "Motherland"] };
const belladonna = { title: "Belladonna of Sadness", year: 1973, runtime: 87, director: "Eiichi Yamamoto", originalTitle: "哀しみのベラドンナ", alternativeTitles: ["The Tragedy of Belladonna", "A Tragédia de Belladonna"] };

test("names the film by any title, allowing for transliteration, but only as a whole part of the title", () => {
  const names = ["Our Land", "మా భూమి", "Maa Bhoomi", "Motherland"];
  assert.ok(namesFilm("MA BHOOMI FULL MOVIE || మా భూమి తెలుగు సినిమా", names));
  assert.ok(namesFilm("MAA BHUMI TELUGU FULL MOVIE", names));
  assert.ok(namesFilm("Maa bhoomi 1979 Full movie Telugu # trending #telugu #movie", names));
  assert.ok(!namesFilm("Gangland in Motherland (Full Movie) - Nishawn Bhullar - Vadda Grewal - New Punjabi Movies", names));
  assert.ok(!namesFilm("Maa Voollo Mahasivudu Telugu Full Movie | Rao Gopal Rao", names));
});

test("keeps the film itself and drops commentary, lookalikes and wrong lengths", () => {
  const found = candidates([
    video("MAA BHOOMI | మా భూమి |B.Narsing Rao| Sai Chand", "2:19:30", { views: 813223 }), // no sign it's the whole film
    video("MA BHOOMI FULL MOVIE || మా భూమి తెలుగు సినిమా ", "2:19:10", { views: 151035 }),
    video("Gangland in Motherland (Full Movie) - Nishawn Bhullar", "2:16:00", { views: 4823053 }),
    video("మన భూమి మన సినిమా | Special Story on Maa Bhoomi Movie", "26:40", { verified: true }),
    video("Maa Bhoomi 1979 Full Movie", "40:00"),
  ], ourLand, 2026);
  assert.deepEqual(found.map(v => v.minutes), [139 + 1 / 6]);

  const belladonnaFound = candidates([
    video("Belladonna Of Sadness (1973)", "1:23:05", { channel: "Pleasers & Punishers Podcast" }),
    video("Belladonna Of Sadness (w/ Foxcade) | #belladonnaofsadness | Quest 057", "1:26:36"),
    video("A Tragédia de Belladonna (1973) - COMPLETO e LEGENDADO", "1:27:00", { views: 122881 }),
    video("Belladonna of Sadness (1973) | Eiichi Yamamoto | [Full Movie HD]", "1:27:19", { views: 94473 }),
  ], belladonna, 2026);
  assert.deepEqual(belladonnaFound.map(v => v.title.slice(0, 12)), ["Belladonna o", "A Tragédia d"], "its own title first, then an alternative");
});

test("a film's own title can't count against it", () => {
  const interview = { title: "The Interview", year: 2014, runtime: 112 };
  assert.equal(candidates([video("The Interview (2014) Full Movie", "1:52:00", { verified: true })], interview, 2026).length, 1);
  assert.equal(candidates([video("The Interview review", "1:52:00", { verified: true })], interview, 2026).length, 0);
});

test("a recent film only counts from a verified channel", () => {
  const oppenheimer = { title: "Oppenheimer", year: 2023, runtime: 181, director: "Christopher Nolan" };
  assert.equal(candidates([video("Oppenheimer: Full Movie Universal Pictures 2023", "2:45:00", { channel: "Senseiii", views: 649715 })], oppenheimer, 2026).length, 0);
  assert.equal(candidates([video("Oppenheimer | Full Movie", "3:00:00", { verified: true })], oppenheimer, 2026).length, 1);
  assert.equal(candidates([video("Oppenheimer | Full Movie", "3:00:00")], oppenheimer, 2031).length, 1);
});

test("reads search results and watch pages", () => {
  const results = `<script>var ytInitialData = ${JSON.stringify({ contents: [{ videoRenderer: {
    videoId: "kvO2PgMCIhU", title: { runs: [{ text: "MA BHOOMI FULL MOVIE" }] }, ownerText: { runs: [{ text: "T RAGHAVENDAR" }] },
    lengthText: { simpleText: "2:19:10" }, viewCountText: { simpleText: "151,035 views" },
    ownerBadges: [{ metadataBadgeRenderer: { style: "BADGE_STYLE_TYPE_VERIFIED" } }],
  } }] })};</script>`;
  assert.deepEqual(parseResults(results)[0], { id: "kvO2PgMCIhU", title: "MA BHOOMI FULL MOVIE", channel: "T RAGHAVENDAR", minutes: 139 + 1 / 6, views: 151035, verified: true, snippet: "", live: false });

  const page = (playabilityStatus, shortDescription = "") =>
    `<script>var ytInitialPlayerResponse = ${JSON.stringify({ playabilityStatus, videoDetails: { lengthSeconds: "5239", shortDescription } })};</script>`;
  assert.equal(parsePlayable(page({ status: "OK" })).ok, true);
  assert.equal(parsePlayable(page({ status: "LOGIN_REQUIRED", reason: "Sign in to confirm your age" })).ok, true);
  assert.equal(parsePlayable(page({ status: "UNPLAYABLE", reason: "Video unavailable" })).ok, false);
  assert.equal(parsePlayable(page({ status: "OK" }, "Full movie link in description 👇 bit.ly/xyz")).ok, false);
});

test("caches answers, and backs off when YouTube turns it away", async () => {
  let t = Date.UTC(2026, 9, 24), calls = 0, refuse = false;
  const search = `<script>var ytInitialData = ${JSON.stringify({ contents: [{ videoRenderer: {
    videoId: "abc", title: { runs: [{ text: "Belladonna of Sadness (1973) Full Movie" }] }, ownerText: { runs: [{ text: "x" }] },
    lengthText: { simpleText: "1:27:19" }, viewCountText: { simpleText: "9 views" } } }] })};</script>`;
  const watch = `<script>var ytInitialPlayerResponse = ${JSON.stringify({ playabilityStatus: { status: "OK" }, videoDetails: { lengthSeconds: "5239" } })};</script>`;
  const ff = createFullFilm({ now: () => t, fetchText: async url => { calls++; if (refuse) throw Error("YouTube answered 302"); return url.includes("/watch") ? watch : search; } });
  const film = { slug: "belladonna", ...belladonna, alternativeTitles: [] };
  assert.equal((await ff.check(film)).id, "abc");
  const before = calls;
  await ff.check(film);
  assert.equal(calls, before, "cached");

  t += 13 * 3600e3; refuse = true;
  await assert.rejects(ff.check(film));
  const refused = calls;
  assert.equal(await ff.check(film), null, "quiet for a while");
  assert.equal(calls, refused);
});

test("when watch pages are refused, oEmbed says whether a video plays", async () => {
  const search = `<script>var ytInitialData = ${JSON.stringify({ contents: [
    { videoRenderer: { videoId: "gone", title: { runs: [{ text: "Maa Bhoomi 1979 Full Movie" }] }, ownerText: { runs: [{ text: "x" }] }, lengthText: { simpleText: "2:20:00" }, viewCountText: { simpleText: "900 views" } } },
    { videoRenderer: { videoId: "kvO2PgMCIhU", title: { runs: [{ text: "MA BHOOMI FULL MOVIE" }] }, ownerText: { runs: [{ text: "y" }] }, lengthText: { simpleText: "2:19:10" }, viewCountText: { simpleText: "151,035 views" } } },
  ] })};</script>`;
  const asked = [];
  const ff = createFullFilm({
    now: () => Date.UTC(2026, 9, 24),
    fetchText: async url => { if (url.includes("/watch")) throw Error("YouTube answered 302"); return search; },
    fetchStatus: async url => { asked.push(url); return url.includes("kvO2PgMCIhU") ? 401 : 200; },
  });
  const found = await ff.check({ slug: "our-land", ...ourLand });
  assert.equal(found.id, "gone", "the one that oEmbed says plays");
  assert.equal(asked.length, 2);
});
