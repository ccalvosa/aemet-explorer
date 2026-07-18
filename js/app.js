/* ==========================================================
   Explorador climático AEMET — app.js (v2)
   9 productos + efemérides + mapa. Todo en cliente.
   ========================================================== */

"use strict";

// ---------- constantes ----------
const DATA_URL = "data";
const VAR_COLORS = { tmax: "#ff7a45", tmed: "#f7c948", tmin: "#4dabf7", prec: "#7ee787" };
const VAR_LABELS = {
  tmax: "Tmax", tmed: "Tmed", tmin: "Tmin",
  prec: "Precipitación", racha: "Racha viento", sol: "Sol",
};
const VAR_UNITS = { tmax: "°C", tmed: "°C", tmin: "°C", prec: "mm", racha: "m/s", sol: "h" };
const ACCENT = "#ff4d4d";
const MS_DAY = 86400000;
const MESES = ["", "ene", "feb", "mar", "abr", "may", "jun",
               "jul", "ago", "sep", "oct", "nov", "dic"];

const PLOTLY_BASE = {
  paper_bgcolor: "#0d1117",
  plot_bgcolor: "#0d1117",
  font: { family: "Inter, sans-serif", color: "#e6edf3", size: 13 },
  margin: { l: 55, r: 20, t: 40, b: 45 },
  xaxis: { gridcolor: "#2b3340", zerolinecolor: "#2b3340" },
  yaxis: { gridcolor: "#2b3340", zerolinecolor: "#2b3340" },
  hoverlabel: {
    bgcolor: "#1b2330",
    bordercolor: "#2b3340",
    font: { color: "#ffffff", family: "Inter, sans-serif", size: 13 },
  },
};
const PLOTLY_CFG = { responsive: true, displaylogo: false };

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

function titleFont() { return { family: "Space Grotesk, sans-serif", size: 16 }; }

function baseLayout(titleText) {
  const l = structuredClone(PLOTLY_BASE);
  if (titleText) l.title = { text: titleText, font: titleFont(), x: 0.02 };
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
        `<span class="r-meta">${st.id} · ${st.province} · ${st.start.slice(0, 4)}–${st.end.slice(0, 4)}</span>`;
      li.addEventListener("mousedown", () => { listEl.hidden = true; inputEl.value = ""; onPick(st.id); });
      listEl.appendChild(li);
    }
    listEl.hidden = false;
  }
  inputEl.addEventListener("input", () => {
    const q = normalize(inputEl.value);
    if (q.length < 2) { listEl.hidden = true; return; }
    render(state.index.stations.filter((st) =>
      normalize(st.name).includes(q) ||
      normalize(st.province).includes(q) ||
      st.id.toLowerCase().startsWith(q)).slice(0, 12));
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

async function loadStation(id) {
  const res = await fetch(`${DATA_URL}/stations/${id}.json`);
  return makeCalendar(await res.json());
}

async function selectStation(id) {
  state.station = await loadStation(id);
  renderPlate();
  renderEphemeris();
  $("tabs").hidden = false;
  $("welcome").hidden = true;
  $("sidebar-empty").hidden = true;
  populateYearSelects();
  activateTab(document.querySelector(".tab.active").dataset.tab);
}

function renderPlate() {
  const st = state.station.json;
  $("plate-id").textContent = st.id;
  $("plate-alt").textContent = st.altitude !== null ? `${st.altitude} m` : "";
  $("plate-name").textContent = st.name;
  $("plate-province").textContent = st.province;
  $("plate-period").textContent = `${st.start} → ${st.end}`;

  const wrap = $("coverage-strips");
  wrap.innerHTML = "";
  const yearKeys = Object.keys(st.coverage).sort();
  for (const v of ["tmax", "tmed", "tmin", "prec"]) {
    const row = document.createElement("div");
    row.className = "coverage-row";
    const label = document.createElement("span");
    label.className = "coverage-var";
    label.textContent = v;
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
      ctx.fillStyle = frac === 0 ? "#0d1117" : `rgba(255,122,69,${0.15 + 0.85 * frac})`;
      ctx.fillRect(i, 0, 1, 1);
    });
    const pct = document.createElement("span");
    pct.className = "coverage-pct";
    pct.textContent = `${Math.round((100 * tv) / td)}%`;
    row.append(label, canvas, pct);
    wrap.appendChild(row);
  }
  $("station-plate").hidden = false;
}

