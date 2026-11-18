#!/usr/bin/env python3
"""
Genera data/recent.json con los últimos N días (120 por defecto) de todas las estaciones,
usando el endpoint 'todasestaciones' de AEMET OpenData (una llamada por
tramo de fechas, no por estación).

Uso (en GitHub Actions o local):
    export AEMET_API_KEY="..."
    python update_recent.py --index data/index.json --output data/recent.json

Formato de salida:
{
  "generated": "...", "start": "YYYY-MM-DD", "end": "YYYY-MM-DD",
  "stations": { "9434": {"tmed": [...], "tmax": [...], ...}, ... }
}
Arrays alineados a días consecutivos start→end, null en huecos.
"last_data" es el último día con algún dato real. Los días que la API no
devuelve se rellenan con el recent.json previo; si la API está caída del todo,
el fichero previo se conserva y el script termina sin error.
La web lo fusiona con el histórico en cliente (recent tiene prioridad).
"""

import argparse
import json
import os
import sys
import time
from datetime import date, timedelta
from pathlib import Path

import requests

BASE = ("https://opendata.aemet.es/opendata/api/valores/climatologicos/"
        "diarios/datos/fechaini/{ini}T00:00:00UTC/fechafin/{fin}T23:59:59UTC/"
        "todasestaciones")
VARS = ["tmed", "tmax", "tmin", "prec", "racha", "sol"]
WINDOW_DAYS = 120        # cubre huecos entre el histórico y la ventana si la API falla
CHUNK_DAYS = 14          # límite práctico del endpoint todasestaciones
SLEEP_BETWEEN = 5        # cortesía con el rate limit


def fetch_json(url, params, tries=6):
    for attempt in range(tries):
        try:
            r = requests.get(url, params=params, timeout=60)
            if r.status_code == 429:
                raise RuntimeError("rate limit")
            r.raise_for_status()
            return r.json()
        except Exception as e:
            wait = 2 ** attempt * 10
            print(f"  intento {attempt + 1}/{tries} fallido ({e}); "
                  f"espera {wait}s", file=sys.stderr)
            time.sleep(wait)
    return None


def to_float(x):
    if x is None:
        return None
    s = str(x).strip().replace(",", ".")
    if s == "Ip":
        return 0.0
    try:
        return round(float(s), 1)
    except ValueError:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--index", type=Path, required=True)
    ap.add_argument("--output", type=Path, required=True)
    ap.add_argument("--window", type=int, default=WINDOW_DAYS)
    args = ap.parse_args()

    api_key = os.environ.get("AEMET_API_KEY")
    if not api_key:
        sys.exit("Define AEMET_API_KEY.")

    known = {s["id"] for s in json.load(open(args.index))["stations"]}

    end = date.today() - timedelta(days=1)
    start = end - timedelta(days=args.window - 1)
    n_days = (end - start).days + 1
    idx_of = lambda d: (d - start).days

    stations = {}
    got_any = False
    cur = start
    while cur <= end:
        fin = min(cur + timedelta(days=CHUNK_DAYS - 1), end)
        print(f"Tramo {cur} → {fin}...")
        meta = fetch_json(BASE.format(ini=cur, fin=fin), {"api_key": api_key})
        if meta and isinstance(meta, dict) and "datos" in meta:
            rows = fetch_json(meta["datos"], {})
            if rows:
                got_any = True
                for row in rows:
                    ind = row.get("indicativo")
                    if ind not in known:
                        continue
                    try:
                        d = date.fromisoformat(row["fecha"])
                    except (KeyError, ValueError):
                        continue
                    i = idx_of(d)
                    if not (0 <= i < n_days):
                        continue
                    st = stations.setdefault(
                        ind, {v: [None] * n_days for v in VARS})
                    for v in VARS:
                        val = to_float(row.get(v))
                        if val is not None:
                            st[v][i] = val
        else:
            print(f"  tramo {cur}→{fin} sin datos (¿API caída?)",
                  file=sys.stderr)
        cur = fin + timedelta(days=1)
        time.sleep(SLEEP_BETWEEN)

    if not got_any:
        # API caída: no machacar el recent.json bueno y no marcar el job como
        # fallido (el workflow ya no commitea si no hay cambios).
        print("::warning::AEMET no devolvió datos en ningún tramo; "
              "se conserva el recent.json previo.")
        return

    # Rellenar con el fichero previo los días que esta vez no llegaron
    # (tramos fallidos o estaciones que la API omitió hoy).
    merged_days = 0
    if args.output.exists():
        try:
            prev = json.load(open(args.output, encoding="utf-8"))
            p_start = date.fromisoformat(prev["start"])
            for ind, pst in prev.get("stations", {}).items():
                if ind not in known:
                    continue
                for v in VARS:
                    pv = pst.get(v) or []
                    for k, val in enumerate(pv):
                        if val is None:
                            continue
                        i = idx_of(p_start + timedelta(days=k))
                        if not (0 <= i < n_days):
                            continue
                        st = stations.setdefault(ind, {w: [None] * n_days for w in VARS})
                        if st[v][i] is None:
                            st[v][i] = val
                            merged_days += 1
        except Exception as e:
            print(f"  AVISO: no se pudo fusionar el fichero previo ({e})", file=sys.stderr)
    if merged_days:
        print(f"  {merged_days} valores recuperados del fichero previo")

    # último día con algún dato real (la API va con días de retraso)
    last_i = max((i for st in stations.values() for i, x in enumerate(st["tmax"])
                  if x is not None), default=None)
    last_data = (start + timedelta(days=last_i)).isoformat() if last_i is not None else None

    out = {
        "generated": time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime()),
        "start": start.isoformat(),
        "end": end.isoformat(),
        "last_data": last_data,
        "stations": stations,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"Hecho: {len(stations)} estaciones, {start} → {end}, "
          f"{args.output.stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
