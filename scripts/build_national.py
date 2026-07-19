#!/usr/bin/env python3
"""
Genera data/national.json: medias anuales por estación y variable, para que
la web calcule índices nacionales (anomalías / % de la normal) contra
cualquier período de referencia sin cargar los 920 JSON diarios.

Uso (tras build_data.py, sobre sus salidas):
    python build_national.py --data-dir ../data --output ../data/national.json

Criterios: año natural con cobertura >=90% para temperaturas (media) y
>=95% para precipitación (total anual). Años que no cumplen → null.

Salida:
{ "y0": 1920, "y1": 2025, "vars": ["tmed","tmax","tmin","prec"],
  "stations": { "9434": { "tmed": [...], ... } } }
Arrays alineados a y0..y1.
"""

import argparse
import json
import sys
from datetime import date, timedelta
from pathlib import Path

VARS_MEAN = ["tmed", "tmax", "tmin"]
COV_MEAN = 0.90
COV_PREC = 0.95


def days_in_year(y):
    return 366 if (y % 4 == 0 and (y % 100 != 0 or y % 400 == 0)) else 365


def annual_stats(st):
    start = date.fromisoformat(st["start"])
    n = len(st["data"][st["vars"][0]])
    # límites de índice por año
    y0, y1 = start.year, (start + timedelta(days=n - 1)).year
    bounds = {}
    for y in range(y0, y1 + 1):
        a = max(0, (date(y, 1, 1) - start).days)
        b = min(n, (date(y, 12, 31) - start).days + 1)
        bounds[y] = (a, b)

    out = {}
    for v in VARS_MEAN + ["prec"]:
        arr = st["data"].get(v)
        res = []
        for y in range(y0, y1 + 1):
            a, b = bounds[y]
            vals = [x for x in arr[a:b] if x is not None] if arr else []
            need = (COV_PREC if v == "prec" else COV_MEAN) * days_in_year(y)
            if len(vals) < need:
                res.append(None)
            elif v == "prec":
                res.append(round(sum(vals), 1))
            else:
                res.append(round(sum(vals) / len(vals), 2))
        out[v] = res
    return y0, y1, out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", type=Path, default=Path("../data"))
    ap.add_argument("--output", type=Path, default=Path("../data/national.json"))
    args = ap.parse_args()

    files = sorted((args.data_dir / "stations").glob("*.json"))
    if not files:
        sys.exit("No hay JSON de estaciones; ejecuta antes build_data.py.")

    per_station = {}
    g0, g1 = 9999, 0
    for k, f in enumerate(files, 1):
        try:
            st = json.load(open(f, encoding="utf-8"))
            y0, y1, res = annual_stats(st)
        except Exception as e:
            print(f"  AVISO {f.name}: {e}", file=sys.stderr)
            continue
        # descarta estaciones sin ni un solo año válido
        if not any(x is not None for v in res.values() for x in v):
            continue
        per_station[st["id"]] = (y0, y1, res)
        g0, g1 = min(g0, y0), max(g1, y1)
        if k % 100 == 0 or k == len(files):
            print(f"  {k}/{len(files)}")

    ny = g1 - g0 + 1
    stations = {}
    for sid, (y0, y1, res) in per_station.items():
        pad_l, pad_r = y0 - g0, g1 - y1
        stations[sid] = {
            v: [None] * pad_l + res[v] + [None] * pad_r
            for v in VARS_MEAN + ["prec"]
        }

    out = {"y0": g0, "y1": g1, "vars": VARS_MEAN + ["prec"],
           "stations": stations}
    with open(args.output, "w", encoding="utf-8") as fo:
        json.dump(out, fo, ensure_ascii=False, separators=(",", ":"))
    print(f"Hecho: {len(stations)} estaciones, {g0}–{g1}, "
          f"{args.output.stat().st_size / 1e6:.1f} MB → {args.output}")


if __name__ == "__main__":
    main()