function renderEphemeris() {
  const S = state.station;
  const box = $("ephemeris");
  const now = new Date();
  const todayMd = (now.getMonth() + 1) * 100 + now.getDate();
  const [refA, refB] = getRef();

  // récords del día (toda la serie, ese mes-día exacto)
  function recordOf(v, fn) {
    let best = null, bestYr = null;
    const vals = S.json.data[v];
    for (let i = 0; i < vals.length; i++) {
      if (S.md[i] !== todayMd || vals[i] === null) continue;
      if (best === null || fn(vals[i], best)) { best = vals[i]; bestYr = S.years[i]; }
    }
    return best === null ? null : { v: best, yr: bestYr };
  }
  const rTmax = recordOf("tmax", (a, b) => a > b);
  const rTmin = recordOf("tmin", (a, b) => a < b);
  const rPrec = recordOf("prec", (a, b) => a > b);

  let html = `<h4>Efemérides · ${mdLabel(todayMd)}</h4>`;
  if (rTmax) html += `<div class="eph-row"><span class="eph-tmax">Tmax más alta</span><span class="mono">${rTmax.v.toFixed(1)} °C · ${rTmax.yr}</span></div>`;
  if (rTmin) html += `<div class="eph-row"><span class="eph-tmin">Tmin más baja</span><span class="mono">${rTmin.v.toFixed(1)} °C · ${rTmin.yr}</span></div>`;
  if (rPrec && rPrec.v > 0) html += `<div class="eph-row"><span class="eph-prec">Prec. máxima</span><span class="mono">${rPrec.v.toFixed(1)} mm · ${rPrec.yr}</span></div>`;

  // último dato de tmax en percentil de la referencia (md ±3)
  const tmax = S.json.data.tmax;
  let lastIdx = -1;
  for (let i = tmax.length - 1; i >= 0; i--) if (tmax[i] !== null) { lastIdx = i; break; }
  if (lastIdx >= 0 && S.md[lastIdx] !== 229) {
    const clim = climDaily(tmax, refA, refB, 3);
    const pool = clim.sorted.get(S.md[lastIdx]);
    if (pool && pool.length > 20) {
      let rank = 0;
      for (const x of pool) if (x <= tmax[lastIdx]) rank++;
      const pct = Math.round((100 * rank) / pool.length);
      html += `<p class="eph-note">Última Tmax (${fmtDate(S.startMs, lastIdx)}): ` +
        `${tmax[lastIdx].toFixed(1)} °C → percentil ${pct} de ${refA}–${refB} para esas fechas.</p>`;
    }
  }
  if (!rTmax && !rTmin) html += `<p class="eph-note">Sin datos para esta fecha.</p>`;
  box.innerHTML = html;
}

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
      document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      activateTab(btn.dataset.tab);
    });
  });
}

