// Builds dist/deck-<version>.zip: the app files plus manifest.json with SHA-256 checksums,
// which is what windows/deploy-update.ps1 installs. No dependencies; needs Node 22.2+.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const components = ["server.mjs", "lib", "public", "test", "package.json", "README.md", "config.example.json"];
const walk = (rel) => {
  const abs = path.join(root, rel);
  return fs.statSync(abs).isDirectory()
    ? fs.readdirSync(abs).filter((n) => n !== ".DS_Store").sort().flatMap((n) => walk(path.posix.join(rel, n)))
    : [rel];
};
const files = components.flatMap(walk);
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const manifest = {
  version,
  files: files.map((f) => ({ path: f, sha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(root, f))).digest("hex") })),
};
const entries = [...files.map((f) => [f, fs.readFileSync(path.join(root, f))]), ["manifest.json", Buffer.from(JSON.stringify(manifest, null, 1))]];

// Minimal zip writer: deflated entries, UTF-8 names, fixed timestamps for reproducible builds.
const chunks = [], central = [];
let offset = 0;
for (const [name, data] of entries) {
  const nameBytes = Buffer.from(name), packed = zlib.deflateRawSync(data), crc = zlib.crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
  local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26);
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(8, 10); header.writeUInt16LE(0, 12); header.writeUInt16LE(0x21, 14); header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(packed.length, 20); header.writeUInt32LE(data.length, 24); header.writeUInt16LE(nameBytes.length, 28);
  header.writeUInt32LE(offset, 42);
  chunks.push(local, nameBytes, packed);
  central.push(header, nameBytes);
  offset += local.length + nameBytes.length + packed.length;
}
const directory = Buffer.concat(central), end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
fs.mkdirSync(path.join(root, "dist"), { recursive: true });
const out = path.join(root, "dist", `deck-${version}.zip`);
fs.writeFileSync(out, Buffer.concat([...chunks, directory, end]));
console.log(`${path.relative(root, out)}: ${files.length} files, ${Math.round(fs.statSync(out).size / 1024)} KB`);
