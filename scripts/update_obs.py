#!/usr/bin/env python3
"""
Genera obs.json con las observaciones de las últimas 24 h de las estaciones
automáticas de AEMET, cada 10 minutos, para la pestaña «Última hora».

Usa dos endpoints de AEMET OpenData en cada ejecución:
  observacion/convencional/diezminutal/todas  datos cada 10 min (solo la última hora)
  observacion/convencional/todas              datos horarios (últimas ~12 h), con
                                              máxima/mínima y lluvia de cada hora

Como el diezminutal solo cubre una hora, el script se lanza cada 20 minutos y
fusiona lo nuevo con el obs.json anterior. Los datos horarios rellenan las
horas en punto que falten (si el cron se retrasa) y dan los extremos reales de
cada hora. Se descartan los valores con bandera de calidad >= 3 (erróneos).
Si la API falla, se conserva el fichero anterior y el script termina sin error.

Uso:
    export AEMET_API_KEY="..."
    python update_obs.py --previous obs_prev.json --output obs.json

Formato de salida (UTC; arrays alineados a instantes consecutivos):
{
  "generated": "...",
  "t0": "2026-11-18T08:50:00Z", "n": 144, "step": 600, "last": "...",   # rejilla de 10 min
  "h0": "2026-11-18T09:00:00Z", "nh": 24,                             # rejilla horaria
  "vars": ["ta", "hr", "vv", "vmax", "dv", "dmax", "pres", "p10"],     # 10 min
  "hvars": ["tamax", "tamin", "prec"],                                 # horarias
  "meta": { "9434": ["ZARAGOZA AEROPUERTO", 41.66, -1.00, 249], ... },
  "data": { "9434": { "ta": [...144], ..., "tamax": [...24], ... } }
}
  ta °C · hr % · vv/vmax viento medio y racha (m/s) · dv/dmax direcciones (grados)
  pres hPa (en la estación) · p10 lluvia en los 10 min (mm)
  tamax/tamin extremos de la hora (°C) · prec lluvia de la hora (mm)
"""

import argparse
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

API = "https://opendata.aemet.es/opendata/api/observacion/convencional/"
URL_10 = API + "diezminutal/todas"
URL_H = API + "todas"
STEP = timedelta(minutes=10)
N10 = 144          # 24 h de 10 min
NH = 24

# variable de salida: (campo diezminutal, bandera de calidad, campo horario)
V10 = {
    "ta": ("TA", "QTA", "ta"),
    "hr": ("HR", "QHR", "hr"),
    "vv": ("VV10m", "QVV10m", "vv"),
    "vmax": ("VMAX10m", "QVMAX10m", "vmax"),
    "dv": ("DV10m", "QDV10m", "dv"),
    "dmax": ("DMAX10m", "QDMAX10m", "dmax"),
    "pres": ("PRES", "QPRES", "pres"),
    "p10": ("PREC", "QPREC", None),
}
VH = {"tamax": "tamax", "tamin": "tamin", "prec": "prec"}


def fetch(url, params=None, tries=3):
    for attempt in range(tries):
        try:
            r = requests.get(url, params=params, timeout=90)
            if r.status_code == 429:
                raise RuntimeError("rate limit")
            r.raise_for_status()
            return r
        except Exception as e:
            wait = 2 ** attempt * 10
            print(f"  intento {attempt + 1}/{tries} fallido ({e}); espera {wait}s", file=sys.stderr)
            time.sleep(wait)
    return None


def fetch_rows(url, api_key):
    r = fetch(url, {"api_key": api_key})
    if r is None:
        return None
    try:
        datos = r.json().get("datos")
        rd = fetch(datos) if datos else None
        return json.loads(rd.content.decode("latin-1")) if rd is not None else None
    except Exception as e:
        print(f"  error leyendo {url} ({e})", file=sys.stderr)
        return None


def parse_time(s):
    return datetime.strptime(s.replace("Z", "+0000"), "%Y-%m-%dT%H:%M:%S%z").astimezone(timezone.utc)


def iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def num(x):
    if x is None or x == "":
        return None
    try:
        return round(float(x), 1)
    except (TypeError, ValueError):
        return None


