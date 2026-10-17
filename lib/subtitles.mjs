const stamp = /(?:\d{1,2}:)?\d{2}:\d{2}[,.]\d{3}/g;
const millis = value => {
  const parts = value.trim().split(/[,:.]/).map(Number);
  if (parts.length === 4) return ((parts[0] * 60 + parts[1]) * 60 + parts[2]) * 1000 + parts[3];
  if (parts.length === 3) return (parts[0] * 60 + parts[1]) * 1000 + parts[2];
  return null;
};
export function shiftSubtitles(content, seconds, format = "srt") {
  if (!["srt", "vtt"].includes(format.toLowerCase())) throw Error("Simple timing shifts support SRT and VTT. Use audio synchronization for styled formats.");
  if (!Number.isFinite(seconds) || Math.abs(seconds) > 600) throw Error("Enter an offset between −600 and 600 seconds");
  return content.split(/(?<=\n)/).map(line => line.includes("-->") ? line.replace(stamp, match => {
    const total = Math.max(0, Math.round(millis(match) + seconds * 1000));
    const hours = Math.floor(total / 3600000), short = match.split(":").length === 2 && !hours;
    return `${short ? "" : String(hours).padStart(2, "0") + ":"}${String(Math.floor(total / 60000) % 60).padStart(2, "0")}:${String(Math.floor(total / 1000) % 60).padStart(2, "0")}${match.includes(",") ? "," : "."}${String(total % 1000).padStart(3, "0")}`;
  }) : line).join("");
}
export function subtitleCues(content) {
  return String(content).replace(/\r/g, "").split(/\n\s*\n/).flatMap(block => {
    const lines = block.split("\n"); const i = lines.findIndex(l => l.includes(" --> "));
    if (i < 0) return [];
    const [start, end] = lines[i].split(/\s*-->\s*/);
    return [{ start: millis(start.trim()), end: millis(end.trim().split(" ")[0]), text: lines.slice(i + 1).join("\n") }];
  });
}
