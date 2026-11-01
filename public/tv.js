// The phone companion for Vitrine: choose tonight's film, play a link or search YouTube on the TV.
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

async function call(path, body) {
  const r = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Error(data.error || `Deck answered ${r.status}`);
  return data;
}

let noteTimer;
function note(text, error = false) {
  const el = $("note");
  el.textContent = text;
  el.classList.toggle("error", error);
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => { el.textContent = ""; }, 5000);
}

const poster = url => url ? `<img src="${esc(url)}" alt="" loading="lazy" />` : `<div class="poster-blank"></div>`;
const runtime = m => m > 0 ? (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`) : null;

function showTonight({ film }) {
  const meta = [film.year, runtime(film.runtime), film.director].filter(Boolean).join(" · ");
  const s = film.stremio;
  const stremio = !s || film.status === "available" ? ""
    : s.good ? `On Stremio in ${s.quality || "HD"}, ${s.seeders} seeders`
    : s.count ? `Stremio has only ${s.quality || "poor"} copies so far` : "Nothing on Stremio yet";
  const youtube = film.youtube?.found && film.status !== "available" ? "On YouTube in full" : "";
  const where = [stremio, youtube].filter(Boolean).join(" · ");
  $("tonight").innerHTML = `${poster(film.poster)}<div><h3>${esc(film.title)}</h3><p>${esc(meta)}</p>${where ? `<p>${esc(where)}</p>` : ""}
    <button class="button" type="button" id="another">Something else</button></div>`;
  $("another").onclick = () => choose({ next: true }, "Picked something else");
}

async function choose(body, done) {
  try {
    showTonight(await call("/hub/api/watchlist/tonight", { ...body, show: true }));
    note(`${done}. It's on the TV.`);
  } catch (error) {
    note(error.message, true);
  }
}

let searchSeq = 0;
async function searchFilms(q) {
  const mine = ++searchSeq;
  if (!q.trim()) { $("films").innerHTML = ""; return; }
  try {
    const { films } = await call(`/hub/api/watchlist/films?q=${encodeURIComponent(q)}`);
    if (mine !== searchSeq) return;
    $("films").innerHTML = films.length
      ? films.map(f => `<button type="button" data-slug="${esc(f.slug)}">${poster(f.poster)}<div>${esc(f.title)} <span>${esc(f.year || "")}</span></div></button>`).join("")
      : `<p class="note">Nothing on the watchlist matches.</p>`;
  } catch (error) {
    note(error.message, true);
  }
}

$("films").addEventListener("click", e => {
  const b = e.target.closest("button[data-slug]");
  if (!b) return;
  $("film-search").value = "";
  $("films").innerHTML = "";
  choose({ slug: b.dataset.slug }, "Tonight's film is set");
});

let typing;
$("film-search").addEventListener("input", e => {
  clearTimeout(typing);
  typing = setTimeout(() => searchFilms(e.target.value), 180);
});

async function send(body, done, form) {
  const button = form.querySelector("button");
  button.disabled = true;
  try {
    await call("/hub/api/tv/send", body);
    form.reset();
    note(done);
  } catch (error) {
    note(error.message, true);
  } finally {
    button.disabled = false;
  }
}

$("link-form").addEventListener("submit", e => {
  e.preventDefault();
  send({ kind: "link", url: $("link").value }, "Sent. It'll open on the TV.", e.target);
});

$("search-form").addEventListener("submit", e => {
  e.preventDefault();
  send({ kind: "search", text: $("search").value }, "Searching YouTube on the TV.", e.target);
});

// Your YouTube: the TV's own YouTube row is published signed out, so the room uses your subscriptions.
let ytPoll;
function showYouTube(s) {
  clearTimeout(ytPoll);
  const el = $("yt");
  if (s.connected) {
    el.innerHTML = `<p>The YouTube room shows new uploads from the ${s.channels} channels you follow${s.source === "takeout" ? ", from your Takeout file" : ""}.</p>
      <div class="actions"><label class="button" for="takeout">Replace with a new file</label><button class="button" type="button" id="yt-off">Disconnect</button></div>
      <input type="file" id="takeout" accept=".csv,text/csv" />`;
    $("yt-off").onclick = async () => { showYouTube(await call("/hub/api/youtube/disconnect", {})); note("YouTube disconnected."); };
  } else if (s.signIn) {
    el.innerHTML = `<p>On any device, go to <strong>${esc(s.signIn.url)}</strong> and enter</p><p class="code">${esc(s.signIn.code)}</p><p>This page updates once you've allowed it.</p>`;
    ytPoll = setTimeout(() => call("/hub/api/youtube?count=1").then(showYouTube), 5000);
    return;
  } else {
    el.innerHTML = `<p>YouTube's own row on the TV isn't yours. Bring your subscriptions and the YouTube room shows new uploads from the channels you follow.</p>
      <div class="actions"><label class="button primary" for="takeout">Choose subscriptions.csv</label>${s.canSignIn ? `<button class="button" type="button" id="yt-signin">Sign in with a code</button>` : ""}</div>
      <p class="note">Get the file from takeout.google.com: choose only YouTube, then only subscriptions.</p>
      <input type="file" id="takeout" accept=".csv,text/csv" />`;
    if (s.canSignIn) $("yt-signin").onclick = async () => {
      try { showYouTube(await call("/hub/api/youtube/signin", {})); } catch (error) { note(error.message, true); }
    };
  }
  $("takeout").onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const result = await call("/hub/api/youtube/takeout", { csv: await file.text() });
      showYouTube(result);
      note(`Following ${result.channels} channels on the TV.`);
    } catch (error) {
      note(error.message, true);
    }
  };
}
call("/hub/api/youtube?count=1").then(showYouTube).catch(error => { $("yt").innerHTML = `<p class="note error">${esc(error.message)}</p>`; });

// Whether the TV is on, with a button to wake it or put it to sleep (shown only when Deck can).
let awake = null;
function showPower(state) {
  if (!state.configured) return;
  awake = state.awake;
  $("power").hidden = false;
  $("power-state").textContent = awake === true ? "The TV is on." : awake === false ? "The TV is asleep." : "The TV isn't answering.";
  $("power-button").textContent = awake === true ? "Turn off" : "Wake the TV";
}
$("power-button").addEventListener("click", async () => {
  const button = $("power-button");
  button.disabled = true;
  try {
    showPower(await call("/hub/api/tv/power", { action: awake === true ? "sleep" : "wake" }));
  } catch (error) {
    note(error.message, true);
  } finally {
    button.disabled = false;
  }
});
call("/hub/api/tv/power").then(showPower).catch(() => {});

call("/hub/api/watchlist/tonight").then(showTonight).catch(error => {
  $("tonight").innerHTML = `<p class="note error">${esc(error.message)}</p>`;
});