def load_previous(path):
    """Devuelve (obs10, obsh, meta): {(id, t): {var: valor}} de cada rejilla."""
    o10, oh, meta = {}, {}, {}
    if not path or not path.exists():
        return o10, oh, meta
    try:
        prev = json.load(open(path, encoding="utf-8"))
        meta = prev.get("meta", {})
        if "h0" not in prev:   # formato antiguo (solo horario): se ignora
            return o10, oh, meta
        t0, h0 = parse_time(prev["t0"]), parse_time(prev["h0"])
        for sid, arrs in prev.get("data", {}).items():
            for v, arr in arrs.items():
                hourly = v in VH
                for k, x in enumerate(arr):
                    if x is None:
                        continue
                    if hourly:
                        oh.setdefault((sid, h0 + timedelta(hours=k)), {})[v] = x
                    else:
                        o10.setdefault((sid, t0 + k * STEP), {})[v] = x
    except Exception as e:
        print(f"  AVISO: no se pudo leer el obs.json previo ({e})", file=sys.stderr)
    return o10, oh, meta


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--previous", type=Path, default=None)
    ap.add_argument("--output", type=Path, required=True)
    args = ap.parse_args()
    api_key = os.environ.get("AEMET_API_KEY")
    if not api_key:
        sys.exit("Define AEMET_API_KEY.")

    o10, oh, meta = load_previous(args.previous)
    rows10 = fetch_rows(URL_10, api_key)
    time.sleep(2)
    rowsh = fetch_rows(URL_H, api_key)
    if not rows10 and not rowsh:
        print("::warning::La API de observación de AEMET no responde; se conserva el obs.json anterior.")
        if args.previous and args.previous.exists() and args.previous.resolve() != args.output.resolve():
            args.output.write_bytes(args.previous.read_bytes())
        return

    # ---- diezminutales ----
    for row in rows10 or []:
        sid, f = row.get("IDEMA"), row.get("Fecha")
        if not sid or not f:
            continue
        t = parse_time(f)
        if t.minute % 10 or t.second:
            continue
        slot = o10.setdefault((sid, t), {})
        for v, (field, qf, _) in V10.items():
            x = num(row.get(field))
            q = row.get(qf)
            if x is None or (q is not None and q >= 3):
                continue
            slot[v] = x
        lon, lat = (row.get("LOC") or {}).get("coordinates", [None, None])
        meta[sid] = [(row.get("UBI") or sid).strip(),
                     round(lat, 4) if lat is not None else None,
                     round(lon, 4) if lon is not None else None,
                     int(round(float(row["ALT"]))) if row.get("ALT") is not None else None]

    # ---- horarios: extremos y lluvia de la hora; rellenan las horas en punto ----
    for row in rowsh or []:
        sid, f = row.get("idema"), row.get("fint")
        if not sid or not f:
            continue
        t = parse_time(f)
        if t.minute or t.second:
            continue
        hs = oh.setdefault((sid, t), {})
        for v, field in VH.items():
            x = num(row.get(field))
            if x is not None:
                hs[v] = x
        s10 = o10.setdefault((sid, t), {})
        for v, (_, _, hfield) in V10.items():
            if hfield and v not in s10:
                x = num(row.get(hfield))
                if x is not None:
                    s10[v] = x
        if sid not in meta and row.get("lat") is not None:
            meta[sid] = [(row.get("ubi") or sid).strip(), round(float(row["lat"]), 4),
                         round(float(row["lon"]), 4),
                         int(round(float(row["alt"]))) if row.get("alt") is not None else None]

    last = max(t for (_, t), s in o10.items() if s)
    t0 = last - (N10 - 1) * STEP
    lastH = last.replace(minute=0)
    h0 = lastH - timedelta(hours=NH - 1)
    data = {}
    for (sid, t), vals in o10.items():
        if t < t0 or t > last or not vals:
            continue
        k = int((t - t0) / STEP)
        st = data.setdefault(sid, {})
        for v, x in vals.items():
            st.setdefault(v, [None] * N10)[k] = x
    for (sid, t), vals in oh.items():
        if t < h0 or t > lastH or not vals:
            continue
        k = int((t - h0).total_seconds() // 3600)
        st = data.setdefault(sid, {})
        for v, x in vals.items():
            st.setdefault(v, [None] * NH)[k] = x
    meta = {sid: m for sid, m in meta.items() if sid in data and m[1] is not None}
    order = list(V10) + list(VH)
    out = {"generated": iso(datetime.now(timezone.utc)),
           "t0": iso(t0), "n": N10, "step": int(STEP.total_seconds()), "last": iso(last),
           "h0": iso(h0), "nh": NH, "vars": list(V10), "hvars": list(VH), "meta": meta,
           "data": {sid: {v: st[v] for v in order if v in st}
                    for sid, st in sorted(data.items()) if sid in meta}}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as fo:
        json.dump(out, fo, ensure_ascii=False, separators=(",", ":"))
    slots = {t for (_, t), s in o10.items() if s and t >= t0}
    print(f"Hecho: {len(out['data'])} estaciones, {len(slots)}/{N10} instantes de 10 min "
          f"({iso(min(slots))} → {iso(last)}); filas nuevas: {len(rows10 or [])} diezminutales, "
          f"{len(rowsh or [])} horarias · {args.output.stat().st_size / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
