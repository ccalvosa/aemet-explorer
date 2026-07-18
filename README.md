# Explorador climático AEMET

Web estática (GitHub Pages) para análisis interactivo de series diarias de
estaciones de AEMET. Todo el cómputo ocurre en el navegador; no hay backend.

## Estructura

- `scripts/build_data.py` — convierte los CSVs diarios de AEMET OpenData a un
  JSON columnar por estación (`data/stations/{id}.json`) + catálogo (`data/index.json`).
- `index.html`, `css/`, `js/` — la aplicación.
- `data/` — generado por el script (no editar a mano).

## Generar los datos

```bash
python scripts/build_data.py --input-dir /ruta/a/csvs --output-dir data --workers 8
```

## Desarrollo local

```bash
python -m http.server 8000
# → http://localhost:8000
```

(Es necesario servir por HTTP: `fetch` no funciona con `file://`.)

## Publicar

Settings → Pages → Deploy from branch → `main`, raíz del repo.
Si `data/` supera límites cómodos de Git, considerar Git LFS o un branch de datos.

## Formato de estación

Rejilla diaria densa desde `start`: arrays alineados a días consecutivos con
`null` en huecos, más cobertura anual por variable. Ver docstring del script.

## Licencia de datos

Datos elaborados a partir de AEMET OpenData (© AEMET), reutilización permitida
con atribución.

## v2 — productos

Nueve análisis: año en curso vs climatología (sobre P5–P95 del período de
referencia), evolución anual, warming stripes, índices climáticos (noches
tropicales, heladas, primer 30/35/40 °C, duración del verano...), rachas,
comparador de años, distribución por períodos (histograma/ECDF), calendario
anual de anomalías y comparador de dos estaciones. Período de referencia
global configurable (1991–2020 por defecto). Efemérides del día en la placa
de estación.

## Mapa de estaciones

Requiere `data/coords.json`:

```bash
export AEMET_API_KEY="tu_api_key"
python scripts/build_coords.py --output data/coords.json
```
