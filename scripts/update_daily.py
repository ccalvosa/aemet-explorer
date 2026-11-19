#!/usr/bin/env python3
"""
Valores diarios PROVISIONALES a partir de las observaciones de la red
automática (obs.json de update_obs.py), y su comparación con la climatología
de cada estación para hoy y ayer.

Se ejecuta tras update_obs.py en el mismo workflow:
    python update_daily.py --obs obs.json --previous daily_prev.json \\
        --data-dir data --output daily.json

Días climatológicos como en los diarios de AEMET:
  Tmax / Tmin  de 00 a 24 UTC
  Precipitación de 07 a 07 UTC (el día D acumula de D 07 UTC a D+1 07 UTC)

Cada hora (que termina en t) se resume en [máx, mín, lluvia] usando los
extremos horarios y los datos de 10 min. Las horas se guardan unos días en
"_hours" para que cada ejecución complete los días aunque obs.json solo
cubra 24 h. Los días se conservan 20 días; la web solo los usa para rellenar
fechas sin dato consolidado.

Salida:
{
  "generated": "...", "upto": "2026-11-19T09:50:00Z", "ref": [1991, 2020],
  "days": ["2026-10-31", ..., "2026-11-19"],
  "st": { "9434": { "tx": [...], "tn": [...], "p": [...], "nh": [...], "np": [...] } },
        nh = horas con temperatura del día (24 = completo); np = horas de lluvia
  "cmp": { "2026-11-19": { "9434": [ntx, ptx, ntn, ptn,
                                      rtxHi, ytxHi, rtxLo, ytxLo, rtnHi, ytnHi, rtnLo, ytnLo,
                                      mtxHi, ymtxHi, mtnLo, ymtnLo], ... }, ... }
        ntx/ntn normal de la fecha (±7 días, período ref) · ptx/ptn percentil del valor provisional
        r*: récords de esa fecha (toda la serie, sin el propio día) · m*: récords del mes
  "_hours": { "2026-11-19T09:00:00Z": { "9434": [max, min, prec] } }
}
"""

import argparse
import json
import sys
from bisect import bisect_left, bisect_right
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

KEEP_DAYS = 20
KEEP_HOURS = 72
REF = (1991, 2020)
HALF = 7
MIN_HOURS_CMP = 6       # horas mínimas para comparar el día


def parse_time(s):
    return datetime.strptime(s.replace("Z", "+0000"), "%Y-%m-%dT%H:%M:%S%z").astimezone(timezone.utc)


def iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def hourly_from_obs(O):
    """{hora_fin: {id: [max, min, prec]}} a partir de obs.json."""
    t0, step = parse_time(O["t0"]), timedelta(seconds=O.get("step", 3600))
    h0 = parse_time(O.get("h0", O["t0"]))
    per = int(timedelta(hours=1) / step)
    out = {}
    for sid, D in O["data"].items():
        ta, p10 = D.get("ta"), D.get("p10")
        tax, tan, pr = D.get("tamax"), D.get("tamin"), D.get("prec")
        for j in range(O.get("nh", O["n"])):
            end = h0 + timedelta(hours=j)
            kend = int((end - t0) / step)
            ks = [k for k in range(kend - per + 1, kend + 1) if 0 <= k < O["n"]]
            vals = [ta[k] for k in ks if ta and ta[k] is not None]
            hx = [v for v in vals + [tax[j] if tax else None] if v is not None]
            hn = [v for v in vals + [tan[j] if tan else None] if v is not None]
            p = pr[j] if pr and pr[j] is not None else None
            if p is None and p10:
                pv = [p10[k] for k in ks if p10[k] is not None]
                if len(pv) >= max(1, len(ks) - 1):
                    p = round(sum(pv), 1)
            if not hx and p is None:
                continue
            out.setdefault(iso(end), {})[sid] = [max(hx) if hx else None, min(hn) if hn else None, p]
    return out


