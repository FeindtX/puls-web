"use strict";
// Puls – Web-App. Liest pulse.json aus deinem privaten GitHub-Repository
// (Branch "data") und schreibt Trainings und Journal nach data/*.json auf main.

// ------------------------------------------------------------------ Speicher

const LS = {
  get(k, d) { try { const v = localStorage.getItem("puls." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { v == null ? localStorage.removeItem("puls." + k) : localStorage.setItem("puls." + k, JSON.stringify(v)); } catch {} },
};

const state = {
  data: LS.get("data", null),
  updated: LS.get("updated", null),
  settings: LS.get("settings", { repo: "", token: "" }),
  gym: LS.get("gym", null),
  journal: LS.get("journal", {}),
  selected: null,
  loading: false,
  error: null,
  lastRun: null,
  trendRange: 30,
  journalDate: null,
};

// ------------------------------------------------------------------ Format

const C = {
  green: "#2EDB71", yellow: "#F5C542", red: "#FF5252", strain: "#2F8CFF", sleep: "#9C8CFF",
  stress: "#FF9F43", battery: "#3DD6D0", sub: "#8B929C", line: "#2A2F37", card2: "#1E2228", text: "#F2F4F7",
  deep: "#6C4DFF", rem: "#4FB3FF", light: "#9C8CFF", awake: "#E7E9EE",
  zones: ["#4A5059", "#7FA6C9", "#2F8CFF", "#2EDB71", "#F5C542", "#FF5252"],
};
const recColor = (s) => s == null ? C.sub : s >= 67 ? C.green : s >= 34 ? C.yellow : C.red;
const stageColor = (s) => ({ deep: C.deep, rem: C.rem, awake: C.awake })[s] || C.light;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const num = (v, d = 0) => v == null || !isFinite(v) ? "–" : Number(v).toFixed(d).replace(".", d ? "," : ".");
const hm = (m) => { if (m == null || !isFinite(m)) return "–"; const t = Math.round(m); return `${Math.floor(t / 60)}:${String(Math.abs(t % 60)).padStart(2, "0")}`; };
const pad = (n) => String(n).padStart(2, "0");

function parse(s) {
  if (!s) return null;
  const m = /^(\d{4})-(\d\d)-(\d\d)(?:T(\d\d):(\d\d)(?::(\d\d))?)?/.exec(s);
  return m ? new Date(+m[1], m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) : null;
}
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const isoMin = (d) => `${isoDay(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const clock = (s) => { const d = typeof s === "string" ? parse(s) : s; return d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : "–"; };
const WD = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];
const MO = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
const longDay = (d) => `${WD[d.getDay()]}, ${d.getDate()}. ${MO[d.getMonth()]}`;
const shortDay = (d) => `${d.getDate()}.${d.getMonth() + 1}.`;
const todayIso = () => isoDay(new Date());
const signedMin = (m) => { const v = Math.round(m); return Math.abs(v) < 5 ? "pünktlich" : v > 0 ? `${v} min später` : `${-v} min früher`; };
const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const sd = (xs) => { if (xs.length < 2) return 0; const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };

// ------------------------------------------------------------------ Daten

const days = () => state.data?.days || [];
const dayOf = (date) => days().find((d) => d.date === date);
function windowDays(n, until) {
  const all = days();
  let end = until ? all.findIndex((d) => d.date === until) : all.length - 1;
  if (end < 0) end = all.length - 1;
  return all.slice(Math.max(0, end - n + 1), end + 1);
}
const selectedDay = () => days()[state.selected ?? days().length - 1];
const repoOk = () => /^[\w.-]+\/[\w.-]+$/.test(state.settings.repo.trim()) && state.settings.token.trim();

async function gh(path, opts = {}) {
  const res = await fetch(`https://api.github.com/repos/${state.settings.repo.trim()}${path}`, {
    ...opts,
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${state.settings.token.trim()}`,
      Accept: opts.raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  if (res.status === 401) throw new Error("Der GitHub-Schlüssel ist ungültig oder abgelaufen.");
  if (res.status === 403) throw new Error("Dem GitHub-Schlüssel fehlen Rechte (Contents und Actions: Lesen & Schreiben).");
  if (res.status === 404 && opts.allow404) return null;
  if (res.status === 404) throw new Error("Repository oder Daten nicht gefunden. Stimmt der Name?");
  if (!res.ok) throw new Error(`GitHub antwortet mit Fehler ${res.status}.`);
  if (res.status === 204) return null;
  return opts.raw ? res.text() : res.json();
}

async function refresh(quiet) {
  if (state.loading) return;
  state.loading = true; if (!quiet) render();
  try {
    let text;
    if (repoOk()) {
      text = await gh("/contents/pulse.json?ref=data", { raw: true, allow404: true });
      if (text == null) {
        await gh(""); // wirft eine klare Meldung, falls das Repository nicht stimmt
        if (!state.firstSyncAsked) { state.firstSyncAsked = true; triggerSync(true, true); }
        throw new Error("Noch keine Daten. Der erste Garmin-Abruf läuft und dauert 3–5 Minuten. Tippe danach oben auf ↻.");
      }
      gh("/actions/runs?per_page=1").then((r) => { state.lastRun = r?.workflow_runs?.[0] || null; }).catch(() => {});
      syncJournalDown().catch(() => {});
    } else {
      const res = await fetch("pulse.json", { cache: "no-store" });
      if (!res.ok) throw new Error("Trag in den Einstellungen dein GitHub-Repository und den Schlüssel ein.");
      text = await res.text();
    }
    const data = JSON.parse(text);
    const followToday = state.selected == null || state.selected >= days().length - 1;
    state.data = data;
    state.updated = new Date().toISOString();
    if (followToday) state.selected = data.days.length - 1;
    LS.set("data", data); LS.set("updated", state.updated);
    state.error = null;
  } catch (e) {
    state.error = e instanceof TypeError ? "Keine Verbindung. Gezeigt wird der letzte Stand." : e.message;
  } finally {
    state.loading = false;
    render();
  }
}

// Base64 für UTF-8 (GitHub Contents API)
const b64enc = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const b64dec = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, "")), (c) => c.charCodeAt(0)));

async function readRepoJson(path, fallback) {
  const r = await gh(`/contents/${path}?ref=main`, { allow404: true });
  return r ? { value: JSON.parse(b64dec(r.content)), sha: r.sha } : { value: fallback, sha: null };
}

async function writeRepoJson(path, value, sha, message) {
  return gh(`/contents/${path}`, {
    method: "PUT",
    body: JSON.stringify({ message, content: b64enc(JSON.stringify(value, null, 1)), branch: "main", ...(sha ? { sha } : {}) }),
  });
}

/** Ändert data/sessions.json und stößt eine Neuberechnung an. */
async function editSessions(fn, message) {
  if (!repoOk()) { toast("Erst GitHub in den Einstellungen verbinden."); return false; }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { value, sha } = await readRepoJson("data/sessions.json", []);
      await writeRepoJson("data/sessions.json", fn(value), sha, message);
      await triggerSync(true);
      return true;
    } catch (e) {
      if (attempt === 2 || !/409|422/.test(e.message)) { toast(e.message); return false; }
    }
  }
  return false;
}

async function triggerSync(silent, quiet) {
  if (!repoOk()) { await refresh(); return; }
  try {
    await gh("/actions/workflows/sync.yml/dispatches", { method: "POST", body: JSON.stringify({ ref: "main" }) });
    if (!quiet) toast(silent ? "Gespeichert. Strain wird in 1–2 Minuten neu berechnet." : "Sync gestartet. Neue Daten in 1–2 Minuten.");
    setTimeout(() => refresh(true), 100_000);
  } catch (e) { toast(e.message); }
}

// Journal: lokal sofort, ins Repo verzögert gesammelt.
let journalTimer = null;
function saveJournal() {
  LS.set("journal", state.journal);
  if (!repoOk()) return;
  clearTimeout(journalTimer);
  journalTimer = setTimeout(async () => {
    try {
      const { value, sha } = await readRepoJson("data/journal.json", {});
      await writeRepoJson("data/journal.json", { ...value, ...state.journal }, sha, "Journal");
    } catch (e) { toast("Journal nur lokal gespeichert: " + e.message); }
  }, 3000);
}
async function syncJournalDown() {
  const { value } = await readRepoJson("data/journal.json", {});
  state.journal = { ...value, ...state.journal };
  LS.set("journal", state.journal);
}

// ------------------------------------------------------------------ Bausteine

function ring(progress, color, size, stroke, inner) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r, p = Math.max(0.002, Math.min(progress || 0, 1));
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${C.card2}" stroke-width="${stroke}"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round"
      stroke-dasharray="${c * p} ${c}" transform="rotate(-90 ${size / 2} ${size / 2})" style="filter:drop-shadow(0 0 6px ${color}88)"/>
    <text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" fill="${C.text}" style="font-weight:800;font-size:${size * 0.2}px">${inner}</text>
  </svg>`;
}

function hero(progress, color, value, label, sub) {
  return `<div class="hero">${ring(progress, color, 190, 14, value)}
    <div style="font-size:12px;font-weight:800;letter-spacing:1.2px;color:${color};margin-top:-6px">${label}</div>
    ${sub ? `<h2>${sub}</h2>` : ""}</div>`;
}

const title = (t, right) => `<div class="title"><b>${t}</b>${right ? `<span>${right}</span>` : ""}</div>`;
const tile = (k, v, unit, d, color) => `<div class="tile"><div class="k">${k}</div>
  <div class="v" ${color ? `style="color:${color}"` : ""}>${v}${unit ? `<small>${unit}</small>` : ""}</div>${d ? `<div class="d">${d}</div>` : ""}</div>`;
const empty = (e, t, x) => `<div class="card empty"><div class="e">${e}</div><b>${t}</b><p class="muted small">${x}</p></div>`;

function topbar(t, sub, back = true, right = "") {
  return `<div class="top">
    ${back ? `<button class="iconbtn" data-action="back" aria-label="Zurück"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></button>` : `<span style="width:40px"></span>`}
    <h1>${t}${sub ? `<span class="sub">${sub}</span>` : ""}</h1>
    ${right || `<span style="width:40px"></span>`}</div>`;
}

const ICON = {
  running: "🏃", treadmill_running: "🏃", trail_running: "🏃", cycling: "🚴", indoor_cycling: "🚴",
  walking: "🚶", hiking: "🥾", strength_training: "🏋️", fitness_equipment: "🏋️", hiit: "🔥",
  indoor_cardio: "🔥", swimming: "🏊", lap_swimming: "🏊", sailing_v2: "⛵", yoga: "🧘",
};
const TYPES = [["strength_training", "Krafttraining"], ["hiit", "HIIT"], ["indoor_cardio", "Cardio"], ["running", "Laufen"],
  ["cycling", "Radfahren"], ["walking", "Gehen"], ["yoga", "Yoga"], ["other", "Sport"]];

function actRow(date, a) {
  return `<a class="act" href="#/activity/${date}/${encodeURIComponent(a.id)}">
    <div class="ic">${ICON[a.type] || "💪"}</div>
    <div class="grow" style="flex:1;min-width:0">
      <div class="name">${esc(a.name)}${a.source === "detected" ? `<span class="pill y">ERKANNT</span>` : ""}${a.live ? `<span class="pill g">LÄUFT</span>` : ""}</div>
      <div class="small muted">${clock(a.start)}–${a.end ? clock(a.end) : "jetzt"} · ${hm(a.durationMin)} h${a.avgHr ? ` · Ø ${Math.round(a.avgHr)} bpm` : ""}</div>
    </div>
    <div class="val">${num(a.strain, 1)}</div><span class="chev">›</span></a>`;
}

function zoneBars(z, floors) {
  const total = Math.max(z.reduce((a, b) => a + b, 0), 1), max = Math.max(...z, 1);
  let h = "";
  for (let i = z.length - 1; i >= 0; i--) {
    h += `<div class="row" style="margin-bottom:7px">
      <b class="small" style="width:24px;color:${C.zones[i]}">Z${i}</b>
      <div class="bar grow"><i style="left:0;width:${Math.max(2, (z[i] / max) * 100)}%;background:${C.zones[i]}"></i></div>
      <span class="small muted" style="width:40px;text-align:right">${hm(z[i])}</span>
      <span class="small muted" style="width:36px;text-align:right">${Math.round((z[i] / total) * 100)} %</span></div>`;
  }
  if (floors?.length === 5) h += `<div class="tiny muted">Zonen ab ${floors.join(" · ")} bpm</div>`;
  return h;
}

function metricRow(icon, name, value, base, unit, digits = 0, higherBetter = true) {
  let delta = "";
  if (value != null && base) {
    const pct = ((value - base) / base) * 100, good = higherBetter ? pct >= 0 : pct <= 0;
    const cls = Math.abs(pct) < 3 ? "muted" : good ? "up" : "down";
    delta = `<div class="small ${cls}" style="font-weight:700">${pct >= 0 ? "↑" : "↓"} ${num(Math.abs(pct))} %</div>`;
  }
  return `<div class="metric"><div class="ic">${icon}</div>
    <div class="grow" style="flex:1"><b>${name}</b>${base ? `<div class="small muted">Ø ${num(base, digits)} ${unit} (30 Tage)</div>` : ""}</div>
    <div class="r"><b>${num(value, digits)} ${unit}</b>${delta}</div></div>`;
}

// ------------------------------------------------------------------ Diagramme (SVG)

const W = 340;

function dayAxis(list, x, y) {
  const step = Math.max(1, Math.round(list.length / 5));
  return list.map((d, i) => i % step === 0 ? `<text x="${x(i)}" y="${y}" text-anchor="middle">${shortDay(parse(d.date))}</text>` : "").join("");
}

function barChart(list, value, color, { max, height = 140, highlight, digits = 0 } = {}) {
  const vals = list.map(value), top = max ?? Math.max(1, ...vals.filter((v) => v != null)) * 1.1;
  const h = height, plotH = h - 20, bw = (W - 30) / Math.max(list.length, 1);
  const x = (i) => i * bw + bw / 2, y = (v) => plotH - (v / top) * plotH;
  let g = "";
  for (const t of [0, 0.5, 1]) g += `<line x1="0" x2="${W - 30}" y1="${y(top * t)}" y2="${y(top * t)}" stroke="${C.line}"/><text x="${W - 26}" y="${y(top * t) + 3}">${num(top * t, top < 10 ? 1 : 0)}</text>`;
  list.forEach((d, i) => {
    const v = vals[i]; if (v == null) return;
    const op = highlight && highlight !== d.date ? 0.45 : 1;
    g += `<rect x="${i * bw + bw * 0.15}" y="${y(v)}" width="${bw * 0.7}" height="${Math.max(1, plotH - y(v))}" rx="2" fill="${color(v)}" opacity="${op}"/>`;
  });
  return `<svg class="chart" viewBox="0 -8 ${W} ${h + 8}">${g}${dayAxis(list, x, h - 4)}</svg>`;
}

function lineChart(list, value, color, { height = 130, baseline } = {}) {
  const pts = list.map((d, i) => [i, value(d)]).filter((p) => p[1] != null);
  if (!pts.length) return `<p class="muted small">Keine Daten im Zeitraum</p>`;
  const vs = pts.map((p) => p[1]).concat(baseline != null ? [baseline] : []);
  let lo = Math.min(...vs), hi = Math.max(...vs); const padv = (hi - lo) * 0.15 || 5; lo -= padv; hi += padv;
  const h = height, plotH = h - 20, bw = (W - 30) / Math.max(list.length, 1);
  const x = (i) => i * bw + bw / 2, y = (v) => plotH - ((v - lo) / (hi - lo)) * plotH;
  let g = "";
  for (const t of [0, 0.5, 1]) { const v = lo + (hi - lo) * t; g += `<line x1="0" x2="${W - 30}" y1="${y(v)}" y2="${y(v)}" stroke="${C.line}"/><text x="${W - 26}" y="${y(v) + 3}">${num(v, hi < 10 ? 1 : 0)}</text>`; }
  if (baseline != null) g += `<line x1="0" x2="${W - 30}" y1="${y(baseline)}" y2="${y(baseline)}" stroke="${C.sub}" stroke-dasharray="4 4"/>`;
  g += `<polyline fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" points="${pts.map((p) => `${x(p[0])},${y(p[1])}`).join(" ")}"/>`;
  g += pts.map((p) => `<circle cx="${x(p[0])}" cy="${y(p[1])}" r="${list.length > 40 ? 1.5 : 2.5}" fill="${color}"/>`).join("");
  return `<svg class="chart" viewBox="0 -8 ${W} ${h + 8}">${g}${dayAxis(list, x, h - 4)}</svg>`;
}

function timeAxis(x, h, stepH = 6) {
  let g = "";
  for (let hh = 0; hh <= 24; hh += stepH) g += `<line x1="${x(hh * 60)}" x2="${x(hh * 60)}" y1="0" y2="${h - 18}" stroke="${C.line}" stroke-dasharray="2 3"/><text x="${x(hh * 60)}" y="${h - 4}" text-anchor="middle">${pad(hh % 24)}:00</text>`;
  return g;
}

function hrChart(date, timeline, activities) {
  const h = 170, plotH = h - 22, base = parse(date);
  const x = (m) => 4 + (m / 1440) * (W - 38), hi = Math.max(150, ...timeline.map((p) => p[1]));
  const y = (v) => plotH - (v / hi) * plotH;
  let g = timeAxis(x, h);
  for (const a of activities) {
    const s = parse(a.start), e = a.end ? parse(a.end) : new Date();
    const ms = (s - base) / 60000, me = (e - base) / 60000;
    g += `<rect x="${x(ms)}" y="0" width="${Math.max(2, x(me) - x(ms))}" height="${plotH}" fill="${C.strain}" opacity="${a.source === "detected" ? 0.16 : 0.26}"/>`;
  }
  for (const v of [50, 100, 150]) g += `<text x="${W - 30}" y="${y(v) + 3}">${v}</text>`;
  g += `<polyline fill="none" stroke="${C.red}" stroke-width="1.6" stroke-linejoin="round" points="${timeline.map((p) => `${x(p[0])},${y(p[1])}`).join(" ")}"/>`;
  return `<svg class="chart" viewBox="0 -8 ${W} ${h + 8}">${g}</svg>`;
}

function hypnogram(segments) {
  const rows = ["awake", "rem", "light", "deep"], names = { awake: "Wach", rem: "REM", light: "Leicht", deep: "Tief" };
  const s0 = parse(segments[0].start), s1 = parse(segments[segments.length - 1].end);
  const span = (s1 - s0) || 1, h = 160, rowH = (h - 22) / 4, left = 44;
  const x = (d) => left + ((d - s0) / span) * (W - left - 4);
  let g = rows.map((r, i) => `<text x="0" y="${i * rowH + rowH / 2 + 3}">${names[r]}</text>`).join("");
  const first = new Date(s0); first.setMinutes(0, 0, 0);
  for (let t = new Date(first.getTime() + 3600000); t < s1; t = new Date(t.getTime() + 2 * 3600000)) {
    g += `<line x1="${x(t)}" x2="${x(t)}" y1="0" y2="${h - 20}" stroke="${C.line}" stroke-dasharray="2 3"/><text x="${x(t)}" y="${h - 4}" text-anchor="middle">${clock(t)}</text>`;
  }
  for (const s of segments) {
    const a = parse(s.start), b = parse(s.end), i = rows.indexOf(s.stage);
    g += `<rect x="${x(a)}" y="${i * rowH + rowH * 0.15}" width="${Math.max(1.5, x(b) - x(a))}" height="${rowH * 0.7}" rx="2" fill="${stageColor(s.stage)}"/>`;
  }
  return `<svg class="chart" viewBox="0 -8 ${W} ${h + 8}">${g}</svg>`;
}

function stressChart(date, timeline) {
  const h = 120, plotH = h - 22, x = (m) => 4 + (m / 1440) * (W - 30), y = (v) => plotH - (v / 3) * plotH;
  let g = timeAxis(x, h);
  for (const v of [0, 1, 2, 3]) g += `<text x="${W - 20}" y="${y(v) + 3}">${v}</text>`;
  for (const [m, v100] of timeline) {
    const v = (v100 / 100) * 3;
    g += `<rect x="${x(m)}" y="${y(v)}" width="3" height="${plotH - y(v)}" fill="${v < 1 ? C.battery : v < 2 ? C.stress : C.red}"/>`;
  }
  return `<svg class="chart" viewBox="0 -8 ${W} ${h + 8}">${g}</svg>`;
}

function scatter(pairs) {
  const h = 170, plotH = h - 20, x = (s) => 6 + (s / 21) * (W - 40), y = (r) => plotH - (r / 100) * plotH;
  let g = "";
  for (const r of [0, 25, 50, 75, 100]) g += `<line x1="0" x2="${W - 30}" y1="${y(r)}" y2="${y(r)}" stroke="${C.line}"/><text x="${W - 26}" y="${y(r) + 3}">${r}</text>`;
  for (const s of [0, 5, 10, 15, 20]) g += `<text x="${x(s)}" y="${h - 4}" text-anchor="middle">${s}</text>`;
  g += pairs.map(([s, r]) => `<circle cx="${x(s)}" cy="${y(r)}" r="4" fill="${recColor(r)}"/>`).join("");
  return `<svg class="chart" viewBox="0 -8 ${W} ${h + 8}">${g}</svg>`;
}

// ------------------------------------------------------------------ Ansichten

function viewHome() {
  const all = days(), day = selectedDay(), d = day ? parse(day.date) : new Date();
  const isToday = day?.date === todayIso();
  const label = !day ? "Heute" : isToday ? "Heute" : day.date === isoDay(new Date(Date.now() - 864e5)) ? "Gestern" : longDay(d);
  const status = state.loading ? "Aktualisiere …" : state.updated ? `Stand ${clock(new Date(state.updated))}` : "";
  const i = state.selected ?? all.length - 1;
  let h = `<div class="top">
    <button class="iconbtn" data-action="day" data-d="-1" ${i <= 0 ? "disabled" : ""}><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></button>
    <h1>${label}<span class="sub">${status}</span></h1>
    <button class="iconbtn" data-action="day" data-d="1" ${i >= all.length - 1 ? "disabled" : ""}><svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg></button>
  </div>
  <div class="between" style="margin:-4px 0 8px">
    <button class="iconbtn ${state.loading ? "spin" : ""}" data-action="sync" aria-label="Synchronisieren"><svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 01-14 5.3M4 12a8 8 0 0114-5.3M18 3v4h-4M6 21v-4h4"/></svg></button>
    <a class="iconbtn" href="#/settings" aria-label="Einstellungen"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 01-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 010-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 014 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 010 4h-.1a1.7 1.7 0 00-1.5 1z"/></svg></a>
  </div>`;
  if (state.error) h += `<div class="banner">⚠️<span>${esc(state.error)}</span></div>`;

  if (!state.data) {
    return h + empty("📡", "Noch keine Daten", "Öffne die Einstellungen und verbinde dein GitHub-Repository.");
  }
  if (!day?.hasData) {
    h += empty("⌚️", "Keine Daten für diesen Tag", "Die Garmin wurde nicht getragen oder hat noch nicht synchronisiert.");
    if (isToday) h += gymCard();
    return h;
  }
  const r = day.recovery, s = day.sleep, st = day.strain;
  const gs = s?.garminScore;
  const gsColor = gs == null ? C.sub : gs >= 80 ? C.green : gs >= 60 ? C.yellow : C.red;
  const gsWord = gs == null ? "kein Wert" : gs >= 90 ? "Hervorragend" : gs >= 80 ? "Gut" : gs >= 60 ? "Ausreichend" : "Schlecht";
  h += `<div class="rings four">
    <a class="ring" href="#/sleep/${day.date}">${ring((s?.performance ?? 0) / 100, C.sleep, 74, 7, s ? Math.round(s.performance) + "%" : "–")}
      <div class="lbl" style="color:${C.sleep}">SCHLAF</div><div class="s">${s ? hm(s.asleepMin) + " h" : "keine Nacht"}</div></a>
    <a class="ring" href="#/sleep/${day.date}">${ring((gs ?? 0) / 100, gsColor, 74, 7, gs ?? "–")}
      <div class="lbl" style="color:${gsColor}">SLEEP SCORE</div><div class="s">${gsWord}</div></a>
    <a class="ring" href="#/recovery/${day.date}">${ring((r?.score ?? 0) / 100, recColor(r?.score), 96, 9, r ? r.score + "%" : "–")}
      <div class="lbl" style="color:${recColor(r?.score)}">RECOVERY</div><div class="s">${r?.hrv ? "HRV " + Math.round(r.hrv) : "kein Wert"}</div></a>
    <a class="ring" href="#/strain/${day.date}">${ring((st?.day ?? 0) / 21, C.strain, 74, 7, num(st?.day, 1))}
      <div class="lbl" style="color:${C.strain}">STRAIN</div><div class="s">${st?.kcal ? Math.round(st.kcal) + " kcal" : ""}</div></a>
  </div>`;
  h += coachCard(day);
  if (isToday) h += gymCard();
  const acts = st?.activities || [];
  h += `<div class="card">${title("Aktivitäten", acts.length || "")}${acts.length ? acts.map((a) => actRow(day.date, a)).join("") : `<p class="muted small" style="margin:0">Keine Trainings an diesem Tag.</p>`}</div>`;
  if (isToday && state.data.sleepPlanner) h += tonightCard(state.data.sleepPlanner);
  const lvl = day.stress?.level;
  h += `<div class="grid2">
    <div class="card">${title("Stress")}<div class="tile" style="padding:0;background:none"><div class="v" style="color:${C.stress}">${num(lvl, 1)}<small>/ 3</small></div>
      <div class="d">${lvl == null ? "keine Messung" : lvl < 1 ? "Entspannt" : lvl < 2 ? "Mittel" : "Hoch"}</div></div></div>
    <div class="card">${title("Body Battery")}<div class="tile" style="padding:0;background:none"><div class="v" style="color:${C.battery}">${num(day.bodyBattery?.now ?? day.bodyBattery?.high)}<small>/ 100</small></div>
      <div class="d">+${num(day.bodyBattery?.charged)} / −${num(day.bodyBattery?.drained)}</div></div></div></div>`;
  h += `<div class="grid2">
    ${tile("HRV", num(r?.hrv), "ms", r?.hrvBaseline ? `Ø ${Math.round(r.hrvBaseline)} ms` : "")}
    ${tile("Ruhepuls", num(r?.rhr), "bpm", r?.rhrBaseline ? `Ø ${num(r.rhrBaseline)} bpm` : "")}
    ${tile("Kalorien", num(st?.kcal), "kcal", st?.activeKcal ? `${Math.round(st.activeKcal)} aktiv` : "")}
    ${tile("Schritte", num(st?.steps), "", "&nbsp;")}</div>`;
  if ((state.data.nightsWithRecovery ?? 0) < 5) h += `<p class="small muted">Recovery kalibriert sich noch. Ab 5 Nächten werden die Werte verlässlich.</p>`;
  return h;
}

function coachCard(day) {
  const t = day.strain?.target, c = day.strain?.day ?? 0;
  if (!t) return "";
  const status = c < t.low ? `Noch ${num(t.low - c, 1)} bis zum Ziel` : c <= t.high ? "Im Zielbereich ✓" : "Über dem Ziel, gönn dir Erholung";
  return `<div class="card">${title("Strain-Coach", `Ziel ${num(t.low, 1)}–${num(t.high, 1)}`)}
    <div class="bar"><i style="left:${(t.low / 21) * 100}%;width:${((t.high - t.low) / 21) * 100}%;background:rgba(47,140,255,.3)"></i>
      <i style="left:0;width:${Math.max(3, (Math.min(c, 21) / 21) * 100)}%;background:${C.strain}"></i></div>
    <div class="between small" style="margin:8px 0"><span class="muted tiny">0</span><b>${status}</b><span class="muted tiny">21</span></div>
    <div class="muted small">${esc(t.text)}</div></div>`;
}

function gymCard() {
  if (state.gym) {
    return `<div class="card">${title("Gym")}<div class="row">
      <div class="grow" style="flex:1"><b>${esc(state.gym.name)}</b><div class="timer" id="gymTimer">${elapsed(state.gym.start)}</div>
      <div class="small muted">Seit ${clock(state.gym.start)}. Die Strain kommt aus dem Garmin-Puls.</div></div>
      <button class="stop" data-action="gym-stop" aria-label="Stoppen">■</button></div></div>`;
  }
  return `<div class="card">${title("Gym")}
    <button class="btn" data-action="gym-start">▶︎ Gym-Training starten</button>
    <div class="between small" style="margin-top:10px"><span class="muted">Vergessen? Trainings werden automatisch am Puls erkannt.</span>
    <a class="link" href="#/log">Nachtragen</a></div></div>`;
}
function elapsed(start) {
  const s = Math.max(0, Math.floor((Date.now() - parse(start)) / 1000));
  return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}

function tonightCard(p) {
  return `<div class="card">${title("Heute Nacht", `Wecker ${clock(p.wake)}`)}
    <div class="row" style="margin-bottom:12px"><span style="font-size:22px">🛏️</span>
      <div class="grow" style="flex:1"><span class="muted small">Ins Bett um</span><div style="font-size:28px;font-weight:800;color:${C.sleep}">${clock(p.recommendedBed)}</div></div>
      <div style="text-align:right"><div class="tiny muted">Bedarf</div><b>${hm(p.needMin)} h</b></div></div>
    <div class="opts">${p.options.map((o) => `<div><b>${clock(o.bed)}</b><div class="tiny muted">${esc(o.label)} ${o.pct}%</div></div>`).join("")}</div></div>`;
}

function viewRecovery(date) {
  const day = dayOf(date), r = day?.recovery, hist = windowDays(30, date);
  let h = topbar("Recovery", day ? longDay(parse(date)) : "");
  if (!r) return h + empty("🌙", "Keine Recovery", "Dafür braucht es eine Nacht mit der Garmin am Handgelenk.");
  const head = r.zone === "green" ? "Du bist bereit für Belastung." : r.zone === "yellow" ? "Dein Körper hält eine moderate Belastung aus." : "Dein Körper braucht heute Erholung.";
  h += hero(r.score / 100, recColor(r.score), r.score + "%", "RECOVERY", head);
  if (r.calibrating) h += `<p class="small muted" style="text-align:center">Kalibrierung läuft</p>`;
  h += `<div class="card">${title("Einflussfaktoren")}
    ${metricRow("〰️", "Herzfrequenzvariabilität", r.hrv, r.hrvBaseline, "ms")}<div class="divider"></div>
    ${metricRow("♥︎", "Ruhepuls", r.rhr, r.rhrBaseline, "bpm", 0, false)}<div class="divider"></div>
    ${metricRow("🫁", "Atemfrequenz", r.resp, r.respBaseline, "/min", 1, false)}<div class="divider"></div>
    ${metricRow("🛏️", "Schlafleistung", day.sleep?.performance, null, "%")}
    ${r.spo2 ? `<div class="divider"></div>${metricRow("💧", "Blutsauerstoff", r.spo2, null, "%")}` : ""}</div>`;
  const names = { hrv: "HRV", rhr: "Ruhepuls", sleep: "Schlaf", resp: "Atmung" };
  const contrib = Object.entries(r.contributions || {}).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  h += `<div class="card">${title("Was heute zählt")}${contrib.map(([k, v]) => {
    const w = Math.min(Math.abs(v) / 3, 1) * 50;
    return `<div class="row" style="margin-bottom:8px"><span style="width:80px">${names[k] || k}</span>
      <div class="grow" style="flex:1;position:relative;height:12px"><i style="position:absolute;left:50%;top:-2px;bottom:-2px;width:1px;background:${C.line}"></i>
      <i style="position:absolute;top:1px;height:10px;border-radius:3px;${v >= 0 ? `left:50%` : `right:50%`};width:${Math.max(w, 1.5)}%;background:${v >= 0 ? C.green : C.red}"></i></div>
      <span class="small muted" style="width:50px;text-align:right">${v >= 0.3 ? "hilft" : v <= -0.3 ? "bremst" : "neutral"}</span></div>`;
  }).join("")}</div>`;
  const avg = mean(hist.filter((d) => d.recovery).map((d) => d.recovery.score));
  h += `<div class="card">${title("Recovery · 30 Tage", avg != null ? `Ø ${Math.round(avg)}%` : "")}${barChart(hist, (d) => d.recovery?.score, recColor, { max: 100, highlight: date })}</div>`;
  h += `<div class="card">${title("HRV · 30 Tage", r.hrvBaseline ? `Basis ${Math.round(r.hrvBaseline)} ms` : "")}${lineChart(hist, (d) => d.recovery?.hrv, C.green, { baseline: r.hrvBaseline })}</div>`;
  return h;
}

function viewSleep(date) {
  const day = dayOf(date), s = day?.sleep;
  let h = topbar("Schlaf", day ? longDay(parse(date)) : "");
  if (!s) {
    h += empty("🌙", "Keine Schlafdaten", "Für diese Nacht hat die Garmin keinen Schlaf aufgezeichnet.");
    if (date === todayIso() && state.data?.sleepPlanner) h += tonightCard(state.data.sleepPlanner);
    return h;
  }
  h += hero(s.performance / 100, C.sleep, Math.round(s.performance) + "%", "SCHLAFLEISTUNG", `${clock(s.start)} – ${clock(s.end)} · ${hm(s.asleepMin)} h`);
  const mx = Math.max(s.needMin, s.asleepMin) * 1.05, np = s.needParts;
  h += `<div class="card">${title("Geschlafen vs. benötigt")}
    <div class="row" style="margin-bottom:6px"><div style="height:20px;border-radius:5px;background:${C.sleep};width:${(s.asleepMin / mx) * 70}%"></div><b class="small">Geschlafen ${hm(s.asleepMin)}</b></div>
    <div class="row" style="margin-bottom:12px"><div style="height:20px;border-radius:5px;background:#8B929C80;width:${(s.needMin / mx) * 70}%"></div><b class="small">Bedarf ${hm(s.needMin)}</b></div>
    ${[["Grundbedarf", np.base], ["Belastung vom Vortag", np.strain], ["Schlafschuld", np.debt], ...(np.nap ? [["Nickerchen", np.nap]] : [])]
      .map(([k, v], i) => `<div class="between small"><span class="muted">${k}</span><span>${i && v > 0 ? "+" : ""}${hm(v)} h</span></div>`).join("")}</div>`;
  if (s.hypnogram?.length) h += `<div class="card">${title("Schlafphasen")}${hypnogram(s.hypnogram)}</div>`;
  const st = s.stages, tot = Math.max(st.deep + st.light + st.rem + st.awake, 1);
  const parts = [["deep", "Tief", st.deep], ["rem", "REM", st.rem], ["light", "Leicht", st.light], ["awake", "Wach", st.awake]];
  h += `<div class="card">${title("Phasen")}<div style="display:flex;gap:2px;height:12px;border-radius:6px;overflow:hidden;margin-bottom:12px">
    ${parts.map(([k, , v]) => `<i style="width:${(v / tot) * 100}%;background:${stageColor(k)}"></i>`).join("")}</div>
    <div class="between">${parts.map(([k, n, v]) => `<div><div class="small muted"><span style="color:${stageColor(k)}">●</span> ${n}</div><b>${hm(v)}</b><div class="tiny muted">${Math.round((v / tot) * 100)} %</div></div>`).join("")}</div></div>`;
  h += `<div class="grid2">${tile("Effizienz", num(s.efficiency), "%", "Schlaf / Zeit im Bett")}${tile("Konsistenz", num(s.consistency), "%", "letzte 4 Nächte")}
    ${tile("Erholsam", num(s.restorativePct), "%", "Tief- + REM-Schlaf")}${tile("Atemfrequenz", num(s.resp, 1), "/min", s.awakeCount != null ? `${s.awakeCount}× wach` : "")}</div>`;
  const sch = state.data.schedule || {}, d = parse(date), we = d.getDay() === 0 || d.getDay() === 6;
  const col = (m) => Math.abs(m) <= 30 ? C.green : Math.abs(m) <= 75 ? C.yellow : C.red;
  h += `<div class="card">${title("Dein Rhythmus", `${sch.bedtime || "22:30"} – ${we ? sch.wake_weekend || "07:30" : sch.wake_weekday || "06:30"}`)}
    <div class="between"><div><div class="small muted">Eingeschlafen</div><div style="font-size:20px;font-weight:700">${clock(s.start)}</div><b class="small" style="color:${col(s.bedDeviationMin)}">${signedMin(s.bedDeviationMin)}</b></div>
    <div><div class="small muted">Aufgewacht</div><div style="font-size:20px;font-weight:700">${clock(s.end)}</div><b class="small" style="color:${col(s.wakeDeviationMin)}">${signedMin(s.wakeDeviationMin)}</b></div></div></div>`;
  const hist = windowDays(14, date);
  h += `<div class="card">${title("Schlaf · 14 Nächte", "Linie = Bedarf")}${sleepChart(hist)}</div>`;
  if (date === days()[days().length - 1]?.date && state.data.sleepPlanner) h += tonightCard(state.data.sleepPlanner);
  return h;
}

function sleepChart(list) {
  const h = 140, plotH = h - 20, top = 11, bw = (W - 30) / Math.max(list.length, 1);
  const x = (i) => i * bw + bw / 2, y = (v) => plotH - (v / top) * plotH;
  let g = "";
  for (const v of [0, 5, 10]) g += `<line x1="0" x2="${W - 30}" y1="${y(v)}" y2="${y(v)}" stroke="${C.line}"/><text x="${W - 26}" y="${y(v) + 3}">${v} h</text>`;
  list.forEach((d, i) => {
    if (!d.sleep) return;
    const a = d.sleep.asleepMin / 60, n = d.sleep.needMin / 60;
    g += `<rect x="${i * bw + bw * 0.18}" y="${y(a)}" width="${bw * 0.64}" height="${plotH - y(a)}" rx="2" fill="${C.sleep}"/>`;
    g += `<line x1="${i * bw + bw * 0.08}" x2="${i * bw + bw * 0.92}" y1="${y(n)}" y2="${y(n)}" stroke="${C.text}" stroke-width="2" stroke-dasharray="3 2"/>`;
  });
  return `<svg class="chart" viewBox="0 -8 ${W} ${h + 8}">${g}${dayAxis(list, x, h - 4)}</svg>`;
}

function viewStrain(date) {
  const day = dayOf(date), st = day?.strain;
  let h = topbar("Strain", day ? longDay(parse(date)) : "");
  if (!st) return h + empty("⚡️", "Kein Strain", "Für diesen Tag gibt es keine Pulsdaten.");
  const v = st.day ?? 0, lvl = v < 10 ? "Leichte Belastung" : v < 14 ? "Moderate Belastung" : v < 18 ? "Hohe Belastung" : "Sehr hohe Belastung";
  h += hero(v / 21, C.strain, num(st.day, 1), "STRAIN", lvl);
  h += `<p class="muted small" style="text-align:center;margin-top:-10px">Ziel ${num(st.target.low, 1)}–${num(st.target.high, 1)}</p>`;
  if (st.hrTimeline?.length) h += `<div class="card">${title("Herzfrequenz", "5-Minuten-Mittel")}${hrChart(date, st.hrTimeline, st.activities)}<div class="tiny muted">Blau: Trainings (hell = automatisch erkannt)</div></div>`;
  h += `<div class="card">${title("Aktivitäten")}${st.activities.length ? st.activities.map((a) => actRow(date, a)).join("") : `<p class="muted small" style="margin:0">Keine Trainings. Der Strain stammt aus der Alltagsbewegung.</p>`}</div>`;
  h += `<div class="card">${title("Herzfrequenzzonen · ganzer Tag")}${zoneBars(st.zonesMin, state.data.profile?.zoneFloors)}</div>`;
  h += `<div class="grid2">${tile("Kalorien", num(st.kcal), "kcal")}${tile("Schritte", num(st.steps))}${tile("Ø Puls", num(st.avgHr), "bpm")}${tile("Max. Puls", num(st.maxHr), "bpm")}</div>`;
  const hist = windowDays(30, date), avg = mean(hist.map((d) => d.strain?.day).filter((x) => x != null));
  h += `<div class="card">${title("Strain · 30 Tage", avg != null ? `Ø ${num(avg, 1)}` : "")}${barChart(hist, (d) => d.strain?.day, () => C.strain, { max: 21, highlight: date })}</div>`;
  return h;
}

function viewActivity(date, id) {
  const a = dayOf(date)?.strain?.activities.find((x) => x.id === id);
  let h = topbar("Aktivität", longDay(parse(date)));
  if (!a) return h + empty("❔", "Nicht gefunden", "Diese Aktivität gibt es nicht mehr. Vielleicht wurde sie gerade neu berechnet.");
  h += `<div class="hero"><div style="font-size:40px">${ICON[a.type] || "💪"}</div><h2 style="font-size:22px">${esc(a.name)}</h2>
    <div class="muted">${clock(a.start)}–${a.end ? clock(a.end) : "jetzt"} · ${hm(a.durationMin)} h</div>
    ${a.source === "detected" ? `<span class="pill y">AUTOMATISCH ERKANNT</span>` : ""}</div>`;
  h += `<div class="grid2">${tile("Strain", num(a.strain, 1), "", "", C.strain)}${tile("Kalorien", num(a.kcal), "kcal")}
    ${tile("Ø Puls", num(a.avgHr), "bpm")}${tile("Max. Puls", num(a.maxHr), "bpm")}
    ${a.distanceKm ? tile("Distanz", num(a.distanceKm, 2), "km") : ""}${a.steps != null ? tile("Schritte", num(a.steps), "", a.cadence ? `${Math.round(a.cadence)} pro Minute` : "") : ""}</div>`;
  h += `<div class="card">${title("Herzfrequenzzonen")}${zoneBars(a.zonesMin, state.data.profile?.zoneFloors)}</div>`;
  if (a.source === "detected") {
    h += `<div class="card">${title("Stimmt das?")}
      <p class="small muted">Erkannt an erhöhtem Puls ohne aufgezeichnete Aktivität${a.cadence != null ? ` (${Math.round(a.cadence)} Schritte/min)` : ""}.</p>
      <label class="f"><span>Art</span><select class="in" id="actType">${TYPES.map(([k, n]) => `<option value="${k}" ${k === a.type ? "selected" : ""}>${n}</option>`).join("")}</select></label>
      <label class="f"><span>Name</span><input class="in" id="actName" value="${esc((TYPES.find((t) => t[0] === a.type) || [, "Training"])[1])}"></label>
      <div class="btns"><button class="btn" data-action="confirm" data-date="${date}" data-id="${esc(a.id)}">✓ Bestätigen</button>
      <button class="btn ghost" data-action="dismiss" data-date="${date}" data-id="${esc(a.id)}">✕ Kein Training</button></div></div>`;
  } else if (a.source === "manual" && !a.live) {
    h += `<button class="btn red" data-action="delete" data-id="${esc(a.id)}">Training löschen</button>`;
  } else if (a.source === "garmin") {
    h += `<p class="small muted">Mit der Garmin aufgezeichnet. Bearbeiten in Garmin Connect.</p>`;
  }
  return h;
}

function viewLog() {
  const now = new Date(), start = new Date(now - 3600e3);
  return topbar("Training nachtragen") + `<div class="card">
    <label class="f"><span>Art</span><select class="in" id="logType">${TYPES.map(([k, n]) => `<option value="${k}">${n}</option>`).join("")}</select></label>
    <label class="f"><span>Name</span><input class="in" id="logName" value="Krafttraining"></label>
    <label class="f"><span>Beginn</span><input class="in" type="datetime-local" id="logStart" value="${isoMin(start)}"></label>
    <label class="f"><span>Ende</span><input class="in" type="datetime-local" id="logEnd" value="${isoMin(now)}"></label>
    <label class="f"><span>Notiz</span><input class="in" id="logNote" placeholder="z. B. Push-Tag, Beine …"></label>
    <button class="btn" data-action="log-save">Sichern</button>
    <p class="small muted">Die Strain wird aus dem Puls deiner Garmin in diesem Zeitraum berechnet. In Garmin Connect musst du nichts eintragen.</p></div>`;
}

function weekly() {
  const cur = windowDays(7), prev = windowDays(14).slice(0, 7);
  const sum = (l) => ({
    rec: mean(l.filter((d) => d.recovery).map((d) => d.recovery.score)),
    hrv: mean(l.map((d) => d.recovery?.hrv).filter((x) => x != null)),
    sleep: mean(l.map((d) => d.sleep?.asleepMin).filter((x) => x != null)),
    strain: mean(l.map((d) => d.strain?.day).filter((x) => x != null)),
    nights: l.filter((d) => d.sleep).length,
  });
  const a = sum(cur), b = sum(prev);
  const cell = (n, v, p, u, dg, hb, f = (x) => x) => {
    let delta = "–";
    if (v != null && p != null) { const d = f(v) - f(p); const cls = hb == null || Math.abs(d) < 0.05 ? "muted" : (d >= 0) === hb ? "up" : "down"; delta = `<span class="${cls}">${d >= 0 ? "+" : ""}${num(d, dg)}</span>`; }
    return `<div><div class="tiny muted">${n}</div><b>${v == null ? "–" : num(f(v), dg)}${u}</b><div class="tiny" style="font-weight:700">${delta}</div></div>`;
  };
  let txt = a.nights ? `${a.nights} von 7 Nächten erfasst.${a.sleep ? ` Im Schnitt ${hm(a.sleep)} h Schlaf.` : ""}${a.rec != null && b.rec != null ? (a.rec >= b.rec ? " Deine Erholung ist besser als letzte Woche." : " Deine Erholung ist schwächer als letzte Woche.") : ""}`
    : "Diese Woche noch keine Nächte mit Daten. Trag die Garmin beim Schlafen.";
  return `<div class="card">${title("Wochenbericht", "vs. Vorwoche")}<div class="opts" style="margin-bottom:10px">
    ${cell("Recovery", a.rec, b.rec, "%", 0, true)}${cell("HRV", a.hrv, b.hrv, "", 0, true)}${cell("Schlaf", a.sleep, b.sleep, "h", 1, true, (x) => x / 60)}${cell("Strain", a.strain, b.strain, "", 1, null)}</div>
    <div class="small muted">${txt}</div></div>`;
}

function viewTrends() {
  const n = state.trendRange, list = windowDays(n);
  let h = topbar("Trends", "", false);
  h += `<div class="seg">${[7, 30, 90].map((r) => `<button data-action="range" data-r="${r}" class="${r === n ? "on" : ""}">${r} Tage</button>`).join("")}</div>`;
  h += weekly();
  const card = (t, unit, val, chart, dg = 0) => {
    const vs = list.map(val).filter((x) => x != null), avg = mean(vs);
    return `<div class="card">${title(t, avg != null ? `Ø ${num(avg, dg)} ${unit}` : "")}${vs.length ? chart : `<p class="muted small">Keine Daten im Zeitraum</p>`}</div>`;
  };
  h += card("Recovery", "%", (d) => d.recovery?.score, barChart(list, (d) => d.recovery?.score, recColor, { max: 100 }));
  h += card("HRV", "ms", (d) => d.recovery?.hrv, lineChart(list, (d) => d.recovery?.hrv, C.green));
  h += card("Ruhepuls", "bpm", (d) => d.recovery?.rhr, lineChart(list, (d) => d.recovery?.rhr, C.red));
  h += card("Schlaf", "h", (d) => d.sleep && d.sleep.asleepMin / 60, barChart(list, (d) => d.sleep && d.sleep.asleepMin / 60, () => C.sleep), 1);
  h += card("Strain", "", (d) => d.strain?.day, barChart(list, (d) => d.strain?.day, () => C.strain, { max: 21 }), 1);
  h += card("Stress", "/ 3", (d) => d.stress?.level, lineChart(list, (d) => d.stress?.level, C.stress), 1);
  const pairs = [];
  for (let i = 1; i < list.length; i++) if (list[i - 1].strain?.day != null && list[i].recovery) pairs.push([list[i - 1].strain.day, list[i].recovery.score]);
  h += `<div class="card">${title("Strain → Recovery am nächsten Tag")}${pairs.length >= 3 ? scatter(pairs) + `<div class="tiny muted">Jeder Punkt: Strain eines Tages (x) und Recovery am Morgen danach (y).</div>` : `<p class="muted small">Braucht noch ein paar Tage mit Daten.</p>`}</div>`;
  return h;
}

const QUESTIONS = [
  ["alcohol", "Alkohol getrunken?", "🍷"], ["caffeine_late", "Koffein nach 14 Uhr?", "☕️"],
  ["late_meal", "Weniger als 2 h vor dem Schlafen gegessen?", "🍽️"], ["screen_bed", "Handy oder Bildschirm im Bett?", "📱"],
  ["gym", "Krafttraining gemacht?", "🏋️"], ["sauna", "In der Sauna gewesen?", "🧖"], ["stress", "Stressiger Tag?", "🤯"],
  ["daylight", "Mindestens 30 min Tageslicht?", "☀️"], ["nap", "Nickerchen gemacht?", "😴"], ["magnesium", "Magnesium genommen?", "💊"],
  ["sick", "Krank oder erkältet?", "🤧"], ["hydration", "Mindestens 2 Liter getrunken?", "💧"],
];

function viewJournal() {
  if (!state.journalDate) { const n = new Date(); state.journalDate = isoDay(n.getHours() < 12 ? new Date(n - 864e5) : n); }
  const key = state.journalDate, d = parse(key), ans = state.journal[key] || {};
  let h = `<div class="top">
    <button class="iconbtn" data-action="jday" data-d="-1"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></button>
    <h1>${longDay(d)}<span class="sub">${Object.keys(ans).length} von ${QUESTIONS.length} beantwortet</span></h1>
    <button class="iconbtn" data-action="jday" data-d="1" ${key >= todayIso() ? "disabled" : ""}><svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg></button></div>`;
  h += `<div class="card tight">${QUESTIONS.map(([id, t, ic]) => `<div class="q"><span class="ic">${ic}</span><span style="flex:1">${t}</span>
    <div class="yn"><button data-action="ans" data-q="${id}" data-v="1" class="${ans[id] === true ? "on" : ""}">Ja</button>
    <button data-action="ans" data-q="${id}" data-v="0" class="${ans[id] === false ? "on" : ""}">Nein</button></div></div>`).join("")}</div>`;
  // Wirkung: Recovery am Folgetag bei Ja vs. Nein
  const next = {}; const all = days();
  all.forEach((x, i) => { if (all[i + 1]?.recovery) next[x.date] = all[i + 1].recovery.score; });
  const ready = [], pending = [];
  for (const [id, t, ic] of QUESTIONS) {
    const yes = [], no = [];
    for (const [date, a] of Object.entries(state.journal)) { if (a[id] == null || next[date] == null) continue; (a[id] ? yes : no).push(next[date]); }
    if (yes.length >= 3 && no.length >= 3) ready.push({ t, ic, y: mean(yes), n: mean(no), cy: yes.length, cn: no.length });
    else if (yes.length + no.length) pending.push(`${t.replace("?", "")} (${yes.length + no.length})`);
  }
  ready.sort((a, b) => Math.abs(b.y - b.n) - Math.abs(a.y - a.n));
  h += `<div class="card">${title("Wirkung auf deine Recovery")}
    ${ready.length ? ready.map((r) => { const dl = r.y - r.n; return `<div class="row" style="margin-bottom:10px"><span>${r.ic}</span>
      <div style="flex:1"><div class="small">${r.t}</div><div class="tiny muted">Ja: Ø ${Math.round(r.y)}% (${r.cy}×) · Nein: Ø ${Math.round(r.n)}% (${r.cn}×)</div></div>
      <b class="${Math.abs(dl) < 3 ? "muted" : dl > 0 ? "up" : "down"}">${dl >= 0 ? "+" : ""}${Math.round(dl)}%</b></div>`; }).join("")
      : `<p class="small muted">Beantworte das Journal ein paar Tage lang. Sobald eine Frage mindestens 3× mit Ja und 3× mit Nein beantwortet ist, siehst du hier ihre Wirkung auf deine Recovery am nächsten Morgen.</p>`}
    ${pending.length ? `<div class="tiny muted">Noch zu wenig Antworten: ${pending.join(", ")}</div>` : ""}</div>`;
  return h;
}

function viewHealth() {
  const recent = windowDays(30), last = [...recent].reverse().find((d) => d.recovery), r = last?.recovery;
  const range = (vals, minW) => { if (vals.length < 5) return null; const m = mean(vals), w = Math.max(sd(vals) * 1.5, minW); return { lo: m - w, hi: m + w }; };
  const vals = (k) => recent.map((d) => d.recovery?.[k]).filter((x) => x != null);
  const vit = [["〰️", "HRV", r?.hrv, range(vals("hrv"), 8), "ms", 0], ["♥︎", "Ruhepuls", r?.rhr, range(vals("rhr"), 3), "bpm", 0],
    ["🫁", "Atemfrequenz", r?.resp, range(vals("resp"), 1), "/min", 1], ["💧", "Blutsauerstoff", r?.spo2, range(vals("spo2"), 2), "%", 0]];
  const status = vit.map(([, , v, rg]) => v == null || !rg ? null : v >= rg.lo && v <= rg.hi);
  const measured = status.filter((s) => s != null).length, ok = status.filter((s) => s === true).length;
  let h = topbar("Gesundheit", "", false);
  h += `<div class="card">${title("Gesundheitsmonitor", last ? `Nacht zum ${shortDay(parse(last.date))}` : "")}
    ${measured ? `<div class="row"><b style="font-size:34px;color:${ok === measured ? C.green : C.yellow}">${ok}/${measured}</b><span class="muted">Werte im Normalbereich</span></div>
    <p class="small muted" style="margin-bottom:0">${ok === measured ? "Alles im Rahmen deiner üblichen Werte." : "Mindestens ein Wert weicht ab. Das kann an Alkohol, Krankheit, Stress oder hartem Training liegen."}</p>`
      : `<p class="muted small">Noch keine Messung. Trag die Garmin heute Nacht.</p>`}</div>`;
  h += `<div class="card">${vit.map(([ic, n, v, rg, u, dg], i) => `<div class="metric"${i ? ` style="border-top:1px solid ${C.line};padding-top:10px;margin-top:6px"` : ""}><div class="ic">${ic}</div>
    <div style="flex:1"><b>${n}</b><div class="tiny muted">${rg ? `Normal: ${num(rg.lo, dg)}–${num(rg.hi, dg)} ${u}` : "Normalbereich ab 5 Nächten"}</div></div>
    <div class="r"><b>${num(v, dg)} ${u}</b></div><span style="margin-left:8px">${status[i] == null ? "–" : status[i] ? "✅" : "⚠️"}</span></div>`).join("")}</div>`;
  const t = days()[days().length - 1];
  if (t?.stress?.timeline?.length) h += `<div class="card">${title("Stress heute", `Ø ${num(t.stress.level, 1)} / 3`)}${stressChart(t.date, t.stress.timeline)}</div>`;
  const p = state.data?.profile || {};
  h += `<div class="title" style="margin-top:4px"><b>Fitness</b></div><div class="grid2">
    ${tile("VO₂max", num(p.vo2max), "ml/kg/min", "Von Garmin geschätzt", C.green)}
    ${tile("Fitness-Alter", num(p.fitnessAge), "Jahre", p.age ? `Tatsächlich ${p.age} Jahre` : "", C.green)}
    ${tile("Max. Herzfrequenz", num(p.hrMax), "bpm")}${tile("Ruhepuls-Basis", num(p.rhrBaseline), "bpm")}</div>
    <p class="tiny muted">Puls ist kein Medizinprodukt. Die Werte dienen nur der Orientierung.</p>`;
  return h;
}

function viewSettings() {
  const s = state.settings, run = state.lastRun, sch = state.data?.schedule || {};
  const runTxt = run ? `${run.status === "completed" ? (run.conclusion === "success" ? "✅ erfolgreich" : "❌ " + run.conclusion) : "⏳ läuft"} · ${clock(new Date(run.updated_at))} Uhr, ${shortDay(new Date(run.updated_at))}` : "–";
  return topbar("Einstellungen") + `<div class="card">${title("GitHub-Verbindung")}
    <label class="f"><span>Repository (Name/Repo)</span><input class="in" id="setRepo" value="${esc(s.repo)}" placeholder="dein-name/puls" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
    <label class="f"><span>Zugangsschlüssel (Fine-grained Token)</span><input class="in" id="setToken" type="password" value="${esc(s.token)}" placeholder="github_pat_…" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
    <button class="btn" data-action="save-settings">Speichern & laden</button>
    <p class="small muted">Der Schlüssel bleibt nur auf diesem iPhone gespeichert. Er braucht für dein privates Puls-Repository die Rechte <b>Contents</b> und <b>Actions</b> (jeweils Lesen & Schreiben).</p></div>
  <div class="card">${title("Sync")}
    <div class="between small"><span class="muted">Letzter Cloud-Sync</span><span>${runTxt}</span></div>
    <div class="between small" style="margin:6px 0 12px"><span class="muted">Daten berechnet</span><span>${state.data ? clock(state.data.generatedAt) + ", " + shortDay(parse(state.data.generatedAt)) : "–"}</span></div>
    <button class="btn ghost" data-action="sync">Jetzt mit Garmin synchronisieren</button>
    <p class="small muted">GitHub holt automatisch alle 30 Minuten deine Garmin-Daten (nachts seltener).</p></div>
  <div class="card">${title("Schlaf-Rhythmus")}
    <label class="f"><span>Ins Bett</span><input class="in" id="schBed" type="time" value="${esc(sch.bedtime || "22:30")}"></label>
    <div class="grid2" style="margin-bottom:12px">
      <label class="f" style="margin:0"><span>Aufstehen Mo–Fr</span><input class="in" id="schWd" type="time" value="${esc(sch.wake_weekday || "06:30")}"></label>
      <label class="f" style="margin:0"><span>Aufstehen Sa–So</span><input class="in" id="schWe" type="time" value="${esc(sch.wake_weekend || "07:30")}"></label></div>
    <button class="btn ghost" data-action="save-schedule">Schlafzeiten speichern</button>
    <p class="small muted">Daraus berechnet Puls Schlafbedarf, Schlafplaner und Konstanz.</p></div>
  <div class="card">${title("Profil")}
    <div class="between small"><span class="muted">Name</span><span>${esc(state.data?.profile?.name || "–")}</span></div>
    <div class="between small"><span class="muted">Nächte mit Recovery</span><span>${state.data?.nightsWithRecovery ?? "–"}</span></div></div>`;
}

// ------------------------------------------------------------------ Router & Aktionen

function route() {
  const parts = (location.hash.replace(/^#\/?/, "") || "").split("/").map(decodeURIComponent);
  return parts[0] ? parts : ["home"];
}

let timerHandle = null;
function render() {
  const [r, a, b] = route();
  const views = {
    home: viewHome, recovery: () => viewRecovery(a), sleep: () => viewSleep(a), strain: () => viewStrain(a),
    activity: () => viewActivity(a, b), log: viewLog, trends: viewTrends, journal: viewJournal, health: viewHealth, settings: viewSettings,
  };
  document.getElementById("view").innerHTML = (views[r] || viewHome)();
  const tab = ["trends", "journal", "health"].includes(r) ? r : "home";
  document.querySelectorAll("#tabs a").forEach((el) => el.classList.toggle("on", el.dataset.tab === tab));
  clearInterval(timerHandle);
  if (state.gym && document.getElementById("gymTimer")) {
    timerHandle = setInterval(() => { const el = document.getElementById("gymTimer"); if (el) el.textContent = elapsed(state.gym.start); }, 1000);
  }
}

function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg; el.classList.add("show");
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove("show"), 3500);
}

const ACTIONS = {
  back: () => (history.length > 1 ? history.back() : (location.hash = "#/")),
  day: (el) => { const n = days().length; state.selected = Math.max(0, Math.min(n - 1, (state.selected ?? n - 1) + +el.dataset.d)); render(); },
  sync: () => triggerSync(false),
  range: (el) => { state.trendRange = +el.dataset.r; render(); },
  jday: (el) => { const d = parse(state.journalDate); d.setDate(d.getDate() + +el.dataset.d); if (isoDay(d) <= todayIso()) state.journalDate = isoDay(d); render(); },
  ans: (el) => {
    const k = state.journalDate, q = el.dataset.q, v = el.dataset.v === "1", a = { ...(state.journal[k] || {}) };
    if (a[q] === v) delete a[q]; else a[q] = v;
    if (Object.keys(a).length) state.journal[k] = a; else delete state.journal[k];
    saveJournal(); render();
  },
  "gym-start": async () => {
    const now = new Date();
    state.gym = { id: "m" + now.getTime(), start: isoMin(now), type: "strength_training", name: "Krafttraining" };
    LS.set("gym", state.gym); render();
    if (repoOk()) await editSessions((s) => [...s.filter((x) => x.id !== state.gym.id), { id: state.gym.id, start: state.gym.start, type: state.gym.type, name: state.gym.name }], "Gym gestartet");
  },
  "gym-stop": async (el) => {
    el.disabled = true;
    const g = state.gym, end = isoMin(new Date());
    const ok = await editSessions((s) => [...s.filter((x) => x.id !== g.id), { id: g.id, start: g.start, end, type: g.type, name: g.name }], "Gym beendet");
    if (ok) { state.gym = null; LS.set("gym", null); }
    render();
  },
  "log-save": async (el) => {
    const v = (id) => document.getElementById(id).value;
    const start = v("logStart"), end = v("logEnd");
    if (!start || !end || end <= start) { toast("Das Ende muss nach dem Beginn liegen."); return; }
    el.disabled = true;
    const id = "m" + Date.now(), note = v("logNote").trim();
    const ok = await editSessions((s) => [...s, { id, start: start.slice(0, 16), end: end.slice(0, 16), type: v("logType"), name: v("logName") || "Training", ...(note ? { note } : {}) }], "Training nachgetragen");
    el.disabled = false;
    if (ok) history.back();
  },
  confirm: async (el) => {
    const a = dayOf(el.dataset.date)?.strain?.activities.find((x) => x.id === el.dataset.id); if (!a) return;
    el.disabled = true;
    const type = document.getElementById("actType").value, name = document.getElementById("actName").value || "Training";
    if (await editSessions((s) => [...s.filter((x) => x.id !== "c" + a.id), { id: "c" + a.id, start: a.start, end: a.end, type, name }], "Training bestätigt")) history.back();
    el.disabled = false;
  },
  dismiss: async (el) => {
    const a = dayOf(el.dataset.date)?.strain?.activities.find((x) => x.id === el.dataset.id); if (!a) return;
    el.disabled = true;
    if (await editSessions((s) => [...s.filter((x) => x.id !== "i" + a.id), { id: "i" + a.id, start: a.start, end: a.end, type: "ignore" }], "Erkennung verworfen")) history.back();
    el.disabled = false;
  },
  delete: async (el) => {
    if (!confirm("Training wirklich löschen?")) return;
    el.disabled = true;
    if (await editSessions((s) => s.filter((x) => x.id !== el.dataset.id), "Training gelöscht")) history.back();
    el.disabled = false;
  },
  "save-schedule": async (el) => {
    if (!repoOk()) { toast("Erst GitHub in den Einstellungen verbinden."); return; }
    const v = (id) => document.getElementById(id).value;
    const schedule = { bedtime: v("schBed"), wake_weekday: v("schWd"), wake_weekend: v("schWe") };
    if (!Object.values(schedule).every((t) => /^\d\d:\d\d$/.test(t))) { toast("Bitte alle drei Uhrzeiten ausfüllen."); return; }
    el.disabled = true;
    try {
      const { value, sha } = await readRepoJson("data/settings.json", {});
      await writeRepoJson("data/settings.json", { ...value, schedule }, sha, "Schlafzeiten");
      if (state.data) state.data.schedule = schedule;
      await triggerSync(true);
    } catch (e) { toast(e.message); }
    el.disabled = false;
  },
  "save-settings": async () => {
    state.settings = { repo: document.getElementById("setRepo").value.trim(), token: document.getElementById("setToken").value.trim() };
    LS.set("settings", state.settings);
    await refresh();
    if (!state.error) { toast("Verbunden ✓"); location.hash = "#/"; }
    else toast(state.error);
  },
};

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (!el || el.disabled) return;
  e.preventDefault();
  ACTIONS[el.dataset.action]?.(el);
});
window.addEventListener("hashchange", () => { render(); document.getElementById("view").scrollTop = 0; });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh(true); });

if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js");
if (!repoOk() && !state.data && location.protocol === "https:" && !location.hash) location.hash = "#/settings";
render();
refresh(true);
