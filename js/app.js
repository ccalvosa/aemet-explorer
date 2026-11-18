/* ==========================================================
   Explorador climático AEMET — app.js (v3)
   13 análisis + récords del día/mes/absolutos. Todo en cliente.
   ========================================================== */

"use strict";

// ---------- constantes ----------
const DATA_URL = "data";
// Colores de variable y del tema: se rellenan desde las variables CSS
// (refreshTheme) para que los gráficos sigan el tema claro/oscuro.
const VAR_COLORS = { tmax: "#e8590c", tmed: "#e5a00d", tmin: "#1c7ed6", prec: "#2b8a3e", dtr: "#9c36b5" };
const TH = { bg: "#f6f4ef", card: "#ffffff", card2: "#f2efe9", fg: "#1f2430", muted: "#6b7280",
             grid: "#ece8e0", border: "#e5e0d7", band: "rgba(107,114,128,0.2)", accent: "#e8590c" };
let ACCENT = "#d6336c";
const VAR_LABELS = {
  tmax: "Tmax", tmed: "Tmed", tmin: "Tmin",
  prec: "Precipitación", racha: "Racha viento", sol: "Sol", dtr: "Amplitud térmica",
};
const VAR_UNITS = { tmax: "°C", tmed: "°C", tmin: "°C", prec: "mm", racha: "m/s", sol: "h", dtr: "°C" };
const MS_DAY = 86400000;
const MESES = ["", "ene", "feb", "mar", "abr", "may", "jun",
               "jul", "ago", "sep", "oct", "nov", "dic"];
