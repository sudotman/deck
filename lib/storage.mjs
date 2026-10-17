import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function readJSON(filename, fallback) {
  try { return JSON.parse(fs.readFileSync(filename, "utf8")); }
  catch { return fallback; }
}
export function writeJSON(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename + ".tmp", JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(filename + ".tmp", filename);
}
export function tokenStore(directory, name) {
  const filename = directory && path.join(directory, "data", name + ".json");
  const entries = new Map(filename ? readJSON(filename, []) : []);
  const save = () => {
    for (const [id, item] of entries) if (item.expires < Date.now()) entries.delete(id);
    if (filename) writeJSON(filename, [...entries]);
  };
  save();
  return {
    get: (id) => entries.get(id),
    set(id, item) { entries.set(id, item); save(); },
    delete(id) { entries.delete(id); save(); },
    [Symbol.iterator]: () => entries[Symbol.iterator](),
  };
}
const canonical = (value) => Array.isArray(value) ? value.map(canonical) :
  value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
export function actionKey(body) {
  const { label, ...payload } = body;
  return `${body.action}:${crypto.createHash("sha256").update(JSON.stringify(canonical(payload))).digest("hex")}`;
}
export function redact(text, secrets = []) {
  let value = String(text ?? "").replace(/(\b(?:password|passkey|apikey|api_key|token|cookie|secret)["']?\s*[:=]\s*["']?)[^&\s"'},]+/gi, "$1[redacted]");
  for (const secret of secrets) if (typeof secret === "string" && secret.length > 4) value = value.replaceAll(secret, "[redacted]");
  return value;
}