def day_values(hours, d):
    """Tmax/Tmin (00–24 UTC) y lluvia (07–07 UTC) del día d por estación."""
    a = datetime(d.year, d.month, d.day, tzinfo=timezone.utc)
    res = {}
    for k in range(1, 25):                 # horas que terminan en (00, 24]
        for sid, (hx, hn, _) in hours.get(iso(a + timedelta(hours=k)), {}).items():
            r = res.setdefault(sid, {"tx": None, "tn": None, "nh": 0, "p": 0.0, "np": 0})
            if hx is not None:
                r["tx"] = hx if r["tx"] is None else max(r["tx"], hx)
                r["nh"] += 1
            if hn is not None:
                r["tn"] = hn if r["tn"] is None else min(r["tn"], hn)
    for k in range(8, 32):                 # (07, 07+24]
        for sid, (_, _, p) in hours.get(iso(a + timedelta(hours=k)), {}).items():
            if p is None:
                continue
            r = res.setdefault(sid, {"tx": None, "tn": None, "nh": 0, "p": 0.0, "np": 0})
            r["p"] += p
            r["np"] += 1
    return res


def load_station(path, recent):
    st = json.load(open(path, encoding="utf-8"))
    start = date.fromisoformat(st["start"])
    D = {v: st["data"].get(v) for v in ("tmax", "tmin")}
    rec = recent.get("stations", {}).get(st["id"]) if recent else None
    if rec and D["tmax"]:
        r0 = date.fromisoformat(recent["start"])
        n_r = (date.fromisoformat(recent["end"]) - r0).days + 1
        need = (r0 - start).days + n_r
        for v in D:
            if D[v] is None:
                continue
            if len(D[v]) < need:
                D[v] = D[v] + [None] * (need - len(D[v]))
            for k in range(n_r):
                x = (rec.get(v) or [None] * n_r)[k] if rec.get(v) else None
                if x is not None and 0 <= (r0 - start).days + k < len(D[v]):
                    D[v][(r0 - start).days + k] = x
    return start, D


