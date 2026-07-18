/* ==========================================================
   Explorador climático AEMET — app.js
   Todo el cómputo ocurre en el navegador sobre JSON estáticos.
   Formato de estación: rejilla diaria densa desde `start`,
   arrays alineados con null en huecos (ver scripts/build_data.py).
   ========================================================== */

"use strict";

// ---------- constantes ----------
const DATA_URL = "data";
const VAR_COLORS = { tmax: "#ff7a45", tmed: "#f7c948", tmin: "#4dabf7" };
const VAR_LABELS = {
  tmax: "Tmax", tmed: "Tmed", tmin: "Tmin",
  prec: "Precipitación", racha: "Racha viento", sol: "Sol",
};
const VAR_UNITS = { tmax: "°C", tmed: "°C", tmin: "°C", prec: "mm", racha: "m/s", sol: "h" };
const ACCENT = "#ff4d4d";
const MS_DAY = 86400000;

const PLOTLY_BASE = {
  paper_bgcolor: "#0d1117",
  plot_bgcolor: "#0d1117",
  font: { family: "Inter, sans-serif", color: "#e6edf3", size: 13 },
  margin: { l: 55, r: 20, t: 30, b: 45 },
  xaxis: { gridcolor: "#2b3340", zerolinecolor: "#2b3340" },
  yaxis: { gridcolor: "#2b3340", zerolinecolor: "#2b3340" },
  hoverlabel: { bgcolor: "#1b2330", bordercolor: "#2b3340" },
};
const PLOTLY_CFG = { responsive: true, displaylogo: false };

// ---------- estado ----------
const state = {
  index: null,        // catálogo
  station: null,      // JSON de la estación activa
  years: null,        // Int16Array año por día
  md: null,           // Int16Array mes*100+día por día
  yearList: [],       // años presentes en la serie
};

// ---------- helpers ----------
const $ = (id) => document.getElementById(id);

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

function mdLabel(md) {
  const meses = ["", "ene", "feb", "mar", "abr", "may", "jun",
                 "jul", "ago", "sep", "oct", "nov", "dic"];
  return `${md % 100} ${meses[Math.floor(md / 100)]}`;
}