const MESES_LARGO = ["", "enero", "febrero", "marzo", "abril", "mayo", "junio",
                     "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const FONT = "Plus Jakarta Sans, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif";
const PLOTLY_CFG = { responsive: true, displaylogo: false, locale: "es",
                     modeBarButtonsToRemove: ["lasso2d", "select2d", "autoScale2d"] };
// Fechas de los ejes y tooltips en español
if (window.Plotly) {
  Plotly.register({
    moduleType: "locale", name: "es", dictionary: {},
    format: {
      days: ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"],
      shortDays: ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"],
      months: ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto",
               "septiembre", "octubre", "noviembre", "diciembre"],
      shortMonths: ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"],
      date: "%d/%m/%Y",
    },
  });
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function hexToRgba(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

function refreshTheme() {
  for (const v of ["tmax", "tmed", "tmin", "prec", "dtr"]) VAR_COLORS[v] = cssVar(`--${v}`) || VAR_COLORS[v];
  for (const [k, css] of [["bg", "--bg"], ["card", "--card"], ["card2", "--card-2"], ["fg", "--fg"],
                          ["muted", "--muted"], ["grid", "--grid"], ["border", "--border"], ["accent", "--accent"]]) {
    TH[k] = cssVar(css) || TH[k];
  }
  TH.band = hexToRgba(TH.muted, 0.22);
  ACCENT = cssVar("--hl") || ACCENT;
}

function isDark() {
  const t = document.documentElement.dataset.theme;
  if (t) return t === "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

// Secuencia de mes-día de un año bisiesto (366 posiciones) y de uno no bisiesto
const MD_SEQ = (() => {
  const seq = [];
  const d = new Date(Date.UTC(2020, 0, 1));
  for (let i = 0; i < 366; i++) {
    seq.push((d.getUTCMonth() + 1) * 100 + d.getUTCDate());
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return seq;
})();
const MD_SEQ_365 = MD_SEQ.filter((m) => m !== 229);
const MD_IDX_365 = new Map(MD_SEQ_365.map((m, i) => [m, i]));

// ---------- estado ----------
const state = {
  index: null,
  station: null,   // { json, years, md, startMs, yearList }
  stationB: null,  // segunda estación para "Dos estaciones"
};

// ---------- helpers ----------
const $ = (id) => document.getElementById(id);

function titleFont() { return { family: FONT, size: 15, color: TH.fg }; }

function baseLayout(titleText) {
  const ax = { gridcolor: TH.grid, zerolinecolor: TH.border, linecolor: TH.border, tickcolor: TH.border };
  const l = {
    paper_bgcolor: TH.card,
    plot_bgcolor: TH.card,
    font: { family: FONT, color: TH.fg, size: 12.5 },
    margin: { l: 55, r: 20, t: 44, b: 45 },
    xaxis: { ...ax },
    yaxis: { ...ax },
    hoverlabel: { bgcolor: TH.card, bordercolor: TH.border, font: { color: TH.fg, family: FONT, size: 13 } },
    legend: { bgcolor: "rgba(0,0,0,0)" },
  };
  if (titleText) l.title = { text: titleText, font: titleFont(), x: 0.01, xanchor: "left" };
  return l;
}

function fmtDate(startMs, idx) {
  return new Date(startMs + idx * MS_DAY).toISOString().slice(0, 10);
}

function parseMd(text) {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(text.trim());
  if (!m) return null;
  const mo = +m[1], d = +m[2];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return mo * 100 + d;
}

function mdLabel(md) { return `${md % 100} ${MESES[Math.floor(md / 100)]}`; }

function getRef() {
  let a = +$("ref-start").value, b = +$("ref-end").value;
  if (!Number.isFinite(a) || !Number.isFinite(b) || a > b) { a = 1991; b = 2020; }
  return [a, b];
}

function quantile(sorted, q) {
  const n = sorted.length;
  if (!n) return NaN;
  const pos = (n - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (pos - lo) * (sorted[hi] - sorted[lo]);
}

function mean(arr) { return arr.reduce((s, x) => s + x, 0) / arr.length; }

function ols(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  if (!sxx) return null;
  const b = sxy / sxx;
  return { a: my - b * mx, b };
}

/** Calendario (año, mes-día) de la rejilla de una estación. */
function makeCalendar(json) {
  // variable derivada: amplitud térmica diaria (DTR = tmax - tmin)
  if (json.data.tmax && json.data.tmin && !json.data.dtr) {
    const tx = json.data.tmax, tn = json.data.tmin;
    json.data.dtr = tx.map((x, i) => (x !== null && tn[i] !== null) ? Math.round((x - tn[i]) * 10) / 10 : null);
    if (!json.vars.includes("dtr")) json.vars.push("dtr");
  }
  const startMs = Date.parse(json.start + "T00:00:00Z");
  const n = json.data[json.vars[0]].length;
  const years = new Int16Array(n), md = new Int16Array(n);
  const d = new Date(startMs);
  for (let i = 0; i < n; i++) {
    years[i] = d.getUTCFullYear();
    md[i] = (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return { json, years, md, startMs, yearList: [...new Set(years)] };
}

/**
 * Agrega una variable por "año de grupo" dentro de una ventana MM-DD.
 * Ventanas que cruzan el año (12-01→02-28): el grupo es el año en que
 * TERMINA la ventana. Devuelve Map(año → {sum, n, nTotal}).
 */
function aggregateWindow(values, mdStart, mdEnd, cal) {
  const c = cal || state.station;
  const wraps = mdStart > mdEnd;
  const groups = new Map();
  for (let i = 0; i < values.length; i++) {
    const m = c.md[i];
    const inWin = wraps ? (m >= mdStart || m <= mdEnd) : (m >= mdStart && m <= mdEnd);
    if (!inWin) continue;
    const gy = wraps && m >= mdStart ? c.years[i] + 1 : c.years[i];
    let g = groups.get(gy);
    if (!g) { g = { sum: 0, n: 0, nTotal: 0 }; groups.set(gy, g); }
    g.nTotal++;
    const v = values[i];
    if (v !== null) { g.sum += v; g.n++; }
  }
  return groups;
}

/**
 * Matriz año → array[365] alineado a MD_SEQ_365 (29-feb descartado).
 * startMd=101 → año natural; startMd=1001 → año hidrológico (grupo = año en
 * que termina: oct 2023–sep 2024 → 2024).
 */
function yearMatrix(values, startMd = 101, cal) {
  const c = cal || state.station;
  const offset = MD_IDX_365.get(startMd);
  const out = new Map();
  for (let i = 0; i < values.length; i++) {
    const m = c.md[i];
    if (m === 229) continue;
    const p0 = MD_IDX_365.get(m);
    const pos = (p0 - offset + 365) % 365;
    const gy = p0 >= offset ? (offset === 0 ? c.years[i] : c.years[i] + 1) : c.years[i];
    let row = out.get(gy);
    if (!row) { row = new Array(365).fill(null); out.set(gy, row); }
    row[pos] = values[i];
  }
  return out;
}

/**
 * Climatología diaria del período de referencia: para cada mes-día,
 * estadísticos sobre una ventana móvil de ±half días (circular).
 * Devuelve { mean: Map(md→x), sorted: Map(md→array ordenado) }.
 */
function climDaily(values, refA, refB, half, cal) {
  const c = cal || state.station;
  const buckets = new Map(MD_SEQ_365.map((m) => [m, []]));
  for (let i = 0; i < values.length; i++) {
    const y = c.years[i];
    if (y < refA || y > refB) continue;
    const v = values[i];
    if (v === null || c.md[i] === 229) continue;
    buckets.get(c.md[i]).push(v);
  }
  const meanMap = new Map(), sortedMap = new Map();
  for (let p = 0; p < 365; p++) {
    const pool = [];
    for (let k = -half; k <= half; k++) {
      pool.push(...buckets.get(MD_SEQ_365[(p + k + 365) % 365]));
    }
    if (pool.length) {
      pool.sort((a, b) => a - b);
      sortedMap.set(MD_SEQ_365[p], pool);
      meanMap.set(MD_SEQ_365[p], mean(pool));
    }
  }
  return { mean: meanMap, sorted: sortedMap };
}

// ==========================================================
// Catálogo, búsqueda reutilizable y mapa
// ==========================================================

async function loadIndex() {
  const res = await fetch(`${DATA_URL}/index.json`);
  state.index = await res.json();
}

function normalize(s) {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/** Buscador con teclado sobre el catálogo; onPick(id) al elegir. */
function makeSearch(inputEl, listEl, onPick) {
  let selIdx = -1;
  function render(matches) {
    listEl.innerHTML = "";
    selIdx = -1;
    if (!matches.length) { listEl.hidden = true; return; }
    for (const st of matches) {
      const li = document.createElement("li");
      li.innerHTML =
        `<span class="r-name">${st.name}</span>` +
        `<span class="r-meta">${st.province} · ${st.start.slice(0, 4)}–${st.end.slice(0, 4)}` +
        `${st.altitude !== null ? ` · ${st.altitude} m` : ""} · ${st.id}</span>`;
      li.addEventListener("mousedown", () => { listEl.hidden = true; inputEl.value = ""; onPick(st.id); });
      listEl.appendChild(li);
    }
    listEl.hidden = false;
  }
  inputEl.addEventListener("input", () => {
    const q = normalize(inputEl.value);
    if (q.length < 2) { listEl.hidden = true; return; }
    // primero los nombres que empiezan por la búsqueda; luego, las series más largas
    const score = (st) => {
      const n = normalize(st.name);
      return (st.id.toLowerCase() === q ? 0 : n.startsWith(q) ? 1 : n.includes(q) ? 2 : 3) * 1e6 - st.n_days;
    };
    render(state.index.stations.filter((st) =>
      normalize(st.name).includes(q) ||
      normalize(st.province).includes(q) ||
      st.id.toLowerCase().startsWith(q)).sort((a, b) => score(a) - score(b)).slice(0, 12));
  });
  inputEl.addEventListener("keydown", (e) => {
    const items = [...listEl.children];
    if (!items.length) return;
    if (e.key === "ArrowDown") selIdx = Math.min(selIdx + 1, items.length - 1);
    else if (e.key === "ArrowUp") selIdx = Math.max(selIdx - 1, 0);
    else if (e.key === "Enter" && selIdx >= 0) {
      items[selIdx].dispatchEvent(new Event("mousedown")); return;
    } else return;
    e.preventDefault();
    items.forEach((li, i) => li.classList.toggle("sel", i === selIdx));
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search-box")) listEl.hidden = true;
  });
}

// ==========================================================
// Selección de estación, placa y efemérides
// ==========================================================

async function loadRecent() {
  if (state.recentTried) return;
  state.recentTried = true;
  try {
    const r = await fetch(`${DATA_URL}/recent.json`);
    if (r.ok) state.recent = await r.json();
  } catch { /* sin recent: la web funciona con el histórico */ }
}

/** Fusiona la ventana reciente sobre el JSON histórico (recent manda). */
function mergeRecent(json) {
  const R = state.recent;
  if (!R || !R.stations[json.id]) return json;
  const rec = R.stations[json.id];
  const stStart = Date.parse(json.start + "T00:00:00Z");
  const stEnd = Date.parse(json.end + "T00:00:00Z");
  const rStart = Date.parse(R.start + "T00:00:00Z");
  const rEnd = Date.parse(R.end + "T00:00:00Z");
  const newEnd = Math.max(stEnd, rEnd);
  const extra = Math.round((newEnd - stEnd) / MS_DAY);
  if (extra > 0) {
    for (const v of json.vars) json.data[v].push(...new Array(extra).fill(null));
    json.end = new Date(newEnd).toISOString().slice(0, 10);
  }
  const nR = Math.round((rEnd - rStart) / MS_DAY) + 1;
  for (let k = 0; k < nR; k++) {
    const idx = Math.round((rStart - stStart) / MS_DAY) + k;
    if (idx < 0) continue;
    for (const v of json.vars) {
      const val = rec[v] ? rec[v][k] : null;
      if (val !== null && val !== undefined) json.data[v][idx] = val;
    }
  }
  return json;
}

async function loadStation(id) {
  await loadRecent();
  const res = await fetch(`${DATA_URL}/stations/${id}.json`);
  return makeCalendar(mergeRecent(await res.json()));
}

// ---------- carga y navegación ----------

function showLoader(txt) { $("loader-txt").textContent = txt; $("loader").hidden = false; }
function hideLoader() { $("loader").hidden = true; }

function currentTab() {
  const p = document.querySelector(".panel:not([hidden])");
  if (p) return p.id.replace("panel-", "");
  const a = document.querySelector(".tab.active");
  return a ? a.dataset.tab : "anio";
}

/** Muestra la vista de análisis; con o sin ficha de estación. */
function showApp() {
  $("welcome").hidden = true;
  $("app").hidden = false;
  $("top-search").hidden = false;
  $("station-plate").hidden = !state.station;
  document.querySelectorAll(".tab").forEach((b) => {
    b.disabled = !state.station && b.dataset.tab !== "nacional";
    b.title = b.disabled ? "Elige antes una estación" : "";
  });
}

function updateHash() {
  const id = state.station ? state.station.json.id : "espana";
  const h = `#${encodeURIComponent(id)}/${currentTab()}`;
  if (location.hash !== h) history.replaceState(null, "", h);
}

async function selectStation(id, tab) {
  const meta = state.index.stations.find((s) => s.id === id);
  if (!meta) return;
  showLoader(`Cargando ${meta.name}…`);
  try {
    state.station = await loadStation(id);
  } catch {
    hideLoader();
    alert(`No se pudo cargar la estación ${id}.`);
    return;
  }
  hideLoader();
  showApp();
  renderPlate();
  renderEphemeris();
  populateYearSelects();
  activateTab(tab && $(`panel-${tab}`) ? tab : currentTab());
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function goNational() {
  showApp();
  activateTab("nacional");
}

function routeFromHash() {
  const m = /^#\/?([^/]+)(?:\/([a-z]+))?/.exec(location.hash);
  if (!m) return false;
  const id = decodeURIComponent(m[1]);
  if (id === "espana") { goNational(); return true; }
  if (!state.index.stations.some((s) => s.id === id)) return false;
  selectStation(id, m[2]);
  return true;
}

// ---------- ficha de estación ----------

function renderPlate() {
  const st = state.station.json;
  const y0 = st.start.slice(0, 4), y1 = st.end.slice(0, 4);
  $("plate-province").textContent = st.province;
  $("plate-name").textContent = st.name;
  $("plate-id").textContent = `Indicativo ${st.id}`;
  $("plate-alt").textContent = st.altitude !== null ? `${st.altitude} m de altitud` : "altitud desconocida";
  $("plate-alt").hidden = false;
  $("plate-period").textContent = `${y0} – ${y1} · ${y1 - y0 + 1} años`;
  document.title = `${st.name} · Explorador climático AEMET`;

  const wrap = $("coverage-strips");
  wrap.innerHTML = "";
  const yearKeys = Object.keys(st.coverage).sort();
  for (const v of ["tmax", "tmed", "tmin", "prec"]) {
    const row = document.createElement("div");
    row.className = "coverage-row";
    const label = document.createElement("span");
    label.textContent = VAR_LABELS[v] === "Precipitación" ? "Prec" : VAR_LABELS[v];
    const canvas = document.createElement("canvas");
    canvas.className = "coverage-strip";
    canvas.width = yearKeys.length; canvas.height = 1;
    const ctx = canvas.getContext("2d");
    let tv = 0, td = 0;
    yearKeys.forEach((yr, i) => {
      const valid = st.coverage[yr][v] ?? 0;
      const diy = (+yr % 4 === 0 && (+yr % 100 !== 0 || +yr % 400 === 0)) ? 366 : 365;
      tv += valid; td += diy;
      const frac = Math.min(1, valid / diy);
      ctx.fillStyle = frac === 0 ? TH.card2 : hexToRgba(TH.accent, 0.15 + 0.85 * frac);
      ctx.fillRect(i, 0, 1, 1);
    });
    const pct = document.createElement("span");
    pct.className = "coverage-pct";
    pct.textContent = `${Math.round((100 * tv) / td)}%`;
    row.append(label, canvas, pct);
    wrap.appendChild(row);
  }
}

// ---------- récords: hoy / este mes / siempre ----------

const nf1 = (x) => x.toFixed(1).replace(".", ",").replace("-", "−");

/** Un solo pase por la serie: extremos del día de hoy, del mes en curso y absolutos. */
function computeRecords(S) {
  const D = S.json.data;
  const now = new Date();
  const cm = now.getMonth() + 1;
  const todayMd = cm * 100 + now.getDate();
  const mk = () => ({ txM: null, txm: null, tnM: null, tnm: null, pM: null, gM: null });
  const day = mk(), mon = mk(), abs = mk();
  const upd = (slot, val, hi, i) => {
    if (val === null || val === undefined) return slot;
    if (!slot || (hi ? val > slot.v : val < slot.v)) return { v: val, i };
    return slot;
  };
  const feed = (R, i) => {
    R.txM = upd(R.txM, D.tmax[i], true, i);
    R.txm = upd(R.txm, D.tmax[i], false, i);
    R.tnM = upd(R.tnM, D.tmin[i], true, i);
    R.tnm = upd(R.tnm, D.tmin[i], false, i);
    if (D.prec) R.pM = upd(R.pM, D.prec[i], true, i);
    if (D.racha) R.gM = upd(R.gM, D.racha[i], true, i);
  };
  const yearTot = new Map(), monthTot = new Map();
  for (let i = 0; i < D.tmax.length; i++) {
    const md = S.md[i], mo = Math.floor(md / 100);
    feed(abs, i);
    if (mo === cm) feed(mon, i);
    if (md === todayMd) feed(day, i);
    const p = D.prec ? D.prec[i] : null;
    if (p !== null) {
      const yy = S.years[i];
      const ty = yearTot.get(yy) || { sum: 0, n: 0 };
      ty.sum += p; ty.n++; yearTot.set(yy, ty);
      if (mo === cm) {
        const tm = monthTot.get(yy) || { sum: 0, n: 0 };
        tm.sum += p; tm.n++; monthTot.set(yy, tm);
      }
    }
  }
  const DIM = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const leap = (y) => (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 1 : 0;
  function extTotal(map, needDays, hi) {
    let best = null;
    for (const [y, t] of map) {
      if (t.n < 0.9 * needDays(y)) continue;   // meses/años incompletos fuera
      if (!best || (hi ? t.sum > best.sum : t.sum < best.sum)) best = { yr: y, sum: t.sum };
    }
    return best;
  }
  const dInM = (y) => DIM[cm] + (cm === 2 ? leap(y) : 0);
  const dInY = (y) => 365 + leap(y);
  return {
    todayMd, cm, day, mon, abs,
    wetMonth: extTotal(monthTot, dInM, true), dryMonth: extTotal(monthTot, dInM, false),
    wetYear: extTotal(yearTot, dInY, true), dryYear: extTotal(yearTot, dInY, false),
  };
}

function renderEphemeris() {
  const S = state.station;
  if (!S) return;
  const scope = state.recScope || "dia";
  const R = computeRecords(S);
  const y0 = S.yearList[0];

  const niceDate = (i) => {
    const md = S.md[i];
    return `${md % 100} ${MESES[Math.floor(md / 100)]} ${S.years[i]}`;
  };
  const when = scope === "dia" ? (r) => `en ${S.years[r.i]}` : (r) => niceDate(r.i);
  const set = { dia: R.day, mes: R.mon, abs: R.abs }[scope];

  $("rec-title").innerHTML = {
    dia: `Récords de un ${R.todayMd % 100} de ${MESES_LARGO[R.cm]}`,
    mes: `Récords de ${MESES_LARGO[R.cm]}`,
    abs: "Récords absolutos",
  }[scope] + ` <span>· desde ${y0}</span>`;

  const tiles = [];
  const tile = (cls, label, val, unit, date) =>
    tiles.push(`<div class="rec-tile ${cls}"><div class="rl">${label}</div>` +
      `<div class="rv">${val}<small>${unit}</small></div><div class="rd">${date}</div></div>`);
  if (set.txM) tile("t-tmax", "Máxima más alta", nf1(set.txM.v), "°C", when(set.txM));
  if (set.txm) tile("t-tmax", "Máxima más baja", nf1(set.txm.v), "°C", when(set.txm));
  if (set.tnM) tile("t-tmin", "Mínima más alta", nf1(set.tnM.v), "°C", when(set.tnM));
  if (set.tnm) tile("t-tmin", "Mínima más baja", nf1(set.tnm.v), "°C", when(set.tnm));
  if (set.pM && set.pM.v > 0) tile("t-prec", "Más lluvia en un día", nf1(set.pM.v), " mm", when(set.pM));
  if (set.gM && set.gM.v > 0) tile("t-wind", "Racha más fuerte", Math.round(set.gM.v * 3.6), " km/h", `${nf1(set.gM.v)} m/s · ${when(set.gM)}`);
  if (scope === "mes") {
    if (R.wetMonth) tile("t-prec", `${cap(MESES_LARGO[R.cm])} más lluvioso`, nf1(R.wetMonth.sum), " mm", `en ${R.wetMonth.yr}`);
    if (R.dryMonth) tile("t-prec", `${cap(MESES_LARGO[R.cm])} más seco`, nf1(R.dryMonth.sum), " mm", `en ${R.dryMonth.yr}`);
  } else if (scope === "abs") {
    if (R.wetYear) tile("t-prec", "Año más lluvioso", R.wetYear.sum.toFixed(0), " mm", `en ${R.wetYear.yr}`);
    if (R.dryYear) tile("t-prec", "Año más seco", R.dryYear.sum.toFixed(0), " mm", `en ${R.dryYear.yr}`);
  }
  $("ephemeris").innerHTML = tiles.length ? tiles.join("")
    : `<p class="rec-empty">Sin datos para esta fecha.</p>`;

  // último dato de Tmax situado en el percentil de la referencia (md ±3)
  const [refA, refB] = getRef();
  const tmax = S.json.data.tmax;
  let lastIdx = -1;
  for (let i = tmax.length - 1; i >= 0; i--) if (tmax[i] !== null) { lastIdx = i; break; }
  const box = $("last-obs");
  box.hidden = true;
  if (lastIdx >= 0 && S.md[lastIdx] !== 229) {
    const clim = climDaily(tmax, refA, refB, 3);
    const pool = clim.sorted.get(S.md[lastIdx]);
    if (pool && pool.length > 20) {
      let rank = 0;
      for (const x of pool) if (x <= tmax[lastIdx]) rank++;
      const pct = Math.round((100 * rank) / pool.length);
      const verdict = pct >= 95 ? "excepcionalmente cálida 🔥" : pct >= 80 ? "más cálida de lo normal"
        : pct <= 5 ? "excepcionalmente fría 🥶" : pct <= 20 ? "más fresca de lo normal" : "dentro de lo normal";
      box.innerHTML = `Último dato (${niceDate(lastIdx)}): máxima de <b>${nf1(tmax[lastIdx])} °C</b>, ` +
        `${verdict} — percentil ${pct} de ${refA}–${refB} para esas fechas.`;
      box.hidden = false;
    }
  }
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

function populateYearSelects() {
  const years = [...state.station.yearList].reverse();
  for (const selId of ["co-year", "an-year", "ca-year"]) {
    const sel = $(selId);
    sel.innerHTML = "";
    for (const y of years) {
      const opt = document.createElement("option");
      opt.value = y; opt.textContent = y;
      sel.appendChild(opt);
    }
  }
}

// ==========================================================
// Pestañas
// ==========================================================

const TAB_RUNNERS = {};

function setupTabs() {
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      activateTab(btn.dataset.tab);
      if (window.matchMedia("(max-width: 860px)").matches) {
        btn.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
      }
    });
  });
}

function safeRun(fn) {
  try { fn(); } catch (e) { console.error(e); }
}

/** Limpia gráficos y nota del panel (para no dejar restos de otra estación) y lo calcula. */
function runPanel(name) {
  const panel = $(`panel-${name}`);
  panel.querySelectorAll(".plot").forEach((d) => { if (d.data) Plotly.purge(d); });
  const note = panel.querySelector(".note");
  if (note) note.textContent = "";
  if (TAB_RUNNERS[name]) safeRun(TAB_RUNNERS[name]);
}

function activateTab(name) {
  if (!state.station && name !== "nacional") return;
  stopNatPlay();
  const navName = name === "distribucion" ? "periodos" : name;
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === navName));
  document.querySelectorAll(".panel").forEach((p) => { p.hidden = true; });
  $(`panel-${name}`).hidden = false;
  updateHash();
  runPanel(name);
}

// ==========================================================
// PRODUCTO: Año en curso vs climatología
// ==========================================================

function runAnio() {
  const S = state.station;
  const v = $("an-var").value;
  const year = +$("an-year").value;
  const isPrec = v === "prec";
  $("an-hydro-wrap").hidden = !isPrec;
  const hydro = isPrec && $("an-hydro").checked;
  const startMd = hydro ? 1001 : 101;
  const [refA, refB] = getRef();
  const M = yearMatrix(S.json.data[v], startMd);

  // eje x con año ficticio para etiquetas de mes
  const x = [];
  {
    const d = new Date(Date.UTC(2001, Math.floor(startMd / 100) - 1, startMd % 100));
    for (let p = 0; p < 365; p++) { x.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  }
  const ht = "%{x|%-d %b}: %{y:.1f}";
  let traces, note = "";

  if (isPrec) {
    // ---- precipitación: trayectorias acumuladas ----
    function cumTraj(row) {
      const out = new Array(365).fill(null);
      let lastValid = -1;
      for (let p = 364; p >= 0; p--) if (row[p] !== null) { lastValid = p; break; }
      let sum = 0, n = 0;
      for (let p = 0; p <= lastValid; p++) {
        if (row[p] !== null) { sum += row[p]; n++; }
        if (!n || n < 0.8 * (p + 1)) continue;
        out[p] = sum;
      }
      return out;
    }
    const refTraj = [];
    for (let y = refA; y <= refB; y++) if (M.has(y)) refTraj.push(cumTraj(M.get(y)));
    if (refTraj.length < 10) note = `Solo ${refTraj.length} años de ${refA}–${refB} con datos: sobre poco fiable. `;
    const p05 = [], p50 = [], p95 = [];
    for (let p = 0; p < 365; p++) {
      const col = refTraj.map((t) => t[p]).filter((z) => z !== null).sort((a, b) => a - b);
      p05.push(col.length ? quantile(col, 0.05) : null);
      p50.push(col.length ? quantile(col, 0.50) : null);
      p95.push(col.length ? quantile(col, 0.95) : null);
    }
    let recMax = null, recMin = null;
    for (const [y, row] of M) {
      const t = cumTraj(row);
      let last = null;
      for (let p = 364; p > 300; p--) if (t[p] !== null) { last = t[p]; break; }
      if (last === null) continue;
      if (!recMax || last > recMax.v) recMax = { y, v: last, t };
      if (!recMin || last < recMin.v) recMin = { y, v: last, t };
    }
    const sel = M.has(year) ? cumTraj(M.get(year)) : null;
    traces = [
      { x, y: p95, mode: "lines", line: { width: 0 }, hoverinfo: "skip", showlegend: false },
      { x, y: p05, mode: "lines", line: { width: 0 }, fill: "tonexty",
        fillcolor: TH.band, name: `P5–P95 ${refA}–${refB}`, hoverinfo: "skip" },
      { x, y: p50, mode: "lines", name: `mediana ${refA}–${refB}`,
        line: { color: TH.muted, width: 1.5, dash: "dash" }, hovertemplate: ht + "<extra>mediana</extra>" },
    ];
    if (recMax && recMax.y !== year) traces.push({ x, y: recMax.t, mode: "lines",
      name: `récord húmedo (${recMax.y})`, line: { color: VAR_COLORS.tmin, width: 1 },
      opacity: 0.6, hovertemplate: ht + `<extra>${recMax.y}</extra>` });
    if (recMin && recMin.y !== year) traces.push({ x, y: recMin.t, mode: "lines",
      name: `récord seco (${recMin.y})`, line: { color: VAR_COLORS.tmax, width: 1 },
      opacity: 0.6, hovertemplate: ht + `<extra>${recMin.y}</extra>` });
    if (sel) traces.push({ x, y: sel, mode: "lines", name: String(year),
      line: { color: ACCENT, width: 3 }, hovertemplate: ht + `<extra>${year}</extra>` });
    if (!sel) note += `El año no tiene datos suficientes de precipitación.`;
  } else {
    // ---- temperatura: valores diarios sobre climatología ±7 días ----
    const clim = climDaily(S.json.data[v], refA, refB, 7);
    const p05 = [], p50 = [], p95 = [];
    for (let p = 0; p < 365; p++) {
      const pool = clim.sorted.get(MD_SEQ_365[p]);
      p05.push(pool ? quantile(pool, 0.05) : null);
      p50.push(pool ? quantile(pool, 0.50) : null);
      p95.push(pool ? quantile(pool, 0.95) : null);
    }
    if (![...clim.sorted.values()].length) note = "Sin datos en el período de referencia. ";
    // récords diarios absolutos de toda la serie (mes-día exacto)
    // récords diarios SOLO de los años anteriores al seleccionado
    const rMax = new Array(365).fill(null), rMin = new Array(365).fill(null);
    let nPrev = 0;
    for (const [gy, row] of M) {
      if (gy >= year) continue;
      nPrev++;
      for (let p = 0; p < 365; p++) {
        if (row[p] === null) continue;
        if (rMax[p] === null || row[p] > rMax[p]) rMax[p] = row[p];
        if (rMin[p] === null || row[p] < rMin[p]) rMin[p] = row[p];
      }
    }
    if (nPrev < 10) note += `Solo ${nPrev} años anteriores a ${year}: récords previos poco significativos. `;
    const sel = M.has(year) ? M.get(year) : null;
    traces = [
      { x, y: rMax, mode: "lines", name: `récord previo alto (pre-${year})`,
        line: { color: VAR_COLORS.tmax, width: 1, dash: "dot" }, opacity: 0.55,
        hovertemplate: ht + "<extra>récord alto</extra>" },
      { x, y: rMin, mode: "lines", name: `récord previo bajo (pre-${year})`,
        line: { color: VAR_COLORS.tmin, width: 1, dash: "dot" }, opacity: 0.55,
        hovertemplate: ht + "<extra>récord bajo</extra>" },
      { x, y: p95, mode: "lines", line: { width: 0 }, hoverinfo: "skip", showlegend: false },
      { x, y: p05, mode: "lines", line: { width: 0 }, fill: "tonexty",
        fillcolor: TH.band, name: `P5–P95 ${refA}–${refB}`, hoverinfo: "skip" },
      { x, y: p50, mode: "lines", name: `mediana ${refA}–${refB}`,
        line: { color: TH.muted, width: 1.5, dash: "dash" }, hovertemplate: ht + "<extra>mediana</extra>" },
    ];
    if (sel) traces.push({ x, y: sel, mode: "lines", name: String(year),
      line: { color: ACCENT, width: 1.8 }, connectgaps: false,
      hovertemplate: ht + `<extra>${year}</extra>` });
    else note += `El año ${year} no tiene datos de ${VAR_LABELS[v]}.`;
  }

  const yearTxt = hydro ? `${year - 1}–${String(year).slice(2)}` : String(year);
  const layout = baseLayout(`${S.json.name} · ${VAR_LABELS[v]} ${isPrec ? "acumulada" : "diaria"} · ${yearTxt}` +
    (isPrec ? "" : ` · banda ${refA}–${refB} (±7 días)`));
  layout.xaxis.tickformat = "%b";
  layout.xaxis.dtick = "M1";
  layout.yaxis.title = { text: VAR_UNITS[v] };
  layout.legend = { orientation: "h", y: -0.12 };
  Plotly.newPlot("plot-anio", traces, layout, PLOTLY_CFG);
  $("an-note").textContent = note;
}

// ==========================================================
// PRODUCTO: Evolución anual
// ==========================================================

function runEvolution() {
  const S = state.station;
  const mdS = parseMd($("ev-md-start").value);
  const mdE = parseMd($("ev-md-end").value);
  if (mdS === null || mdE === null) {
    $("ev-note").textContent = "Ventana no válida: usa formato MM-DD."; return;
  }
  const minCov = +$("ev-cov").value / 100;
  const vars = ["tmax", "tmed", "tmin", "dtr"].filter((v) => $(`ev-${v}`).checked);
  if (!vars.length) { $("ev-note").textContent = "Selecciona al menos una variable."; return; }

  const traces = [];
  let excluded = 0;
  for (const v of vars) {
    const groups = aggregateWindow(S.json.data[v], mdS, mdE);
    const xs = [], ys = [];
    for (const [yr, g] of [...groups].sort((a, b) => a[0] - b[0])) {
      if (!g.nTotal) continue;
      if (g.n / g.nTotal < minCov) { excluded++; continue; }
      xs.push(yr); ys.push(g.sum / g.n);
    }
    traces.push({
      x: xs, y: ys, name: VAR_LABELS[v], mode: "markers",
      marker: { color: VAR_COLORS[v], size: 5, opacity: 0.55 },
      hovertemplate: "%{x}: %{y:.2f} °C<extra>" + VAR_LABELS[v] + "</extra>",
    });
    if ($("ev-smooth").checked && xs.length > 10) {
      const sy = xs.map((_, i) => {
        const lo = Math.max(0, i - 5), hi = Math.min(xs.length, i + 5);
        let s = 0; for (let j = lo; j < hi; j++) s += ys[j];
        return s / (hi - lo);
      });
      traces.push({ x: xs, y: sy, mode: "lines", line: { color: VAR_COLORS[v], width: 2.5 },
                    hoverinfo: "skip", showlegend: false });
    }
  }
  const layout = baseLayout(`${S.json.name} · media ${mdLabel(mdS)} → ${mdLabel(mdE)}`);
  layout.yaxis.title = { text: "°C" };
  layout.legend = { orientation: "h", y: -0.12 };
  Plotly.newPlot("plot-evolucion", traces, layout, PLOTLY_CFG);

  // ---- anomalías vs referencia global ----
  const [refA, refB] = getRef();
  const anomTraces = [];
  const refNote = [];
  let shortRef = false;
  for (const v of vars) {
    const groups = aggregateWindow(S.json.data[v], mdS, mdE);
    const valid = new Map();
    for (const [yr, g] of groups) {
      if (g.nTotal && g.n / g.nTotal >= minCov) valid.set(yr, g.sum / g.n);
    }
    const refVals = [...valid].filter(([y]) => y >= refA && y <= refB).map(([, m]) => m);
    if (refVals.length < 10) { shortRef = true; continue; }
    const base = mean(refVals);
    refNote.push(`${VAR_LABELS[v]} ${base.toFixed(2)} °C`);
    const yrs = [...valid.keys()].sort((a, b) => a - b);
    const an = yrs.map((y) => valid.get(y) - base);
    if (vars.length === 1) {
      const amax = Math.max(...an.map(Math.abs));
      anomTraces.push({ x: yrs, y: an, type: "bar",
        marker: { color: an, colorscale: "RdBu", reversescale: false, cmin: -amax, cmax: amax },
        hovertemplate: "%{x}: %{y:+.2f} °C<extra></extra>", name: VAR_LABELS[v] });
    } else {
      anomTraces.push({ x: yrs, y: an, mode: "lines+markers", name: VAR_LABELS[v],
        line: { color: VAR_COLORS[v], width: 1.2 }, marker: { size: 4 },
        hovertemplate: "%{x}: %{y:+.2f} °C<extra>" + VAR_LABELS[v] + "</extra>" });
    }
  }
  const l2 = baseLayout("");
  l2.margin.t = 10;
  l2.yaxis.title = { text: `anomalía (°C) vs ${refA}–${refB}` };
  l2.legend = { orientation: "h", y: -0.18 };
  l2.showlegend = vars.length > 1;
  l2.shapes = [{ type: "line", xref: "paper", x0: 0, x1: 1, y0: 0, y1: 0,
    line: { color: TH.muted, width: 1 } }];
  Plotly.newPlot("plot-evolucion-anom", anomTraces, l2, PLOTLY_CFG);

  $("ev-note").textContent =
    (excluded ? `${excluded} año-variable excluidos por cobertura < ${Math.round(minCov * 100)}%. ` : "") +
    (refNote.length ? `Media de referencia ${refA}–${refB}: ${refNote.join(" · ")}. ` : "") +
    (shortRef ? "Alguna variable no tiene años suficientes en la referencia para calcular anomalías." : "");
}

// ==========================================================
// PRODUCTO: Stripes
// ==========================================================

function runStripes() {
  const S = state.station;
  const v = $("st-var").value;
  const isPrec = v === "prec";
  const u = VAR_UNITS[v];
  const mdS = parseMd($("st-md-start").value);
  const mdE = parseMd($("st-md-end").value);
  if (mdS === null || mdE === null) { $("st-note").textContent = "Ventana no válida."; return; }
  const minCov = +$("st-cov").value / 100;
  const [refA, refB] = getRef();

  const groups = aggregateWindow(S.json.data[v], mdS, mdE);
  const vals = new Map();
  for (const [yr, g] of groups) {
    if (g.nTotal && g.n / g.nTotal >= minCov) vals.set(yr, isPrec ? g.sum : g.sum / g.n);
  }
  const refVals = [...vals].filter(([y]) => y >= refA && y <= refB).map(([, m]) => m);
  if (refVals.length < 10) {
    $("st-note").textContent =
      `Solo ${refVals.length} años válidos en ${refA}–${refB}: la referencia no es fiable.`;
    return;
  }
  const refMean = mean(refVals);
  if (isPrec && refMean <= 0) {
    $("st-note").textContent = "Precipitación de referencia nula: no se puede normalizar.";
    return;
  }

  const yrs = [...vals.keys()].sort((a, b) => a - b);
  const y0 = yrs[0], y1 = yrs[yrs.length - 1];
  const center = isPrec ? 100 : 0;
  const cscale = isPrec ? [[0,"#8c510a"],[0.25,"#d8b365"],[0.5,"#f6e8c3"],[0.75,"#5ab4ac"],[1,"#01665e"]]
    : v === "sol" ? [[0,"#3b4a7a"],[0.5,"#f1f1ee"],[1,"#f59f00"]] : "RdBu";
  const allYears = [], anoms = [];
  for (let y = y0; y <= y1; y++) {
    allYears.push(y);
    anoms.push(vals.has(y)
      ? (isPrec ? (100 * vals.get(y)) / refMean : vals.get(y) - refMean)
      : null);
  }
  const amax = Math.max(...anoms.filter((a) => a !== null).map((a) => Math.abs(a - center))) || 1;

  // ---- banda de stripes ----
  const l1 = baseLayout(`${S.json.name} · ${VAR_LABELS[v]} ${mdLabel(mdS)} → ${mdLabel(mdE)} · ` +
    (isPrec ? `% de la normal ${refA}–${refB}` : `anomalía vs ${refA}–${refB}`));
  l1.margin = { l: 30, r: 20, t: 40, b: 30 };
  l1.yaxis = { visible: false };
  Plotly.newPlot("plot-stripes", [{
    x: allYears, y: [""], z: [anoms], type: "heatmap",
    colorscale: cscale, reversescale: false,
    zmin: center - amax, zmax: center + amax, showscale: false,
    hovertemplate: isPrec ? "%{x}: %{z:.0f}% de la normal<extra></extra>"
                          : `%{x}: %{z:+.2f} ${u}<extra></extra>`,
  }], l1, PLOTLY_CFG);

  // ---- barras de anomalía + tendencia + media móvil ----
  const l2 = baseLayout("");
  l2.margin.t = 10;
  l2.yaxis.title = { text: isPrec ? "% de la normal" : `anomalía (${u})` };
  l2.legend = { orientation: "h", y: -0.18 };
  if (isPrec) l2.shapes = [{ type: "line", xref: "paper", x0: 0, x1: 1, y0: 100, y1: 100,
    line: { color: TH.muted, dash: "dash", width: 1 } }];
  const anomTraces = [{
    x: allYears, y: anoms, type: "bar", name: "anomalía", showlegend: false,
    marker: { color: anoms, colorscale: cscale, reversescale: false,
              cmin: center - amax, cmax: center + amax },
    hovertemplate: isPrec ? "%{x}: %{y:.0f}%<extra></extra>" : `%{x}: %{y:+.2f} ${u}<extra></extra>`,
  }];

  const vx = [], vy = [];
  for (let k = 0; k < allYears.length; k++) if (anoms[k] !== null) { vx.push(allYears[k]); vy.push(anoms[k]); }

  let trendTxt = "";
  if ($("st-trend").checked) {
    const fit = ols(vx, vy);
    if (fit) {
      anomTraces.push({
        x: [vx[0], vx[vx.length - 1]],
        y: [fit.a + fit.b * vx[0], fit.a + fit.b * vx[vx.length - 1]],
        mode: "lines", name: "tendencia",
        line: { color: TH.fg, width: 2, dash: "dot" }, hoverinfo: "skip",
      });
      trendTxt = ` Tendencia: ${(fit.b * 10 >= 0 ? "+" : "")}${(fit.b * 10).toFixed(2)} ` +
        `${isPrec ? "puntos%" : u}/década (OLS, orientativa).`;
    }
  }

  let maTxt = "";
  if ($("st-ma").checked) {
    const win = Math.max(2, Math.min(50, +$("st-ma-win").value || 10));
    const mx = [], my = [];
    for (let k = 0; k < vx.length; k++) {
      const lo = Math.max(0, k - Math.floor(win / 2));
      const hi = Math.min(vx.length, k + Math.ceil(win / 2));
      let s = 0; for (let t = lo; t < hi; t++) s += vy[t];
      mx.push(vx[k]); my.push(s / (hi - lo));
    }
    anomTraces.push({
      x: mx, y: my, mode: "lines", name: `media móvil ${win}a`,
      line: { color: VAR_COLORS.tmed, width: 2.5 },
      hovertemplate: isPrec ? "%{x}: %{y:.0f}%<extra>móvil " + win + "a</extra>"
                            : `%{x}: %{y:+.2f} ${u}<extra>móvil ${win}a</extra>`,
    });
    maTxt = ` Media móvil de ${win} años.`;
  }

  l2.showlegend = anomTraces.length > 1;
  Plotly.newPlot("plot-stripes-anom", anomTraces, l2, PLOTLY_CFG);

  $("st-note").textContent =
    (isPrec
      ? `Normal ${refA}–${refB}: ${refMean.toFixed(0)} mm en la ventana (100% = normal). `
      : `Media de referencia ${refA}–${refB}: ${refMean.toFixed(2)} ${u}${v === "sol" ? " al día" : ""}. `) +
    `Años en blanco: sin cobertura suficiente.` + trendTxt + maTxt;
}
// ==========================================================
// PRODUCTO: Índices climáticos
// ==========================================================

const INDICES = {
  noches_trop: { label: "Noches tropicales (Tmin ≥ 20 °C) — días/año", v: "tmin", type: "count", test: (x) => x >= 20 },
  noches_torr: { label: "Noches tórridas (Tmin ≥ 25 °C) — días/año", v: "tmin", type: "count", test: (x) => x >= 25 },
  dias_verano: { label: "Días de verano (Tmax ≥ 25 °C) — días/año", v: "tmax", type: "count", test: (x) => x >= 25 },
  dias_calor: { label: "Días cálidos (Tmax ≥ 35 °C) — días/año", v: "tmax", type: "count", test: (x) => x >= 35 },
  dias_helada: { label: "Días de helada (Tmin < 0 °C) — días/año", v: "tmin", type: "count", test: (x) => x < 0 },
  primer_30: { label: "Primer día del año con Tmax ≥ 30 °C — fecha", v: "tmax", type: "first", test: (x) => x >= 30 },
  primer_35: { label: "Primer día del año con Tmax ≥ 35 °C — fecha", v: "tmax", type: "first", test: (x) => x >= 35 },
  primer_40: { label: "Primer día del año con Tmax ≥ 40 °C — fecha", v: "tmax", type: "first", test: (x) => x >= 40 },
  ult_helada: { label: "Última helada de primavera (antes del 1 jul) — fecha", v: "tmin", type: "lastBefore", test: (x) => x < 0 },
  pri_helada: { label: "Primera helada de otoño (después del 1 jul) — fecha", v: "tmin", type: "firstAfter", test: (x) => x < 0 },
  dur_verano: { label: "Duración del verano térmico (primer→último Tmax ≥ 30 °C) — días", v: "tmax", type: "duration", test: (x) => x >= 30 },
};

function populateIndices() {
  const sel = $("ix-index");
  for (const [k, d] of Object.entries(INDICES)) {
    const opt = document.createElement("option");
    opt.value = k; opt.textContent = d.label;
    sel.appendChild(opt);
  }
}

function runIndices() {
  const S = state.station;
  const def = INDICES[$("ix-index").value];
  const minCov = +$("ix-cov").value / 100;
  const M = yearMatrix(S.json.data[def.v]);
  const posJul1 = MD_IDX_365.get(701);

  const xs = [], ys = [];
  let neverCount = 0;
  for (const [yr, row] of [...M].sort((a, b) => a[0] - b[0])) {
    const valid = row.filter((x) => x !== null).length;
    if (valid < minCov * 365) continue;
    let val = null;
    if (def.type === "count") {
      val = row.reduce((s, x) => s + (x !== null && def.test(x) ? 1 : 0), 0);
    } else {
      let first = null, last = null;
      for (let p = 0; p < 365; p++) {
        if (row[p] === null || !def.test(row[p])) continue;
        if (first === null) first = p;
        last = p;
      }
      if (def.type === "first") val = first;
      else if (def.type === "lastBefore") {
        val = null;
        for (let p = 0; p < posJul1; p++) if (row[p] !== null && def.test(row[p])) val = p;
      } else if (def.type === "firstAfter") {
        val = null;
        for (let p = posJul1; p < 365; p++) if (row[p] !== null && def.test(row[p])) { val = p; break; }
      } else if (def.type === "duration") {
        val = first !== null ? last - first + 1 : 0;
      }
      if (val === null && def.type !== "duration") { neverCount++; continue; }
    }
    xs.push(yr); ys.push(val);
  }

  const isDate = ["first", "lastBefore", "firstAfter"].includes(def.type);
  const traces = [{
    x: xs, y: ys, mode: def.type === "count" ? undefined : "markers",
    type: def.type === "count" ? "bar" : "scatter",
    marker: def.type === "count"
      ? { color: ys, colorscale: "Plasma" }
      : { color: VAR_COLORS[def.v], size: 6 },
    hovertemplate: isDate ? "%{x}: %{text}<extra></extra>" : "%{x}: %{y}<extra></extra>",
    text: isDate ? ys.map((p) => mdLabel(MD_SEQ_365[p])) : undefined,
  }];

  let slopeTxt = "";
  const fit = ols(xs, ys);
  if (fit) {
    traces.push({
      x: [xs[0], xs[xs.length - 1]],
      y: [fit.a + fit.b * xs[0], fit.a + fit.b * xs[xs.length - 1]],
      mode: "lines", line: { color: TH.fg, width: 1.5, dash: "dot" },
      hoverinfo: "skip", showlegend: false,
    });
    slopeTxt = ` Tendencia lineal: ${(fit.b * 10).toFixed(1)} ${isDate || def.type === "duration" ? "días" : "días"}/década.`;
  }

  const layout = baseLayout(`${S.json.name} · ${def.label}`);
  layout.showlegend = false;
  if (isDate) {
    const ticks = [101, 201, 301, 401, 501, 601, 701, 801, 901, 1001, 1101, 1201];
    layout.yaxis.tickvals = ticks.map((m) => MD_IDX_365.get(m));
    layout.yaxis.ticktext = ticks.map((m) => MESES[Math.floor(m / 100)]);
  } else {
    layout.yaxis.title = { text: "días" };
  }
  Plotly.newPlot("plot-indices", traces, layout, PLOTLY_CFG);

  $("ix-note").textContent =
    `${xs.length} años con cobertura ≥ ${Math.round(minCov * 100)}%.` +
    (neverCount ? ` ${neverCount} años cumplen cobertura pero nunca alcanzan el umbral (no se dibujan).` : "") +
    slopeTxt + " La tendencia OLS es orientativa, sin test de significación.";
}

// ==========================================================
// PRODUCTO: Rachas
// ==========================================================

/** Ventana MM-DD opcional compartida por los dos modos. */
function streakWindow() {
  const S = state.station;
  const mdS = parseMd($("ra-md-start").value);
  const mdE = parseMd($("ra-md-end").value);
  const manual = mdS !== null && mdE !== null;
  if (!manual && ($("ra-md-start").value.trim() || $("ra-md-end").value.trim())) return null;
  const wraps = manual && mdS > mdE;
  return {
    manual, mdS, mdE, wraps,
    inWindow: (i) => {
      if (!manual) return true;
      const m = S.md[i];
      return wraps ? (m >= mdS || m <= mdE) : (m >= mdS && m <= mdE);
    },
    groupYear: (i) => (wraps && S.md[i] >= mdS ? S.years[i] + 1 : S.years[i]),
    label: manual ? `Ventana ${mdLabel(mdS)}–${mdLabel(mdE)} aplicada cada año (las rachas no cruzan de un año al siguiente). ` : "",
  };
}

function setStreakHeader(cols) {
  $("ra-table").querySelector("thead").innerHTML =
    "<tr>" + cols.map((c) => `<th>${c}</th>`).join("") + "</tr>";
}

function runStreaks() {
  const seca = $("ra-modo").value === "seca";
  document.querySelectorAll(".ra-diaria").forEach((e) => { e.hidden = seca; });
  document.querySelectorAll(".ra-seca").forEach((e) => { e.hidden = !seca; });
  if (seca) runDrySpells(); else runStreaksDaily();
}

function runStreaksDaily() {
  const S = state.station;
  const v = $("ra-var").value;
  const op = $("ra-op").value;
  const thr = +$("ra-thr").value;
  $("ra-unit").textContent = VAR_UNITS[v];
  const values = S.json.data[v];
  if (!values) return;
  const test = { ">=": (x) => x >= thr, ">": (x) => x > thr,
                 "<=": (x) => x <= thr, "<": (x) => x < thr }[op];

  const W = streakWindow();
  if (!W) {
    $("ra-note").textContent = "Ventana incompleta o mal formada (MM-DD). Rellena ambos campos o déjalos vacíos.";
    return;
  }

  const streaks = [];
  const perYear = new Map();
  let runStart = -1, runLen = 0;
  for (let i = 0; i <= values.length; i++) {
    const x = i < values.length ? values[i] : null;
    const inWin = i < values.length && W.inWindow(i);
    const ok = inWin && x !== null && test(x);
    if (ok) {
      if (!runLen) runStart = i;
      runLen++;
      // conteo anual dentro de ventana que cruza el año: al año en que termina
      const gy = W.groupYear(i);
      perYear.set(gy, (perYear.get(gy) || 0) + 1);
    } else {
      if (runLen) streaks.push({ start: runStart, len: runLen });
      runLen = 0;
    }
  }
  streaks.sort((a, b) => b.len - a.len || b.start - a.start);

  $("ra-title-left").textContent = "Días por año que cumplen la condición";
  $("ra-title-right").textContent = "Rachas más largas de la serie";
  setStreakHeader(["#", "Días", "Inicio", "Fin"]);
  const tbody = $("ra-table").querySelector("tbody");
  tbody.innerHTML = "";
  streaks.slice(0, 15).forEach((s, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${i + 1}</td><td>${s.len}</td>` +
      `<td>${fmtDate(S.startMs, s.start)}</td>` +
      `<td>${fmtDate(S.startMs, s.start + s.len - 1)}</td>`;
    tbody.appendChild(tr);
  });

  const years = [...perYear.keys()].sort((a, b) => a - b);
  const layout = baseLayout(`${VAR_LABELS[v]} ${op} ${thr} ${VAR_UNITS[v]}`);
  layout.yaxis.title = { text: "días/año" };
  Plotly.newPlot("plot-rachas", [{
    x: years, y: years.map((y) => perYear.get(y)), type: "bar",
    marker: { color: years.map((y) => perYear.get(y)), colorscale: "Plasma" },
    hovertemplate: "%{x}: %{y} días<extra></extra>",
  }], layout, PLOTLY_CFG);

  $("ra-note").textContent = W.label +
    "Los días sin dato cortan las rachas: en años con huecos la racha real pudo ser más larga.";
}

/**
 * Períodos secos por acumulado: tramos consecutivos cuya precipitación TOTAL
 * queda por debajo del umbral. Como la precipitación no es negativa, la suma
 * crece al alargar la ventana y basta un barrido de dos punteros: para cada
 * día final se busca el inicio más temprano que aún cumple.
 * No es el CDD de ETCCDI (que exige cada día < 1 mm); aquí se admiten
 * lloviznas mientras el total del período no alcance el umbral.
 */
function runDrySpells() {
  const S = state.station;
  const thr = +$("ra-seca-thr").value;
  const nullsZero = $("ra-nulls").value === "cero";
  const showAll = $("ra-overlap").value === "todas";
  const values = S.json.data.prec;
  if (!values) {
    $("ra-note").textContent = "Esta estación no tiene serie de precipitación.";
    Plotly.purge("plot-rachas"); return;
  }
  if (!(thr > 0)) { $("ra-note").textContent = "El umbral debe ser mayor que 0 mm."; return; }

  const W = streakWindow();
  if (!W) {
    $("ra-note").textContent = "Ventana incompleta o mal formada (MM-DD). Rellena ambos campos o déjalos vacíos.";
    return;
  }

  // 1) segmentos contiguos utilizables (ventana + tratamiento de nulos)
  const segments = [];
  let seg = null;
  for (let i = 0; i < values.length; i++) {
    const usable = W.inWindow(i) && (values[i] !== null || nullsZero);
    if (usable) { if (!seg) { seg = { i0: i, n: 0 }; segments.push(seg); } seg.n++; }
    else seg = null;
  }

  // 2) dos punteros dentro de cada segmento: máximo tramo con suma < umbral
  const cands = [];
  let nullsIn = 0;
  for (const s of segments) {
    let l = s.i0, sum = 0;
    for (let r = s.i0; r < s.i0 + s.n; r++) {
      sum += values[r] === null ? 0 : values[r];
      while (sum >= thr && l <= r) { sum -= values[l] === null ? 0 : values[l]; l++; }
      if (l <= r) cands.push({ start: l, len: r - l + 1, sum });
    }
  }
  if (!cands.length) {
    $("ra-note").textContent = `Ningún período acumula menos de ${thr} mm con estos ajustes.`;
    Plotly.purge("plot-rachas");
    $("ra-table").querySelector("tbody").innerHTML = "";
    return;
  }

  // 3) máximo por año (sobre los tramos maximales, independiente del listado)
  const perYear = new Map();
  for (const c of cands) {
    const gy = W.groupYear(c.start);
    if (c.len > (perYear.get(gy) || 0)) perYear.set(gy, c.len);
  }

  // 4) listado: solapado o episodios disjuntos por longitud
  const sorted = [...cands].sort((a, b) => b.len - a.len || a.start - b.start);
  let list;
  if (showAll) {
    list = sorted.slice(0, 15);
  } else {
    list = [];
    for (const c of sorted) {
      if (list.length >= 15) break;
      const end = c.start + c.len - 1;
      if (list.some((k) => c.start <= k.start + k.len - 1 && k.start <= end)) continue;
      list.push(c);
    }
  }

  // 5) huecos dentro de los episodios listados (solo informativo)
  if (nullsZero) {
    for (const c of list) {
      for (let i = c.start; i < c.start + c.len; i++) if (values[i] === null) nullsIn++;
    }
  }

  $("ra-title-left").textContent = "Período seco más largo por año (días)";
  $("ra-title-right").textContent = showAll
    ? "Tramos secos más largos (pueden solaparse)"
    : "Episodios secos más largos (sin solapar)";
  setStreakHeader(["#", "Días", "Inicio", "Fin", "mm"]);
  const tbody = $("ra-table").querySelector("tbody");
  tbody.innerHTML = "";
  list.forEach((c, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${i + 1}</td><td>${c.len}</td>` +
      `<td>${fmtDate(S.startMs, c.start)}</td>` +
      `<td>${fmtDate(S.startMs, c.start + c.len - 1)}</td>` +
      `<td>${c.sum.toFixed(1)}</td>`;
    tbody.appendChild(tr);
  });

  const years = [...perYear.keys()].sort((a, b) => a - b);
  const layout = baseLayout(`Períodos secos · total < ${thr} mm acumulados`);
  layout.yaxis.title = { text: "días" };
  Plotly.newPlot("plot-rachas", [{
    x: years, y: years.map((y) => perYear.get(y)), type: "bar",
    marker: { color: years.map((y) => perYear.get(y)),
              colorscale: [[0, "#f6e8c3"], [0.5, "#d8b365"], [1, "#8c510a"]] },
    hovertemplate: "%{x}: %{y} días<extra></extra>",
  }], layout, PLOTLY_CFG);

  $("ra-note").textContent = W.label +
    `Período seco = tramo consecutivo cuya precipitación total suma menos de ${thr} mm. ` +
    `No equivale al CDD de ETCCDI, que exige que cada día quede por debajo del umbral. ` +
    (nullsZero
      ? `Los días sin dato cuentan como 0 mm${nullsIn ? ` (${nullsIn} en los episodios listados)` : ""}: un hueco instrumental puede inflar la duración.`
      : "Los días sin dato cortan el período: en años con huecos la sequía real pudo ser más larga.") +
    (showAll ? " El listado incluye subrachas del mismo episodio." : "");
}

// ==========================================================
// PRODUCTO: Comparador de años
// ==========================================================

function runComparator() {
  const S = state.station;
  const refYear = +$("co-year").value;
  const vx = $("co-x").value, vy = $("co-y").value;
  const minCov = +$("co-cov").value / 100;
  const X = S.json.data[vx], Y = S.json.data[vy];

  // ventana: manual si el usuario rellena MM-DD; si no, la del año de referencia
  const mdManS = parseMd($("co-md-start").value);
  const mdManE = parseMd($("co-md-end").value);
  const manual = mdManS !== null && mdManE !== null;
  let mdMin, mdMax, nRef;
  if (manual) {
    mdMin = mdManS; mdMax = mdManE;
    const g = aggregateWindow(X, mdMin, mdMax);
    const gRef = g.get(refYear);
    const hRef = aggregateWindow(Y, mdMin, mdMax).get(refYear);
    nRef = Math.min(gRef ? gRef.n : 0, hRef ? hRef.n : 0);
    if (!nRef) {
      $("co-note").textContent = `El año ${refYear} no tiene datos en ${mdLabel(mdMin)}–${mdLabel(mdMax)}.`;
      Plotly.purge("plot-comparador"); return;
    }
  } else {
    if ($("co-md-start").value.trim() || $("co-md-end").value.trim()) {
      $("co-note").textContent = "Ventana incompleta o mal formada (MM-DD). Rellena ambos campos o déjalos vacíos.";
      Plotly.purge("plot-comparador"); return;
    }
    mdMin = Infinity; mdMax = -Infinity; nRef = 0;
    for (let i = 0; i < X.length; i++) {
      if (S.years[i] !== refYear || X[i] === null || Y[i] === null) continue;
      nRef++;
      if (S.md[i] < mdMin) mdMin = S.md[i];
      if (S.md[i] > mdMax) mdMax = S.md[i];
    }
    if (!nRef) {
      $("co-note").textContent = `El año ${refYear} no tiene datos válidos de ambas variables.`;
      Plotly.purge("plot-comparador"); return;
    }
  }

  const gx = aggregateWindow(X, mdMin, mdMax);
  const gy = aggregateWindow(Y, mdMin, mdMax);
  const rows = [];
  for (const [yr, g] of gx) {
    const h = gy.get(yr);
    if (!h || g.n < minCov * nRef || h.n < minCov * nRef) continue;
    rows.push({ yr, x: g.sum / g.n, y: h.sum / h.n });
  }
  rows.sort((a, b) => a.yr - b.yr);
  const ref = rows.find((r) => r.yr === refYear);
  const rest = rows.filter((r) => r.yr !== refYear);

  const traces = [{
    x: rest.map((r) => r.x), y: rest.map((r) => r.y),
    mode: "markers", text: rest.map((r) => String(r.yr)),
    marker: { color: rest.map((r) => r.yr), colorscale: "Plasma", size: 10,
              line: { color: TH.card, width: 1 },
              colorbar: { title: "Año", thickness: 14, outlinecolor: TH.grid } },
    hovertemplate: "%{text}<br>" + VAR_LABELS[vx] + ": %{x:.2f} °C<br>" +
                   VAR_LABELS[vy] + ": %{y:.2f} °C<extra></extra>",
  }];
  if (ref) traces.push({
    x: [ref.x], y: [ref.y], mode: "markers+text",
    text: [String(refYear)], textposition: "top right",
    textfont: { color: ACCENT, size: 15, family: FONT },
    marker: { color: ACCENT, size: 16, line: { color: "#fff", width: 1.5 } },
    hovertemplate: refYear + "<br>%{x:.2f} °C · %{y:.2f} °C<extra></extra>",
  });

  const layout = baseLayout(`${S.json.name} · ${mdLabel(mdMin)} → ${mdLabel(mdMax)} de cada año`);
  layout.xaxis.title = { text: `${VAR_LABELS[vx]} media (°C)` };
  layout.yaxis.title = { text: `${VAR_LABELS[vy]} media (°C)` };
  layout.showlegend = false;
  if (rest.length) {
    const med = (arr) => quantile([...arr].sort((a, b) => a - b), 0.5);
    const mx = med(rest.map((r) => r.x)), my = med(rest.map((r) => r.y));
    layout.shapes = [
      { type: "line", x0: mx, x1: mx, yref: "paper", y0: 0, y1: 1,
        line: { color: TH.grid, dash: "dash", width: 1 } },
      { type: "line", y0: my, y1: my, xref: "paper", x0: 0, x1: 1,
        line: { color: TH.grid, dash: "dash", width: 1 } },
    ];
  }
  Plotly.newPlot("plot-comparador", traces, layout, PLOTLY_CFG);

  let rankTxt = "";
  if (ref && rest.length) {
    const warmer = rest.filter((r) => r.x > ref.x).length;
    rankTxt = ` En ${VAR_LABELS[vx]}, ${refYear} es el ${warmer + 1}º más cálido de ${rows.length} comparables.`;
  }
  $("co-note").textContent =
    (manual
      ? `Ventana manual ${mdLabel(mdMin)}–${mdLabel(mdMax)} (${nRef} días con dato en ${refYear}); `
      : `Ventana definida por los ${nRef} días con dato de ${refYear}; `) +
    `${rows.length} años con cobertura ≥ ${Math.round(minCov * 100)}%.` + rankTxt;
}

// ==========================================================
// PRODUCTO: Distribución por períodos
// ==========================================================

function runDistribution() {
  const S = state.station;
  const v = $("di-var").value;
  const mdS = parseMd($("di-md-start").value);
  const mdE = parseMd($("di-md-end").value);
  if (mdS === null || mdE === null) { $("di-note").textContent = "Ventana no válida."; return; }
  const A = [+$("di-a1").value, +$("di-a2").value];
  const B = [+$("di-b1").value, +$("di-b2").value];
  const mode = $("di-mode").value;
  const values = S.json.data[v];
  const wraps = mdS > mdE;

  function collect(y0, y1) {
    const out = [];
    for (let i = 0; i < values.length; i++) {
      const m = S.md[i];
      const inWin = wraps ? (m >= mdS || m <= mdE) : (m >= mdS && m <= mdE);
      if (!inWin || values[i] === null) continue;
      const gy = wraps && m >= mdS ? S.years[i] + 1 : S.years[i];
      if (gy >= y0 && gy <= y1) out.push(values[i]);
    }
    return out.sort((a, b) => a - b);
  }
  const da = collect(A[0], A[1]);
  const db = collect(B[0], B[1]);
  if (da.length < 100 || db.length < 100) {
    $("di-note").textContent =
      `Datos insuficientes (A: ${da.length}, B: ${db.length} días). Amplía períodos o ventana.`;
    Plotly.purge("plot-distribucion");
    return;
  }

  const nameA = `${A[0]}–${A[1]}`, nameB = `${B[0]}–${B[1]}`;
  let traces;
  if (mode === "hist") {
    traces = [
      { x: da, type: "histogram", histnorm: "probability", name: nameA,
        marker: { color: VAR_COLORS.tmin }, opacity: 0.55, xbins: { size: 1 } },
      { x: db, type: "histogram", histnorm: "probability", name: nameB,
        marker: { color: VAR_COLORS.tmax }, opacity: 0.55, xbins: { size: 1 } },
    ];
  } else {
    const ecdf = (d) => ({ x: d, y: d.map((_, i) => (i + 1) / d.length) });
    const ea = ecdf(da), eb = ecdf(db);
    traces = [
      { ...ea, mode: "lines", name: nameA, line: { color: VAR_COLORS.tmin, width: 2 } },
      { ...eb, mode: "lines", name: nameB, line: { color: VAR_COLORS.tmax, width: 2 } },
    ];
  }

  const layout = baseLayout(
    `${S.json.name} · ${VAR_LABELS[v]} diaria · ${mdLabel(mdS)} → ${mdLabel(mdE)}`);
  layout.xaxis.title = { text: `${VAR_LABELS[v]} (°C)` };
  layout.yaxis.title = { text: mode === "hist" ? "frecuencia" : "prob. acumulada" };
  layout.barmode = "overlay";
  layout.legend = { orientation: "h", y: -0.15 };
  Plotly.newPlot("plot-distribucion", traces, layout, PLOTLY_CFG);

  const mA = mean(da), mB = mean(db);
  const p95A = quantile(da, 0.95), p95B = quantile(db, 0.95);
  const exceed = db.filter((x) => x > p95A).length / db.length * 100;
  $("di-note").textContent =
    `Media: ${mA.toFixed(1)} → ${mB.toFixed(1)} °C (${(mB - mA >= 0 ? "+" : "")}${(mB - mA).toFixed(1)}). ` +
    `P95: ${p95A.toFixed(1)} → ${p95B.toFixed(1)} °C. ` +
    `El ${exceed.toFixed(1)}% de los días de ${nameB} supera el P95 de ${nameA} (esperado por definición: 5%).`;
}

// ==========================================================
// PRODUCTO: Calendario anual
// ==========================================================

function runCalendar() {
  const S = state.station;
  const year = +$("ca-year").value;
  const v = $("ca-var").value;
  const modeAnom = $("ca-mode").value === "anom";
  const [refA, refB] = getRef();
  const values = S.json.data[v];

  let clim = null;
  if (modeAnom) clim = climDaily(values, refA, refB, 7);

  const z = Array.from({ length: 12 }, () => new Array(31).fill(null));
  const txt = Array.from({ length: 12 }, () => new Array(31).fill(""));
  let found = 0;
  for (let i = 0; i < values.length; i++) {
    if (S.years[i] !== year || values[i] === null) continue;
    const mo = Math.floor(S.md[i] / 100), d = S.md[i] % 100;
    let val = values[i];
    if (modeAnom) {
      const cm = clim.mean.get(S.md[i] === 229 ? 228 : S.md[i]);
      if (cm === undefined) continue;
      val = values[i] - cm;
    }
    z[mo - 1][d - 1] = val;
    txt[mo - 1][d - 1] = `${d} ${MESES[mo]}: ${values[i].toFixed(1)} °C` +
      (modeAnom ? ` (${val >= 0 ? "+" : ""}${val.toFixed(1)})` : "");
    found++;
  }
  if (!found) {
    $("ca-note").textContent = `Sin datos de ${VAR_LABELS[v]} en ${year}.`;
    Plotly.purge("plot-calendario");
    return;
  }

  const amax = Math.max(...z.flat().filter((x) => x !== null).map(Math.abs));
  const layout = baseLayout(
    `${S.json.name} · ${VAR_LABELS[v]} ${year}` +
    (modeAnom ? ` · anomalía diaria vs ${refA}–${refB}` : ""));
  layout.xaxis = { ...layout.xaxis, title: { text: "día del mes" }, dtick: 2 };
  layout.yaxis = { ...layout.yaxis, autorange: "reversed" };
  Plotly.newPlot("plot-calendario", [{
    x: Array.from({ length: 31 }, (_, i) => i + 1),
    y: MESES.slice(1), z, text: txt, type: "heatmap",
    colorscale: modeAnom ? "RdBu" : "Plasma", reversescale: false,
    zmin: modeAnom ? -amax : undefined, zmax: modeAnom ? amax : undefined,
    zmid: modeAnom ? 0 : undefined,
    hovertemplate: "%{text}<extra></extra>",
    colorbar: { title: "°C", thickness: 14, outlinecolor: TH.grid },
    hoverongaps: false,
  }], layout, PLOTLY_CFG);
  $("ca-note").textContent = modeAnom
    ? "Anomalía respecto a la media de referencia por fecha (ventana ±7 días)." : "";
}


// ==========================================================
// PRODUCTO: Olas de calor y de frío
// ==========================================================

function runWaves() {
  const S = state.station;
  const calor = $("ol-tipo").value === "calor";
  const oficial = $("ol-def").value === "oficial";
  const v = calor ? "tmax" : "tmin";
  const values = S.json.data[v];
  const [refA, refB] = getRef();

  // umbral por mes-día
  const thr = new Map();
  let defTxt;
  if (oficial) {
    // P95 de tmax jul-ago (P5 de tmin ene-feb) de 1971-2000, umbral fijo
    const pool = [];
    for (let i = 0; i < values.length; i++) {
      const y = S.years[i], mo = Math.floor(S.md[i] / 100);
      if (y < 1971 || y > 2000 || values[i] === null) continue;
      if (calor ? (mo === 7 || mo === 8) : (mo === 1 || mo === 2)) pool.push(values[i]);
    }
    if (pool.length < 500) {
      $("ol-note").textContent = `Datos insuficientes en 1971–2000 (${pool.length} días) para la definición oficial.`;
      Plotly.purge("plot-olas"); return;
    }
    pool.sort((a, b) => a - b);
    const t = quantile(pool, calor ? 0.95 : 0.05);
    for (const m of MD_SEQ) thr.set(m, t);
    defTxt = `umbral fijo ${t.toFixed(1)} °C (P${calor ? 95 : 5} ${calor ? "jul–ago" : "ene–feb"} 1971–2000)`;
  } else {
    const clim = climDaily(values, refA, refB, 10); // ±10 días = ventana de 21
    for (const [m, pool] of clim.sorted) thr.set(m, quantile(pool, calor ? 0.95 : 0.05));
    thr.set(229, thr.get(228));
    if (thr.size < 300) {
      $("ol-note").textContent = "Referencia insuficiente para el umbral móvil.";
      Plotly.purge("plot-olas"); return;
    }
    defTxt = `P${calor ? 95 : 5} móvil de 21 días sobre ${refA}–${refB}`;
  }

  // detección de episodios (>=3 días consecutivos; hueco corta)
  const events = [];
  const perYear = new Map(); // año → {dias, olas}
  let start = -1, len = 0, exc = 0;
  function closeRun(i) {
    if (len >= 3) {
      events.push({ start, len, exc: exc / len });
      const y = S.years[start];
      const e = perYear.get(y) || { dias: 0, olas: 0 };
      e.dias += len; e.olas++;
      perYear.set(y, e);
    }
    len = 0; exc = 0;
  }
  for (let i = 0; i <= values.length; i++) {
    const x = i < values.length ? values[i] : null;
    const t = i < values.length ? thr.get(S.md[i]) : undefined;
    const ok = x !== null && t !== undefined && (calor ? x > t : x < t);
    if (ok) { if (!len) start = i; len++; exc += Math.abs(x - t); }
    else closeRun(i);
  }
  events.sort((a, b) => b.len - a.len);

  const y0 = S.yearList[0], y1 = S.yearList[S.yearList.length - 1];
  const yrs = [], dias = [], olas = [];
  for (let y = y0; y <= y1; y++) {
    yrs.push(y);
    const e = perYear.get(y);
    dias.push(e ? e.dias : 0);
    olas.push(e ? e.olas : 0);
  }

  const layout = baseLayout(`${S.json.name} · olas de ${calor ? "calor" : "frío"} · ${defTxt}`);
  layout.yaxis.title = { text: "días en ola / año" };
  layout.yaxis2 = { overlaying: "y", side: "right", title: { text: "nº de olas" },
                    gridcolor: "rgba(0,0,0,0)", zerolinecolor: TH.grid, rangemode: "tozero" };
  layout.legend = { orientation: "h", y: -0.12 };
  Plotly.newPlot("plot-olas", [
    { x: yrs, y: dias, type: "bar", name: "días en ola",
      marker: { color: dias, colorscale: calor ? "Reds" : "Blues" },
      hovertemplate: "%{x}: %{y} días<extra></extra>" },
    { x: yrs, y: olas, yaxis: "y2", mode: "lines+markers", name: "nº de olas",
      line: { color: TH.fg, width: 1 }, marker: { size: 4 },
      hovertemplate: "%{x}: %{y} olas<extra></extra>" },
  ], layout, PLOTLY_CFG);

  // calendario año × día del año: intensidad (|valor - umbral|) en días de ola
  {
    const y0c = S.yearList[0], y1c = S.yearList[S.yearList.length - 1];
    const nY = y1c - y0c + 1;
    const z = Array.from({ length: nY }, () => new Array(365).fill(null));
    const txtc = Array.from({ length: nY }, () => new Array(365).fill(""));
    for (const e of events) {
      for (let i = e.start; i < e.start + e.len; i++) {
        if (S.md[i] === 229) continue;
        const pos = MD_IDX_365.get(S.md[i]);
        const row = S.years[i] - y0c;
        const intens = Math.abs(values[i] - thr.get(S.md[i]));
        z[row][pos] = intens;
        txtc[row][pos] = `${mdLabel(S.md[i])} ${S.years[i]}: ${values[i].toFixed(1)} °C ` +
          `(${calor ? "+" : "−"}${intens.toFixed(1)} sobre umbral)`;
      }
    }
    const xc = [];
    {
      const d = new Date(Date.UTC(2001, 0, 1));
      for (let p = 0; p < 365; p++) { xc.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
    }
    const lc = baseLayout(`Días en ola de ${calor ? "calor" : "frío"} · color = exceso sobre el umbral`);
    lc.xaxis.tickformat = "%b";
    lc.xaxis.dtick = "M1";
    lc.yaxis.title = { text: "año" };
    lc.yaxis.autorange = "reversed";
    lc.yaxis.dtick = 10;
    Plotly.newPlot("plot-olas-cal", [{
      x: xc, y: Array.from({ length: nY }, (_, k) => y0c + k), z,
      type: "heatmap", colorscale: calor ? "Reds" : "Blues",
      text: txtc, hovertemplate: "%{text}<extra></extra>", hoverongaps: false,
      colorbar: { title: "°C", thickness: 14, outlinecolor: TH.grid },
      zmin: 0,
    }], lc, PLOTLY_CFG);
  }

  let top = "";
  if (events.length) {
    const e = events[0];
    top = ` Episodio más largo: ${e.len} días (${fmtDate(S.startMs, e.start)} → ` +
      `${fmtDate(S.startMs, e.start + e.len - 1)}), exceso medio ${e.exc.toFixed(1)} °C.`;
  }
  $("ol-note").textContent =
    `${events.length} episodios de ≥3 días en toda la serie.${top} ` +
    `La oficial de AEMET usa el 10% de estaciones a la vez; aquí está adaptada a estación única. Los huecos cortan episodios.`;
}

// ==========================================================
// PRODUCTO: Ratio de récords cálidos vs fríos por década
// ==========================================================

function runRecords() {
  const S = state.station;
  const skip = +$("re-skip").value;
  const tmax = S.json.data.tmax, tmin = S.json.data.tmin;
  const y0 = S.yearList[0];
  const startCount = y0 + skip * 10;

  const rMax = new Map(), rMin = new Map(); // md → récord vigente
  const warm = new Map(), cold = new Map(); // década → conteo
  const dec = (y) => Math.floor(y / 10) * 10;
  for (let i = 0; i < tmax.length; i++) {
    const m = S.md[i], y = S.years[i];
    if (tmax[i] !== null) {
      const r = rMax.get(m);
      if (r === undefined || tmax[i] > r) {
        rMax.set(m, tmax[i]);
        if (y >= startCount) warm.set(dec(y), (warm.get(dec(y)) || 0) + 1);
      }
    }
    if (tmin[i] !== null) {
      const r = rMin.get(m);
      if (r === undefined || tmin[i] < r) {
        rMin.set(m, tmin[i]);
        if (y >= startCount) cold.set(dec(y), (cold.get(dec(y)) || 0) + 1);
      }
    }
  }

  const decades = [...new Set([...warm.keys(), ...cold.keys()])].sort((a, b) => a - b);
  const w = decades.map((d) => warm.get(d) || 0);
  const c = decades.map((d) => cold.get(d) || 0);
  const labels = decades.map((d) => `${d}s`);
  const ratio = decades.map((d, i) => c[i] ? (w[i] / c[i]).toFixed(1) : "∞");

  const layout = baseLayout(
    `${S.json.name} · récords diarios batidos por década (desde ${startCount})`);
  layout.barmode = "group";
  layout.yaxis.title = { text: "récords batidos" };
  layout.legend = { orientation: "h", y: -0.12 };
  layout.annotations = decades.map((d, i) => ({
    x: labels[i], y: Math.max(w[i], c[i]), yshift: 14, showarrow: false,
    text: `${ratio[i]}:1`, font: { size: 11, color: TH.muted },
  }));
  Plotly.newPlot("plot-records", [
    { x: labels, y: w, type: "bar", name: "récords cálidos (Tmax)",
      marker: { color: VAR_COLORS.tmax }, hovertemplate: "%{x}: %{y}<extra>cálidos</extra>" },
    { x: labels, y: c, type: "bar", name: "récords fríos (Tmin)",
      marker: { color: VAR_COLORS.tmin }, hovertemplate: "%{x}: %{y}<extra>fríos</extra>" },
  ], layout, PLOTLY_CFG);

  $("re-note").textContent =
    `Un récord se cuenta cuando la Tmax (Tmin) del día supera (baja de) el récord vigente ` +
    `de esa fecha hasta ese momento. En clima estacionario el ratio tiende a 1:1 y ambos decaen con la edad de la serie. ` +
    `Las ${skip} primeras décadas se excluyen del conteo (todo es récord al principio) pero sí fijan los récords iniciales.`;
}


// ==========================================================
// PRODUCTO: Comparar períodos (mes / estación / año, A vs B)
// ==========================================================

const SEASONS = {
  MAM: { mdS: 301, mdE: 531, label: "primavera (MAM)" },
  JJA: { mdS: 601, mdE: 831, label: "verano (JJA)" },
  SON: { mdS: 901, mdE: 1130, label: "otoño (SON)" },
  DJF: { mdS: 1201, mdE: 228, label: "invierno (DJF)" },
};

function populatePeriodSubs() {
  const tipo = $("pe-tipo").value;
  for (const sel of [$("pe-a-sub"), $("pe-b-sub")]) {
    const prev = sel.value;
    sel.innerHTML = "";
    if (tipo === "mes") {
      for (let m = 1; m <= 12; m++) {
        const o = document.createElement("option");
        o.value = m; o.textContent = MESES[m];
        sel.appendChild(o);
      }
      sel.value = prev >= 1 && prev <= 12 ? prev : 7;
    } else if (tipo === "estacion") {
      for (const [k, s] of Object.entries(SEASONS)) {
        const o = document.createElement("option");
        o.value = k; o.textContent = s.label;
        sel.appendChild(o);
      }
      sel.value = SEASONS[prev] ? prev : "JJA";
    } else {
      const o = document.createElement("option");
      o.value = "anio"; o.textContent = "—";
      sel.appendChild(o);
    }
    sel.disabled = tipo === "anio";
  }
}

/** Días (índices de rejilla, en orden) de un período tipo/sub/año. */
function periodDays(tipo, sub, yr) {
  const S = state.station;
  let mdS, mdE, label;
  if (tipo === "mes") {
    const m = +sub;
    mdS = m * 100 + 1; mdE = m * 100 + 31;
    label = `${MESES[m]} ${yr}`;
  } else if (tipo === "estacion") {
    ({ mdS, mdE } = SEASONS[sub]);
    label = `${SEASONS[sub].label} ${mdS > mdE ? (yr - 1) + "–" + String(yr).slice(2) : yr}`;
  } else {
    mdS = 101; mdE = 1231; label = String(yr);
  }
  const wraps = mdS > mdE;
  const idx = [];
  for (let i = 0; i < S.md.length; i++) {
    const m = S.md[i];
    const inWin = wraps ? (m >= mdS || m <= mdE) : (m >= mdS && m <= mdE);
    if (!inWin) continue;
    const gy = wraps && m >= mdS ? S.years[i] + 1 : S.years[i];
    if (gy === yr) idx.push(i);
  }
  return { idx, label };
}

function runPeriodos() {
  const S = state.station;
  const v = $("pe-var").value;
  const tipo = $("pe-tipo").value;
  const isPrec = v === "prec";
  const values = S.json.data[v];
  const A = periodDays(tipo, $("pe-a-sub").value, +$("pe-a-yr").value);
  const B = periodDays(tipo, $("pe-b-sub").value, +$("pe-b-yr").value);

  function series(P) {
    const y = [], txt = [];
    let sum = 0, n = 0, mx = -Infinity, mn = Infinity;
    for (const i of P.idx) {
      const val = values[i];
      if (val !== null) {
        sum += val; n++;
        if (val > mx) mx = val;
        if (val < mn) mn = val;
      }
      y.push(val === null ? null : (isPrec ? sum : val));
      txt.push(fmtDate(S.startMs, i));
    }
    return { y, txt, n, mean: n ? sum / n : null, sum, mx, mn };
  }
  const sa = series(A), sb = series(B);
  if (!sa.n || !sb.n) {
    $("pe-note").textContent = `Sin datos: ${A.label} (${sa.n} días válidos), ${B.label} (${sb.n}).`;
    Plotly.purge("plot-periodos"); return;
  }

  const layout = baseLayout(`${S.json.name} · ${VAR_LABELS[v]} · ${A.label} vs ${B.label}`);
  layout.xaxis.title = { text: "día del período" };
  layout.yaxis.title = { text: isPrec ? "mm acumulados" : "°C" };
  layout.legend = { orientation: "h", y: -0.15 };
  const mk = (s, P, color) => ({
    x: s.y.map((_, k) => k + 1), y: s.y, mode: "lines", name: P.label,
    line: { color, width: 2 }, connectgaps: false, text: s.txt,
    hovertemplate: "%{text}: %{y:.1f}<extra>" + P.label + "</extra>",
  });
  Plotly.newPlot("plot-periodos",
    [mk(sa, A, VAR_COLORS.tmin), mk(sb, B, VAR_COLORS.tmax)], layout, PLOTLY_CFG);

  const d = (x) => x.toFixed(1);
  $("pe-note").textContent = isPrec
    ? `Total: ${A.label} ${d(sa.sum)} mm (${sa.n} días) · ${B.label} ${d(sb.sum)} mm (${sb.n} días) · ` +
      `diferencia ${d(sb.sum - sa.sum)} mm.`
    : `Media: ${A.label} ${d(sa.mean)} °C · ${B.label} ${d(sb.mean)} °C (Δ ${sb.mean - sa.mean >= 0 ? "+" : ""}${d(sb.mean - sa.mean)}). ` +
      `Máx/mín: ${d(sa.mx)}/${d(sa.mn)} vs ${d(sb.mx)}/${d(sb.mn)} °C. ` +
      `Días válidos: ${sa.n} vs ${sb.n}.`;
}

// ==========================================================
// PRODUCTO: España (toda la red; agregados precomputados)
// ==========================================================

const REGIONS = {
  "Norte atlántico y cantábrico": ["A CORUÑA", "LUGO", "OURENSE", "PONTEVEDRA", "ASTURIAS", "CANTABRIA", "BIZKAIA", "GIPUZKOA"],
  "Meseta norte y valle del Ebro": ["LEON", "ZAMORA", "SALAMANCA", "VALLADOLID", "PALENCIA", "BURGOS", "SORIA", "SEGOVIA",
    "AVILA", "ARABA/ALAVA", "LA RIOJA", "NAVARRA", "HUESCA", "ZARAGOZA", "TERUEL", "LLEIDA"],
  "Meseta sur y Extremadura": ["MADRID", "GUADALAJARA", "CUENCA", "TOLEDO", "CIUDAD REAL", "ALBACETE", "CACERES", "BADAJOZ"],
  "Mediterráneo y Baleares": ["GIRONA", "BARCELONA", "TARRAGONA", "CASTELLON", "VALENCIA", "ALICANTE", "MURCIA", "BALEARES", "ILLES BALEARS"],
  "Andalucía, Ceuta y Melilla": ["HUELVA", "SEVILLA", "CADIZ", "CORDOBA", "JAEN", "GRANADA", "MALAGA", "ALMERIA", "CEUTA", "MELILLA"],
  "Canarias": ["LAS PALMAS", "SANTA CRUZ DE TENERIFE", "STA. CRUZ DE TENERIFE"],
};
const PROV_REGION = new Map(Object.entries(REGIONS).flatMap(([r, ps]) => ps.map((p) => [p, r])));
const ALT_BANDS = [[-Infinity, 200, "Menos de 200 m"], [200, 600, "200–600 m"], [600, 1000, "600–1000 m"], [1000, Infinity, "Más de 1000 m"]];
const GROUP_COLORS = ["#1c7ed6", "#2b8a3e", "#e8590c", "#ae3ec9", "#f08c00", "#0c8599"];
const SEASON_MONTHS = { DJF: [12, 1, 2], MAM: [3, 4, 5], JJA: [6, 7, 8], SON: [9, 10, 11] };
const PER_LABEL = { anio: "año completo", DJF: "invierno", MAM: "primavera", JJA: "verano", SON: "otoño" };
const DIV_TEMP = [[0, "#2166ac"], [0.25, "#67a9cf"], [0.5, "#f4f1ea"], [0.75, "#ef8a62"], [1, "#b2182b"]];
const DIV_PREC = [[0, "#8c510a"], [0.25, "#d8b365"], [0.5, "#f4f1ea"], [0.75, "#5ab4ac"], [1, "#01665e"]];

async function loadNational() {
  if (state.nationalTried) return;
  state.nationalTried = true;
  try {
    const r = await fetch(`${DATA_URL}/national.json`);
    if (r.ok) state.national = await r.json();
  } catch { /* sin national.json */ }
  try {
    const r = await fetch(`${DATA_URL}/coords.json`);
    if (r.ok) state.coords = await r.json();
  } catch { state.coords = {}; }
  state.coords = state.coords || {};
  state.stMeta = new Map(state.index.stations.map((s) => [s.id, s]));
}

async function loadNationalMonthly() {
  if (state.nationalM !== undefined) return;
  showLoader("Cargando datos mensuales de toda la red…");
  try {
    const r = await fetch(`${DATA_URL}/national_monthly.json`);
    state.nationalM = r.ok ? await r.json() : null;
  } catch { state.nationalM = null; }
  hideLoader();
}

function perLabel(per) {
  return per.startsWith("m") ? MESES_LARGO[+per.slice(1)] : PER_LABEL[per];
}

/** Map id → array (alineado a N.y0..N.y1) de la variable en el período del año pedido. */
async function natSeries(v, per) {
  const N = state.national;
  state.natCache = state.natCache || new Map();
  const key = `${v}|${per}`;
  if (state.natCache.has(key)) return state.natCache.get(key);
  const out = new Map();
  if (per === "anio") {
    for (const id in N.stations) if (N.stations[id][v]) out.set(id, N.stations[id][v]);
  } else {
    await loadNationalMonthly();
    const M = state.nationalM;
    if (!M) return null;
    const months = per.startsWith("m") ? [+per.slice(1)] : SEASON_MONTHS[per];
    const ny = N.y1 - N.y0 + 1;
    for (const id in M.stations) {
      const s = M.stations[id], arr = s[v];
      if (!arr) continue;
      const res = new Array(ny).fill(null);
      let any = false;
      for (let k = 0; k < ny; k++) {
        const y = N.y0 + k;
        let sum = 0, ok = true;
        for (const m of months) {
          const yy = per === "DJF" && m === 12 ? y - 1 : y;
          const t = (yy - s.y0) * 12 + (m - 1);
          const x = t >= 0 && t < arr.length ? arr[t] : null;
          if (x === null) { ok = false; break; }
          sum += x;
        }
        if (ok) { res[k] = v === "prec" ? Math.round(sum * 10) / 10 : sum / months.length; any = true; }
      }
      if (any) out.set(id, res);
    }
  }
  state.natCache.set(key, out);
  return out;
}

/** Anomalías por estación frente a su propia base de referencia, con filtro de red fija. */
function natAnoms(series, v, red) {
  const N = state.national;
  const isPrec = v === "prec";
  const [refA, refB] = getRef();
  const ny = N.y1 - N.y0 + 1;
  const counts = new Array(ny).fill(0);
  for (const arr of series.values()) arr.forEach((x, k) => { if (x !== null) counts[k]++; });
  const cmax = Math.max(...counts);
  let kEnd = ny - 1;
  while (kEnd > 0 && counts[kEnd] < 0.5 * cmax) kEnd--;
  const yEnd = N.y0 + kEnd;
  const yStart = red === "todas" ? N.y0 : +red;
  const stations = [];
  for (const [id, arr] of series) {
    let bSum = 0, bN = 0;
    for (let y = Math.max(refA, N.y0); y <= Math.min(refB, N.y1); y++) {
      const x = arr[y - N.y0];
      if (x !== null) { bSum += x; bN++; }
    }
    if (bN < 0.8 * (refB - refA + 1)) continue;
    const base = bSum / bN;
    if (isPrec && base <= 0) continue;
    if (red !== "todas") {
      let nv = 0;
      for (let y = yStart; y <= yEnd; y++) if (arr[y - N.y0] !== null) nv++;
      if (nv < 0.8 * (yEnd - yStart + 1)) continue;
    }
    const anom = arr.map((x) => (x === null ? null : isPrec ? (100 * x) / base : x - base));
    const meta = state.stMeta.get(id) || {};
    const c = state.coords[id];
    stations.push({ id, anom, base, name: meta.name || id, prov: meta.province || "",
                    alt: meta.altitude ?? null, lat: c ? c[0] : null, lon: c ? c[1] : null });
  }
  return { stations, yStart, yEnd, isPrec };
}

/** Media de la red año a año (por estación o por celdas de 1°) y reparto por encima/debajo de lo normal. */
function natAverage(stations, area, isPrec) {
  const N = state.national;
  const ny = N.y1 - N.y0 + 1;
  const mean = new Array(ny).fill(null), nSt = new Array(ny).fill(0);
  const above = new Array(ny).fill(0), below = new Array(ny).fill(0);
  const center = isPrec ? 100 : 0;
  for (let k = 0; k < ny; k++) {
    const cells = new Map();
    let s = 0, n = 0;
    for (const st of stations) {
      const a = st.anom[k];
      if (a === null) continue;
      n++;
      if (a > center) above[k]++; else below[k]++;
      if (area) {
        if (st.lat === null) continue;
        const key = `${Math.floor(st.lat)},${Math.floor(st.lon)}`;
        const c = cells.get(key) || { s: 0, n: 0 };
        c.s += a; c.n++; cells.set(key, c);
      } else { s += a; }
    }
    nSt[k] = n;
    if (!n) continue;
    if (area) {
      let cs = 0;
      for (const c of cells.values()) cs += c.s / c.n;
      mean[k] = cells.size ? cs / cells.size : null;
    } else mean[k] = s / n;
  }
  return { mean, nSt, above, below };
}

function runningMean(ys, win) {
  const h = Math.floor(win / 2);
  return ys.map((_, i) => {
    let s = 0, n = 0;
    for (let j = i - h; j <= i + h; j++) if (j >= 0 && j < ys.length && ys[j] !== null) { s += ys[j]; n++; }
    return n >= Math.ceil(win * 0.7) ? s / n : null;
  });
}

function stopNatPlay() {
  if (state.natPlay) { clearInterval(state.natPlay); state.natPlay = null; }
  const b = $("na-play");
  if (b) b.textContent = "▶";
}

async function runNacional() {
  await loadNational();
  const N = state.national;
  if (!N) {
    $("na-note").textContent = "Falta data/national.json: genéralo con scripts/build_national.py y súbelo al repo.";
    return;
  }
  const view = state.natView || "evol";
  document.querySelectorAll("#panel-nacional [data-views]").forEach((el) => {
    el.hidden = !el.dataset.views.split(" ").includes(view);
  });
  document.querySelectorAll("#panel-nacional .na-sub").forEach((el) => { el.hidden = el.dataset.view !== view; });
  if (view === "recs") { runNatRecords(); return; }

  const v = $("na-var").value;
  const per = $("na-per").value;
  const series = await natSeries(v, per);
  if (!series) { $("na-note").textContent = "No se pudo cargar data/national_monthly.json."; return; }
  const A = natAnoms(series, v, $("na-red").value);
  state.natLast = { A, v, per };
  if (A.stations.length < 10) {
    $("na-note").textContent = `Solo ${A.stations.length} estaciones cumplen los requisitos. Prueba con «Todas las disponibles» o cambia el período normal.`;
    return;
  }
  if (view === "evol") runNatEvol(A, v, per);
  else if (view === "mapa") runNatMap();
  else runNatRegions(A, v, per);
}

function natSubtitle(A, per, area) {
  const [refA, refB] = getRef();
  return `${cap(perLabel(per))} · ${A.isPrec ? `% de la normal ${refA}–${refB}` : `anomalía vs ${refA}–${refB}`} · ` +
    `${A.stations.length} estaciones${area ? ", promedio por área" : ""}`;
}

function runNatEvol(A, v, per) {
  const N = state.national;
  const area = $("na-peso").value === "area";
  const minSt = +$("na-min").value;
  const trendFrom = +$("na-trend").value;
  const avg = natAverage(A.stations, area, A.isPrec);
  const xs = [], ys = [], ns = [], up = [], dn = [];
  for (let y = A.yStart; y <= A.yEnd; y++) {
    const k = y - N.y0;
    if (avg.mean[k] === null || avg.nSt[k] < minSt) continue;
    xs.push(y); ys.push(avg.mean[k]); ns.push(avg.nSt[k]);
    up.push((100 * avg.above[k]) / avg.nSt[k]); dn.push((-100 * avg.below[k]) / avg.nSt[k]);
  }
  if (xs.length < 5) {
    $("na-note").textContent = `Solo ${xs.length} años con ≥ ${minSt} estaciones. Baja el mínimo o elige «Todas las disponibles».`;
    return;
  }
  const isPrec = A.isPrec, center = isPrec ? 100 : 0;
  const unit = isPrec ? "%" : "°C";
  const amax = Math.max(...ys.map((y) => Math.abs(y - center))) || 1;
  const layout = baseLayout(`España · ${VAR_LABELS[v]} · ${natSubtitle(A, per, area)}`);
  layout.yaxis.title = { text: isPrec ? "% de la normal" : "anomalía (°C)" };
  layout.yaxis2 = { overlaying: "y", side: "right", title: { text: "estaciones" }, showgrid: false, rangemode: "tozero" };
  layout.legend = { orientation: "h", y: -0.14 };
  layout.shapes = [{ type: "line", xref: "paper", x0: 0, x1: 1, y0: center, y1: center, line: { color: TH.muted, width: 1 } }];
  const traces = [
    { x: xs, y: ys, type: "bar", name: isPrec ? "% de la normal" : "anomalía",
      marker: { color: ys.map((y) => y - center), colorscale: isPrec ? DIV_PREC : DIV_TEMP, cmin: -amax, cmax: amax },
      customdata: ns, hovertemplate: `%{x}: %{y:${isPrec ? ".0f" : "+.2f"}} ${unit}<br>%{customdata} estaciones<extra></extra>` },
    { x: xs, y: runningMean(ys, 11), mode: "lines", name: "media móvil 11 años",
      line: { color: TH.fg, width: 2.5 }, hoverinfo: "skip" },
    { x: xs, y: ns, yaxis: "y2", mode: "lines", name: "nº de estaciones",
      line: { color: TH.muted, width: 1, dash: "dot" }, hovertemplate: "%{x}: %{y} estaciones<extra></extra>" },
  ];
  let trendTxt = "";
  const tx = [], ty = [];
  xs.forEach((x, i) => { if (x >= trendFrom) { tx.push(x); ty.push(ys[i]); } });
  const fit = ols(tx, ty);
  if (fit) {
    traces.push({ x: [tx[0], tx[tx.length - 1]], y: [fit.a + fit.b * tx[0], fit.a + fit.b * tx[tx.length - 1]],
      mode: "lines", name: `tendencia desde ${trendFrom}`, line: { color: ACCENT, width: 2, dash: "dash" }, hoverinfo: "skip" });
    trendTxt = ` Tendencia desde ${trendFrom}: ${fit.b >= 0 ? "+" : ""}${(fit.b * 10).toFixed(isPrec ? 1 : 2)} ${isPrec ? "puntos %" : "°C"} por década (OLS, orientativa).`;
  }
  Plotly.newPlot("plot-nacional", traces, layout, PLOTLY_CFG);

  // ---- consenso de la red ----
  const lc = baseLayout("");
  lc.margin.t = 10;
  lc.barmode = "relative";
  lc.yaxis.title = { text: "% de estaciones" };
  lc.yaxis.range = [-100, 100];
  lc.yaxis.tickvals = [-100, -50, 0, 50, 100];
  lc.yaxis.ticktext = ["100", "50", "0", "50", "100"];
  lc.legend = { orientation: "h", y: -0.18 };
  const hiName = isPrec ? "más lluviosas de lo normal" : "más cálidas de lo normal";
  const loName = isPrec ? "más secas de lo normal" : "más frías de lo normal";
  Plotly.newPlot("plot-nacional-cons", [
    { x: xs, y: up, type: "bar", name: hiName, marker: { color: isPrec ? "#5ab4ac" : VAR_COLORS.tmax },
      hovertemplate: `%{x}: %{y:.0f}% ${hiName}<extra></extra>` },
    { x: xs, y: dn, type: "bar", name: loName, marker: { color: isPrec ? "#d8b365" : VAR_COLORS.tmin },
      customdata: dn.map((d) => -d), hovertemplate: `%{x}: %{customdata:.0f}% ${loName}<extra></extra>` },
  ], lc, PLOTLY_CFG);

  // ---- clasificación ----
  const rows = xs.map((x, i) => ({ y: x, v: ys[i] })).sort((a, b) => b.v - a.v);
  const fmt = (r) => isPrec ? `${r.v.toFixed(0)} %` : `${r.v >= 0 ? "+" : ""}${r.v.toFixed(2)} °C`;
  const last = xs[xs.length - 1];
  function fill(id, title, list) {
    const t = $(id);
    t.querySelector("thead").innerHTML = `<tr><th>#</th><th>${title}</th><th>${isPrec ? "% normal" : "Anomalía"}</th></tr>`;
    t.querySelector("tbody").innerHTML = list.map((r, i) =>
      `<tr${r.y === last ? ' class="hl"' : ""}><td>${i + 1}</td><td>${r.y}</td><td>${fmt(r)}</td></tr>`).join("");
  }
  fill("na-rank-hi", isPrec ? "Más lluviosos" : "Más cálidos", rows.slice(0, 10));
  fill("na-rank-lo", isPrec ? "Más secos" : "Más fríos", rows.slice(-10).reverse());
  const pos = rows.findIndex((r) => r.y === last) + 1;
  const hiWord = isPrec ? "más lluvioso" : "más cálido";

  $("na-note").textContent =
    `${last} es el ${pos}º ${hiWord} de ${rows.length} años con datos (desde ${xs[0]}).` + trendTxt +
    (A.yStart > N.y0 ? ` Red fija: solo estaciones con ≥ 80 % de años válidos entre ${A.yStart} y ${A.yEnd}, para que la composición de la red no cree tendencias falsas.` : " Red variable: las estaciones entran y salen; los primeros años son poco representativos.") +
    (area ? " Promedio por área: primero se promedian las estaciones de cada celda de 1° y luego las celdas, para que las zonas con muchas estaciones no pesen más." : "") +
    " Series no homogeneizadas.";
}

function runNatMap() {
  const L = state.natLast;
  if (!L) return;
  const { A, v, per } = L;
  const N = state.national;
  const mode = $("na-map-mode").value;
  const isPrec = A.isPrec;
  const slider = $("na-map-year");
  slider.min = A.yStart; slider.max = A.yEnd;
  if (!state.natYearTouched) slider.value = A.yEnd;
  if (+slider.value > A.yEnd) slider.value = A.yEnd;
  if (+slider.value < A.yStart) slider.value = A.yStart;
  const year = +slider.value;
  $("na-map-year-val").textContent = year;
  $("na-year-wrap").hidden = mode !== "anom";

  const pts = [];
  let title, cmin, cmax, unit, fmtv;
  if (mode === "anom") {
    const k = year - N.y0;
    for (const st of A.stations) if (st.lat !== null && st.anom[k] !== null) pts.push({ st, z: st.anom[k] });
    const [refA, refB] = getRef();
    title = `${cap(perLabel(per))} de ${year} · ${VAR_LABELS[v]} · ${isPrec ? `% de la normal ${refA}–${refB}` : `anomalía vs ${refA}–${refB}`}`;
    unit = isPrec ? "%" : "°C";
    fmtv = isPrec ? ".0f" : "+.1f";
    if (isPrec) { cmin = 0; cmax = 200; } else { cmin = -3; cmax = 3; }
  } else {
    const from = +$("na-trend").value;
    for (const st of A.stations) {
      if (st.lat === null) continue;
      const xs = [], ys = [];
      for (let y = from; y <= A.yEnd; y++) { const a = st.anom[y - N.y0]; if (a !== null) { xs.push(y); ys.push(a); } }
      if (xs.length < 0.8 * (A.yEnd - from + 1)) continue;
      const fit = ols(xs, ys);
      if (fit) pts.push({ st, z: fit.b * 10 });
    }
    title = `Tendencia ${from}–${A.yEnd} · ${VAR_LABELS[v]} · ${cap(perLabel(per))} · ${isPrec ? "puntos % por década" : "°C por década"}`;
    unit = isPrec ? "puntos %/década" : "°C/década";
    fmtv = isPrec ? "+.1f" : "+.2f";
    if (isPrec) { cmin = -10; cmax = 10; } else { cmin = -0.6; cmax = 0.6; }
  }
  if (!pts.length) {
    $("na-note").textContent = mode === "anom" ? `Sin estaciones con dato en ${year}.` : "Ninguna estación tiene serie suficiente para la tendencia.";
    Plotly.purge("plot-nacional-mapa");
    return;
  }
  const canary = (p) => p.st.lat < 30;
  const mk = (list, geo, showscale) => ({
    type: "scattergeo", geo, lat: list.map((p) => p.st.lat), lon: list.map((p) => p.st.lon),
    text: list.map((p) => `${p.st.name} (${cap(p.st.prov.toLowerCase())})`),
    customdata: list.map((p) => p.z),
    hovertemplate: `%{text}<br>%{customdata:${fmtv}} ${unit}<extra></extra>`,
    mode: "markers",
    marker: { color: list.map((p) => p.z), colorscale: isPrec ? DIV_PREC : DIV_TEMP, cmin, cmax,
              size: 9, line: { color: TH.card, width: 0.6 }, opacity: 0.95,
              showscale, colorbar: showscale ? { title: { text: unit }, thickness: 12, len: 0.6, outlinewidth: 0 } : undefined },
  });
  const geoBase = {
    projection: { type: "mercator" }, resolution: 50, showframe: false,
    showland: true, landcolor: TH.card2, showocean: true, oceancolor: TH.card, bgcolor: TH.card,
    showcountries: true, countrycolor: TH.border, coastlinecolor: TH.border, showlakes: false,
  };
  const layout = baseLayout(title);
  layout.margin = { l: 0, r: 0, t: 44, b: 0 };
  layout.geo = { ...geoBase, lataxis: { range: [35.2, 44.2] }, lonaxis: { range: [-10.2, 4.8] }, domain: { x: [0, 1], y: [0, 1] } };
  layout.geo2 = { ...geoBase, lataxis: { range: [27.5, 29.6] }, lonaxis: { range: [-18.4, -13.2] },
                  domain: { x: [0, 0.24], y: [0, 0.19] }, showframe: true, framecolor: TH.border };
  layout.showlegend = false;
  const traces = [mk(pts.filter((p) => !canary(p)), "geo", true), mk(pts.filter(canary), "geo2", false)];
  Plotly.react("plot-nacional-mapa", traces, layout, PLOTLY_CFG);

  const zs = pts.map((p) => p.z).sort((a, b) => a - b);
  const pos = zs.filter((z) => z > (mode === "anom" && isPrec ? 100 : 0)).length;
  $("na-note").textContent = `${pts.length} estaciones. ` +
    (mode === "anom"
      ? `${Math.round((100 * pos) / pts.length)} % por encima de lo normal; mediana ${zs[Math.floor(zs.length / 2)].toFixed(isPrec ? 0 : 1)} ${unit}. Pulsa ▶ para recorrer los años.`
      : `${Math.round((100 * pos) / pts.length)} % con tendencia positiva; mediana ${zs[Math.floor(zs.length / 2)].toFixed(2)} ${unit}. Solo estaciones con ≥ 80 % de años desde ${$("na-trend").value}.`) +
    " La escala de color está fija para poder comparar años.";
}

function runNatRegions(A, v, per) {
  const N = state.national;
  const area = $("na-peso").value === "area";
  const byAlt = $("na-grp").value === "alt";
  const minSt = Math.max(3, Math.round(+$("na-min").value / 10));
  const from = +$("na-trend").value;
  const groups = new Map();
  for (const st of A.stations) {
    let g;
    if (byAlt) { if (st.alt === null) continue; g = ALT_BANDS.find(([a, b]) => st.alt >= a && st.alt < b)[2]; }
    else g = PROV_REGION.get(st.prov) || null;
    if (!g) continue;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(st);
  }
  const order = byAlt ? ALT_BANDS.map((b) => b[2]) : Object.keys(REGIONS);
  const traces = [], trends = [];
  order.forEach((g, gi) => {
    const list = groups.get(g);
    if (!list || list.length < 3) return;
    const avg = natAverage(list, area, A.isPrec);
    const xs = [], ys = [];
    for (let y = A.yStart; y <= A.yEnd; y++) {
      const k = y - N.y0;
      if (avg.mean[k] === null || avg.nSt[k] < minSt) continue;
      xs.push(y); ys.push(avg.mean[k]);
    }
    if (xs.length < 10) return;
    const col = GROUP_COLORS[gi % GROUP_COLORS.length];
    traces.push({ x: xs, y: ys, mode: "markers", marker: { color: col, size: 4, opacity: 0.35 },
                  legendgroup: g, showlegend: false, hoverinfo: "skip" });
    traces.push({ x: xs, y: runningMean(ys, 11), mode: "lines", name: `${g} (${list.length})`, legendgroup: g,
                  line: { color: col, width: 2.5 },
                  hovertemplate: `%{x}: %{y:${A.isPrec ? ".0f" : "+.2f"}}<extra>${g}</extra>` });
    const tx = [], ty = [];
    xs.forEach((x, i) => { if (x >= from) { tx.push(x); ty.push(ys[i]); } });
    const fit = ols(tx, ty);
    if (fit) trends.push({ g, b: fit.b * 10, n: list.length, col });
  });
  const [refA, refB] = getRef();
  const layout = baseLayout(`${VAR_LABELS[v]} · ${cap(perLabel(per))} por ${byAlt ? "altitud" : "región"} · media móvil de 11 años · ` +
    (A.isPrec ? `% de la normal ${refA}–${refB}` : `anomalía vs ${refA}–${refB}`));
  layout.yaxis.title = { text: A.isPrec ? "% de la normal" : "anomalía (°C)" };
  layout.legend = { orientation: "h", y: -0.14 };
  Plotly.newPlot("plot-nacional-reg", traces, layout, PLOTLY_CFG);

  const unit = A.isPrec ? "puntos %/década" : "°C/década";
  const l2 = baseLayout("");
  l2.margin = { l: 210, r: 30, t: 10, b: 45 };
  l2.xaxis.title = { text: `tendencia desde ${from} (${unit})` };
  l2.yaxis.autorange = "reversed";
  l2.showlegend = false;
  Plotly.newPlot("plot-nacional-regtr", [{
    type: "bar", orientation: "h", y: trends.map((t) => t.g), x: trends.map((t) => t.b),
    marker: { color: trends.map((t) => t.col) },
    text: trends.map((t) => `${t.b >= 0 ? "+" : ""}${t.b.toFixed(A.isPrec ? 1 : 2)}`), textposition: "outside",
    customdata: trends.map((t) => t.n),
    hovertemplate: `%{y}: %{x:+.2f} ${unit}<br>%{customdata} estaciones<extra></extra>`,
  }], l2, PLOTLY_CFG);
  $("na-note").textContent =
    `Entre paréntesis, nº de estaciones de cada grupo. Cada año exige al menos ${minSt} estaciones con dato en el grupo. ` +
    (byAlt ? "Altitud de la estación según AEMET. " : "Regiones agrupadas por provincia. ") +
    "Los puntos tenues son los valores anuales.";
}

/** Récords absolutos batidos cada año en el conjunto de la red. */
function runNatRecords() {
  const N = state.national;
  const type = $("na-rec-type").value;
  const K = +$("na-rec-k").value;
  const defs = {
    calor: [{ key: "txx", hi: true, name: "Tmax más alta", color: VAR_COLORS.tmax },
            { key: "tnn", hi: false, name: "Tmin más baja", color: VAR_COLORS.tmin }],
    noches: [{ key: "tnx", hi: true, name: "Tmin más alta (noche más cálida)", color: VAR_COLORS.tmax },
             { key: "txn", hi: false, name: "Tmax más baja (día más frío)", color: VAR_COLORS.tmin }],
    lluvia: [{ key: "rx1", hi: true, name: "Lluvia máxima en 24 h", color: VAR_COLORS.prec }],
  }[type];
  if (!N.ext) {
    $("na-note").textContent = "national.json no incluye extremos anuales: regenera con scripts/build_national.py.";
    return;
  }
  const ny = N.y1 - N.y0 + 1;
  const res = defs.map(() => ({ rec: new Array(ny).fill(0), elig: new Array(ny).fill(0), exp: new Array(ny).fill(0) }));
  defs.forEach((d, di) => {
    const R = res[di];
    for (const id in N.stations) {
      const arr = N.stations[id][d.key];
      if (!arr) continue;
      let best = null, nPrev = 0;
      for (let k = 0; k < ny; k++) {
        const x = arr[k];
        if (x === null) continue;
        if (nPrev >= K) {
          R.elig[k]++;
          R.exp[k] += 1 / (nPrev + 1);
          if (d.hi ? x > best : x < best) R.rec[k]++;
        }
        if (best === null || (d.hi ? x > best : x < best)) best = x;
        nPrev++;
      }
    }
  });
  const ys = [];
  for (let k = 0; k < ny; k++) if (res[0].elig[k] >= 20) ys.push(k);
  if (!ys.length) { $("na-note").textContent = "No hay suficientes estaciones con esa longitud de serie."; return; }
  const years = ys.map((k) => N.y0 + k);
  const traces = [];
  defs.forEach((d, di) => {
    const R = res[di], sign = di === 0 ? 1 : -1;
    traces.push({ x: years, y: ys.map((k) => (sign * 100 * R.rec[k]) / R.elig[k]), type: "bar", name: `récords de ${d.name}`,
      marker: { color: d.color }, customdata: ys.map((k) => [R.rec[k], R.elig[k]]),
      hovertemplate: `%{x}: %{customdata[0]} de %{customdata[1]} estaciones<extra>${d.name}</extra>` });
  });
  defs.forEach((d, di) => {
    const R = res[di], sign = di === 0 ? 1 : -1;
    traces.push({ x: years, y: ys.map((k) => (sign * 100 * R.exp[k]) / R.elig[k]), mode: "lines",
      name: di === 0 ? "esperado con clima estable" : undefined, showlegend: di === 0, legendgroup: "exp",
      line: { color: TH.fg, width: 1.5, dash: "dot" }, hovertemplate: "%{x}: esperado %{y:.1f} %<extra></extra>" });
  });
  const layout = baseLayout(`España · % de estaciones que baten su récord absoluto cada año · series de ≥ ${K} años`);
  layout.barmode = "relative";
  layout.yaxis.title = { text: "% de estaciones" };
  if (defs.length > 1) {
    layout.yaxis.tickformat = "";
    layout.yaxis.ticksuffix = " %";
  }
  layout.legend = { orientation: "h", y: -0.14 };
  Plotly.newPlot("plot-nacional-rec", traces, layout, PLOTLY_CFG);

  // ---- por décadas ----
  const decs = [...new Set(years.map((y) => Math.floor(y / 10) * 10))];
  const tot = defs.map((d, di) => decs.map((dc) => ys.filter((k) => Math.floor((N.y0 + k) / 10) * 10 === dc)
    .reduce((s, k) => s + res[di].rec[k], 0)));
  const l2 = baseLayout("");
  l2.margin.t = 10;
  l2.barmode = "group";
  l2.yaxis.title = { text: "récords batidos" };
  l2.legend = { orientation: "h", y: -0.18 };
  if (defs.length > 1) {
    l2.annotations = decs.map((dc, i) => ({ x: `${dc}s`, y: Math.max(tot[0][i], tot[1][i]), yshift: 12, showarrow: false,
      text: tot[1][i] ? `${(tot[0][i] / tot[1][i]).toFixed(1)}:1` : "∞", font: { size: 11, color: TH.muted } }));
  }
  Plotly.newPlot("plot-nacional-recdec", defs.map((d, di) => ({
    x: decs.map((dc) => `${dc}s`), y: tot[di], type: "bar", name: d.name, marker: { color: d.color },
    hovertemplate: "%{x}: %{y} récords<extra>" + d.name + "</extra>",
  })), l2, PLOTLY_CFG);

  const lastK = ys[ys.length - 1];
  const R0 = res[0];
  $("na-note").textContent =
    `Una estación bate su récord cuando el extremo del año supera todos los de sus años anteriores; solo cuentan estaciones con ≥ ${K} años previos válidos. ` +
    `Con un clima estable, la probabilidad de récord en el año n+1 es 1/(n+1): es la línea punteada. ` +
    `En ${N.y0 + lastK}, ${R0.rec[lastK]} de ${R0.elig[lastK]} estaciones batieron su récord de ${defs[0].name}. ` +
    (defs.length > 1 ? "El ratio sobre cada década compara récords cálidos y fríos. " : "") +
    "Años incompletos (cobertura < 90 %) no cuentan.";
}

// ==========================================================
// Estadística: gamma, GEV (L-momentos), SPI
// ==========================================================

function lnGamma(x) {
  // Lanczos (g=7, n=9)
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
             -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
const gammaFn = (x) => Math.exp(lnGamma(x));

/** Gamma incompleta regularizada inferior P(a, x). */
function gammaP(a, x) {
  if (x <= 0) return 0;
  const gln = lnGamma(a);
  if (x < a + 1) {
    let ap = a, sum = 1 / a, del = sum;
    for (let n = 0; n < 300; n++) { ap++; del *= x / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 1e-12) break; }
    return sum * Math.exp(-x + a * Math.log(x) - gln);
  }
  let b = x + 1 - a, c = 1e300, d = 1 / b, h = d;
  for (let i = 1; i < 300; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-12) break;
  }
  return 1 - Math.exp(-x + a * Math.log(x) - gln) * h;
}

/** Inversa de la normal estándar (Acklam). */
function normInv(p) {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
         (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** Ajuste GEV por L-momentos (Hosking, 1985). k > 0 → cola superior acotada. */
function gevFit(sample) {
  const x = [...sample].sort((p, q) => p - q);
  const n = x.length;
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < n; i++) {
    b0 += x[i];
    b1 += (i / (n - 1)) * x[i];
    b2 += ((i * (i - 1)) / ((n - 1) * (n - 2))) * x[i];
  }
  b0 /= n; b1 /= n; b2 /= n;
  const l1 = b0, l2 = 2 * b1 - b0, l3 = 6 * b2 - 6 * b1 + b0;
  if (!(l2 > 0)) return null;
  const t3 = l3 / l2;
  const c = 2 / (3 + t3) - Math.LN2 / Math.log(3);
  const k = 7.8590 * c + 2.9554 * c * c;
  if (Math.abs(k) < 1e-6) {
    const alpha = l2 / Math.LN2;
    return { xi: l1 - 0.5772156649 * alpha, alpha, k: 0 };
  }
  const g = gammaFn(1 + k);
  const alpha = (l2 * k) / ((1 - 2 ** -k) * g);
  return { xi: l1 - (alpha * (1 - g)) / k, alpha, k };
}
function gevQuantile(f, F) {
  const y = -Math.log(F);
  return f.k === 0 ? f.xi - f.alpha * Math.log(y) : f.xi + (f.alpha * (1 - y ** f.k)) / f.k;
}
function gevCdf(f, x) {
  if (f.k === 0) return Math.exp(-Math.exp(-(x - f.xi) / f.alpha));
  const z = 1 - (f.k * (x - f.xi)) / f.alpha;
  if (z <= 0) return f.k > 0 ? 1 : 0;
  return Math.exp(-(z ** (1 / f.k)));
}

/** Extremo de cada año natural con cobertura suficiente. */
function annualExtremes(values, hi, minCov) {
  const S = state.station;
  const acc = new Map();
  for (let i = 0; i < values.length; i++) {
    const y = S.years[i];
    let a = acc.get(y);
    if (!a) { a = { n: 0, ext: null, i: -1 }; acc.set(y, a); }
    const x = values[i];
    if (x === null) continue;
    a.n++;
    if (a.ext === null || (hi ? x > a.ext : x < a.ext)) { a.ext = x; a.i = i; }
  }
  const out = [];
  for (const [y, a] of acc) {
    const diy = (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 366 : 365;
    if (a.ext !== null && a.n >= minCov * diy) out.push({ y, v: a.ext, i: a.i });
  }
  return out.sort((p, q) => p.y - q.y);
}

// ==========================================================
// PRODUCTO: Períodos de retorno
// ==========================================================

const RT_DEFS = {
  txx: { v: "tmax", hi: true, label: "Tmax más alta del año", unit: "°C", word: "máxima de" },
  tnx: { v: "tmin", hi: true, label: "Tmin más alta del año", unit: "°C", word: "mínima de" },
  tnn: { v: "tmin", hi: false, label: "Tmin más baja del año", unit: "°C", word: "mínima de" },
  rx1: { v: "prec", hi: true, label: "Lluvia máxima en 24 h", unit: "mm", word: "lluvia de" },
  rgx: { v: "racha", hi: true, label: "Racha máxima del año", unit: "m/s", word: "racha de" },
};

function runRetorno() {
  const S = state.station;
  const def = RT_DEFS[$("rt-var").value];
  const dos = $("rt-mode").value === "dos";
  document.querySelectorAll(".rt-dos").forEach((e) => { e.hidden = !dos; });
  $("rt-unit").textContent = def.unit;
  const values = S.json.data[def.v];
  if (!values) { $("rt-note").textContent = "La estación no tiene esta variable."; return; }
  const ext = annualExtremes(values, def.hi, def.v === "racha" ? 0.8 : 0.9);
  const yLast = S.yearList[S.yearList.length - 1];
  if (!state.rtTouched) { $("rt-b2").value = yLast; }

  const periods = dos
    ? [{ a: +$("rt-a1").value, b: +$("rt-a2").value, color: VAR_COLORS.tmin },
       { a: +$("rt-b1").value, b: +$("rt-b2").value, color: VAR_COLORS.tmax }]
    : [{ a: S.yearList[0], b: yLast, color: def.hi ? VAR_COLORS.tmax : VAR_COLORS.tmin }];
  const sgn = def.hi ? 1 : -1;
  const fits = [];
  for (const P of periods) {
    const sub = ext.filter((e) => e.y >= P.a && e.y <= P.b);
    P.n = sub.length;
    if (sub.length >= 3) { P.a = Math.max(P.a, sub[0].y); P.b = Math.min(P.b, sub[sub.length - 1].y); }
    P.label = `${P.a}–${P.b}`;
    if (sub.length < 15) { P.fit = null; fits.push(P); continue; }
    P.fit = gevFit(sub.map((e) => sgn * e.v));
    P.sub = sub;
    fits.push(P);
  }
  const ok = fits.filter((P) => P.fit);
  if (!ok.length) {
    $("rt-note").textContent = `Hacen falta al menos 15 años completos por época (hay ${fits.map((P) => `${P.label}: ${P.n}`).join(", ")}).`;
    $("rt-table").querySelector("tbody").innerHTML = ""; $("rt-answer").textContent = "";
    return;
  }

  const Ts = [];
  for (let lt = Math.log10(1.1); lt <= Math.log10(500) + 1e-9; lt += 0.02) Ts.push(10 ** lt);
  const traces = [];
  for (const P of ok) {
    const xs = [...P.sub].sort((p, q) => sgn * p.v - sgn * q.v);
    const n = xs.length;
    traces.push({ x: xs.map((_, i) => 1 / (1 - (i + 1 - 0.44) / (n + 0.12))), y: xs.map((e) => e.v),
      mode: "markers", name: `años ${P.label}`, legendgroup: P.label, showlegend: false,
      marker: { color: P.color, size: 7, opacity: 0.75, line: { color: TH.card, width: 1 } },
      text: xs.map((e) => fmtDate(S.startMs, e.i)),
      hovertemplate: `%{text}: %{y:.1f} ${def.unit}<br>período empírico ≈ %{x:.0f} años<extra>${P.label}</extra>` });
    traces.push({ x: Ts, y: Ts.map((T) => sgn * gevQuantile(P.fit, 1 - 1 / T)), mode: "lines",
      name: `ajuste ${P.label} (${P.n} años)`, legendgroup: P.label, line: { color: P.color, width: 2.5 },
      hovertemplate: `cada %{x:.0f} años: %{y:.1f} ${def.unit}<extra>${P.label}</extra>` });
  }
  const layout = baseLayout(`${S.json.name} · ${def.label}`);
  layout.xaxis.type = "log";
  layout.xaxis.title = { text: "período de retorno (años)" };
  layout.xaxis.tickvals = [1.1, 2, 5, 10, 20, 50, 100, 200, 500];
  layout.xaxis.ticktext = ["1", "2", "5", "10", "20", "50", "100", "200", "500"];
  layout.yaxis.title = { text: def.unit };
  layout.legend = { orientation: "h", y: -0.16 };
  Plotly.newPlot("plot-retorno", traces, layout, PLOTLY_CFG);

  const RT = [2, 5, 10, 20, 50, 100];
  const t = $("rt-table");
  t.querySelector("thead").innerHTML = `<tr><th>Una vez cada…</th>${ok.map((P) => `<th>${P.label}</th>`).join("")}</tr>`;
  t.querySelector("tbody").innerHTML = RT.map((T) =>
    `<tr><td>${T} años</td>${ok.map((P) => `<td>${nf1(sgn * gevQuantile(P.fit, 1 - 1 / T))} ${def.unit}</td>`).join("")}</tr>`).join("");

  // ---- pregunta: ¿cada cuánto se alcanza X? ----
  let X = parseFloat($("rt-val").value);
  if (!Number.isFinite(X)) {
    const rec = ext.reduce((m, e) => (m === null || sgn * e.v > sgn * m.v ? e : m), null);
    X = rec.v;
    $("rt-val").placeholder = nf1(X).replace(",", ".");
  }
  const cmp = def.hi ? "o más" : "o menos";
  const parts = ok.map((P) => {
    const F = gevCdf(P.fit, sgn * X);
    const T = 1 / (1 - F);
    let txt;
    if (F >= 1 - 1e-9) txt = "prácticamente imposible según el ajuste";
    else if (T > 1000) txt = "menos de una vez cada 1000 años";
    else if (T < 1.05) txt = "casi todos los años";
    else txt = `una vez cada <b>${T < 10 ? T.toFixed(1).replace(".", ",") : Math.round(T)} años</b> (${(100 * (1 - F)).toFixed(1).replace(".", ",")} % cada año)`;
    return `${ok.length > 1 ? `en ${P.label}, ` : ""}${txt}`;
  });
  $("rt-answer").innerHTML = `Una ${def.word} <b>${nf1(X)} ${def.unit}</b> ${cmp} se espera ${parts.join("; ")}.`;

  const bounded = ok.filter((P) => P.fit.k > 0).map((P) => `${P.label}: ${nf1(sgn * (P.fit.xi + P.fit.alpha / P.fit.k))} ${def.unit}`);
  $("rt-note").textContent =
    `GEV ajustada por L-momentos al extremo de cada año natural con ≥ ${def.v === "racha" ? 80 : 90} % de días con dato. ` +
    "Supone un clima estable dentro de cada época: comparar dos épocas muestra cuánto ha cambiado. " +
    "Con menos de 30 años la incertidumbre es grande, y los períodos mucho más largos que la serie son extrapolación. " +
    (bounded.length ? `El ajuste tiene un techo teórico (${bounded.join(" · ")}). ` : "") +
    (def.v === "racha" ? "Las rachas dependen mucho del anemómetro y su emplazamiento." : "");
}

// ==========================================================
// PRODUCTO: Sequía (SPI)
// ==========================================================

const SPI_CATS = [
  [2, "extremadamente húmedo"], [1.5, "muy húmedo"], [1, "moderadamente húmedo"], [-1, "normal"],
  [-1.5, "sequía moderada"], [-2, "sequía severa"], [-Infinity, "sequía extrema"],
];
const spiCat = (z) => SPI_CATS.find(([t]) => z >= t || (t === -1 && z > -1))[1];

function monthlyPrec(S) {
  const vals = S.json.data.prec;
  const y0 = S.years[0];
  const nM = (S.years[S.years.length - 1] - y0 + 1) * 12;
  const sum = new Array(nM).fill(0), n = new Array(nM).fill(0), tot = new Array(nM).fill(0);
  for (let i = 0; i < vals.length; i++) {
    const t = (S.years[i] - y0) * 12 + Math.floor(S.md[i] / 100) - 1;
    tot[t]++;
    if (vals[i] !== null) { sum[t] += vals[i]; n[t]++; }
  }
  const DIM = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return { y0, m: sum.map((s, t) => {
    const mo = t % 12, y = y0 + Math.floor(t / 12);
    const dim = DIM[mo] + (mo === 1 && (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 1 : 0);
    return n[t] >= 0.9 * dim ? s : null;
  }) };
}

function computeSPI(monthly, k, refA, refB) {
  const { y0, m } = monthly;
  const acc = m.map((_, t) => {
    if (t < k - 1) return null;
    let s = 0;
    for (let j = t - k + 1; j <= t; j++) { if (m[j] === null) return null; s += m[j]; }
    return s;
  });
  const spi = new Array(acc.length).fill(null);
  for (let mo = 0; mo < 12; mo++) {
    const idx = [];
    for (let t = mo; t < acc.length; t += 12) if (acc[t] !== null) idx.push(t);
    let sample = idx.filter((t) => { const y = y0 + Math.floor(t / 12); return y >= refA && y <= refB; }).map((t) => acc[t]);
    if (sample.length < 20) sample = idx.map((t) => acc[t]);
    if (sample.length < 10) continue;
    const pos = sample.filter((x) => x > 0);
    const q = (sample.length - pos.length) / sample.length;
    if (pos.length < 5) continue;
    const mu = mean(pos);
    const A = Math.log(mu) - mean(pos.map(Math.log));
    const alpha = A > 0 ? (1 + Math.sqrt(1 + (4 * A) / 3)) / (4 * A) : 50;
    const beta = mu / alpha;
    const nZero = sample.length - pos.length;
    for (const t of idx) {
      const x = acc[t];
      let H = x > 0 ? q + (1 - q) * gammaP(alpha, x / beta) : (nZero + 1) / (2 * (sample.length + 1));
      H = Math.min(Math.max(H, 1e-6), 1 - 1e-6);
      spi[t] = normInv(H);
    }
  }
  return spi;
}

function runSPI() {
  const S = state.station;
  if (!S.json.data.prec) { $("spi-note").textContent = "La estación no tiene precipitación."; return; }
  const k = +$("spi-k").value;
  const [refA, refB] = getRef();
  const M = monthlyPrec(S);
  const spi = computeSPI(M, k, refA, refB);
  const x = [], y = [];
  spi.forEach((z, t) => {
    if (z === null) return;
    const yy = M.y0 + Math.floor(t / 12), mo = (t % 12) + 1;
    x.push(`${yy}-${String(mo).padStart(2, "0")}-15`); y.push(z);
  });
  if (y.length < 24) {
    $("spi-note").textContent = "Serie de precipitación demasiado corta o con demasiados huecos para el SPI.";
    $("spi-now").textContent = "";
    return;
  }
  const scale = [[0, "#8c510a"], [0.3, "#d8b365"], [0.5, "#f4f1ea"], [0.7, "#5ab4ac"], [1, "#01665e"]];
  const view = $("spi-view").value;
  const layout = baseLayout(`${S.json.name} · SPI-${k} (lluvia acumulada en ${k} ${k === 1 ? "mes" : "meses"}) · ajuste gamma sobre ${refA}–${refB}`);
  layout.yaxis.title = { text: `SPI-${k}` };
  layout.yaxis.range = [-3.2, 3.2];
  layout.bargap = 0;
  layout.showlegend = false;
  if (view !== "all") {
    const lastY = +x[x.length - 1].slice(0, 4);
    layout.xaxis.range = [`${lastY - +view}-12-01`, x[x.length - 1].slice(0, 8) + "28"];
  }
  layout.shapes = [-2, -1.5, -1, 1, 1.5, 2].map((v) => ({ type: "line", xref: "paper", x0: 0, x1: 1, y0: v, y1: v,
    line: { color: TH.muted, width: 0.8, dash: Math.abs(v) === 1 ? "dash" : "dot" } }));
  Plotly.newPlot("plot-spi", [{
    x, y, type: "bar", marker: { color: y, colorscale: scale, cmin: -2.5, cmax: 2.5 },
    text: y.map(spiCat), hovertemplate: "%{x|%b %Y}: %{y:.2f} · %{text}<extra></extra>",
  }], layout, PLOTLY_CFG);

  // ---- calendario año × mes ----
  const yFirst = M.y0, yLastAll = M.y0 + Math.floor((spi.length - 1) / 12);
  const yrs = [], z = [], txt = [];
  for (let yy = yLastAll; yy >= yFirst; yy--) {
    const row = [], tr = [];
    let any = false;
    for (let mo = 0; mo < 12; mo++) {
      const v = spi[(yy - M.y0) * 12 + mo];
      row.push(v); tr.push(v === null ? "" : `${MESES[mo + 1]} ${yy}: ${v.toFixed(2)} · ${spiCat(v)}`);
      if (v !== null) any = true;
    }
    if (any) { yrs.push(String(yy)); z.push(row); txt.push(tr); }
  }
  const lc = baseLayout("");
  lc.margin = { l: 50, r: 20, t: 10, b: 30 };
  lc.yaxis.type = "category";
  lc.yaxis.dtick = 5;
  lc.yaxis.autorange = "reversed";
  lc.xaxis.side = "top";
  $("plot-spi-cal").style.height = `${Math.max(260, Math.min(1100, yrs.length * 11 + 60))}px`;
  Plotly.newPlot("plot-spi-cal", [{
    type: "heatmap", x: MESES.slice(1), y: yrs, z, text: txt, hovertemplate: "%{text}<extra></extra>",
    colorscale: scale, zmin: -2.5, zmax: 2.5, hoverongaps: false, xgap: 1, ygap: 1,
    colorbar: { title: { text: "SPI" }, thickness: 12, outlinewidth: 0 },
  }], lc, PLOTLY_CFG);

  // ---- situación actual y peor sequía (criterio de McKee) ----
  let lastT = spi.length - 1;
  while (lastT >= 0 && spi[lastT] === null) lastT--;
  const lz = spi[lastT];
  const lyy = M.y0 + Math.floor(lastT / 12), lmo = (lastT % 12) + 1;
  $("spi-now").innerHTML = `Último mes con dato (<b>${MESES_LARGO[lmo]} ${lyy}</b>): SPI-${k} = <b>${lz.toFixed(2).replace(".", ",").replace("-", "−")}</b> → ${spiCat(lz)}.`;
  const events = [];
  let st = -1, minz = 0;
  for (let t = 0; t <= spi.length; t++) {
    const v = t < spi.length ? spi[t] : null;
    if (v !== null && v < 0) { if (st < 0) { st = t; minz = v; } minz = Math.min(minz, v); }
    else { if (st >= 0 && minz <= -1) events.push({ st, len: t - st, minz }); st = -1; }
  }
  const lab = (t) => `${MESES[(t % 12) + 1]} ${M.y0 + Math.floor(t / 12)}`;
  const longest = events.sort((a, b) => b.len - a.len)[0];
  const worst = [...events].sort((a, b) => a.minz - b.minz)[0];
  $("spi-note").textContent =
    (longest ? `Sequía más larga: ${longest.len} meses (${lab(longest.st)} → ${lab(longest.st + longest.len - 1)}). ` : "") +
    (worst ? `Más intensa: SPI ${worst.minz.toFixed(2)} (${lab(worst.st)} → ${lab(worst.st + worst.len - 1)}). ` : "") +
    "Episodio de sequía (McKee): meses seguidos con SPI negativo que llegan a −1 o menos. " +
    "Meses con más del 10 % de días sin dato quedan en blanco y cortan las acumulaciones.";
}

// ==========================================================
// PRODUCTO: Dos estaciones
// ==========================================================

async function runDuel() {
  if (!state.stationB) {
    $("du-note").textContent = "Elige la segunda estación en el buscador de este panel.";
    return;
  }
  const A = state.station, B = state.stationB;
  const v = $("du-var").value;
  const mdS = parseMd($("du-md-start").value);
  const mdE = parseMd($("du-md-end").value);
  if (mdS === null || mdE === null) { $("du-note").textContent = "Ventana no válida."; return; }
  const minCov = 0.8;

  function annual(S) {
    const out = new Map();
    for (const [yr, g] of aggregateWindow(S.json.data[v], mdS, mdE, S)) {
      if (g.nTotal && g.n / g.nTotal >= minCov) out.set(yr, g.sum / g.n);
    }
    return out;
  }
  const mA = annual(A), mB = annual(B);
  const common = [...mA.keys()].filter((y) => mB.has(y)).sort((a, b) => a - b);
  if (common.length < 5) {
    $("du-note").textContent = `Solo ${common.length} años en común con cobertura suficiente.`;
    return;
  }

  const l1 = baseLayout(`${VAR_LABELS[v]} media ${mdLabel(mdS)} → ${mdLabel(mdE)}`);
  l1.yaxis.title = { text: "°C" };
  l1.legend = { orientation: "h", y: -0.15 };
  const yrsA = [...mA.keys()].sort((a, b) => a - b);
  const yrsB = [...mB.keys()].sort((a, b) => a - b);
  Plotly.newPlot("plot-duelo", [
    { x: yrsA, y: yrsA.map((y) => mA.get(y)), mode: "lines+markers",
      name: A.json.name, line: { color: VAR_COLORS.tmax, width: 1.5 }, marker: { size: 4 } },
    { x: yrsB, y: yrsB.map((y) => mB.get(y)), mode: "lines+markers",
      name: B.json.name, line: { color: VAR_COLORS.tmin, width: 1.5 }, marker: { size: 4 } },
  ], l1, PLOTLY_CFG);

  const diffs = common.map((y) => mA.get(y) - mB.get(y));
  const l2 = baseLayout(`Diferencia ${A.json.name} − ${B.json.name}`);
  l2.yaxis.title = { text: "Δ °C" };
  l2.showlegend = false;
  const traces2 = [{
    x: common, y: diffs, type: "bar",
    marker: { color: diffs, colorscale: "RdBu", reversescale: false, cmid: 0 },
    hovertemplate: "%{x}: %{y:+.2f} °C<extra></extra>",
  }];
  const fit = ols(common, diffs);
  let trendTxt = "";
  if (fit) {
    traces2.push({
      x: [common[0], common[common.length - 1]],
      y: [fit.a + fit.b * common[0], fit.a + fit.b * common[common.length - 1]],
      mode: "lines", line: { color: TH.fg, width: 1.5, dash: "dot" }, hoverinfo: "skip",
    });
    trendTxt = ` Tendencia de la diferencia: ${(fit.b * 10>= 0 ? "+" : "")}${(fit.b * 10).toFixed(2)} °C/década (OLS, orientativa).`;
  }
  Plotly.newPlot("plot-duelo-diff", traces2, l2, PLOTLY_CFG);

  $("du-note").textContent =
    `${common.length} años en común. Diferencia media: ` +
    `${(mean(diffs) >= 0 ? "+" : "")}${mean(diffs).toFixed(2)} °C.` + trendTxt +
    " Ojo con cambios de emplazamiento o instrumentación: las series no están homogeneizadas.";
}


// ==========================================================
// Exportar PNG para redes
// ==========================================================

const EXPORT_SIZES = {
  "plot-comparador": [1500, 1500],
  "plot-stripes": [1600, 500],
  "plot-stripes-anom": [1600, 800],
  "plot-rachas": [1600, 900],
  "plot-duelo": [1600, 800],
  "plot-duelo-diff": [1600, 800],
  "plot-olas-cal": [1600, 1200],
  "plot-nacional-mapa": [1500, 1300],
  "plot-nacional-regtr": [1600, 800],
  "plot-spi-cal": [1400, 1600],
  "plot-retorno": [1500, 1100],
};

function loadImage(src) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error("no se pudo generar la imagen"));
    im.src = src;
  });
}

/** Exporta todos los gráficos visibles del análisis en UNA imagen PNG, con firma y fuente al pie. */
async function exportActivePanel() {
  const panel = document.querySelector(".panel:not([hidden])");
  if (!panel) return;
  const plots = [...panel.querySelectorAll(".plot")]
    .filter((d) => d.offsetParent !== null && d.data && d.data.length && d.layout);
  const btn = $("export-png");
  if (!plots.length) {
    alert("No hay ningún gráfico que exportar en esta sección.");
    return;
  }
  btn.disabled = true; btn.textContent = "Generando…";
  const SCALE = 2;
  try {
    const single = plots.length === 1;
    const imgs = [];
    for (const div of plots) {
      let [w, hgt] = EXPORT_SIZES[div.id] || [1600, 1000];
      if (!single) { hgt = Math.round((hgt * 1600) / w); w = 1600; }
      const data = JSON.parse(JSON.stringify(div.data));
      const layout = JSON.parse(JSON.stringify(div.layout));
      delete layout.width; delete layout.height; delete layout.template;
      layout.font = { ...(layout.font || {}), size: 22 };
      if (layout.title && layout.title.text) layout.title.font = { family: FONT, size: 30, color: TH.fg };
      const hasLegend = layout.showlegend !== false && data.filter((t) => t.showlegend !== false).length > 1;
      const isGeo = data.some((t) => t.type === "scattergeo");
      layout.margin = isGeo ? { l: 10, r: 10, t: 90, b: 10 }
        : { l: 110, r: 80, t: layout.title && layout.title.text ? 100 : 40, b: hasLegend ? 160 : 90 };
      if (hasLegend && layout.legend && layout.legend.orientation === "h") layout.legend.y = -0.16;
      const url = await Plotly.toImage({ data, layout, config: { locale: "es" } },
        { format: "png", width: w, height: hgt, scale: SCALE });
      imgs.push(await loadImage(url));
    }
    const FOOT = 90 * SCALE;
    const W = Math.max(...imgs.map((im) => im.width));
    const H = imgs.reduce((s, im) => s + im.height, 0) + FOOT;
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const ctx = cv.getContext("2d");
    ctx.fillStyle = TH.card; ctx.fillRect(0, 0, W, H);
    let y = 0;
    for (const im of imgs) { ctx.drawImage(im, 0, y); y += im.height; }
    ctx.strokeStyle = TH.border; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(40 * SCALE, y + 1); ctx.lineTo(W - 40 * SCALE, y + 1); ctx.stroke();
    ctx.textBaseline = "middle";
    ctx.fillStyle = TH.fg;
    ctx.font = `800 ${26 * SCALE}px "Plus Jakarta Sans", system-ui, sans-serif`;
    ctx.textAlign = "left";
    ctx.fillText("@MeteoZGZ", 40 * SCALE, y + FOOT / 2);
    ctx.fillStyle = TH.muted;
    ctx.font = `500 ${18 * SCALE}px "Plus Jakarta Sans", system-ui, sans-serif`;
    ctx.textAlign = "right";
    ctx.fillText("Datos: AEMET OpenData · ccalvosa.github.io/aemet-explorer", W - 40 * SCALE, y + FOOT / 2);

    const blob = await new Promise((res) => cv.toBlob(res, "image/png"));
    if (!blob) throw new Error("el navegador no pudo crear el PNG");
    const name = panel.id.replace("panel-", "") +
      (panel.id === "panel-nacional" ? `-${state.natView || "evol"}` : "");
    const prefix = state.station && panel.id !== "panel-nacional" ? state.station.json.id : "espana";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${prefix}_${name}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  } catch (e) {
    console.error(e);
    alert(`No se pudo exportar la imagen: ${e.message || e}`);
  } finally {
    btn.disabled = false; btn.textContent = "⤓ PNG";
  }
}

// ==========================================================
// init
// ==========================================================

Object.assign(TAB_RUNNERS, {
  anio: runAnio, evolucion: runEvolution, stripes: runStripes,
  indices: runIndices, rachas: runStreaks, comparador: runComparator,
  olas: runWaves, records: runRecords, periodos: runPeriodos, nacional: runNacional,
  distribucion: runDistribution, calendario: runCalendar, duelo: runDuel,
  retorno: runRetorno, spi: runSPI,
});

const QUICK_PICKS = [
  ["3195", "Madrid Retiro"], ["0076", "Barcelona"], ["8416", "València"], ["5783", "Sevilla"],
  ["9434", "Zaragoza"], ["1082", "Bilbao"], ["6155A", "Málaga"], ["1387", "A Coruña"],
  ["2422", "Valladolid"], ["7178I", "Murcia"], ["B228", "Palma"], ["C447A", "Tenerife Norte"],
];

function renderQuickPicks() {
  const box = $("quick-picks");
  const ids = new Set(state.index.stations.map((s) => s.id));
  for (const [id, label] of QUICK_PICKS) {
    if (!ids.has(id)) continue;
    const b = document.createElement("button");
    b.className = "chip";
    b.textContent = label;
    b.addEventListener("click", () => selectStation(id));
    box.appendChild(b);
  }
}

/** Recalcula automáticamente al cambiar cualquier control del panel. */
function bindControls() {
  $("pe-tipo").addEventListener("change", populatePeriodSubs);
  populatePeriodSubs();
  $("ra-var").addEventListener("change", () => {
    $("ra-unit").textContent = VAR_UNITS[$("ra-var").value];
  });
  for (const [slider, out, suffix] of [["ev-cov", "ev-cov-val", "%"], ["co-cov", "co-cov-val", "%"],
                                       ["st-cov", "st-cov-val", "%"], ["ix-cov", "ix-cov-val", "%"],
                                       ["re-skip", "re-skip-val", ""], ["na-min", "na-min-val", ""]]) {
    $(slider).addEventListener("input", () => { $(out).textContent = `${$(slider).value}${suffix}`; });
  }
  for (const name of Object.keys(TAB_RUNNERS)) {
    $(`panel-${name}`).querySelectorAll(".controls select, .controls input").forEach((el) => {
      if (el.id === "du-search") return;
      el.addEventListener("change", () => {
        if (state.station || name === "nacional") runPanel(name);
      });
    });
  }
  for (const id of ["ref-start", "ref-end"]) {
    $(id).addEventListener("change", () => {
      if ($("app").hidden) return;
      if (state.station) renderEphemeris();
      activateTab(currentTab());
    });
  }
  document.querySelectorAll(".seg-switch").forEach((seg) => seg.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b) activateTab(b.dataset.go);
  }));
  $("na-view").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    state.natView = b.dataset.view;
    $("na-view").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    runPanel("nacional");
  });
  $("na-map-year").addEventListener("input", () => {
    state.natYearTouched = true;
    $("na-map-year-val").textContent = $("na-map-year").value;
    safeRun(runNatMap);
  });
  $("na-play").addEventListener("click", () => {
    if (state.natPlay) { stopNatPlay(); return; }
    const sl = $("na-map-year");
    state.natYearTouched = true;
    if (+sl.value >= +sl.max) sl.value = sl.min;
    $("na-play").textContent = "❚❚";
    state.natPlay = setInterval(() => {
      if (+sl.value >= +sl.max) { stopNatPlay(); return; }
      sl.value = +sl.value + 1;
      safeRun(runNatMap);
    }, 450);
  });
  for (const id of ["rt-a1", "rt-a2", "rt-b1", "rt-b2"]) $(id).addEventListener("change", () => { state.rtTouched = true; });
  $("rt-var").addEventListener("change", () => { $("rt-val").value = ""; });
  $("rec-scope").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    state.recScope = b.dataset.scope;
    $("rec-scope").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    renderEphemeris();
  });
}

