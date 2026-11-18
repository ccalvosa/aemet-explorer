#!/usr/bin/env python3
"""
Genera los agregados nacionales que usa la pestaña «España», para calcular
anomalías, mapas, regiones y récords de toda la red sin cargar los 920 JSON
diarios en el navegador.

Uso (tras build_data.py, sobre sus salidas):
    python build_national.py --data-dir ../data

Salidas:

data/national.json — anual, arrays alineados a y0..y1 (null = año no válido)
{ "y0": 1920, "y1": 2025,
  "vars": ["tmed","tmax","tmin","prec"],          # medias / total anual
  "ext":  ["txx","txn","tnx","tnn","rx1"],        # extremos anuales
  "stations": { "9434": { "tmed": [...], ..., "txx": [...], ... } } }
    txx = Tmax más alta del año    txn = Tmax más baja
    tnx = Tmin más alta            tnn = Tmin más baja
    rx1 = precipitación máxima en 24 h

data/national_monthly.json — mensual, por estación desde su propio año inicial
{ "vars": [...], "stations": { "9434": { "y0": 1941,
    "tmed": [ene1941, feb1941, ..., dic<último>], ... } } }

Criterios de validez:
  anual   — temperaturas (media y extremos) >= 90 % de días; precipitación
            (total y máximo) >= 95 %.
  mensual — temperaturas >= 80 % de días; precipitación >= 90 %.
"""

import argparse
import json
import sys
from datetime import date, timedelta
from pathlib import Path

VARS_MEAN = ["tmed", "tmax", "tmin"]
EXT = ["txx", "txn", "tnx", "tnn", "rx1"]
COV_MEAN = 0.90
COV_PREC = 0.95
COV_MEAN_M = 0.80
COV_PREC_M = 0.90


def days_in_year(y):
    return 366 if (y % 4 == 0 and (y % 100 != 0 or y % 400 == 0)) else 365


def days_in_month(y, m):
    nxt = date(y + (m == 12), m % 12 + 1, 1)
    return (nxt - date(y, m, 1)).days


def valid(arr, a, b):
    return [x for x in arr[a:b] if x is not None] if arr else []


def station_stats(st):
    start = date.fromisoformat(st["start"])
    n = len(st["data"][st["vars"][0]])
    y0, y1 = start.year, (start + timedelta(days=n - 1)).year
    D = st["data"]

    def idx(d):
        return max(0, min(n, (d - start).days))

    annual = {v: [] for v in VARS_MEAN + ["prec"] + EXT}
    monthly = {v: [] for v in VARS_MEAN + ["prec"]}
    for y in range(y0, y1 + 1):
        a = idx(date(y, 1, 1))
        b = min(n, (date(y, 12, 31) - start).days + 1)
        need_t = COV_MEAN * days_in_year(y)
        need_p = COV_PREC * days_in_year(y)
        tx, tn = valid(D.get("tmax"), a, b), valid(D.get("tmin"), a, b)
        for v in VARS_MEAN:
            vals = valid(D.get(v), a, b)
            annual[v].append(round(sum(vals) / len(vals), 2) if len(vals) >= need_t else None)
        pr = valid(D.get("prec"), a, b)
        ok_p = len(pr) >= need_p
        annual["prec"].append(round(sum(pr), 1) if ok_p else None)
        annual["txx"].append(max(tx) if len(tx) >= need_t else None)
        annual["txn"].append(min(tx) if len(tx) >= need_t else None)
        annual["tnx"].append(max(tn) if len(tn) >= need_t else None)
        annual["tnn"].append(min(tn) if len(tn) >= need_t else None)
        annual["rx1"].append(max(pr) if ok_p else None)

        for m in range(1, 13):
            dm = days_in_month(y, m)
            ma = (date(y, m, 1) - start).days
            mb = ma + dm
            if mb <= 0 or ma >= n:
                for v in monthly:
                    monthly[v].append(None)
                continue
            ma, mb = max(0, ma), min(n, mb)
            for v in VARS_MEAN:
                vals = valid(D.get(v), ma, mb)
                monthly[v].append(round(sum(vals) / len(vals), 2) if len(vals) >= COV_MEAN_M * dm else None)
            pv = valid(D.get("prec"), ma, mb)
            monthly["prec"].append(round(sum(pv), 1) if len(pv) >= COV_PREC_M * dm else None)
    return y0, y1, annual, monthly


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", type=Path, default=Path("../data"))
    ap.add_argument("--output", type=Path, default=None,
                    help="ruta de national.json (por defecto <data-dir>/national.json)")
    ap.add_argument("--output-monthly", type=Path, default=None,
                    help="ruta de national_monthly.json (por defecto junto a national.json)")
    args = ap.parse_args()
    out_a = args.output or args.data_dir / "national.json"
    out_m = args.output_monthly or out_a.with_name("national_monthly.json")

    files = sorted((args.data_dir / "stations").glob("*.json"))
    if not files:
        sys.exit("No hay JSON de estaciones; ejecuta antes build_data.py.")

    per_station, monthly_all = {}, {}
    g0, g1 = 9999, 0
    for k, f in enumerate(files, 1):
        try:
            st = json.load(open(f, encoding="utf-8"))
            y0, y1, ann, mon = station_stats(st)
        except Exception as e:
            print(f"  AVISO {f.name}: {e}", file=sys.stderr)
            continue
        if any(x is not None for v in ann.values() for x in v):
            per_station[st["id"]] = (y0, y1, ann)
            g0, g1 = min(g0, y0), max(g1, y1)
        if any(x is not None for v in mon.values() for x in v):
            monthly_all[st["id"]] = {"y0": y0, **mon}
        if k % 100 == 0 or k == len(files):
            print(f"  {k}/{len(files)}")

    stations = {}
    for sid, (y0, y1, ann) in per_station.items():
        pad_l, pad_r = y0 - g0, g1 - y1
        stations[sid] = {v: [None] * pad_l + ann[v] + [None] * pad_r for v in ann}

    out = {"y0": g0, "y1": g1, "vars": VARS_MEAN + ["prec"], "ext": EXT, "stations": stations}
    with open(out_a, "w", encoding="utf-8") as fo:
        json.dump(out, fo, ensure_ascii=False, separators=(",", ":"))
    with open(out_m, "w", encoding="utf-8") as fo:
        json.dump({"vars": VARS_MEAN + ["prec"], "stations": monthly_all}, fo,
                  ensure_ascii=False, separators=(",", ":"))
    print(f"Hecho: {len(stations)} estaciones, {g0}–{g1}\n"
          f"  {out_a}: {out_a.stat().st_size / 1e6:.1f} MB\n"
          f"  {out_m}: {out_m.stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
