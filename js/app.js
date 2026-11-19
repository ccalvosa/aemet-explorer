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
function makeSearch(inputEl, listEl, onPick, opts = {}) {
  let selIdx = -1;
  function render(matches) {
    listEl.innerHTML = "";
    selIdx = -1;
    if (!matches.length) { listEl.hidden = true; return; }
    for (const st of matches) {
      const li = document.createElement("li");
      li.innerHTML =
        `<span class="r-name">${st.name}</span>` +
        `<span class="r-meta">${opts.meta ? opts.meta(st) : `${st.province} · ${st.start.slice(0, 4)}–${st.end.slice(0, 4)}` +
        `${st.altitude !== null ? ` · ${st.altitude} m` : ""} · ${st.id}`}</span>`;
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
    render((opts.list ? opts.list() : state.index.stations).filter((st) =>
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

/** Carga recent.json una sola vez; todas las llamadas esperan a la misma descarga. */
function loadRecent() {
  if (!state.recentP) {
    state.recentP = (async () => {
      try {
        const r = await fetch(`${DATA_URL}/recent.json`);
        if (r.ok) state.recent = await r.json();
      } catch { /* sin recent: la web funciona con el histórico */ }
    })();
  }
  return state.recentP;
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

/** daily.json (valores diarios provisionales de la red automática); una sola descarga. */
function loadDaily() {
  if (!state.dailyP) {
    state.dailyP = (async () => {
      const local = ["localhost", "127.0.0.1", ""].includes(location.hostname);
      const remote = "https://raw.githubusercontent.com/ccalvosa/aemet-explorer/obs/daily.json";
      const urls = local ? [`${DATA_URL}/daily.json`, remote] : [remote, `${DATA_URL}/daily.json`];
      for (const u of urls) {
        try {
          const r = await fetch(`${u}?t=${Math.floor(Date.now() / 300000)}`, { cache: "no-cache" });
          if (r.ok) { state.daily = await r.json(); return state.daily; }
        } catch { /* siguiente */ }
      }
      return null;
    })();
  }
  return state.dailyP;
}

/**
 * Rellena con los valores diarios provisionales las fechas que aún no tienen
 * dato consolidado (nunca sustituye uno). Marca esas fechas en json.prov.
 */
function mergeProvisional(json) {
  const C = state.daily;
  json.prov = {};
  if (!C || !C.st[json.id]) return json;
  const a = C.st[json.id];
  const startMs = Date.parse(json.start + "T00:00:00Z");
  C.days.forEach((ds, k) => {
    const nh = a.nh[k] || 0, np = a.np[k] || 0;
    if (nh < 6 && np < 6) return;
    const idx = Math.round((Date.parse(ds + "T00:00:00Z") - startMs) / MS_DAY);
    if (idx < 0) return;
    const len = json.data[json.vars[0]].length;
    if (idx >= len) {
      for (const v of json.vars) json.data[v].push(...new Array(idx - len + 1).fill(null));
      json.end = ds;
    }
    const D = json.data, used = [];
    const put = (v, x) => { if (D[v] && x !== null && x !== undefined && D[v][idx] === null) { D[v][idx] = x; used.push(v); } };
    if (nh >= 6) {
      put("tmax", a.tx[k]); put("tmin", a.tn[k]);
      if (a.tx[k] !== null && a.tn[k] !== null) put("tmed", Math.round(((a.tx[k] + a.tn[k]) / 2) * 10) / 10);
    }
    if (np >= 6) put("prec", a.p[k]);
    if (used.length) json.prov[ds] = { nh, np, open: nh < 24 || np < 24, vars: used };
  });
  return json;
}

async function loadStation(id) {
  await Promise.all([loadRecent(), loadDaily()]);
  const res = await fetch(`${DATA_URL}/stations/${id}.json`);
  return makeCalendar(mergeProvisional(mergeRecent(await res.json())));
}

/** Información de dato provisional para el índice i de la estación (o null). */
function provInfo(S, i) {
  const p = S.json.prov;
  if (!p) return null;
  return p[fmtDate(S.startMs, i)] || null;
}

function provTxt(info) {
  if (!info) return "";
  return info.open ? `Provisional · día incompleto (${info.nh} de 24 h)` : "Provisional · red automática";
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
    b.disabled = !state.station && !NO_STATION_TABS.has(b.dataset.tab);
    b.title = b.disabled ? "Elige antes una estación" : "";
  });
}

function updateHash() {
  const id = state.station ? state.station.json.id : "espana";
  const tab = currentTab();
  const h = `#${encodeURIComponent(id)}/${tab}${tab === "dia" && state.diaDate ? `/${state.diaDate}` : ""}`;
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
  const m = /^#\/?([^/]+)(?:\/([a-z]+))?(?:\/(\d{4}-\d{2}-\d{2}))?/.exec(location.hash);
  if (!m) return false;
  const id = decodeURIComponent(m[1]);
  if (m[3]) state.diaDate = m[3];
  if (id === "espana") { showApp(); activateTab(NO_STATION_TABS.has(m[2]) ? m[2] : "nacional"); return true; }
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
        `${verdict} — percentil ${pct} de ${refA}–${refB} para esas fechas` +
        (provInfo(S, lastIdx) ? ` <span class="prov-tag">${provTxt(provInfo(S, lastIdx))}</span>` : "") + ". " +
        `<button class="link-btn" data-day="${fmtDate(S.startMs, lastIdx)}">Ver el día completo →</button>`;
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

const NO_STATION_TABS = new Set(["nacional", "ahora"]);

function activateTab(name) {
  if (!state.station && !NO_STATION_TABS.has(name)) return;
  stopNatPlay();
  stopObsPlay();
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
  // pulsar un día del año elegido abre su ficha en «Un día»
  $("plot-anio").on("plotly_click", (ev) => {
    const p = ev.points && ev.points.find((q) => q.data.name === String(year));
    if (!p) return;
    const [, mm, dd] = String(p.x).slice(0, 10).split("-");
    const yy = hydro && +mm >= 10 ? year - 1 : year;
    if (dayIndex(S, `${yy}-${mm}-${dd}`) >= 0) openDay(`${yy}-${mm}-${dd}`);
  });
  const provDays = Object.keys(S.json.prov || {}).filter((d) => +d.slice(0, 4) === year || (hydro && +d.slice(0, 4) === year - 1));
  if (provDays.length) note += `Desde el ${+provDays[0].slice(8)} ${MESES[+provDays[0].slice(5, 7)]} los datos son provisionales (red automática, sin validar). `;
  $("an-note").textContent = note + (note ? " " : "") + "Pulsa un día de la línea del año para ver su ficha completa.";
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
  $("plot-calendario").on("plotly_click", (ev) => {
    const p = ev.points && ev.points[0];
    if (!p || p.z === null || p.z === undefined) return;
    const mo = MESES.indexOf(p.y);
    if (mo > 0) openDay(`${year}-${String(mo).padStart(2, "0")}-${String(p.x).padStart(2, "0")}`);
  });
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
// PRODUCTO: Un día cualquiera — un día frente a su climatología
// ==========================================================

// fem: concordancia de los ordinales ("la 2.ª más alta" / "el 2.º más soleado")
const DAY_VARS = {
  tmax: { label: "Máxima", unit: "°C", cls: "t-tmax", agg: "mean", fem: true, hi: "más alta", lo: "más baja",
          mHi: "más cálido", mLo: "más frío", mLabel: "Máxima media" },
  tmin: { label: "Mínima", unit: "°C", cls: "t-tmin", agg: "mean", fem: true, hi: "más alta", lo: "más baja",
          mHi: "más cálido", mLo: "más frío", mLabel: "Mínima media" },
  tmed: { label: "Media", unit: "°C", cls: "t-tmed", agg: "mean", fem: true, hi: "más alta", lo: "más baja",
          mHi: "más cálido", mLo: "más frío", mLabel: "Temperatura media" },
  prec: { label: "Precipitación", unit: "mm", cls: "t-prec", agg: "sum", fem: true, hi: "más alta", lo: "más baja",
          mHi: "más lluvioso", mLo: "más seco", mLabel: "Precipitación total" },
  racha: { label: "Racha máxima", unit: "km/h", cls: "t-wind", agg: "max", fem: true, hi: "más fuerte", lo: "más floja",
           mHi: "más ventoso", mLo: "menos ventoso", mLabel: "Racha más fuerte" },
  sol: { label: "Sol", unit: "h", cls: "t-sol", agg: "sum", fem: false, hi: "más soleado", lo: "menos soleado",
         mHi: "más soleado", mLo: "menos soleado", mLabel: "Horas de sol" },
};
const DIAS_SEMANA = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const dayColor = (v) => (v === "racha" ? VAR_COLORS.dtr : v === "sol" ? (cssVar("--sol") || "#f08c00") : VAR_COLORS[v]);
const ord = (r, fem) => `${r}.${fem ? "ª" : "º"}`;
const sgnf = (x, d = 1) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(d).replace(".", ",")}`;
const pctTxt = (p) => (p >= 99.5 ? ">99" : p < 0.5 ? "<1" : String(Math.round(p)));
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Serie de la variable en unidades de la ficha (racha en km/h). Cacheada por estación. */
function dayValues(S, v) {
  const raw = S.json.data[v];
  if (!raw) return null;
  if (v !== "racha") return raw;
  if (!S._rachaKmh) S._rachaKmh = raw.map((x) => (x === null ? null : Math.round(x * 36) / 10));
  return S._rachaKmh;
}

function dayIndex(S, iso) {
  const t = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(t)) return -1;
  const i = Math.round((t - S.startMs) / MS_DAY);
  return i >= 0 && i < S.md.length ? i : -1;
}

/** Último día con Tmax, Tmin o precipitación. */
function lastDataIndex(S) {
  const D = S.json.data;
  for (let i = S.md.length - 1; i >= 0; i--) {
    if ((D.tmax && D.tmax[i] !== null) || (D.tmin && D.tmin[i] !== null) || (D.prec && D.prec[i] !== null)) return i;
  }
  return S.md.length - 1;
}

function pctRank(sorted, x) {
  if (!sorted.length) return NaN;
  let lt = 0, eq = 0;
  for (const u of sorted) { if (u < x) lt++; else if (u === x) eq++; else break; }
  return (100 * (lt + 0.5 * eq)) / sorted.length;
}

/**
 * Estadísticos de una variable para el día i:
 *  pool      valores del período normal en ±W días alrededor de la fecha (climatología del día)
 *  monthPool valores del período normal en todo el mes
 *  sameDay   la misma fecha en todos los años [{y, v, i}]
 *  monthAll  todos los valores de ese mes en toda la serie (récords del mes)
 */
function dayStats(S, v, i, W, refA, refB) {
  const vals = dayValues(S, v);
  if (!vals) return null;
  const md = S.md[i], mo = Math.floor(md / 100);
  const p0 = MD_IDX_365.get(md === 229 ? 228 : md);
  const pool = [], monthPool = [], sameDay = [], monthAll = [];
  let absHi = -Infinity, absLo = Infinity;
  for (let j = 0; j < vals.length; j++) {
    const u = vals[j];
    if (u === null) continue;
    const m = S.md[j], y = S.years[j];
    if (u > absHi) absHi = u;
    if (u < absLo) absLo = u;
    if (m === md) sameDay.push({ y, v: u, i: j });
    if (Math.floor(m / 100) !== mo) {
      if (y < refA || y > refB) continue;
    } else {
      monthAll.push(u);
      if (y >= refA && y <= refB) monthPool.push(u);
    }
    if (y < refA || y > refB) continue;
    let d = Math.abs(MD_IDX_365.get(m === 229 ? 228 : m) - p0);
    d = Math.min(d, 365 - d);
    if (d <= W) pool.push(u);
  }
  const num = (a, b) => a - b;
  pool.sort(num); monthPool.sort(num); monthAll.sort(num);
  return { v, x: vals[i], pool, monthPool, sameDay, monthAll, absHi, absLo, md, mo };
}

/** Puesto de x entre los valores (1 = el más alto / el más bajo) y empates. */
function rankOf(list, x) {
  let gt = 0, lt = 0, eq = 0;
  for (const u of list) { if (u > x) gt++; else if (u < x) lt++; else eq++; }
  return { hi: gt + 1, lo: lt + 1, ties: eq - 1, n: list.length };
}

/** Agregado de un mes (días 1..dEnd) para cada año. Map(año → valor) solo con cobertura suficiente. */
function monthAggregate(S, v, mo, dEnd) {
  const vals = v === "raindays" ? S.json.data.prec : dayValues(S, v);
  if (!vals) return new Map();
  const agg = v === "raindays" ? "count" : DAY_VARS[v].agg;
  const g = new Map();
  for (let j = 0; j < vals.length; j++) {
    const m = S.md[j];
    if (Math.floor(m / 100) !== mo || m % 100 > dEnd) continue;
    const u = vals[j];
    if (u === null) continue;
    const y = S.years[j];
    let o = g.get(y);
    if (!o) { o = { sum: 0, n: 0, max: -Infinity, cnt: 0 }; g.set(y, o); }
    o.sum += u; o.n++;
    if (u > o.max) o.max = u;
    if (u >= 1) o.cnt++;
  }
  const minCov = agg === "mean" || agg === "max" ? 0.8 : 0.9;
  const out = new Map();
  for (const [y, o] of g) {
    if (o.n < minCov * Math.min(dEnd, daysInMonth(y, mo))) continue;
    out.set(y, agg === "mean" ? o.sum / o.n : agg === "sum" ? o.sum : agg === "max" ? o.max : o.cnt);
  }
  return out;
}

function fmtVal(v, x) {
  if (v === "racha") return String(Math.round(x));
  return nf1(x);
}

// ---------- ficha ----------

function buildDayTiles(S, i, stats, refA, refB) {
  const tiles = [];
  const md = S.md[i];
  const dayTxt = `un ${md % 100} de ${MESES[Math.floor(md / 100)]}`;
  const mesTxt = MESES_LARGO[Math.floor(md / 100)];
  for (const st of stats) {
    const def = DAY_VARS[st.v];
    const T = { v: st.v, label: def.label, unit: def.unit, color: dayColor(st.v), cls: def.cls, badges: [] };
    tiles.push(T);
    if (st.x === null) { T.val = "—"; T.lines = ["Sin dato este día"]; continue; }
    T.val = fmtVal(st.v, st.x);
    T.lines = [];
    const normal = st.pool.length ? mean(st.pool) : null;
    if (st.v === "prec") {
      const rainy = st.pool.filter((u) => u >= 0.1);
      const prob = st.pool.length ? (100 * rainy.length) / st.pool.length : NaN;
      if (st.x < 0.1) {
        T.anom = "Día seco";
        T.anomCls = "";
        if (Number.isFinite(prob)) T.lines.push(`Llueve ${Math.round(prob)} de cada 100 días en estas fechas`);
      } else {
        T.pct = pctRank(rainy, st.x);
        T.anom = st.x >= 1 ? "Día de lluvia" : "Lluvia débil (menos de 1 mm)";
        T.anomCls = "up";
        T.lines.push(`percentil ${pctTxt(T.pct)} de los días de lluvia` +
          (Number.isFinite(prob) ? ` · llueve el ${Math.round(prob)} %` : ""));
        const r = rankOf(st.sameDay.map((o) => o.v), st.x);
        if (r.hi <= Math.max(10, r.n / 4)) T.lines.push(`la ${ord(r.hi, true)} más alta de ${dayTxt} (${r.n} años)`);
        if (r.hi === 1) T.badges.push(r.ties > 0 ? "Iguala el récord del día" : "Récord del día");
        const rm = rankOf(st.monthAll, st.x);
        if (rm.hi === 1) T.badges.push(`Récord de ${mesTxt}`);
        else if (rm.hi <= 10) T.badges.push(`Top ${rm.hi} de ${mesTxt}`);
        if (st.x >= st.absHi) T.badges.push("Récord absoluto");
      }
      continue;
    }
    if (normal !== null) {
      const an = st.x - normal;
      T.pct = pctRank(st.pool, st.x);
      T.anom = `${sgnf(an, st.v === "racha" ? 0 : 1)} ${def.unit} ${an >= 0 ? "sobre" : "bajo"} lo normal`;
      T.anomCls = an >= 0 ? "up" : "down";
      const pm = st.monthPool.length ? pctRank(st.monthPool, st.x) : null;
      T.lines.push(`normal ${fmtVal(st.v, normal)} ${def.unit} · percentil ${pctTxt(T.pct)}` +
        (pm !== null ? ` (${pctTxt(pm)} en ${mesTxt})` : ""));
    }
    const r = rankOf(st.sameDay.map((o) => o.v), st.x);
    if (r.n >= 5) {
      const up = r.hi <= r.lo;
      const k = up ? r.hi : r.lo;
      T.lines.push(k <= r.n / 3
        ? `la ${ord(k, def.fem)} ${up ? def.hi : def.lo} de ${dayTxt} (${r.n} años)`
          .replace(/^la (\d+\.º)/, "el $1")
        : `${dayTxt.replace(/^un/, "Un")}: puesto ${r.hi} de ${r.n}`);
      if (r.hi === 1) T.badges.push(r.ties > 0 ? "Iguala el récord del día" : "Récord del día");
      else if (r.lo === 1 && st.v !== "racha") T.badges.push(r.ties > 0 ? "Iguala el récord del día" : `Récord del día (${def.lo})`);
    }
    const rm = rankOf(st.monthAll, st.x);
    if (rm.hi === 1) T.badges.push(`Récord de ${mesTxt}`);
    else if (rm.lo === 1 && st.v !== "racha" && st.v !== "sol") T.badges.push(`Récord de ${mesTxt} (${def.lo})`);
    else if (rm.hi <= 5) T.badges.push(`Top ${rm.hi} de ${mesTxt}`);
    else if (rm.lo <= 5 && st.v !== "racha" && st.v !== "sol") T.badges.push(`Top ${rm.lo} de ${mesTxt} (${def.lo})`);
    if (st.x >= st.absHi) T.badges.push("Récord absoluto");
    else if (st.x <= st.absLo && st.v !== "racha" && st.v !== "sol") T.badges.push("Récord absoluto (mínimo)");
    if (st.v === "tmin") {
      if (st.x >= 25) T.badges.push("Noche tórrida");
      else if (st.x >= 20) T.badges.push("Noche tropical");
      else if (st.x < 0) T.badges.push("Helada");
    }
    if (st.v === "tmax") {
      if (st.x >= 40) T.badges.push("40 °C o más");
      else if (st.x < 0) T.badges.push("Día sin deshielo");
    }
  }
  return tiles;
}

function renderDayTiles(tiles) {
  const pbar = (T) => {
    if (!Number.isFinite(T.pct)) return "";
    return `<div class="pbar ${T.v === "prec" ? "pbar-prec" : ""}" title="percentil ${Math.round(T.pct)}">` +
      `<span style="left:${Math.max(1.5, Math.min(98.5, T.pct))}%"></span></div>`;
  };
  $("dia-tiles").innerHTML = tiles.map((T) =>
    `<div class="rec-tile day-tile ${T.cls}">` +
      `<div class="rl">${T.label}</div>` +
      `<div class="rv">${T.val}<small>${T.val === "—" ? "" : ` ${T.unit}`}</small></div>` +
      (T.anom ? `<div class="dt-anom ${T.anomCls || ""}">${T.anom}</div>` : "") +
      pbar(T) +
      T.lines.map((l) => `<div class="rd">${l}</div>`).join("") +
      (T.badges.length ? `<div class="badges">${T.badges.map((b) => `<span class="badge">${b}</span>`).join("")}</div>` : "") +
    `</div>`).join("");
}

// ---------- tabla del mes ----------

function buildMonthRows(S, Y, mo, dEnd, refA, refB) {
  const rows = [];
  const vars = ["tmax", "tmin", "tmed", "prec", "raindays", "racha", "sol"]
    .filter((v) => (v === "raindays" ? S.json.data.prec : S.json.data[v]));
  for (const v of vars) {
    const M = monthAggregate(S, v, mo, dEnd);
    const x = M.get(Y);
    const def = v === "raindays"
      ? { mLabel: "Días de lluvia (≥ 1 mm)", unit: "días", mHi: "con más días de lluvia", mLo: "con menos días de lluvia" }
      : DAY_VARS[v];
    const refVals = [...M].filter(([y]) => y >= refA && y <= refB).map(([, u]) => u);
    const normal = refVals.length >= 5 ? mean(refVals) : null;
    const row = { v, label: def.mLabel, unit: def.unit, x, normal, n: M.size };
    if (x !== undefined) {
      const r = rankOf([...M.values()], x);
      const up = r.hi <= r.lo;
      row.rank = up ? r.hi : r.lo;
      row.rankTxt = `${ord(row.rank, false)} ${up ? def.mHi : def.mLo}`;
      row.top = row.rank <= 3;
      if (normal !== null) {
        if (v === "prec" || v === "sol") {
          row.anom = normal > 0 ? `${Math.round((100 * x) / normal)} %` : "—";
          row.anomCls = x >= normal ? (v === "prec" ? "wet" : "up") : (v === "prec" ? "dry" : "down");
        } else {
          row.anom = `${sgnf(x - normal, v === "racha" || v === "raindays" ? 0 : 1)}`;
          row.anomCls = x >= normal ? "up" : "down";
        }
      }
    }
    rows.push(row);
  }
  return rows;
}

function renderMonthTable(rows, Y, mo, dEnd, full, refA, refB) {
  const t = $("dia-month");
  const per = full ? `${cap(MESES_LARGO[mo])} ${Y}` : `1–${dEnd} ${MESES[mo]} ${Y}`;
  t.querySelector("thead").innerHTML =
    `<tr><th></th><th>${per}</th><th>Normal ${refA}–${refB}</th><th>Diferencia</th><th>Puesto</th></tr>`;
  const fv = (r, x) => (r.v === "raindays" ? String(Math.round(x)) : r.v === "racha" ? String(Math.round(x))
    : r.v === "prec" || r.v === "sol" ? (x >= 100 ? String(Math.round(x)) : nf1(x)) : nf1(x));
  t.querySelector("tbody").innerHTML = rows.map((r) =>
    `<tr${r.top ? ' class="hl"' : ""}><td>${r.label}</td>` +
    `<td><b>${r.x === undefined ? "—" : `${fv(r, r.x)} ${r.unit}`}</b></td>` +
    `<td>${r.normal === null ? "—" : `${fv(r, r.normal)} ${r.unit}`}</td>` +
    `<td class="${r.anomCls || ""}">${r.anom || "—"}</td>` +
    `<td>${r.rankTxt ? `${r.rankTxt} <span class="muted">de ${r.n}</span>` : "—"}</td></tr>`).join("");
}

// ---------- titular ----------

function dayHeadline(S, i, tiles, mrows, full, dEnd) {
  const md = S.md[i], d = md % 100, mo = Math.floor(md / 100), Y = S.years[i];
  const get = (v) => tiles.find((T) => T.v === v && T.val !== "—");
  const parts = [];
  const tx = get("tmax"), tn = get("tmin"), pr = get("prec");
  if (tx) {
    let s = `máxima de <b>${tx.val} °C</b>`;
    if (tx.anom) s += ` (${tx.anom})`;
    parts.push(s);
  }
  if (tn) {
    let s = `mínima de <b>${tn.val} °C</b>`;
    const tag = tn.badges.find((b) => /Noche|Helada/.test(b));
    if (tag) s += ` — ${tag.toLowerCase()}`;
    parts.push(s);
  }
  if (pr) parts.push(pr.anom === "Día seco" ? "sin lluvia" : `<b>${pr.val} mm</b> de lluvia`);
  let txt = `El ${DIAS_SEMANA[new Date(S.startMs + i * MS_DAY).getUTCDay()]} ${d} de ${MESES_LARGO[mo]} de ${Y}` +
    ` en ${S.json.name}: ${parts.join(", ")}.`;
  const recs = tiles.flatMap((T) => T.badges.filter((b) => /Récord|Iguala/.test(b)).map((b) => `${b.toLowerCase()} de ${T.label.toLowerCase()}`));
  if (recs.length) txt += ` 🏆 ${cap(recs.slice(0, 3).join(" · "))}.`;
  const mt = mrows.find((r) => r.v === "tmed" && r.rank && r.rank <= 10) || mrows.find((r) => r.v === "prec" && r.rank && r.rank <= 5);
  if (mt) {
    const pos = mt.rank === 1 ? mt.rankTxt.replace(/^1\.º /, "") : mt.rankTxt;
    txt += full
      ? ` ${cap(MESES_LARGO[mo])} de ${Y} fue el ${pos} de ${mt.n} años.`
      : ` En lo que va de ${MESES_LARGO[mo]} (hasta el día ${dEnd}), ${Y} es el ${pos} de ${mt.n} años.`;
  }
  return txt;
}

// ---------- gráficos ----------

/** «Ese día en la historia»: cada fila, una variable; un punto por año en esa fecha. */
function plotDaySwarm(S, i, stats, refA, refB, W) {
  const rows = stats.filter((st) => st.sameDay.length >= 5);
  const Y = S.years[i];
  const n = rows.length;
  const gap = 0.11, h = (1 - gap * (n - 1)) / n;
  const layout = baseLayout(`${S.json.name} · un ${S.md[i] % 100} de ${MESES_LARGO[Math.floor(S.md[i] / 100)]} en la historia`);
  layout.margin = { l: 20, r: 20, t: 70, b: 30 };
  layout.showlegend = false;
  layout.shapes = []; layout.annotations = [];
  const traces = [];
  const y0 = S.yearList[0], y1 = S.yearList[S.yearList.length - 1];
  const jit = (y) => (((y * 7919) % 101) / 101 - 0.5) * 1.3;
  rows.forEach((st, k) => {
    const def = DAY_VARS[st.v], col = dayColor(st.v);
    const ax = k === 0 ? "" : String(k + 1);
    const top = 1 - k * (h + gap), bot = top - h;
    layout[`xaxis${ax}`] = { ...layout.xaxis, domain: [0, 1], anchor: `y${ax}`, ticksuffix: ` ${def.unit}`,
      zeroline: false, showgrid: true, automargin: true };
    layout[`yaxis${ax}`] = { ...layout.yaxis, domain: [bot, top], anchor: `x${ax}`, range: [-1, 1],
      showticklabels: false, showgrid: false, zeroline: false, fixedrange: true };
    const others = st.sameDay.filter((o) => o.y !== Y);
    traces.push({ x: others.map((o) => o.v), y: others.map((o) => jit(o.y)), xaxis: `x${ax}`, yaxis: `y${ax}`,
      mode: "markers", type: "scatter", text: others.map((o) => o.y),
      marker: { size: 8, color: others.map((o) => o.y), cmin: y0, cmax: y1,
                colorscale: [[0, hexToRgba(TH.muted, 0.18)], [1, hexToRgba(col, 0.85)]],
                line: { width: 0 } },
      hovertemplate: `%{text}: %{x:.1f} ${def.unit}<extra>${def.label}</extra>` });
    if (st.pool.length >= 10) {
      const p10 = quantile(st.pool, 0.1), p90 = quantile(st.pool, 0.9), mu = mean(st.pool);
      layout.shapes.push({ type: "rect", xref: `x${ax}`, yref: `y${ax}`, x0: p10, x1: p90, y0: -0.95, y1: 0.95,
        fillcolor: TH.band, line: { width: 0 }, layer: "below" });
      layout.shapes.push({ type: "line", xref: `x${ax}`, yref: `y${ax}`, x0: mu, x1: mu, y0: -0.95, y1: 0.95,
        line: { color: TH.muted, width: 1.5, dash: "dot" }, layer: "below" });
    }
    let lab = `<b>${def.label}</b>`;
    if (st.x !== null) {
      traces.push({ x: [st.x], y: [0], xaxis: `x${ax}`, yaxis: `y${ax}`, mode: "markers+text", type: "scatter",
        text: [`${Y}`], textposition: "top center", textfont: { color: col, family: FONT },
        marker: { size: 17, color: col, symbol: "diamond", line: { color: TH.card, width: 2 } },
        hovertemplate: `${Y}: %{x:.1f} ${def.unit}<extra>${def.label}</extra>` });
      lab += ` · ${fmtVal(st.v, st.x)} ${def.unit}`;
      if (st.v !== "prec" && st.pool.length) lab += ` · percentil ${pctTxt(pctRank(st.pool, st.x))}`;
    } else lab += " · sin dato";
    layout.annotations.push({ xref: "paper", yref: "paper", x: 0, y: top + 0.005, xanchor: "left", yanchor: "bottom",
      text: lab, showarrow: false, font: { color: TH.fg } });
  });
  const hpx = 70 + n * 125;
  $("plot-dia-swarm").style.height = `${hpx}px`;
  EXPORT_SIZES["plot-dia-swarm"] = [1600, 160 + n * 250];
  if (!window.matchMedia("(max-width: 560px)").matches) layout.annotations.push({ xref: "paper", yref: "paper", x: 1, y: 1.0, yanchor: "bottom", xanchor: "right", showarrow: false,
    text: `banda: rango habitual P10–P90 ${refA}–${refB} (±${W} d) · color: más intenso = más reciente`,
    font: { size: 11, color: TH.muted } });
  Plotly.newPlot("plot-dia-swarm", traces, layout, PLOTLY_CFG);
  $("plot-dia-swarm").on("plotly_click", (ev) => {
    const p = ev.points && ev.points[0];
    if (!p || typeof p.text !== "number") return;
    gotoDayYear(p.text);
  });
}

/** El mes del día elegido, día a día, frente a la climatología de cada fecha. */
function plotDayMonth(S, i, v, W, refA, refB) {
  const def = DAY_VARS[v], col = dayColor(v);
  const vals = dayValues(S, v);
  const Y = S.years[i], mo = Math.floor(S.md[i] / 100), dim = daysInMonth(Y, mo);
  const iStart = i - (S.md[i] % 100 - 1);
  const xs = [], ys = [];
  for (let d = 0; d < dim; d++) {
    const j = iStart + d;
    xs.push(`${Y}-${String(mo).padStart(2, "0")}-${String(d + 1).padStart(2, "0")}`);
    ys.push(j >= 0 && j < vals.length ? vals[j] : null);
  }
  const selX = xs[S.md[i] % 100 - 1];
  const layout = baseLayout(`${S.json.name} · ${def.label} en ${MESES_LARGO[mo]} de ${Y}`);
  layout.xaxis = { ...layout.xaxis, type: "date", tickformat: "%-d %b",
    dtick: (window.matchMedia("(max-width: 560px)").matches ? 7 : 2) * MS_DAY,
    range: [Date.parse(xs[0]) - 0.6 * MS_DAY, Date.parse(xs[dim - 1]) + 0.6 * MS_DAY] };
  layout.yaxis.ticksuffix = ` ${def.unit}`;
  layout.legend = { orientation: "h", y: -0.14 };
  layout.shapes = [{ type: "line", xref: "x", yref: "paper", x0: selX, x1: selX, y0: 0, y1: 1,
    line: { color: ACCENT, width: 1.5, dash: "dot" } }];
  let traces;
  if (v === "prec") {
    // acumulado del mes frente a los años del período normal
    const cum = (row) => { let s = 0, n = 0; return row.map((u) => { if (u !== null) { s += u; n++; } return n ? s : null; }); };
    const refCum = [];
    for (let y = refA; y <= refB; y++) {
      const ms = Date.UTC(y, mo - 1, 1), j0 = Math.round((ms - S.startMs) / MS_DAY);
      const row = [];
      let nn = 0;
      for (let d = 0; d < dim; d++) {
        const j = j0 + d, u = j >= 0 && j < vals.length ? vals[j] : null;
        if (u !== null) nn++;
        row.push(u);
      }
      if (nn >= 0.9 * dim) refCum.push(cum(row));
    }
    const qs = (q) => xs.map((_, d) => {
      const c = refCum.map((r) => r[d]).filter((u) => u !== null).sort((a, b) => a - b);
      return c.length ? quantile(c, q) : null;
    });
    const p10 = qs(0.1), p50 = qs(0.5), p90 = qs(0.9);
    const yc = cum(ys);
    let lastJ = dim - 1;
    while (lastJ > 0 && ys[lastJ] === null) lastJ--;
    traces = [
      { x: xs, y: p90, mode: "lines", line: { width: 0 }, hoverinfo: "skip", showlegend: false },
      { x: xs, y: p10, mode: "lines", line: { width: 0 }, fill: "tonexty", fillcolor: TH.band,
        name: `acumulado habitual (P10–P90 ${refA}–${refB})`, hoverinfo: "skip" },
      { x: xs, y: p50, mode: "lines", line: { color: TH.muted, dash: "dash", width: 1.5 }, name: "acumulado mediano",
        hovertemplate: "%{x|%-d %b}: %{y:.1f} mm<extra>mediana</extra>" },
      { x: xs, y: ys, type: "bar", name: "lluvia del día", marker: { color: hexToRgba(col, 0.55) },
        hovertemplate: "%{x|%-d %b}: %{y:.1f} mm<extra>día</extra>" },
      { x: xs.slice(0, lastJ + 1), y: yc.slice(0, lastJ + 1), mode: "lines", name: `acumulado ${Y}`,
        line: { color: col, width: 3 }, hovertemplate: "%{x|%-d %b}: %{y:.1f} mm<extra>acumulado</extra>" },
    ];
  } else {
    const clim = climDaily(vals, refA, refB, W);
    const recHi = new Map(), recLo = new Map();
    for (let j = 0; j < vals.length; j++) {
      const u = vals[j];
      if (u === null || Math.floor(S.md[j] / 100) !== mo) continue;
      const m = S.md[j];
      if (!recHi.has(m) || u > recHi.get(m).v) recHi.set(m, { v: u, y: S.years[j] });
      if (!recLo.has(m) || u < recLo.get(m).v) recLo.set(m, { v: u, y: S.years[j] });
    }
    const mds = xs.map((_, d) => mo * 100 + d + 1);
    const cq = (q) => mds.map((m) => { const s = clim.sorted.get(m === 229 ? 228 : m); return s ? quantile(s, q) : null; });
    const rec = (M) => mds.map((m) => (M.has(m) ? M.get(m) : null));
    const rh = rec(recHi), rl = rec(recLo);
    traces = [
      { x: xs, y: cq(0.9), mode: "lines", line: { width: 0 }, hoverinfo: "skip", showlegend: false },
      { x: xs, y: cq(0.1), mode: "lines", line: { width: 0 }, fill: "tonexty", fillcolor: TH.band,
        name: `rango habitual (P10–P90 ${refA}–${refB})`, hoverinfo: "skip" },
      { x: xs, y: mds.map((m) => clim.mean.get(m === 229 ? 228 : m) ?? null), mode: "lines", name: "normal",
        line: { color: TH.muted, dash: "dash", width: 1.5 }, hovertemplate: `%{x|%-d %b}: %{y:.1f} ${def.unit}<extra>normal</extra>` },
      { x: xs, y: rh.map((r) => r && r.v), text: rh.map((r) => r && r.y), mode: "lines", name: "récord del día",
        line: { color: VAR_COLORS.tmax, dash: "dot", width: 1.3 },
        hovertemplate: `%{x|%-d %b}: %{y:.1f} ${def.unit} en %{text}<extra>récord alto</extra>` },
    ];
    if (v !== "racha" && v !== "sol") {
      traces.push({ x: xs, y: rl.map((r) => r && r.v), text: rl.map((r) => r && r.y), mode: "lines", name: "récord bajo",
        line: { color: VAR_COLORS.tmin, dash: "dot", width: 1.3 },
        hovertemplate: `%{x|%-d %b}: %{y:.1f} ${def.unit} en %{text}<extra>récord bajo</extra>` });
    }
    traces.push({ x: xs, y: ys, mode: "lines+markers", name: String(Y), line: { color: col, width: 2.6 },
      marker: { size: 6, color: col }, connectgaps: false,
      hovertemplate: `%{x|%-d %b %Y}: %{y:.1f} ${def.unit}<extra></extra>` });
  }
  const yi = ys[S.md[i] % 100 - 1];
  if (yi !== null && v !== "prec") {
    traces.push({ x: [selX], y: [yi], mode: "markers", showlegend: false, hoverinfo: "skip",
      marker: { size: 15, color: ACCENT, symbol: "diamond", line: { color: TH.card, width: 2 } } });
  }
  Plotly.newPlot("plot-dia-mes", traces, layout, PLOTLY_CFG);
  $("plot-dia-mes").on("plotly_click", (ev) => {
    const p = ev.points && ev.points[0];
    if (!p || !p.x) return;
    const iso = String(p.x).slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) setDayDate(iso);
  });
}

/** Serie anual de un valor (el de la fecha o el del mes) con el año elegido resaltado. */
function plotYearSeries(div, title, pts, Y, def, v, normal, unitSuffix) {
  const col = dayColor(v);
  const isSum = v === "prec";
  const sel = pts.find((p) => p.y === Y);
  const layout = baseLayout(title);
  layout.showlegend = false;
  layout.yaxis.ticksuffix = ` ${unitSuffix}`;
  layout.margin = { ...layout.margin, b: 40 };
  const traces = [];
  const cols = pts.map((p) => {
    if (p.y === Y) return ACCENT;
    if (isSum || normal === null) return hexToRgba(col, 0.55);
    return p.v >= normal ? hexToRgba(VAR_COLORS.tmax, 0.6) : hexToRgba(VAR_COLORS.tmin, 0.6);
  });
  if (isSum) {
    traces.push({ x: pts.map((p) => p.y), y: pts.map((p) => p.v), type: "bar", marker: { color: cols },
      hovertemplate: `%{x}: %{y:.1f} ${unitSuffix}<extra></extra>` });
  } else {
    traces.push({ x: pts.map((p) => p.y), y: pts.map((p) => p.v), mode: "markers", type: "scatter",
      marker: { color: cols, size: pts.map((p) => (p.y === Y ? 14 : 7)), line: { color: TH.card, width: 1 } },
      hovertemplate: `%{x}: %{y:.1f} ${unitSuffix}<extra></extra>` });
    // tendencia lineal
    if (pts.length >= 20) {
      const f = ols(pts.map((p) => p.y), pts.map((p) => p.v));
      if (f) {
        const xa = pts[0].y, xb = pts[pts.length - 1].y;
        traces.push({ x: [xa, xb], y: [f.a + f.b * xa, f.a + f.b * xb], mode: "lines",
          line: { color: TH.fg, width: 1.5, dash: "dash" }, hoverinfo: "skip" });
        layout.annotations = [{ xref: "paper", yref: "paper", x: 0, y: 1.02, xanchor: "left", yanchor: "bottom",
          showarrow: false, font: { size: 12, color: TH.muted },
          text: `tendencia ${sgnf(f.b * 10, v === "racha" ? 1 : 2)} ${unitSuffix}/década` }];
      }
    }
  }
  if (normal !== null) {
    layout.shapes = [{ type: "line", xref: "paper", x0: 0, x1: 1, y0: normal, y1: normal,
      line: { color: TH.muted, width: 1.2, dash: "dot" } }];
  }
  if (sel) {
    layout.annotations = [...(layout.annotations || []), { x: sel.y, y: sel.v, text: `<b>${Y}</b>`, showarrow: true,
      arrowhead: 0, ax: 0, ay: -26, font: { color: ACCENT, size: 13 }, bgcolor: TH.card }];
  }
  Plotly.newPlot(div, traces, layout, PLOTLY_CFG);
  $(div).on("plotly_click", (ev) => {
    const p = ev.points && ev.points[0];
    if (p && Number.isFinite(+p.x)) gotoDayYear(+p.x);
  });
}

// ---------- navegación por fechas ----------

function setDayDate(iso) {
  const S = state.station;
  if (!S || dayIndex(S, iso) < 0) return;
  state.diaDate = iso;
  $("dia-date").value = iso;
  if (currentTab() === "dia") { updateHash(); runPanel("dia"); } else activateTab("dia");
}

/** Mismo día y mes, otro año (29-feb → 28-feb si no es bisiesto). */
function gotoDayYear(y) {
  const cur = state.diaDate;
  if (!cur) return;
  let md = cur.slice(5);
  if (md === "02-29" && daysInMonth(y, 2) === 28) md = "02-28";
  setDayDate(`${y}-${md}`);
}

/** Abre «Un día» con una fecha (desde el calendario, el año en curso, el último dato…). */
function openDay(iso) {
  state.diaDate = iso;
  activateTab("dia");
}

function shiftDay(k) {
  const S = state.station;
  const i = dayIndex(S, $("dia-date").value);
  if (i < 0) return;
  const j = Math.max(0, Math.min(S.md.length - 1, i + k));
  setDayDate(fmtDate(S.startMs, j));
}

// ---------- principal ----------

function runDia() {
  const S = state.station;
  const [refA, refB] = getRef();
  const W = +$("dia-win").value;
  const minIso = fmtDate(S.startMs, 0), maxIso = fmtDate(S.startMs, lastDataIndex(S));
  const inp = $("dia-date");
  inp.min = minIso; inp.max = maxIso;
  let iso = state.diaDate || inp.value;
  if (!iso || dayIndex(S, iso) < 0 || iso > maxIso) iso = maxIso;
  state.diaDate = iso;
  inp.value = iso;
  updateHash();
  const i = dayIndex(S, iso);
  const Y = S.years[i], md = S.md[i], mo = Math.floor(md / 100);

  const vars = Object.keys(DAY_VARS).filter((v) => S.json.data[v]);
  const stats = vars.map((v) => dayStats(S, v, i, W, refA, refB)).filter((st) => st && st.sameDay.length);
  const tiles = buildDayTiles(S, i, stats, refA, refB);
  const pvi = provInfo(S, i);
  if (pvi && pvi.open) {
    // día en curso: la máxima aún puede subir y la mínima bajar
    for (const T of tiles) {
      if (["tmax", "tmin", "tmed", "prec"].includes(T.v) && T.badges.length) T.badges = T.badges.map((b) => `${b} (de momento)`);
    }
  }
  renderDayTiles(tiles);

  // mes: completo, o hasta el último dato si está en curso
  const lastI = lastDataIndex(S);
  const monthEndI = i + (daysInMonth(Y, mo) - md % 100);
  const full = monthEndI <= lastI;
  const dEnd = full ? daysInMonth(Y, mo) : S.md[lastI] % 100;
  const mrows = buildMonthRows(S, Y, mo, dEnd, refA, refB);
  renderMonthTable(mrows, Y, mo, dEnd, full, refA, refB);
  $("dia-month-title").textContent = full
    ? `${cap(MESES_LARGO[mo])} de ${Y} frente a otros ${MESES_LARGO[mo]}`
    : `Del 1 al ${dEnd} de ${MESES_LARGO[mo]} de ${Y} frente a las mismas fechas de otros años`;

  let head = dayHeadline(S, i, tiles, mrows, full, dEnd);
  if (pvi) head += pvi.open
    ? ` Ojo: día en curso con datos provisionales de la red automática (${pvi.nh} de 24 h); la máxima aún puede subir y la mínima bajar.`
    : " Datos provisionales de la red automática, pendientes de validación por AEMET.";
  $("dia-headline").innerHTML = head;
  const dow = DIAS_SEMANA[new Date(S.startMs + i * MS_DAY).getUTCDay()];
  $("dia-card-date").textContent = `${cap(dow)}, ${md % 100} de ${MESES_LARGO[mo]} de ${Y}`;
  const pv = provInfo(S, i);
  $("dia-card-sub").innerHTML = `${S.json.name} (${S.json.province}) · normal ${refA}–${refB}, ±${W} días` +
    (pv ? ` <span class="prov-tag">${provTxt(pv)}</span>` : "");
  state.diaCard = { title: S.json.name, date: $("dia-card-date").textContent,
    sub: `${S.json.province}${S.json.altitude !== null ? ` · ${S.json.altitude} m` : ""} · normal ${refA}–${refB}` +
      (pv ? ` · ${provTxt(pv).toLowerCase()}` : ""),
    tiles, headline: head.replace(/<[^>]+>/g, "").replace(/🏆/g, "★") };

  plotDaySwarm(S, i, stats, refA, refB, W);

  // variable de los gráficos de detalle
  const sel = $("dia-var");
  const prev = sel.value || "tmax";
  sel.innerHTML = vars.map((v) => `<option value="${v}">${DAY_VARS[v].label}</option>`).join("");
  sel.value = vars.includes(prev) ? prev : vars[0];
  const v = sel.value, def = DAY_VARS[v];
  plotDayMonth(S, i, v, W, refA, refB);

  const st = stats.find((s) => s.v === v);
  if (st) {
    const pts = st.sameDay.map((o) => ({ y: o.y, v: o.v }));
    const normal = st.pool.length ? mean(st.pool) : null;
    plotYearSeries("plot-dia-anios", `${def.label} de un ${md % 100} de ${MESES[mo]}, año a año`, pts, Y, def, v,
      normal, def.unit);
  }
  const M = monthAggregate(S, v, mo, dEnd);
  const mpts = [...M].sort((a, b) => a[0] - b[0]).map(([y, u]) => ({ y, v: u }));
  const refV = mpts.filter((p) => p.y >= refA && p.y <= refB).map((p) => p.v);
  plotYearSeries("plot-dia-mesanios",
    `${def.mLabel} de ${full ? MESES_LARGO[mo] : `1–${dEnd} ${MESES[mo]}`}, año a año`, mpts, Y, def, v,
    refV.length >= 5 ? mean(refV) : null, def.unit);

  $("dia-note").textContent =
    `Climatología del día: valores de ${refA}–${refB} entre ${W} días antes y ${W} después de la fecha; ` +
    "la del mes, todos los días de ese mes en el mismo período. Puestos y récords usan toda la serie, " +
    "incluido el propio día. El percentil de la lluvia se calcula solo sobre los días que llovió. " +
    "La racha está en km/h. Pulsa cualquier punto de los gráficos para saltar a ese día.";
}

// ---------- ficha para compartir (canvas) ----------

function wrapLines(ctx, text, maxW) {
  const words = text.split(/\s+/), lines = [];
  let cur = "";
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t;
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Dibuja la ficha del día en un canvas de 1600 px de ancho lógico. */
function dayCardCanvas(SCALE) {
  const C = state.diaCard;
  const W = 1600, PAD = 56, COLS = 3, GAP = 22;
  const tw = (W - 2 * PAD - GAP * (COLS - 1)) / COLS, th = 300;
  const F = (w, s) => `${w} ${s * SCALE}px "Plus Jakarta Sans", system-ui, sans-serif`;
  const probe = document.createElement("canvas").getContext("2d");
  probe.font = F(500, 26);
  const headLines = wrapLines(probe, C.headline, (W - 2 * PAD) * SCALE);
  const rows = Math.ceil(C.tiles.length / COLS);
  const H = 190 + rows * (th + GAP) + headLines.length * 40 + 50;
  const cv = document.createElement("canvas");
  cv.width = W * SCALE; cv.height = H * SCALE;
  const ctx = cv.getContext("2d");
  ctx.scale(SCALE, SCALE);
  const font = (w, s) => `${w} ${s}px "Plus Jakarta Sans", system-ui, sans-serif`;
  ctx.fillStyle = TH.card; ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";
  ctx.fillStyle = ACCENT; ctx.font = font(700, 24);
  ctx.fillText(C.date.toUpperCase(), PAD, 72);
  ctx.fillStyle = TH.fg; ctx.font = font(800, 50);
  ctx.fillText(C.title, PAD, 128);
  ctx.fillStyle = TH.muted; ctx.font = font(500, 22);
  ctx.fillText(C.sub, PAD, 164);

  const rr = (x, y, w, h, r) => {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  };
  C.tiles.forEach((T, k) => {
    const x = PAD + (k % COLS) * (tw + GAP), y = 196 + Math.floor(k / COLS) * (th + GAP);
    rr(x, y, tw, th, 18); ctx.fillStyle = TH.card2; ctx.fill();
    ctx.fillStyle = T.color; rr(x, y + 24, 6, th - 48, 3); ctx.fill();
    ctx.fillStyle = TH.muted; ctx.font = font(700, 22);
    ctx.fillText(T.label.toUpperCase(), x + 30, y + 46);
    ctx.fillStyle = T.color; ctx.font = font(800, 64);
    ctx.fillText(T.val, x + 30, y + 118);
    const vw = ctx.measureText(T.val).width;
    if (T.val !== "—") { ctx.font = font(700, 28); ctx.fillText(` ${T.unit}`, x + 30 + vw, y + 118); }
    let yy = y + 158;
    if (T.anom) {
      ctx.fillStyle = T.anomCls === "up" ? VAR_COLORS.tmax : T.anomCls === "down" ? VAR_COLORS.tmin : TH.fg;
      if (T.v === "prec" && T.anomCls === "up") ctx.fillStyle = VAR_COLORS.prec;
      ctx.font = font(700, 23); ctx.fillText(T.anom, x + 30, yy); yy += 22;
    }
    if (Number.isFinite(T.pct)) {
      const bx = x + 30, bw = tw - 60, by = yy;
      const g = ctx.createLinearGradient(bx, 0, bx + bw, 0);
      if (T.v === "prec") { g.addColorStop(0, hexToRgba(VAR_COLORS.prec, 0.15)); g.addColorStop(1, VAR_COLORS.prec); } else {
        g.addColorStop(0, VAR_COLORS.tmin); g.addColorStop(0.5, TH.border); g.addColorStop(1, VAR_COLORS.tmax);
      }
      rr(bx, by, bw, 10, 5); ctx.fillStyle = g; ctx.fill();
      const px = bx + (bw * Math.max(1.5, Math.min(98.5, T.pct))) / 100;
      ctx.beginPath(); ctx.arc(px, by + 5, 11, 0, 2 * Math.PI); ctx.fillStyle = TH.fg; ctx.fill();
      ctx.lineWidth = 3; ctx.strokeStyle = TH.card2; ctx.stroke();
      ctx.fillStyle = TH.muted; ctx.font = font(600, 18);
      ctx.fillText(`percentil ${pctTxt(T.pct)}`, bx, by + 38);
      yy = by + 66;
    }
    ctx.fillStyle = T.badges.length ? ACCENT : TH.muted;
    ctx.font = font(700, 19);
    const btxt = T.badges.length ? `★ ${T.badges.slice(0, 2).join(" · ")}` : (T.lines[T.lines.length - 1] || "");
    const bl = wrapLines(ctx, btxt, tw - 60).slice(0, 2);
    bl.forEach((l, q) => ctx.fillText(l, x + 30, Math.min(yy + q * 26, y + th - 18 - (bl.length - 1 - q) * 26)));
  });
  let y = 196 + rows * (th + GAP) + 30;
  ctx.fillStyle = TH.fg; ctx.font = font(500, 26);
  for (const l of headLines) { ctx.fillText(l, PAD, y); y += 40; }
  return cv;
}

// ==========================================================
// PRODUCTO: Última hora — observaciones cada 10 minutos de las últimas 24 h
// ==========================================================

const OBS_REMOTE = "https://raw.githubusercontent.com/ccalvosa/aemet-explorer/obs/obs.json";
const OBS_MAXAGE = 10 * 60000;   // recarga si los datos en memoria tienen más de 10 min
const MAD_FMT = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit",
  day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const RUMBOS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSO", "SO", "OSO", "O", "ONO", "NO", "NNO"];
const rumbo = (deg) => (deg === null || deg === undefined ? "" : RUMBOS[Math.round(deg / 22.5) % 16]);
const TEMP_SCALE = [[0, "#313695"], [0.15, "#4575b4"], [0.3, "#74add1"], [0.42, "#abd9e9"], [0.5, "#ffffbf"],
  [0.6, "#fdae61"], [0.75, "#f46d43"], [0.88, "#d73027"], [1, "#a50026"]];
const PREC_SCALE = [[0, "#e7f5e9"], [0.15, "#a9dfb0"], [0.35, "#4fb06d"], [0.6, "#1c7ed6"], [0.85, "#5f3dc4"], [1, "#862e9c"]];
const WIND_SCALE = [[0, "#f3f0ff"], [0.3, "#b197fc"], [0.6, "#7048e8"], [0.85, "#c2255c"], [1, "#862e3c"]];
const HR_SCALE = [[0, "#b08968"], [0.4, "#ede0d4"], [0.7, "#74c0fc"], [1, "#1864ab"]];

/** "YYYY-MM-DD HH:MM" en hora peninsular (para ejes de Plotly). */
function madridStr(ms) {
  const p = Object.fromEntries(MAD_FMT.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
const madridHour = (ms) => madridStr(ms).slice(11, 16);
function madridLabel(ms) {
  const s = madridStr(ms);
  const today = madridStr(Date.now()).slice(0, 10);
  const yest = madridStr(Date.now() - MS_DAY).slice(0, 10);
  const d = s.slice(0, 10);
  const day = d === today ? "hoy" : d === yest ? "ayer" : `${+d.slice(8)} ${MESES[+d.slice(5, 7)]}`;
  return `${day} a las ${s.slice(11, 16)}`;
}

/** "SANTA CRUZ DE TENERIFE" → "Santa Cruz de Tenerife". */
function titleCase(t) {
  return (t || "").toLowerCase().replace(/(^|[\s(/-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase())
    .replace(/(?<=\s)(De|Del|La|Las|El|Los|Y|D')(?=\s)/g, (w) => w.toLowerCase());
}

/** Nombre legible: el del catálogo si la estación está en él; si no, el de AEMET en minúsculas. */
function obsName(id) {
  const st = state.index && state.index.stations.find((s) => s.id === id);
  if (st) return st.name;
  const raw = (state.obs.meta[id] || [id])[0] || id;
  return titleCase(raw);
}

async function loadObs(force) {
  if (!force && state.obs && Date.now() - state.obs.loadedAt < OBS_MAXAGE) return state.obs;
  const bust = `?t=${Math.floor(Date.now() / 300000)}`;
  const local = ["localhost", "127.0.0.1", ""].includes(location.hostname);
  const urls = local ? [`${DATA_URL}/obs.json`, OBS_REMOTE] : [OBS_REMOTE, `${DATA_URL}/obs.json`];
  let O = null;
  for (const u of urls) {
    try {
      const r = await fetch(u + bust, { cache: "no-cache" });
      if (r.ok) { O = await r.json(); break; }
    } catch { /* siguiente fuente */ }
  }
  if (!O) throw new Error("sin datos de observación");
  O.loadedAt = Date.now();
  O.t0ms = Date.parse(O.t0);
  O.stepMs = (O.step || 3600) * 1000;
  O.h0ms = Date.parse(O.h0 || O.t0);
  O.nh = O.nh || O.n;
  O.ids = Object.keys(O.data);
  // instantes (de 10 min) con temperatura en alguna estación
  O.avail = [];
  for (let k = 0; k < O.n; k++) {
    if (O.ids.some((id) => O.data[id].ta && O.data[id].ta[k] !== null)) O.avail.push(k);
  }
  O.kLast = O.avail.length ? O.avail[O.avail.length - 1] : O.n - 1;
  // horas de la rejilla horaria que tienen algún instante con datos
  const availMs = new Set(O.avail.map((k) => O.t0ms + k * O.stepMs));
  O.hAvail = [];
  for (let j = 0; j < O.nh; j++) {
    const end = O.h0ms + j * 3600000;
    for (let ms = end - 3600000 + O.stepMs; ms <= end; ms += O.stepMs) if (availMs.has(ms)) { O.hAvail.push(j); break; }
  }
  state.obs = O;
  O.list = O.ids.filter((id) => O.meta[id] && O.meta[id][1] !== null).map((id) => {
    const m = O.meta[id], inIdx = state.index && state.index.stations.find((s) => s.id === id);
    return { id, name: obsName(id), province: inIdx ? inIdx.province : "", altitude: m[3],
             lat: m[1], lon: m[2], n_days: inIdx ? inIdx.n_days : 0 };
  });
  state.obs = O;
  return O;
}

const obsMs = (k) => state.obs.t0ms + k * state.obs.stepMs;
const obsHMs = (j) => state.obs.h0ms + j * 3600000;
const obsVal = (a, k) => (a && a[k] !== null && a[k] !== undefined ? a[k] : null);

/** Índices de 10 min dentro de la hora j de la rejilla horaria: (fin − 60 min, fin]. */
function slotsOfHour(j) {
  const O = state.obs;
  const end = Math.round((obsHMs(j) - O.t0ms) / O.stepMs), per = Math.round(3600000 / O.stepMs), out = [];
  for (let k = end - per + 1; k <= end; k++) if (k >= 0 && k < O.n) out.push(k);
  return out;
}

/** Lluvia de la hora j: la horaria o, si falta, la suma de sus 10 min (con al menos 5 de 6). */
function hourPrec(D, j) {
  const p = obsVal(D.prec, j);
  if (p !== null) return p;
  const ks = slotsOfHour(j).map((k) => obsVal(D.p10, k)).filter((x) => x !== null);
  return ks.length >= Math.max(1, slotsOfHour(j).length - 1) ? ks.reduce((t, x) => t + x, 0) : null;
}

/** Resumen de las últimas 24 h de una estación. Extremos solo si hay dato en ≥ 75 % de las horas. */
function obsSummary(id) {
  const O = state.obs, D = O.data[id];
  const need = Math.max(3, 0.75 * O.hAvail.length);
  let hoursOk = 0;
  for (const j of O.hAvail) {
    if (obsVal(D.tamax, j) !== null || slotsOfHour(j).some((k) => obsVal(D.ta, k) !== null)) hoursOk++;
  }
  const covered = hoursOk >= need;
  let tmax = null, tmin = null, gust = null;
  for (const k of O.avail) {
    const t = obsVal(D.ta, k);
    if (t !== null) {
      if (!tmax || t > tmax.v) tmax = { v: t, ms: obsMs(k) };
      if (!tmin || t < tmin.v) tmin = { v: t, ms: obsMs(k) };
    }
    const g = obsVal(D.vmax, k);
    if (g !== null && (!gust || g > gust.v)) gust = { v: g, ms: obsMs(k), dir: obsVal(D.dmax, k) };
  }
  // los extremos horarios salen de datos de cada minuto: pueden superar a los de 10 min
  for (const j of O.hAvail) {
    const a = obsVal(D.tamax, j), b = obsVal(D.tamin, j);
    if (a !== null && (!tmax || a > tmax.v)) tmax = { v: a, ms: obsHMs(j), hourly: true };
    if (b !== null && (!tmin || b < tmin.v)) tmin = { v: b, ms: obsHMs(j), hourly: true };
  }
  let psum = 0, pn = 0;
  for (const j of O.hAvail) { const p = hourPrec(D, j); if (p !== null) { psum += p; pn++; } }
  let lastK = null;
  for (let q = O.avail.length - 1; q >= 0; q--) if (obsVal(D.ta, O.avail[q]) !== null) { lastK = O.avail[q]; break; }
  const firstK = D.ta ? O.avail.find((k) => obsVal(D.ta, k) !== null) : undefined;
  let p1 = null, dp3 = null;
  if (lastK !== null) {
    const per = Math.round(3600000 / O.stepMs), ks = [];
    for (let k = lastK - per + 1; k <= lastK; k++) { const x = obsVal(D.p10, k); if (x !== null) ks.push(x); }
    if (ks.length >= per - 1) p1 = ks.reduce((t, x) => t + x, 0);
    else {
      const j = Math.round((obsMs(lastK) - O.h0ms) / 3600000);
      if (obsHMs(j) === obsMs(lastK)) p1 = obsVal(D.prec, j);
    }
    const p = obsVal(D.pres, lastK), k3 = lastK - Math.round(3 * 3600000 / O.stepMs);
    let pPrev = null;
    for (const d of [0, -1, 1, -2, 2]) { pPrev = obsVal(D.pres, k3 + d); if (pPrev !== null) break; }
    if (p !== null && pPrev !== null) dp3 = p - pPrev;
  }
  const spanH = lastK !== null && firstK !== undefined ? ((lastK - firstK) * O.stepMs) / 3600000 : 0;
  return {
    lastK, lastMs: lastK !== null ? obsMs(lastK) : null, ta: obsVal(D.ta, lastK),
    tmax: covered ? tmax : null, tmin: covered ? tmin : null, gust: covered ? gust : null,
    prec: pn >= need ? psum : null, p1,
    hr: obsVal(D.hr, lastK), pres: obsVal(D.pres, lastK), dp3,
    d24: spanH >= 6 ? { v: D.ta[lastK] - D.ta[firstK], span: Math.round(spanH) } : null,
  };
}

/** Valor de cada estación para el mapa y las clasificaciones (k: instante de 10 min). */
function obsField(v, k) {
  const O = state.obs, out = [];
  const back = Math.round(3600000 / O.stepMs) - 1;   // vale el último dato de la hora anterior
  for (const st of O.list) {
    const D = O.data[st.id];
    let z = null, ms = null;
    let note = null;
    if (v === "atx" || v === "atn") {
      const r = dayCmp(st.id, $("ah-day").value);
      if (r) {
        const val = v === "atx" ? r.tx : r.tn, nrm = v === "atx" ? r.ntx : r.ntn, pc = v === "atx" ? r.ptx : r.ptn;
        if (val !== null && nrm !== null) {
          z = Math.round((val - nrm) * 10) / 10;
          note = `${nf1(val)} °C${pc !== null ? ` · P${pctTxt(pc)}` : ""}`;
        }
      }
      if (z !== null) out.push({ st, z, ms: null, note });
      continue;
    }
    if (v === "ta" || v === "hr") {
      for (let q = k; q >= Math.max(0, k - back); q--) {
        const x = obsVal(D[v], q);
        if (x !== null) { z = x; ms = obsMs(q); break; }
      }
    } else {
      const S = obsSummary(st.id);
      if (v === "tamax" && S.tmax) { z = S.tmax.v; ms = S.tmax.ms; }
      else if (v === "tamin" && S.tmin) { z = S.tmin.v; ms = S.tmin.ms; }
      else if (v === "prec") { z = S.prec; }
      else if (v === "vmax" && S.gust) { z = Math.round(S.gust.v * 3.6); ms = S.gust.ms; }
      else if (v === "d24" && S.d24) { z = Math.round(S.d24.v * 10) / 10; }
    }
    if (z !== null && z !== undefined) out.push({ st, z, ms });
  }
  return out;
}

/** Valores provisionales y comparación climatológica de una estación para el día ds. */
function dayCmp(id, ds) {
  const C = state.daily;
  if (!C || !ds || !C.cmp[ds] || !C.cmp[ds][id] || !C.st[id]) return null;
  const k = C.days.indexOf(ds), a = C.st[id], c = C.cmp[ds][id];
  return { tx: a.tx[k], tn: a.tn[k], nh: a.nh[k] || 0, ntx: c[0], ptx: c[1], ntn: c[2], ptn: c[3],
           rtxHi: [c[4], c[5]], rtxLo: [c[6], c[7]], rtnHi: [c[8], c[9]], rtnLo: [c[10], c[11]],
           mtxHi: [c[12], c[13]], mtnLo: [c[14], c[15]] };
}

const dayLabel = (ds) => `${+ds.slice(8)} de ${MESES_LARGO[+ds.slice(5, 7)]}`;

/** Récords (de la fecha o del mes) que superan los valores provisionales del día ds. */
function dayRecords(ds) {
  const C = state.daily, out = [];
  if (!C || !C.cmp[ds]) return out;
  const mes = MESES_LARGO[+ds.slice(5, 7)];
  for (const id of Object.keys(C.cmp[ds])) {
    const st = state.index.stations.find((x) => x.id === id);
    if (!st || st.n_days < 30 * 365) continue;          // solo series de 30 años o más
    const r = dayCmp(id, ds);
    const chk = (val, rec, hi, what) => {
      if (val === null || rec[0] === null) return;
      if (hi ? val > rec[0] : val < rec[0]) out.push({ id, name: st.name, what, val, old: rec[0], year: rec[1], month: what.includes(mes) });
    };
    chk(r.tx, r.mtxHi, true, `máxima más alta de ${mes}`);
    chk(r.tn, r.mtnLo, false, `mínima más baja de ${mes}`);
    if (!out.some((o) => o.id === id && o.what.startsWith("máxima"))) chk(r.tx, r.rtxHi, true, "máxima más alta para la fecha");
    if (!out.some((o) => o.id === id && o.what.startsWith("mínima más baja"))) chk(r.tn, r.rtnLo, false, "mínima más baja para la fecha");
    // con el día incompleto, la mínima aún puede bajar y la máxima subir: esos récords no están asegurados
    if (r.nh >= 24) {
      chk(r.tn, r.rtnHi, true, "mínima más alta para la fecha");
      chk(r.tx, r.rtxLo, false, "máxima más baja para la fecha");
    }
  }
  return out.sort((a, b) => (b.month - a.month) || (Math.abs(b.val - b.old) - Math.abs(a.val - a.old)));
}

function renderDayRecords() {
  const box = $("ah-records");
  const ds = $("ah-day").value;
  const C = state.daily;
  if (!C || !ds) { box.hidden = true; return; }
  const recs = dayRecords(ds);
  const isToday = ds === C.days[C.days.length - 1];
  const head = `<b>🏆 Récords provisionales · ${isToday ? "hoy" : "ayer"}, ${dayLabel(ds)}</b>` +
    (isToday ? ` <span class="muted">(día en curso: solo se cuentan los récords ya asegurados, máximas que superan el récord y mínimas que bajan del suyo)</span>` : "");
  box.hidden = false;
  if (!recs.length) {
    box.innerHTML = `${head}<p class="muted">Ninguna estación con más de 30 años de datos está batiendo un récord de su fecha.</p>`;
    return;
  }
  const li = recs.slice(0, 14).map((o) =>
    `<li data-id="${o.id}"><b>${o.name}</b> — ${o.what}: <b>${nf1(o.val)} °C</b> ` +
    `<span class="muted">(antes ${nf1(o.old)} °C en ${o.year})</span></li>`).join("");
  box.innerHTML = `${head}<ul class="rec-list">${li}</ul>` +
    (recs.length > 14 ? `<p class="muted">… y ${recs.length - 14} más.</p>` : "") +
    `<p class="muted">${recs.length} récords en estaciones con más de 30 años de datos. Valores sin validar, de la red automática.</p>`;
}

const OBS_DEFS = {
  ta: { label: "Temperatura", unit: "°C", fmt: ".1f", hiT: "Más calor", loT: "Más frío" },
  atx: { label: "Anomalía de la máxima", unit: "°C", fmt: "+.1f", hiT: "Máximas más cálidas para la fecha", loT: "Máximas más frías para la fecha", day: true },
  atn: { label: "Anomalía de la mínima", unit: "°C", fmt: "+.1f", hiT: "Mínimas más cálidas para la fecha", loT: "Mínimas más frías para la fecha", day: true },
  tamax: { label: "Máxima de las últimas 24 h", unit: "°C", fmt: ".1f", hiT: "Máximas más altas", loT: "Máximas más bajas" },
  tamin: { label: "Mínima de las últimas 24 h", unit: "°C", fmt: ".1f", hiT: "Mínimas más altas", loT: "Mínimas más bajas" },
  prec: { label: "Lluvia acumulada en 24 h", unit: "mm", fmt: ".1f", hiT: "Más lluvia", loT: null },
  vmax: { label: "Racha máxima en 24 h", unit: "km/h", fmt: ".0f", hiT: "Rachas más fuertes", loT: null },
  hr: { label: "Humedad relativa", unit: "%", fmt: ".0f", hiT: "Más húmedo", loT: "Más seco" },
  d24: { label: "Cambio de temperatura en 24 h", unit: "°C", fmt: "+.1f", hiT: "Más se calienta", loT: "Más se enfría" },
};

function stopObsPlay() {
  if (state.obsPlay) { clearInterval(state.obsPlay); state.obsPlay = null; }
  const b = $("ah-play");
  if (b) b.textContent = "▶";
}

async function runAhora() {
  let O;
  showLoader("Cargando la última hora…");
  try { [O] = await Promise.all([loadObs(), loadDaily()]); } catch {
    hideLoader();
    $("ah-status").innerHTML = "No se han podido cargar las observaciones. Prueba de nuevo en unos minutos.";
    return;
  } finally { hideLoader(); }
  const ageMin = Math.round((Date.now() - obsMs(O.kLast)) / 60000);
  const spanH = Math.round(((O.kLast - O.avail[0]) * O.stepMs) / 3600000);
  $("ah-status").innerHTML =
    `<span class="live-dot${ageMin > 90 ? " stale" : ""}"></span>Última observación: <b>${madridLabel(obsMs(O.kLast))}</b> ` +
    `(hora peninsular) · ${O.list.length} estaciones · datos cada 10 minutos de las últimas ${Math.min(24, spanH)} h`;
  const sl = $("ah-hour");
  sl.min = O.avail[0]; sl.max = O.kLast;
  if (!state.obsHourTouched || +sl.value > O.kLast || +sl.value < O.avail[0]) sl.value = O.kLast;
  const C = state.daily, sel = $("ah-day");
  if (C) {
    const ds = Object.keys(C.cmp).sort().reverse();
    const prevSel = sel.value;
    sel.innerHTML = ds.map((d, q) => `<option value="${d}">${q === 0 ? "Hoy" : "Ayer"}, ${dayLabel(d)}${q === 0 ? " (en curso)" : ""}</option>`).join("");
    // por la mañana la máxima de hoy aún no significa nada: se empieza por ayer
    const utcH = new Date().getUTCHours();
    sel.value = ds.includes(prevSel) ? prevSel : (utcH < 14 && ds[1] && Object.keys(C.cmp[ds[1]]).length ? ds[1] : ds[0]);
  }
  runAhoraMap();
  renderDayRecords();
  if (!state.obsSel || !O.data[state.obsSel]) {
    const cur = state.station && O.data[state.station.json.id] ? state.station.json.id : null;
    state.obsSel = cur || (O.data["3195"] ? "3195" : O.list[0].id);
  }
  renderObsStation(state.obsSel);
}

function runAhoraMap() {
  const O = state.obs;
  if (!O) return;
  const v = $("ah-var").value, def = OBS_DEFS[v];
  const inst = v === "ta" || v === "hr";
  $("ah-hour-wrap").hidden = !inst;
  $("ah-day-wrap").hidden = !def.day;
  const h = +$("ah-hour").value;
  $("ah-hour-val").textContent = madridLabel(obsMs(h));
  const pts = obsField(v, inst ? h : O.kLast);
  if (!pts.length) {
    Plotly.purge("plot-ahora-mapa");
    $("ah-note").textContent = def.day ? "Aún no hay valores diarios provisionales para ese día." : "";
    return;
  }
  const zs = pts.map((p) => p.z).sort((a, b) => a - b);
  let cs, cmin, cmax;
  if (v === "prec") { cs = PREC_SCALE; cmin = 0; cmax = Math.max(10, quantile(zs, 0.98)); }
  else if (v === "vmax") { cs = WIND_SCALE; cmin = 0; cmax = Math.max(60, quantile(zs, 0.98)); }
  else if (v === "hr") { cs = HR_SCALE; cmin = 20; cmax = 100; }
  else if (def.day) { cs = DIV_TEMP; cmin = -8; cmax = 8; }
  else if (v === "d24") { cs = DIV_TEMP; const a = Math.max(3, Math.abs(quantile(zs, 0.02)), Math.abs(quantile(zs, 0.98))); cmin = -a; cmax = a; }
  else {
    cs = TEMP_SCALE;
    // escala fija por día para que la animación no cambie de colores
    const all = [];
    for (const id of O.ids) {
      const arr = O.data[id][v === "ta" ? "ta" : v];
      if (arr) for (const x of arr) if (x !== null) all.push(x);
    }
    all.sort((a, b) => a - b);
    cmin = Math.floor(quantile(all, 0.01)); cmax = Math.ceil(quantile(all, 0.99));
  }
  // en lluvia, las estaciones secas debajo y pequeñas
  if (v === "prec") pts.sort((a, b) => a.z - b.z);
  const canary = (p) => p.st.lat < 30;
  const mk = (list, geo, showscale) => ({
    type: "scattergeo", geo, lat: list.map((p) => p.st.lat), lon: list.map((p) => p.st.lon),
    text: list.map((p) => `<b>${p.st.name}</b>` + (p.note ? ` · ${p.note}` : p.ms ? ` · ${madridHour(p.ms)}` : "")),
    customdata: list.map((p) => [p.z, p.st.id]),
    hovertemplate: `%{text}<br>%{customdata[0]:${def.fmt}} ${def.unit}<extra></extra>`,
    mode: "markers",
    marker: { color: list.map((p) => p.z), colorscale: cs, cmin, cmax,
              size: list.map((p) => (v === "prec" && p.z < 0.1 ? 5 : 9)),
              line: { color: TH.card, width: 0.6 }, opacity: 0.95,
              showscale, colorbar: showscale ? { title: { text: def.unit }, thickness: 12, len: 0.6, outlinewidth: 0 } : undefined },
  });
  const geoBase = {
    projection: { type: "mercator" }, resolution: 50, showframe: false,
    showland: true, landcolor: TH.card2, showocean: true, oceancolor: TH.card, bgcolor: TH.card,
    showcountries: true, countrycolor: TH.border, coastlinecolor: TH.border, showlakes: false,
  };
  const dsel = $("ah-day").value;
  const when = inst ? madridLabel(obsMs(h)) : def.day ? `${+dsel.slice(8)} ${MESES[+dsel.slice(5, 7)]} (provisional)`
    : `24 h hasta ${madridLabel(obsMs(O.kLast))}`;
  const layout = baseLayout(`${def.label} · ${when}`);
  layout.margin = { l: 0, r: 0, t: 44, b: 0 };
  layout.geo = { ...geoBase, lataxis: { range: [35.2, 44.2] }, lonaxis: { range: [-10.2, 4.8] }, domain: { x: [0, 1], y: [0, 1] } };
  layout.geo2 = { ...geoBase, lataxis: { range: [27.5, 29.6] }, lonaxis: { range: [-18.4, -13.2] },
                  domain: { x: [0, 0.24], y: [0, 0.19] }, showframe: true, framecolor: TH.border };
  layout.showlegend = false;
  const div = $("plot-ahora-mapa");
  Plotly.react(div, [mk(pts.filter((p) => !canary(p)), "geo", true), mk(pts.filter(canary), "geo2", false)], layout, PLOTLY_CFG);
  if (div.removeAllListeners) div.removeAllListeners("plotly_click");
  div.on("plotly_click", (ev) => {
    const p = ev.points && ev.points[0];
    if (p && p.customdata) { renderObsStation(p.customdata[1]); $("ah-station").scrollIntoView({ behavior: "smooth", block: "start" }); }
  });

  // clasificaciones
  const row = (p, k) => `<tr data-id="${p.st.id}"><td>${k + 1}</td><td>${p.st.name}` +
    `${p.st.province ? ` <span class="muted">${titleCase(p.st.province)}</span>` : ""}</td>` +
    `<td><b>${v === "d24" ? sgnf(p.z) : p.z.toFixed(def.fmt.endsWith("0f") ? 0 : 1).replace(".", ",")} ${def.unit}</b></td>` +
    `<td class="muted">${p.note || (p.ms ? madridHour(p.ms) : "")}</td></tr>`;
  const desc = [...pts].sort((a, b) => b.z - a.z), asc = [...pts].sort((a, b) => a.z - b.z);
  $("ah-rank-hi-t").textContent = def.hiT;
  $("ah-rank-hi").querySelector("tbody").innerHTML = desc.slice(0, 10).map(row).join("");
  $("ah-rank-lo-wrap").hidden = !def.loT;
  if (def.loT) {
    $("ah-rank-lo-t").textContent = def.loT;
    $("ah-rank-lo").querySelector("tbody").innerHTML = asc.slice(0, 10).map(row).join("");
  }
  const med = quantile(zs, 0.5);
  $("ah-note").textContent =
    `${pts.length} estaciones con dato. Mediana: ${med.toFixed(def.fmt.endsWith("0f") ? 0 : 1).replace(".", ",")} ${def.unit}. ` +
    "Datos horarios de las estaciones automáticas de AEMET, sin validar: puede haber valores erróneos. " +
    (def.day ? `Anomalía frente a la normal ${(state.daily.ref || [1991, 2020]).join("–")} de cada estación (±7 días); máxima y mínima de 00 a 24 UTC. ` : "") +
    "Cada estación muestra su último dato de la hora anterior (muchas envían los 10 minutos en bloque cada hora). " +
    "Las máximas y mínimas incluyen los extremos de cada hora y exigen dato en al menos el 75 % de las horas. " +
    "Las horas son peninsulares (en Canarias, una menos). " +
    "Pulsa una estación del mapa o de las tablas para ver sus últimas 24 horas.";
}

/** Hoy y ayer de una estación frente a su climatología (valores provisionales). */
function renderStationDayCmp(id) {
  const box = $("ah-st-cmp"), C = state.daily;
  if (!C) { box.innerHTML = ""; return; }
  const parts = [];
  const ref = (C.ref || [1991, 2020]).join("–");
  const dsList = Object.keys(C.cmp).sort().reverse();
  dsList.forEach((ds, q) => {
    const r = dayCmp(id, ds);
    if (!r) return;
    const bits = [];
    const open = r.nh < 24;
    // isMax: la máxima solo puede subir durante el día; la mínima, solo bajar
    const one = (lbl, val, nrm, pc, recHi, recLo, isMax) => {
      if (val === null) return;
      let t = `${lbl} <b>${nf1(val)} °C</b>`;
      if (nrm !== null) t += ` (${sgnf(val - nrm)} °C frente a la normal${pc !== null ? `, percentil ${pctTxt(pc)}` : ""})`;
      const firm = (hi) => !open || hi === isMax;
      if (recHi[0] !== null && val > recHi[0]) {
        t += firm(true) ? ` · <b>supera el récord de la fecha</b> (${nf1(recHi[0])} °C en ${recHi[1]})`
          : ` · de momento, por encima del récord de la fecha (${nf1(recHi[0])} °C en ${recHi[1]}), pero aún puede bajar`;
      } else if (recLo[0] !== null && val < recLo[0]) {
        t += firm(false) ? ` · <b>bate el récord por abajo</b> (${nf1(recLo[0])} °C en ${recLo[1]})`
          : ` · de momento, por debajo del récord de la fecha (${nf1(recLo[0])} °C en ${recLo[1]}), pero aún puede subir`;
      }
      bits.push(t);
    };
    one("máxima", r.tx, r.ntx, r.ptx, r.rtxHi, r.rtxLo, true);
    one("mínima", r.tn, r.ntn, r.ptn, r.rtnHi, r.rtnLo, false);
    if (!bits.length) return;
    parts.push(`<p><b>${q === 0 ? "Hoy" : "Ayer"}, ${dayLabel(ds)}</b>` +
      `${q === 0 || r.nh < 24 ? ` <span class="muted">(${r.nh} de 24 h)</span>` : ""}: ${bits.join("; ")}.</p>`);
  });
  box.innerHTML = parts.length
    ? parts.join("") + `<p class="muted">Valores provisionales de la red automática frente a la normal ${ref} (±7 días) y los récords de la serie diaria.</p>`
    : "";
}

function renderObsStation(id) {
  const O = state.obs;
  if (!O || !O.data[id]) return;
  state.obsSel = id;
  const D = O.data[id], m = O.meta[id], S = obsSummary(id);
  const name = obsName(id);
  const inIdx = state.index.stations.find((s) => s.id === id);
  $("ah-st-name").textContent = name;
  $("ah-st-sub").textContent = [inIdx ? titleCase(inIdx.province) : null, m[3] !== null ? `${m[3]} m` : null, `indicativo ${id}`]
    .filter(Boolean).join(" · ");
  const link = $("ah-st-clim");
  link.hidden = !inIdx;
  link.dataset.id = id;

  const tiles = [];
  const tile = (cls, label, val, unit, foot) =>
    tiles.push(`<div class="rec-tile day-tile ${cls}"><div class="rl">${label}</div>` +
      `<div class="rv">${val}<small>${val === "—" ? "" : ` ${unit}`}</small></div><div class="rd">${foot}</div></div>`);
  const when = (e) => (e.hourly ? `entre las ${madridHour(e.ms - 3600000)} y las ${madridHour(e.ms)}` : `a las ${madridHour(e.ms)}`);
  tile("t-tmed", "Temperatura", S.ta !== null ? nf1(S.ta) : "—", "°C",
    S.lastMs ? `${madridLabel(S.lastMs)}` +
      (S.d24 ? ` · <span class="${S.d24.v >= 0 ? "up" : "down"}">${sgnf(S.d24.v)} °C</span> en ${S.d24.span} h` : "") : "sin dato reciente");
  tile("t-tmax", "Máxima 24 h", S.tmax ? nf1(S.tmax.v) : "—", "°C", S.tmax ? when(S.tmax) : "");
  tile("t-tmin", "Mínima 24 h", S.tmin ? nf1(S.tmin.v) : "—", "°C", S.tmin ? when(S.tmin) : "");
  if (D.prec || D.p10) {
    tile("t-prec", "Lluvia 24 h", S.prec !== null ? nf1(S.prec) : "—", "mm",
      S.p1 !== null ? `${nf1(S.p1)} mm en la última hora` : "");
  }
  if (D.vmax) {
    tile("t-wind", "Racha máxima 24 h", S.gust ? String(Math.round(S.gust.v * 3.6)) : "—", "km/h",
      S.gust ? `${when(S.gust)}${S.gust.dir !== null ? ` · del ${rumbo(S.gust.dir)}` : ""}` : "");
  }
  if (D.hr) tile("t-prec", "Humedad", S.hr !== null ? String(Math.round(S.hr)) : "—", "%", "ahora");
  if (S.pres !== null) {
    tile("t-sol", "Presión", nf1(S.pres).replace(",0", ""), "hPa",
      S.dp3 !== null ? `${sgnf(S.dp3)} hPa en 3 h` : "en la estación");
  }
  $("ah-tiles").innerHTML = tiles.join("");
  renderStationDayCmp(id);

  // ---- gráfico de 24 h: trazo de 10 min, huecos de más de 75 min sin unir ----
  const ks = [];
  for (let k = O.avail[0]; k <= O.kLast; k++) ks.push(k);
  const ser = (arr, idxs, msOf, mult = 1) => {
    const x = [], y = [];
    let prev = null;
    for (const i of idxs) {
      const val = obsVal(arr, i);
      if (val === null) continue;
      const ms = msOf(i);
      if (prev !== null && ms - prev > 75 * 60000) { x.push(madridStr(prev + 60000)); y.push(null); }
      x.push(madridStr(ms)); y.push(Math.round(val * mult * 10) / 10);
      prev = ms;
    }
    return { x, y };
  };
  const rows = [{ key: "t", h: 0.42 }];
  if (D.prec || D.p10 || D.hr) rows.push({ key: "p", h: 0.2 });
  if (D.vv || D.vmax) rows.push({ key: "w", h: 0.22 });
  if (D.pres) rows.push({ key: "pr", h: 0.16 });
  const gap = 0.06, tot = rows.reduce((t, r) => t + r.h, 0) + gap * (rows.length - 1);
  const layout = baseLayout(`${name} · últimas 24 horas`);
  layout.margin = { l: 60, r: 55, t: 50, b: 40 };
  layout.legend = { orientation: "h", y: -0.07 };
  layout.hovermode = "x unified";
  layout.annotations = [];
  let top = 1;
  rows.forEach((r, k) => {
    const hgt = r.h / tot;
    r.ya = k === 0 ? "y" : `y${k + 1}`;
    r.yk = k === 0 ? "yaxis" : `yaxis${k + 1}`;
    layout[r.yk] = { ...layout.yaxis, domain: [top - hgt, top], anchor: "x" };
    top -= hgt + gap / tot;
  });
  layout.xaxis = { ...layout.xaxis, anchor: rows[rows.length - 1].ya, type: "date", tickformat: "%H:%M\n%-d %b",
    range: [madridStr(obsMs(O.avail[0]) - 15 * 60000), madridStr(obsMs(O.kLast) + 15 * 60000)] };
  const C = { mx: VAR_COLORS.tmax, mn: VAR_COLORS.tmin, p: VAR_COLORS.prec, w: VAR_COLORS.dtr };
  const tenMs = (k) => obsMs(k), hMs = (j) => obsHMs(j);
  const traces = [];
  for (const r of rows) {
    if (r.key === "t") {
      layout[r.yk].ticksuffix = " °C";
      const bx = ser(D.tamax, O.hAvail, hMs), bn = ser(D.tamin, O.hAvail, hMs);
      if (bx.x.length) {
        traces.push({ x: bx.x, y: bx.y, yaxis: r.ya, mode: "lines", line: { width: 0, shape: "vh" }, hoverinfo: "skip", showlegend: false });
        traces.push({ x: bn.x, y: bn.y, yaxis: r.ya, mode: "lines", line: { width: 0, shape: "vh" }, fill: "tonexty",
          fillcolor: hexToRgba(C.mx, 0.16), name: "mín–máx horario", hoverinfo: "skip" });
      }
      const t = ser(D.ta, ks, tenMs);
      traces.push({ x: t.x, y: t.y, yaxis: r.ya, mode: "lines+markers", name: "temperatura", line: { color: C.mx, width: 2.4 },
        marker: { size: 3.5 }, hovertemplate: "%{y:.1f} °C" });
      if (S.tmax) layout.annotations.push({ x: madridStr(S.tmax.ms), y: S.tmax.v, yref: r.ya, text: `${nf1(S.tmax.v)}°`,
        showarrow: false, yshift: 14, font: { color: C.mx } });
      if (S.tmin) layout.annotations.push({ x: madridStr(S.tmin.ms), y: S.tmin.v, yref: r.ya, text: `${nf1(S.tmin.v)}°`,
        showarrow: false, yshift: -14, font: { color: C.mn } });
    } else if (r.key === "p") {
      layout[r.yk].ticksuffix = " mm";
      const px = [], py = [];
      for (const j of O.hAvail) { const p = hourPrec(D, j); if (p !== null) { px.push(madridStr(obsHMs(j) - 1800000)); py.push(p); } }
      layout[r.yk].range = [0, Math.max(2, ...py) * 1.15];
      if (py.length) traces.push({ x: px, y: py, yaxis: r.ya, type: "bar", name: "lluvia (por hora)", width: 3600000 * 0.85,
        marker: { color: hexToRgba(C.p, 0.8) }, hovertemplate: "%{y:.1f} mm en la hora" });
      if (D.hr) {
        const k2 = rows.length + 1, hrS = ser(D.hr, ks, tenMs);
        layout[`yaxis${k2}`] = { ...layout.yaxis, overlaying: r.ya, side: "right", range: [0, 105], ticksuffix: " %",
          showgrid: false, anchor: "x" };
        traces.push({ x: hrS.x, y: hrS.y, yaxis: `y${k2}`, mode: "lines", name: "humedad",
          line: { color: VAR_COLORS.tmin, width: 1.6, dash: "dot" }, hovertemplate: "%{y:.0f} %" });
      }
    } else if (r.key === "w") {
      layout[r.yk].ticksuffix = " km/h";
      layout[r.yk].rangemode = "tozero";
      const g = ser(D.vmax, ks, tenMs, 3.6), w = ser(D.vv, ks, tenMs, 3.6);
      traces.push({ x: g.x, y: g.y, yaxis: r.ya, mode: "markers", name: "racha", marker: { color: C.w, size: 5, symbol: "triangle-up" },
        hovertemplate: "racha %{y:.0f} km/h" });
      traces.push({ x: w.x, y: w.y, yaxis: r.ya, mode: "lines", name: "viento medio", line: { color: hexToRgba(C.w, 0.6), width: 2 },
        hovertemplate: "medio %{y:.0f} km/h" });
      // flechas de dirección solo en las horas en punto, para no saturar
      const hk = ks.filter((k) => obsMs(k) % 3600000 === 0 && obsVal(D.vv, k) !== null && obsVal(D.dv, k) !== null);
      traces.push({ x: hk.map((k) => madridStr(obsMs(k))), y: hk.map((k) => Math.round(D.vv[k] * 36) / 10), yaxis: r.ya,
        mode: "markers", name: "dirección", customdata: hk.map((k) => rumbo(D.dv[k])),
        marker: { size: 12, symbol: "arrow", angle: hk.map((k) => (D.dv[k] + 180) % 360), color: C.w, line: { width: 0 } },
        hovertemplate: "del %{customdata}" });
    } else if (r.key === "pr") {
      layout[r.yk].ticksuffix = " hPa";
      const pr = ser(D.pres, ks, tenMs);
      traces.push({ x: pr.x, y: pr.y, yaxis: r.ya, mode: "lines", name: "presión", line: { color: TH.muted, width: 2 },
        hovertemplate: "%{y:.1f} hPa" });
    }
  }
  const div = $("plot-ahora-st");
  div.style.height = `${260 + rows.length * 120}px`;
  EXPORT_SIZES["plot-ahora-st"] = [1600, 600 + rows.length * 300];
  Plotly.newPlot(div, traces, layout, PLOTLY_CFG);
  document.querySelectorAll("#ah-rank-hi tr, #ah-rank-lo tr").forEach((tr) => tr.classList.toggle("hl", tr.dataset.id === id));
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
  "plot-dia-swarm": [1600, 1600],
  "plot-dia-mes": [1600, 900],
  "plot-dia-anios": [1600, 800],
  "plot-dia-mesanios": [1600, 800],
  "plot-ahora-mapa": [1500, 1300],
  "plot-ahora-st": [1600, 1500],
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
async function exportActivePanel(opts = {}) {
  const panel = document.querySelector(".panel:not([hidden])");
  if (!panel) return;
  const plots = [...panel.querySelectorAll(".plot")]
    .filter((d) => d.offsetParent !== null && d.data && d.data.length && d.layout)
    .filter((d) => !opts.only || opts.only.includes(d.id));
  const withCard = panel.id === "panel-dia" && state.diaCard;
  const btn = opts.button || $("export-png");
  const btnTxt = btn.textContent;
  if (!plots.length && !withCard) {
    alert("No hay ningún gráfico que exportar en esta sección.");
    return;
  }
  btn.disabled = true; btn.textContent = "Generando…";
  const SCALE = 2;
  try {
    const single = plots.length === 1 && !withCard;
    const imgs = withCard ? [dayCardCanvas(SCALE)] : [];
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
      (panel.id === "panel-nacional" ? `-${state.natView || "evol"}` : "") +
      (panel.id === "panel-dia" && state.diaDate ? `-${state.diaDate}` : "") +
      (opts.suffix ? `-${opts.suffix}` : "");
    const prefix = panel.id === "panel-ahora" ? `ahora-${state.obsSel || "espana"}`
      : state.station && panel.id !== "panel-nacional" ? state.station.json.id : "espana";
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
    btn.disabled = false; btn.textContent = btnTxt;
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
  retorno: runRetorno, spi: runSPI, dia: runDia, ahora: runAhora,
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
      if (["du-search", "dia-date", "ah-hour", "ah-search", "ah-day"].includes(el.id)) return;
      el.addEventListener("change", () => {
        if (state.station || NO_STATION_TABS.has(name)) runPanel(name);
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
  $("dia-date").addEventListener("change", () => setDayDate($("dia-date").value));
  $("ah-hour").addEventListener("input", () => { state.obsHourTouched = true; safeRun(runAhoraMap); });
  $("ah-play").addEventListener("click", () => {
    if (state.obsPlay) { stopObsPlay(); return; }
    const sl = $("ah-hour");
    state.obsHourTouched = true;
    if (+sl.value >= +sl.max) sl.value = sl.min;
    $("ah-play").textContent = "❚❚";
    state.obsPlay = setInterval(() => {
      if (+sl.value >= +sl.max) { stopObsPlay(); return; }
      sl.value = +sl.value + 1;
      safeRun(runAhoraMap);
    }, 220);
  });
  $("ah-day").addEventListener("change", () => { safeRun(runAhoraMap); safeRun(renderDayRecords); });
  $("ah-records").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-id]");
    if (!li) return;
    renderObsStation(li.dataset.id);
    $("ah-station").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  for (const t of ["ah-rank-hi", "ah-rank-lo"]) {
    $(t).addEventListener("click", (e) => {
      const tr = e.target.closest("tr[data-id]");
      if (!tr) return;
      renderObsStation(tr.dataset.id);
      $("ah-station").scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }
  $("ah-st-clim").addEventListener("click", (e) => selectStation(e.currentTarget.dataset.id, "dia"));
  $("dia-prev").addEventListener("click", () => shiftDay(-1));
  $("dia-next").addEventListener("click", () => shiftDay(1));
  $("dia-prev-y").addEventListener("click", () => gotoDayYear(+state.diaDate.slice(0, 4) - 1));
  $("dia-next-y").addEventListener("click", () => gotoDayYear(+state.diaDate.slice(0, 4) + 1));
  $("dia-last").addEventListener("click", () => setDayDate(fmtDate(state.station.startMs, lastDataIndex(state.station))));
  $("last-obs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-day]");
    if (b) openDay(b.dataset.day);
  });
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
  $("export-png").addEventListener("click", () => exportActivePanel());
  $("dia-share").addEventListener("click", () =>
    exportActivePanel({ only: ["plot-dia-swarm"], suffix: "ficha", button: $("dia-share") }));
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
  $("go-ahora").addEventListener("click", () => { showApp(); activateTab("ahora"); });
  makeSearch($("ah-search"), $("ah-results"), (id) => renderObsStation(id), {
    list: () => (state.obs ? state.obs.list : []),
    meta: (st) => [titleCase(st.province), st.altitude !== null ? `${st.altitude} m` : null, st.id].filter(Boolean).join(" · "),
  });
  renderQuickPicks();
  routeFromHash();
  window.addEventListener("hashchange", () => {
    const id = state.station ? state.station.json.id : "espana";
    if (!location.hash.startsWith(`#${encodeURIComponent(id)}/`)) routeFromHash();
  });
}

init();
