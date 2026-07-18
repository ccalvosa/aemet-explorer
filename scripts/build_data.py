#!/usr/bin/env python3
"""
Convierte CSVs diarios de AEMET OpenData a JSON columnar por estación
para servir estáticamente desde GitHub Pages.

Uso:
    python build_data.py --input-dir csvs/ --output-dir ../data/ [--workers 8]
"""

import argparse
import json
import sys
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import numpy as np
import pandas as pd

VARS = ["tmed", "tmax", "tmin", "prec", "racha", "sol"]
DTYPES = {"indicativo": str, "nombre": str, "provincia": str}


def read_all_csvs(input_dir: Path) -> pd.DataFrame:
    files = sorted(input_dir.rglob("*.csv"))
    if not files:
        sys.exit(f"No hay CSVs en {input_dir}")
    print(f"Leyendo {len(files)} CSVs...")
    frames = []
    for f in files:
        try:
            df = pd.read_csv(f, decimal=",", dtype=DTYPES,
                             usecols=lambda c: c in
                             {"fecha", "indicativo", "nombre", "provincia",
                              "altitud", *VARS})
            frames.append(df)
        except Exception as e:
            print(f"  AVISO: {f.name} descartado ({e})", file=sys.stderr)
    df = pd.concat(frames, ignore_index=True)
    df["fecha"] = pd.to_datetime(df["fecha"], errors="coerce")
    df = df.dropna(subset=["fecha", "indicativo"])
    for v in VARS:
        if v in df.columns and df[v].dtype == object:
            df[v] = (df[v].astype(str).str.replace(",", ".", regex=False)
                     .replace({"Ip": "0.0", "Acum": "nan", "nan": "nan"}))
            df[v] = pd.to_numeric(df[v], errors="coerce")
    for v in VARS:
        if v not in df.columns:
            df[v] = np.nan
    df = (df.sort_values("fecha")
            .drop_duplicates(subset=["indicativo", "fecha"], keep="last"))
    return df


def _round_or_null(arr: np.ndarray) -> list:
    return [None if np.isnan(x) else round(float(x), 1) for x in arr]


def build_station(args) -> dict:
    ind, g, outdir = args
    g = g.set_index("fecha").sort_index()
    full = pd.date_range(g.index.min(), g.index.max(), freq="D")
    g = g.reindex(full)

    data = {v: _round_or_null(g[v].to_numpy(dtype=float)) for v in VARS}

    cov = {}
    years = full.year
    for yr in np.unique(years):
        m = years == yr
        cov[str(int(yr))] = {v: int(g[v].iloc[m].notna().sum()) for v in VARS}

    meta_row = g.dropna(subset=["nombre"]).iloc[-1] if g["nombre"].notna().any() else None
    name = str(meta_row["nombre"]).title() if meta_row is not None else ind
    prov = str(meta_row["provincia"]) if meta_row is not None else ""
    alt = (int(meta_row["altitud"])
           if meta_row is not None and pd.notna(meta_row["altitud"]) else None)

    station = {
        "id": ind, "name": name, "province": prov, "altitude": alt,
        "start": full[0].strftime("%Y-%m-%d"),
        "end": full[-1].strftime("%Y-%m-%d"),
        "vars": VARS, "data": data, "coverage": cov,
    }

    out = outdir / "stations" / f"{ind}.json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump(station, f, ensure_ascii=False, separators=(",", ":"))

    n_days = len(full)
    pct = {v: round(100 * sum(x is not None for x in data[v]) / n_days, 1)
           for v in VARS}
    return {
        "id": ind, "name": name, "province": prov, "altitude": alt,
        "start": station["start"], "end": station["end"],
        "n_days": n_days, "pct_coverage": pct,
        "size_kb": round(out.stat().st_size / 1024, 1),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input-dir", type=Path, required=True)
    ap.add_argument("--output-dir", type=Path, default=Path("../data"))
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args()

    (args.output_dir / "stations").mkdir(parents=True, exist_ok=True)

    df = read_all_csvs(args.input_dir)
    groups = [(ind, g, args.output_dir) for ind, g in df.groupby("indicativo")]
    print(f"{len(groups)} estaciones, {len(df):,} registros")

    entries = []
    with ProcessPoolExecutor(max_workers=args.workers) as ex:
        futures = {ex.submit(build_station, g): g[0] for g in groups}
        for i, fut in enumerate(as_completed(futures), 1):
            try:
                entries.append(fut.result())
            except Exception as e:
                print(f"  ERROR {futures[fut]}: {e}", file=sys.stderr)
            if i % 50 == 0 or i == len(groups):
                print(f"  {i}/{len(groups)}")

    entries.sort(key=lambda e: e["id"])
    index = {
        "generated": pd.Timestamp.now().strftime("%Y-%m-%d %H:%M"),
        "n_stations": len(entries),
        "stations": entries,
    }
    with open(args.output_dir / "index.json", "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, separators=(",", ":"))

    total_mb = sum(e["size_kb"] for e in entries) / 1024
    print(f"\nHecho: {len(entries)} estaciones, {total_mb:.0f} MB en data/stations/")


if __name__ == "__main__":
    main()