/** Precalcula año y mes-día de cada índice de la rejilla diaria (UTC). */
function buildCalendar(station) {
  const startMs = Date.parse(station.start + "T00:00:00Z");
  const n = station.data[station.vars[0]].length;
  const years = new Int16Array(n);
  const md = new Int16Array(n);
  const d = new Date(startMs);
  for (let i = 0; i < n; i++) {
    years[i] = d.getUTCFullYear();
    md[i] = (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
    d.setUTCDate(d.getUTCDate() + 1);
  }
  state.years = years;
  state.md = md;
  state.startMs = startMs;
  state.yearList = [...new Set(years)];
}

/**
 * Agrega una variable por "año de grupo" dentro de una ventana MM-DD.
 * Soporta ventanas que cruzan el año (p. ej. 12-01 → 02-28): en ese caso
 * el grupo es el año en que TERMINA la ventana (DJF 1980/81 → 1981).
 * Devuelve Map(año → {sum, n, nTotal}).
 */
function aggregateWindow(values, mdStart, mdEnd) {
  const wraps = mdStart > mdEnd;
  const groups = new Map();
  const { years, md } = state;
  for (let i = 0; i < values.length; i++) {
    const m = md[i];
    const inWin = wraps ? (m >= mdStart || m <= mdEnd) : (m >= mdStart && m <= mdEnd);
    if (!inWin) continue;
    const gy = wraps && m >= mdStart ? years[i] + 1 : years[i];
    let g = groups.get(gy);
    if (!g) { g = { sum: 0, n: 0, nTotal: 0 }; groups.set(gy, g); }
    g.nTotal++;
    const v = values[i];
    if (v !== null) { g.sum += v; g.n++; }
  }
  return groups;
}

// ==========================================================
// 1. Carga del catálogo y búsqueda
// ==========================================================

async function loadIndex() {
  const res = await fetch(`${DATA_URL}/index.json`);
  state.index = await res.json();
}

function normalize(s) {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function setupSearch() {
  const input = $("station-search");
  const list = $("search-results");
  let selIdx = -1;

  function render(matches) {
    list.innerHTML = "";
    selIdx = -1;
    if (!matches.length) { list.hidden = true; return; }
    for (const st of matches) {
      const li = document.createElement("li");
      li.innerHTML =
        `<span class="r-name">${st.name}</span>` +
        `<span class="r-meta">${st.id} · ${st.province} · ${st.start.slice(0, 4)}–${st.end.slice(0, 4)}</span>`;
      li.addEventListener("mousedown", () => selectStation(st.id));
      list.appendChild(li);
    }
    list.hidden = false;
  }

  input.addEventListener("input", () => {
    const q = normalize(input.value);
    if (q.length < 2) { list.hidden = true; return; }
    const matches = state.index.stations
      .filter((st) =>
        normalize(st.name).includes(q) ||
        normalize(st.province).includes(q) ||
        st.id.toLowerCase().startsWith(q))
      .slice(0, 12);
    render(matches);
  });

  input.addEventListener("keydown", (e) => {
    const items = [...list.children];
    if (!items.length) return;
    if (e.key === "ArrowDown") { selIdx = Math.min(selIdx + 1, items.length - 1); }
    else if (e.key === "ArrowUp") { selIdx = Math.max(selIdx - 1, 0); }
    else if (e.key === "Enter" && selIdx >= 0) {
      items[selIdx].dispatchEvent(new Event("mousedown")); return;
    } else return;
    e.preventDefault();
    items.forEach((li, i) => li.classList.toggle("sel", i === selIdx));
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search-box")) list.hidden = true;
  });
}

// ==========================================================
// 2. Selección de estación y placa lateral
// ==========================================================

async function selectStation(id) {
  $("search-results").hidden = true;
  $("station-search").value = "";
  const res = await fetch(`${DATA_URL}/stations/${id}.json`);
  state.station = await res.json();
  buildCalendar(state.station);
  renderPlate();
  $("tabs").hidden = false;
  $("welcome").hidden = true;
  $("sidebar-empty").hidden = true;
  populateComparatorYears();
  activateTab(document.querySelector(".tab.active").dataset.tab);
}

function renderPlate() {
  const st = state.station;
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
    canvas.width = yearKeys.length;
    canvas.height = 1;
    const ctx = canvas.getContext("2d");
    let totalValid = 0, totalDays = 0;
    yearKeys.forEach((yr, i) => {
      const valid = st.coverage[yr][v] ?? 0;
      const daysInYear = (+yr % 4 === 0 && (+yr % 100 !== 0 || +yr % 400 === 0)) ? 366 : 365;
      const frac = Math.min(1, valid / daysInYear);
      totalValid += valid; totalDays += daysInYear;
      ctx.fillStyle = frac === 0 ? "#0d1117"
        : `rgba(255, 122, 69, ${0.15 + 0.85 * frac})`;
      ctx.fillRect(i, 0, 1, 1);
    });

    const pct = document.createElement("span");
    pct.className = "coverage-pct";
    pct.textContent = `${Math.round((100 * totalValid) / totalDays)}%`;

    row.append(label, canvas, pct);
    wrap.appendChild(row);
  }
  $("station-plate").hidden = false;
}

// ==========================================================
// 3. Pestañas
// ==========================================================

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
  for (const p of ["evolucion", "rachas", "comparador"]) {
    $(`panel-${p}`).hidden = p !== name;
  }
  if (!state.station) return;
  if (name === "evolucion") runEvolution();
  if (name === "rachas") runStreaks();
  if (name === "comparador") runComparator();
}

// ==========================================================
// 4. Evolución anual
// ==========================================================

function runEvolution() {
  const st = state.station;
  const mdS = parseMd($("ev-md-start").value);
  const mdE = parseMd($("ev-md-end").value);
  if (mdS === null || mdE === null) {
    $("ev-note").textContent = "Ventana no válida: usa formato MM-DD (p. ej. 06-15).";
    return;
  }
  const minCov = +$("ev-cov").value / 100;
  const vars = ["tmax", "tmed", "tmin"].filter((v) => $(`ev-${v}`).checked);
  if (!vars.length) { $("ev-note").textContent = "Selecciona al menos una variable."; return; }

  const traces = [];
  let excluded = 0;

  for (const v of vars) {
    const groups = aggregateWindow(st.data[v], mdS, mdE);
    const xs = [], ys = [];
    for (const [yr, g] of [...groups].sort((a, b) => a[0] - b[0])) {
      if (g.nTotal === 0) continue;
      if (g.n / g.nTotal < minCov) { excluded++; continue; }
      xs.push(yr);
      ys.push(g.sum / g.n);
    }
    traces.push({
      x: xs, y: ys, name: VAR_LABELS[v], mode: "markers",
      marker: { color: VAR_COLORS[v], size: 5, opacity: 0.55 },
      hovertemplate: "%{x}: %{y:.2f} °C<extra>" + VAR_LABELS[v] + "</extra>",
    });
    if ($("ev-smooth").checked && xs.length > 10) {
      const win = 10;
      const sx = [], sy = [];
      for (let i = 0; i < xs.length; i++) {
        // media móvil centrada sobre años consecutivos disponibles
        const lo = Math.max(0, i - Math.floor(win / 2));
        const hi = Math.min(xs.length, i + Math.ceil(win / 2));
        let s = 0;
        for (let j = lo; j < hi; j++) s += ys[j];
        sx.push(xs[i]); sy.push(s / (hi - lo));
      }
      traces.push({
        x: sx, y: sy, name: `${VAR_LABELS[v]} (móvil 10a)`, mode: "lines",
        line: { color: VAR_COLORS[v], width: 2.5 },
        hoverinfo: "skip", showlegend: false,
      });
    }
  }

  const layout = structuredClone(PLOTLY_BASE);
  layout.title = {
    text: `${st.name} · media ${mdLabel(mdS)} → ${mdLabel(mdE)}`,
    font: { family: "Space Grotesk, sans-serif", size: 16 }, x: 0.02,
  };
  layout.yaxis.title = { text: "°C" };
  layout.legend = { orientation: "h", y: -0.12 };
  Plotly.newPlot("plot-evolucion", traces, layout, PLOTLY_CFG);

  $("ev-note").textContent = excluded
    ? `${excluded} año-variable excluidos por cobertura < ${Math.round(minCov * 100)}% en la ventana.`
    : "";
}

