// Keeps a private layer out of this public repository. Each line of home/private-patterns.txt
// is a case-insensitive regular expression (addresses, hostnames, device IDs, usernames).
// The git hooks in scripts/hooks run this; without that file it passes silently.
//   node scripts/check-public.mjs staged   files staged for commit (index contents)
//   node scripts/check-public.mjs head     every file in HEAD plus all commit messages
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const patternsFile = "home/private-patterns.txt";
if (!fs.existsSync(patternsFile)) process.exit(0);
const patterns = fs.readFileSync(patternsFile, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => new RegExp(l, "i"));
const git = (...args) => execFileSync("git", args, { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
const mode = process.argv[2] || "staged";
const sources = [];
if (mode === "staged") {
  for (const file of git("diff", "--cached", "--name-only", "--diff-filter=ACMR").toString().split("\n").filter(Boolean))
    sources.push([file, git("show", ":" + file)]);
} else {
  for (const file of git("ls-tree", "-r", "--name-only", "HEAD").toString().split("\n").filter(Boolean))
    sources.push([file, git("show", "HEAD:" + file)]);
  sources.push(["(commit messages)", git("log", "--format=%an %ae%n%B", "HEAD")]);
}
const leaks = [];
for (const [name, content] of sources) {
  if (content.includes(0)) continue; // binary
  content.toString("utf8").split("\n").forEach((line, i) => {
    for (const pattern of patterns) if (pattern.test(line)) leaks.push(`${name}:${i + 1} matches /${pattern.source}/`);
  });
}
if (leaks.length) {
  console.error(`Private details found; nothing was ${mode === "staged" ? "committed" : "pushed"}:\n  ` + leaks.join("\n  "));
  process.exit(1);
}