def compare(start, D, d, tx, tn):
    """Lista cmp de una estación para el día d (valores provisionales tx, tn)."""
    md = (d.month, d.day)
    doy = date(2001, d.month, min(d.day, 28) if d.month == 2 and d.day == 29 else d.day).timetuple().tm_yday
    pools = {"tmax": [], "tmin": []}
    recs = {}
    for v in ("tmax", "tmin"):
        arr = D[v]
        if not arr:
            continue
        rhi = rlo = mhi = mlo = None
        for i, x in enumerate(arr):
            if x is None:
                continue
            di = start + timedelta(days=i)
            if di == d:
                continue
            if (di.month, di.day) == md:
                if rhi is None or x > rhi[0]:
                    rhi = (x, di.year)
                if rlo is None or x < rlo[0]:
                    rlo = (x, di.year)
            if di.month == d.month:
                if mhi is None or x > mhi[0]:
                    mhi = (x, di.year)
                if mlo is None or x < mlo[0]:
                    mlo = (x, di.year)
            if REF[0] <= di.year <= REF[1] and not (di.month == 2 and di.day == 29):
                dd = abs(date(2001, di.month, di.day).timetuple().tm_yday - doy)
                if min(dd, 365 - dd) <= HALF:
                    pools[v].append(x)
        recs[v] = (rhi, rlo, mhi, mlo)

    def pct(pool, x):
        if x is None or len(pool) < 50:
            return None
        pool.sort()
        lo, hi = bisect_left(pool, x), bisect_right(pool, x)
        return round(100 * (lo + 0.5 * (hi - lo)) / len(pool), 1)

    def mean(pool):
        return round(sum(pool) / len(pool), 1) if len(pool) >= 50 else None

    def pair(r):
        return [r[0], r[1]] if r else [None, None]

    rx, rn = recs.get("tmax", (None,) * 4), recs.get("tmin", (None,) * 4)
    return ([mean(pools["tmax"]), pct(pools["tmax"], tx), mean(pools["tmin"]), pct(pools["tmin"], tn)]
            + pair(rx[0]) + pair(rx[1]) + pair(rn[0]) + pair(rn[1]) + pair(rx[2]) + pair(rn[3]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--obs", type=Path, required=True)
    ap.add_argument("--previous", type=Path, default=None)
    ap.add_argument("--data-dir", type=Path, default=Path("data"))
    ap.add_argument("--output", type=Path, required=True)
    args = ap.parse_args()

    O = json.load(open(args.obs, encoding="utf-8"))
    prev = {}
    if args.previous and args.previous.exists():
        try:
            prev = json.load(open(args.previous, encoding="utf-8"))
        except Exception as e:
            print(f"  AVISO: daily previo ilegible ({e})", file=sys.stderr)

    # ---- horas: las previas, actualizadas con las de obs.json ----
    hours = prev.get("_hours", {})
    for t, sts in hourly_from_obs(O).items():
        hours.setdefault(t, {}).update(sts)
    upto = parse_time(O["last"])
    hours = {t: v for t, v in hours.items() if parse_time(t) > upto - timedelta(hours=KEEP_HOURS)}

    # ---- días: los previos congelados y los que cubren las horas guardadas, recalculados ----
    today = upto.date()
    days = [today - timedelta(days=k) for k in range(KEEP_DAYS - 1, -1, -1)]
    dayiso = [d.isoformat() for d in days]
    old = {}
    for k, ds in enumerate(prev.get("days", [])):
        for sid, a in prev.get("st", {}).items():
            old.setdefault((sid, ds), {f: a[f][k] for f in ("tx", "tn", "p", "nh", "np") if f in a})
    first_hour = min(parse_time(t) for t in hours) if hours else upto
    vals = dict(old)
    for d in days:
        a = datetime(d.year, d.month, d.day, tzinfo=timezone.utc)
        if a + timedelta(days=1, hours=7) <= first_hour:
            continue                        # día ya fuera de las horas guardadas: se queda como estaba
        for sid, r in day_values(hours, d).items():
            o = old.get((sid, d.isoformat()), {})
            # no empeorar un día ya completo con menos horas
            keep_t = o.get("nh", 0) > r["nh"]
            keep_p = o.get("np", 0) > r["np"]
            vals[(sid, d.isoformat())] = {
                "tx": o.get("tx") if keep_t else r["tx"], "tn": o.get("tn") if keep_t else r["tn"],
                "nh": o.get("nh") if keep_t else r["nh"],
                "p": o.get("p") if keep_p else (round(r["p"], 1) if r["np"] else None),
                "np": o.get("np") if keep_p else r["np"],
            }
    st = {}
    for (sid, ds), v in vals.items():
        if ds not in dayiso:
            continue
        k = dayiso.index(ds)
        a = st.setdefault(sid, {f: [None] * len(days) for f in ("tx", "tn", "p", "nh", "np")})
        for f in a:
            a[f][k] = v.get(f)

    # ---- comparación con la climatología: hoy y ayer ----
    cmp_ = {}
    stations_dir = args.data_dir / "stations"
    recent = None
    rp = args.data_dir / "recent.json"
    if rp.exists():
        try:
            recent = json.load(open(rp, encoding="utf-8"))
        except Exception:
            recent = None
    for d in days[-2:]:
        cmp_[d.isoformat()] = {}
    k_days = {d.isoformat(): dayiso.index(d.isoformat()) for d in days[-2:]}
    n_done = 0
    for sid, a in st.items():
        path = stations_dir / f"{sid}.json"
        if not path.exists():
            continue
        todo = [(ds, k) for ds, k in k_days.items() if (a["nh"][k] or 0) >= MIN_HOURS_CMP]
        if not todo:
            continue
        try:
            start, D = load_station(path, recent)
        except Exception as e:
            print(f"  AVISO {sid}: {e}", file=sys.stderr)
            continue
        for ds, k in todo:
            cmp_[ds][sid] = compare(start, D, date.fromisoformat(ds), a["tx"][k], a["tn"][k])
        n_done += 1

    out = {"generated": iso(datetime.now(timezone.utc)), "upto": iso(upto), "ref": list(REF),
           "days": dayiso, "st": dict(sorted(st.items())), "cmp": cmp_, "_hours": hours}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as fo:
        json.dump(out, fo, ensure_ascii=False, separators=(",", ":"))
    print(f"Hecho: {len(st)} estaciones, {len(days)} días ({dayiso[0]} → {dayiso[-1]}), "
          f"{len(hours)} horas guardadas, comparación de {n_done} estaciones · "
          f"{args.output.stat().st_size / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
