#!/usr/bin/env python3
"""
Genera data/coords.json con las coordenadas de las estaciones a partir del
inventario de AEMET OpenData.

Uso:
    export AEMET_API_KEY="tu_api_key"
    python build_coords.py --output ../data/coords.json

La API de AEMET responde en dos pasos (metadatos con URL 'datos' + descarga)
y se cae con frecuencia: el script reintenta con espera exponencial.

Salida: {"9434": [41.6606, -1.0042], ...}  (grados decimales, WGS84)
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

import requests

INVENTORY_URL = ("https://opendata.aemet.es/opendata/api/valores/"
                 "climatologicos/inventarioestaciones/todasestaciones")


def dms_to_dd(text: str) -> float:
    """'394924N' / '0024532W' → grados decimales. Últimos 4 dígitos = MMSS."""
    text = text.strip()
    hemi = text[-1].upper()
    digits = text[:-1]
    if not digits.isdigit() or hemi not in "NSEW":
        raise ValueError(f"coordenada no reconocida: {text!r}")
    sec = int(digits[-2:])
    minu = int(digits[-4:-2])
    deg = int(digits[:-4])
    dd = deg + minu / 60 + sec / 3600
    if hemi in "SW":
        dd = -dd
    return round(dd, 4)


def fetch_json(url: str, params: dict, tries: int = 6) -> object:
    for attempt in range(tries):
        try:
            r = requests.get(url, params=params, timeout=30)
            if r.status_code == 429:
                raise RuntimeError("rate limit")
            r.raise_for_status()
            return r.json()
        except Exception as e:
            wait = 2 ** attempt * 5
            print(f"  intento {attempt + 1}/{tries} fallido ({e}); "
                  f"reintento en {wait}s", file=sys.stderr)
            time.sleep(wait)
    sys.exit("AEMET OpenData no responde tras varios intentos.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--output", type=Path, default=Path("../data/coords.json"))
    args = ap.parse_args()

    api_key = os.environ.get("AEMET_API_KEY")
    if not api_key:
        sys.exit("Define la variable de entorno AEMET_API_KEY.")

    print("Solicitando inventario de estaciones...")
    meta = fetch_json(INVENTORY_URL, {"api_key": api_key})
    if not isinstance(meta, dict) or "datos" not in meta:
        sys.exit(f"Respuesta inesperada de AEMET: {meta}")

    print("Descargando datos...")
    stations = fetch_json(meta["datos"], {})

    coords, errors = {}, 0
    for st in stations:
        try:
            coords[st["indicativo"]] = [dms_to_dd(st["latitud"]),
                                        dms_to_dd(st["longitud"])]
        except (KeyError, ValueError) as e:
            errors += 1
            print(f"  descartada {st.get('indicativo', '?')}: {e}",
                  file=sys.stderr)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(coords, f, separators=(",", ":"))

    print(f"Hecho: {len(coords)} estaciones "
          f"({errors} descartadas) → {args.output} "
          f"({args.output.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
