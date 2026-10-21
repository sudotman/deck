import test from "node:test";
import assert from "node:assert/strict";
import { isAdvertSubtitle } from "../lib/subtitles.mjs";

const srt = (...texts) => texts.map((t, i) => `${i + 1}\n00:0${i}:00,000 --> 00:0${i}:05,000\n${t}\n`).join("\n");

test("a release group's advert .srt is caught", () => {
  // The file that came with Belladonna of Sadness, word for word.
  assert.equal(isAdvertSubtitle(srt("Provided by YTS.LT", "Find the official YIFY movies site at\nhttps://YTS.LT", "Downloaded from YTS.LT", "Official YIFY movies site:\nYTS.LT")), true);
});

test("real subtitles, short forced ones included, are left alone", () => {
  assert.equal(isAdvertSubtitle(srt("Where are you going?", "To the village.", "Wait for me!")), false, "a short forced subtitle");
  assert.equal(isAdvertSubtitle(srt("Provided by YTS.LT", "Where are you going?", "To the village.", "Wait for me!", "Run.")), false, "one advert line in real dialogue");
  assert.equal(isAdvertSubtitle(srt("Provided by YTS.LT", "Downloaded from YTS.LT", "www.yts.lt", "Where are you going?")), false, "mostly adverts, but one line of dialogue");
  assert.equal(isAdvertSubtitle(Array.from({ length: 40 }, (_, i) => `${i + 1}\n00:00:${String(i).padStart(2, "0")},000 --> 00:00:${String(i).padStart(2, "0")},900\nLine ${i} www.example.com`).join("\n\n")), false, "long files aren't adverts");
  assert.equal(isAdvertSubtitle(""), false);
});