function activateTab(name) {
  document.querySelectorAll(".panel").forEach((p) => { p.hidden = true; });
  $(`panel-${name}`).hidden = false;
  if (state.station && TAB_RUNNERS[name]) TAB_RUNNERS[name]();
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

  /** trayectoria acumulada de un año; null a partir de demasiado hueco */
  function cumTraj(row) {
    const out = new Array(365).fill(null);
    let sum = 0, n = 0;
    for (let p = 0; p < 365; p++) {
      if (row[p] !== null) { sum += row[p]; n++; }
      if (n === 0) continue;
      if (n < 0.8 * (p + 1)) continue; // hueco excesivo hasta la fecha
      out[p] = isPrec ? sum : sum / n;
    }
    return out;
  }

  // sobre de percentiles del período de referencia
  const refTraj = [];
  for (let y = refA; y <= refB; y++) if (M.has(y)) refTraj.push(cumTraj(M.get(y)));
  if (refTraj.length < 10) {
    $("an-note").textContent =
      `Solo ${refTraj.length} años del período ${refA}–${refB} tienen datos: el sobre de percentiles no es fiable. Amplía la referencia.`;
  } else { $("an-note").textContent = ""; }

  const p05 = [], p50 = [], p95 = [];
  for (let p = 0; p < 365; p++) {
    const col = refTraj.map((t) => t[p]).filter((x) => x !== null).sort((a, b) => a - b);
    p05.push(col.length ? quantile(col, 0.05) : null);
    p50.push(col.length ? quantile(col, 0.50) : null);
    p95.push(col.length ? quantile(col, 0.95) : null);
  }

  // años récord (máx y mín del valor final) sobre toda la serie
  let recMax = null, recMin = null;
  for (const [y, row] of M) {
    const t = cumTraj(row);
    let last = null;
    for (let p = 364; p >= 0; p--) if (t[p] !== null && p > 300) { last = t[p]; break; }
    if (last === null) continue;
    if (!recMax || last > recMax.v) recMax = { y, v: last, t };
    if (!recMin || last < recMin.v) recMin = { y, v: last, t };
  }

  const sel = M.has(year) ? cumTraj(M.get(year)) : null;

  // eje x con año ficticio para etiquetas de mes
  const x = [];
  {
    const d = new Date(Date.UTC(2001, Math.floor(startMd / 100) - 1, startMd % 100));
    for (let p = 0; p < 365; p++) { x.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  }
  const ht = "%{x|%-d %b}: %{y:.1f}";

  const traces = [
    { x, y: p95, mode: "lines", line: { width: 0 }, hoverinfo: "skip", showlegend: false },
    { x, y: p05, mode: "lines", line: { width: 0 }, fill: "tonexty",
      fillcolor: "rgba(139,148,158,0.22)", name: `P5–P95 ${refA}–${refB}`,
      hoverinfo: "skip" },
    { x, y: p50, mode: "lines", name: `mediana ${refA}–${refB}`,
      line: { color: "#8b949e", width: 1.5, dash: "dash" },
      hovertemplate: ht + "<extra>mediana</extra>" },
  ];
  if (recMax && recMax.y !== year) traces.push({
    x, y: recMax.t, mode: "lines", name: `récord alto (${recMax.y})`,
    line: { color: VAR_COLORS.tmax, width: 1 }, opacity: 0.6,
    hovertemplate: ht + `<extra>${recMax.y}</extra>` });
  if (recMin && recMin.y !== year) traces.push({
    x, y: recMin.t, mode: "lines", name: `récord bajo (${recMin.y})`,
    line: { color: VAR_COLORS.tmin, width: 1 }, opacity: 0.6,
    hovertemplate: ht + `<extra>${recMin.y}</extra>` });
  if (sel) traces.push({
    x, y: sel, mode: "lines", name: String(year),
    line: { color: ACCENT, width: 3 },
    hovertemplate: ht + `<extra>${year}</extra>` });

  const yearTxt = hydro ? `${year - 1}–${String(year).slice(2)}` : String(year);
  const layout = baseLayout(
    `${S.json.name} · ${VAR_LABELS[v]} ${isPrec ? "acumulada" : "media acumulada"} · ${yearTxt}`);
  layout.xaxis.tickformat = "%b";
  layout.xaxis.dtick = "M1";
  layout.yaxis.title = { text: VAR_UNITS[v] };
  layout.legend = { orientation: "h", y: -0.12 };
  Plotly.newPlot("plot-anio", traces, layout, PLOTLY_CFG);

  if (!sel) $("an-note").textContent = `El año ${yearTxt} no tiene datos suficientes de ${VAR_LABELS[v]}.`;
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
  const vars = ["tmax", "tmed", "tmin"].filter((v) => $(`ev-${v}`).checked);
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
  $("ev-note").textContent = excluded
    ? `${excluded} año-variable excluidos por cobertura < ${Math.round(minCov * 100)}%.` : "";
}

// ==========================================================
// PRODUCTO: Stripes
// ==========================================================

function runStripes() {
  const S = state.station;
  const v = $("st-var").value;
  const mdS = parseMd($("st-md-start").value);
  const mdE = parseMd($("st-md-end").value);
  if (mdS === null || mdE === null) { $("st-note").textContent = "Ventana no válida."; return; }
  const minCov = +$("st-cov").value / 100;
  const [refA, refB] = getRef();

  const groups = aggregateWindow(S.json.data[v], mdS, mdE);
  const means = new Map();
  for (const [yr, g] of groups) {
    if (g.nTotal && g.n / g.nTotal >= minCov) means.set(yr, g.sum / g.n);
  }
  const refVals = [...means].filter(([y]) => y >= refA && y <= refB).map(([, m]) => m);
  if (refVals.length < 10) {
    $("st-note").textContent =
      `Solo ${refVals.length} años válidos en ${refA}–${refB}: la referencia no es fiable.`;
    return;
  }
  const refMean = mean(refVals);

  const yrs = [...means.keys()].sort((a, b) => a - b);
  const y0 = yrs[0], y1 = yrs[yrs.length - 1];
  const allYears = [], anoms = [];
  for (let y = y0; y <= y1; y++) {
    allYears.push(y);
    anoms.push(means.has(y) ? means.get(y) - refMean : null);
  }
  const amax = Math.max(...anoms.filter((a) => a !== null).map(Math.abs));

  const l1 = baseLayout(`${S.json.name} · ${VAR_LABELS[v]} ${mdLabel(mdS)} → ${mdLabel(mdE)} · anomalía vs ${refA}–${refB}`);
  l1.margin = { l: 30, r: 20, t: 40, b: 30 };
  l1.yaxis = { visible: false };
  Plotly.newPlot("plot-stripes", [{
    x: allYears, y: allYears.map(() => ""), z: [anoms], type: "heatmap",
    transpose: true, colorscale: "RdBu", reversescale: true,
    zmin: -amax, zmax: amax, showscale: false,
    hovertemplate: "%{x}: %{z:+.2f} °C<extra></extra>",
  }], l1, PLOTLY_CFG);

  const l2 = baseLayout("");
  l2.margin.t = 10;
  l2.yaxis.title = { text: "anomalía (°C)" };
  Plotly.newPlot("plot-stripes-anom", [{
    x: allYears, y: anoms, type: "bar",
    marker: { color: anoms, colorscale: "RdBu", reversescale: true, cmin: -amax, cmax: amax },
    hovertemplate: "%{x}: %{y:+.2f} °C<extra></extra>",
  }], l2, PLOTLY_CFG);

  $("st-note").textContent =
    `Media de referencia ${refA}–${refB}: ${refMean.toFixed(2)} °C. Años en blanco: sin cobertura suficiente.`;
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
      mode: "lines", line: { color: "#e6edf3", width: 1.5, dash: "dot" },
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

function runStreaks() {
  const S = state.station;
  const v = $("ra-var").value;
  const op = $("ra-op").value;
  const thr = +$("ra-thr").value;
  $("ra-unit").textContent = VAR_UNITS[v];
  const values = S.json.data[v];
  if (!values) return;
  const test = { ">=": (x) => x >= thr, ">": (x) => x > thr,
                 "<=": (x) => x <= thr, "<": (x) => x < thr }[op];

  const streaks = [];
  const perYear = new Map();
  let runStart = -1, runLen = 0;
  for (let i = 0; i <= values.length; i++) {
    const x = i < values.length ? values[i] : null;
    const ok = x !== null && test(x);
    if (ok) {
      if (!runLen) runStart = i;
      runLen++;
      perYear.set(S.years[i], (perYear.get(S.years[i]) || 0) + 1);
    } else {
      if (runLen) streaks.push({ start: runStart, len: runLen });
      runLen = 0;
    }
  }
  streaks.sort((a, b) => b.len - a.len || b.start - a.start);

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

  $("ra-note").textContent =
    "Los días sin dato cortan las rachas: en años con huecos la racha real pudo ser más larga.";
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

  let mdMin = Infinity, mdMax = -Infinity, nRef = 0;
  for (let i = 0; i < X.length; i++) {
    if (S.years[i] !== refYear || X[i] === null || Y[i] === null) continue;
    nRef++;
    if (S.md[i] < mdMin) mdMin = S.md[i];
    if (S.md[i] > mdMax) mdMax = S.md[i];
  }
  if (!nRef) {
    $("co-note").textContent = `El año ${refYear} no tiene datos válidos de ambas variables.`;
    Plotly.purge("plot-comparador");
    return;
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
              line: { color: "#0d1117", width: 1 },
              colorbar: { title: "Año", thickness: 14, outlinecolor: "#2b3340" } },
    hovertemplate: "%{text}<br>" + VAR_LABELS[vx] + ": %{x:.2f} °C<br>" +
                   VAR_LABELS[vy] + ": %{y:.2f} °C<extra></extra>",
  }];
  if (ref) traces.push({
    x: [ref.x], y: [ref.y], mode: "markers+text",
    text: [String(refYear)], textposition: "top right",
    textfont: { color: ACCENT, size: 15, family: "Space Grotesk, sans-serif" },
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
        line: { color: "#2b3340", dash: "dash", width: 1 } },
      { type: "line", y0: my, y1: my, xref: "paper", x0: 0, x1: 1,
        line: { color: "#2b3340", dash: "dash", width: 1 } },
    ];
  }
  Plotly.newPlot("plot-comparador", traces, layout, PLOTLY_CFG);

  let rankTxt = "";
  if (ref && rest.length) {
    const warmer = rest.filter((r) => r.x > ref.x).length;
    rankTxt = ` En ${VAR_LABELS[vx]}, ${refYear} es el ${warmer + 1}º más cálido de ${rows.length} comparables.`;
  }
  $("co-note").textContent =
    `Ventana definida por los ${nRef} días con dato de ${refYear}; ` +
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
        marker: { color: "rgba(77,171,247,0.55)" }, xbins: { size: 1 } },
      { x: db, type: "histogram", histnorm: "probability", name: nameB,
        marker: { color: "rgba(255,122,69,0.55)" }, xbins: { size: 1 } },
    ];
  } else {
    const ecdf = (d) => ({ x: d, y: d.map((_, i) => (i + 1) / d.length) });
    const ea = ecdf(da), eb = ecdf(db);
    traces = [
      { ...ea, mode: "lines", name: nameA, line: { color: "#4dabf7", width: 2 } },
      { ...eb, mode: "lines", name: nameB, line: { color: "#ff7a45", width: 2 } },
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
    colorscale: modeAnom ? "RdBu" : "Plasma", reversescale: modeAnom,
    zmin: modeAnom ? -amax : undefined, zmax: modeAnom ? amax : undefined,
    zmid: modeAnom ? 0 : undefined,
    hovertemplate: "%{text}<extra></extra>",
    colorbar: { title: "°C", thickness: 14, outlinecolor: "#2b3340" },
    hoverongaps: false,
  }], layout, PLOTLY_CFG);
  $("ca-note").textContent = modeAnom
    ? "Anomalía respecto a la media de referencia por fecha (ventana ±7 días)." : "";
}