function applyTheme() {
  refreshTheme();
  const meta = document.querySelectorAll('meta[name="theme-color"]');
  meta.forEach((m) => m.setAttribute("content", TH.bg));
  if ($("app").hidden) return;
  if (state.station) renderPlate();
  activateTab(currentTab());
}

function bindTheme() {
  $("theme-toggle").addEventListener("click", () => {
    const next = isDark() ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("theme", next); } catch { /* sin almacenamiento */ }
    applyTheme();
  });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (!document.documentElement.dataset.theme) applyTheme();
  });
}

function bindKeys() {
  document.addEventListener("keydown", (e) => {
    if (e.key !== "/" || e.target.matches("input, select, textarea")) return;
    e.preventDefault();
    ($("app").hidden ? $("hero-search") : $("station-search")).focus();
  });
}

function bindExport() {
  $("export-png").addEventListener("click", exportActivePanel);
}

async function init() {
  refreshTheme();
  bindTheme();
  bindExport();
  setupTabs();
  bindControls();
  bindKeys();
  populateIndices();
  try {
    await loadIndex();
  } catch {
    $("hero-badge").textContent = "No se pudo cargar data/index.json";
    return;
  }
  const lastEnd = state.index.stations.reduce((m, s) => (s.end > m ? s.end : m), "");
  $("hero-badge").textContent =
    `${state.index.n_stations} estaciones · datos diarios de AEMET hasta ${lastEnd.slice(0, 4)}`;
  loadRecent().then(() => {
    const R = state.recent;
    let last = R && R.last_data;
    if (R && !last) {
      let li = -1;
      for (const st of Object.values(R.stations)) {
        const tx = st.tmax || [];
        for (let i = tx.length - 1; i > li; i--) if (tx[i] !== null) { li = i; break; }
      }
      if (li >= 0) last = new Date(Date.parse(R.start + "T00:00:00Z") + li * MS_DAY).toISOString().slice(0, 10);
    }
    if (!last) return;
    const [yy, mm, dd] = last.split("-").map(Number);
    $("hero-badge").textContent =
      `${state.index.n_stations} estaciones · datos diarios hasta el ${dd} de ${MESES_LARGO[mm]} de ${yy}`;
  });
  makeSearch($("hero-search"), $("hero-results"), (id) => selectStation(id));
  makeSearch($("station-search"), $("search-results"), (id) => selectStation(id));
  makeSearch($("du-search"), $("du-results"), async (id) => {
    showLoader("Cargando segunda estación…");
    try { state.stationB = await loadStation(id); } finally { hideLoader(); }
    $("du-search").placeholder = `Comparando con: ${state.stationB.json.name}`;
    runDuel();
  });
  $("go-national").addEventListener("click", goNational);
  renderQuickPicks();
  routeFromHash();
  window.addEventListener("hashchange", () => {
    const id = state.station ? state.station.json.id : "espana";
    if (!location.hash.startsWith(`#${encodeURIComponent(id)}/`)) routeFromHash();
  });
}

init();