// ==========================================================
// 5. Rachas
// ==========================================================

function runStreaks() {
  const st = state.station;
  const v = $("ra-var").value;
  const op = $("ra-op").value;
  const thr = +$("ra-thr").value;
  $("ra-unit").textContent = VAR_UNITS[v];
  const values = st.data[v];
  if (!values) return;

  const test = {
    ">=": (x) => x >= thr, ">": (x) => x > thr,
    "<=": (x) => x <= thr, "<": (x) => x < thr,
  }[op];

  // rachas (los huecos cortan la racha) y conteo anual
  const streaks = [];
  const perYear = new Map();
  let runStart = -1, runLen = 0, gaps = 0;

  for (let i = 0; i <= values.length; i++) {
    const x = i < values.length ? values[i] : null;
    const ok = x !== null && test(x);
    if (ok) {
      if (runLen === 0) runStart = i;
      runLen++;
      const yr = state.years[i];
      perYear.set(yr, (perYear.get(yr) || 0) + 1);
    } else {
      if (x === null && i < values.length) gaps++;
      if (runLen > 0) streaks.push({ start: runStart, len: runLen });
      runLen = 0;
    }
  }

  streaks.sort((a, b) => b.len - a.len || b.start - a.start);
  const top = streaks.slice(0, 15);

  const tbody = $("ra-table").querySelector("tbody");
  tbody.innerHTML = "";
  top.forEach((s, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td>${i + 1}</td><td>${s.len}</td>` +
      `<td>${fmtDate(state.startMs, s.start)}</td>` +
      `<td>${fmtDate(state.startMs, s.start + s.len - 1)}</td>`;
    tbody.appendChild(tr);
  });

  const years = [...perYear.keys()].sort((a, b) => a - b);
  const counts = years.map((y) => perYear.get(y));

  const layout = structuredClone(PLOTLY_BASE);
  layout.title = {
    text: `${VAR_LABELS[v]} ${op} ${thr} ${VAR_UNITS[v]}`,
    font: { family: "Space Grotesk, sans-serif", size: 16 }, x: 0.02,
  };
  layout.yaxis.title = { text: "días/año" };
  Plotly.newPlot("plot-rachas", [{
    x: years, y: counts, type: "bar",
    marker: { color: counts, colorscale: "Plasma" },
    hovertemplate: "%{x}: %{y} días<extra></extra>",
  }], layout, PLOTLY_CFG);

  $("ra-note").textContent =
    "Los días sin dato cortan las rachas: en años con huecos la racha real pudo ser más larga. " +
    "Consulta la cobertura de la estación en el panel lateral.";
}

// ==========================================================
// 6. Comparador de años
// ==========================================================

function populateComparatorYears() {
  const sel = $("co-year");
  sel.innerHTML = "";
  for (const y of [...state.yearList].reverse()) {
    const opt = document.createElement("option");
    opt.value = y; opt.textContent = y;
    sel.appendChild(opt);
  }
}

function runComparator() {
  const st = state.station;
  const refYear = +$("co-year").value;
  const vx = $("co-x").value;
  const vy = $("co-y").value;
  const minCov = +$("co-cov").value / 100;

  const X = st.data[vx], Y = st.data[vy];
  const { years, md } = state;

  // ventana MM-DD definida por los días con dato del año de referencia
  let mdMin = Infinity, mdMax = -Infinity, nRef = 0;
  for (let i = 0; i < X.length; i++) {
    if (years[i] !== refYear) continue;
    if (X[i] === null || Y[i] === null) continue;
    nRef++;
    if (md[i] < mdMin) mdMin = md[i];
    if (md[i] > mdMax) mdMax = md[i];
  }
  if (!nRef) {
    $("co-note").textContent = `El año ${refYear} no tiene datos válidos de ${VAR_LABELS[vx]} y ${VAR_LABELS[vy]}.`;
    Plotly.purge("plot-comparador");
    return;
  }

  // agregación de todos los años en la misma ventana
  const gx = aggregateWindow(X, mdMin, mdMax);
  const gy = aggregateWindow(Y, mdMin, mdMax);
  const rows = [];
  for (const [yr, g] of gx) {
    const h = gy.get(yr);
    if (!h) continue;
    if (g.n < minCov * nRef || h.n < minCov * nRef) continue;
    rows.push({ yr, x: g.sum / g.n, y: h.sum / h.n });
  }
  rows.sort((a, b) => a.yr - b.yr);

  const ref = rows.find((r) => r.yr === refYear);
  const rest = rows.filter((r) => r.yr !== refYear);

  const traces = [{
    x: rest.map((r) => r.x), y: rest.map((r) => r.y),
    mode: "markers", type: "scatter", name: "resto de años",
    text: rest.map((r) => String(r.yr)),
    marker: {
      color: rest.map((r) => r.yr), colorscale: "Plasma",
      size: 10, line: { color: "#0d1117", width: 1 },
      colorbar: { title: "Año", thickness: 14, outlinecolor: "#2b3340" },
    },
    hovertemplate: "%{text}<br>" + VAR_LABELS[vx] + ": %{x:.2f} °C<br>" +
                   VAR_LABELS[vy] + ": %{y:.2f} °C<extra></extra>",
  }];

  if (ref) {
    traces.push({
      x: [ref.x], y: [ref.y], mode: "markers+text", name: String(refYear),
      text: [String(refYear)], textposition: "top right",
      textfont: { color: ACCENT, size: 15, family: "Space Grotesk, sans-serif" },
      marker: { color: ACCENT, size: 16, line: { color: "#ffffff", width: 1.5 } },
      hovertemplate: refYear + "<br>%{x:.2f} °C · %{y:.2f} °C<extra></extra>",
    });
  }

  const layout = structuredClone(PLOTLY_BASE);
  layout.title = {
    text: `${st.name} · ${mdLabel(mdMin)} → ${mdLabel(mdMax)} de cada año`,
    font: { family: "Space Grotesk, sans-serif", size: 16 }, x: 0.02,
  };
  layout.xaxis.title = { text: `${VAR_LABELS[vx]} media (°C)` };
  layout.yaxis.title = { text: `${VAR_LABELS[vy]} media (°C)` };
  layout.showlegend = false;

  if (rest.length) {
    const median = (arr) => {
      const s = [...arr].sort((a, b) => a - b);
      const m = Math.floor(s.length / 2);
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    };
    layout.shapes = [
      { type: "line", x0: median(rest.map((r) => r.x)), x1: median(rest.map((r) => r.x)),
        yref: "paper", y0: 0, y1: 1, line: { color: "#2b3340", dash: "dash", width: 1 } },
      { type: "line", y0: median(rest.map((r) => r.y)), y1: median(rest.map((r) => r.y)),
        xref: "paper", x0: 0, x1: 1, line: { color: "#2b3340", dash: "dash", width: 1 } },
    ];
  }

  Plotly.newPlot("plot-comparador", traces, layout, PLOTLY_CFG);

  let rankTxt = "";
  if (ref && rest.length) {
    const warmer = rest.filter((r) => r.x > ref.x).length;
    rankTxt = ` En ${VAR_LABELS[vx]}, ${refYear} es el ${warmer + 1}º más cálido de ${rows.length} años comparables.`;
  }
  $("co-note").textContent =
    `Ventana definida por los ${nRef} días con dato de ${refYear}; ` +
    `${rows.length} años con cobertura ≥ ${Math.round(minCov * 100)}%.` + rankTxt;
}

// ==========================================================
// init
// ==========================================================

function bindControls() {
  $("ev-run").addEventListener("click", runEvolution);
  $("ra-run").addEventListener("click", runStreaks);
  $("co-run").addEventListener("click", runComparator);
  $("ev-cov").addEventListener("input", () => $("ev-cov-val").textContent = `${$("ev-cov").value}%`);
  $("co-cov").addEventListener("input", () => $("co-cov-val").textContent = `${$("co-cov").value}%`);
  $("ra-var").addEventListener("change", () => {
    $("ra-unit").textContent = VAR_UNITS[$("ra-var").value];
  });
}

async function init() {
  setupSearch();
  setupTabs();
  bindControls();
  try {
    await loadIndex();
    document.querySelector(".tagline").textContent =
      `Series diarias · ${state.index.n_stations} estaciones · análisis en tu navegador`;
  } catch {
    $("sidebar-empty").innerHTML =
      "<p>No se pudo cargar <span class='mono'>data/index.json</span>. " +
      "Ejecuta <span class='mono'>scripts/build_data.py</span> y sirve la web desde la raíz del repo.</p>";
  }
}

init();