// ==========================================================
// PRODUCTO: Dos estaciones
// ==========================================================

async function runDuel() {
  if (!state.stationB) {
    $("du-note").textContent = "Elige la segunda estación en el buscador de arriba.";
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
    marker: { color: diffs, colorscale: "RdBu", reversescale: true, cmid: 0 },
    hovertemplate: "%{x}: %{y:+.2f} °C<extra></extra>",
  }];
  const fit = ols(common, diffs);
  let trendTxt = "";
  if (fit) {
    traces2.push({
      x: [common[0], common[common.length - 1]],
      y: [fit.a + fit.b * common[0], fit.a + fit.b * common[common.length - 1]],
      mode: "lines", line: { color: "#e6edf3", width: 1.5, dash: "dot" }, hoverinfo: "skip",
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
// init
// ==========================================================

Object.assign(TAB_RUNNERS, {
  anio: runAnio, evolucion: runEvolution, stripes: runStripes,
  indices: runIndices, rachas: runStreaks, comparador: runComparator,
  distribucion: runDistribution, calendario: runCalendar, duelo: runDuel,
});

function bindControls() {
  const runs = { "an-run": runAnio, "ev-run": runEvolution, "st-run": runStripes,
                 "ix-run": runIndices, "ra-run": runStreaks, "co-run": runComparator,
                 "di-run": runDistribution, "ca-run": runCalendar, "du-run": runDuel };
  for (const [id, fn] of Object.entries(runs)) $(id).addEventListener("click", fn);

  for (const [slider, out] of [["ev-cov", "ev-cov-val"], ["co-cov", "co-cov-val"],
                               ["st-cov", "st-cov-val"], ["ix-cov", "ix-cov-val"]]) {
    $(slider).addEventListener("input", () => { $(out).textContent = `${$(slider).value}%`; });
  }
  $("ra-var").addEventListener("change", () => {
    $("ra-unit").textContent = VAR_UNITS[$("ra-var").value];
  });
  $("an-var").addEventListener("change", () => {
    $("an-hydro-wrap").hidden = $("an-var").value !== "prec";
  });
  for (const id of ["ref-start", "ref-end"]) {
    $(id).addEventListener("change", () => {
      if (!state.station) return;
      renderEphemeris();
      activateTab(document.querySelector(".tab.active").dataset.tab);
    });
  }
}

async function init() {
  setupTabs();
  bindControls();
  populateIndices();
  try {
    await loadIndex();
    document.querySelector(".tagline").textContent =
      `Series diarias · ${state.index.n_stations} estaciones · análisis en tu navegador`;
    makeSearch($("station-search"), $("search-results"), selectStation);
    makeSearch($("du-search"), $("du-results"), async (id) => {
      state.stationB = await loadStation(id);
      runDuel();
    });
  } catch {
    $("sidebar-empty").innerHTML =
      "<p>No se pudo cargar <span class='mono'>data/index.json</span>. " +
      "Ejecuta <span class='mono'>scripts/build_data.py</span> y sirve la web desde la raíz del repo.</p>";
  }
}

init();
