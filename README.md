# Explorador climático AEMET

Web estática (GitHub Pages) para explorar las series diarias de 920 estaciones
de AEMET. Todo el cálculo ocurre en el navegador; no hay backend.

## Qué ofrece

Al elegir una estación aparece su ficha con **récords en tarjetas**, en tres
ámbitos (Hoy / Este mes / Siempre): máxima más alta y más baja, mínima más alta
y más baja, más lluvia en un día y, para el mes y el año, el más lluvioso y el
más seco, además de la racha de viento más fuerte. También indica en qué
percentil de lo normal cae el último dato de Tmax.

Los análisis se agrupan en cinco bloques:

| Bloque | Análisis |
|---|---|
| Día y año | Un día cualquiera (ficha del día con anomalía, percentil, puesto y récords de todas las variables frente a la climatología de la fecha y del mes; el día en la historia; el mes día a día; la fecha y el mes año a año; ficha descargable para compartir y enlace directo `#id/dia/AAAA-MM-DD`) · Año en curso (frente a P5–P95 y récords previos) · Calendario de anomalías |
| Tendencias | Evolución anual · Warming stripes (temperatura, precipitación u horas de sol) · Índices climáticos (noches tropicales, heladas, primer 30/35/40 °C, duración del verano…) · Récords por década |
| Extremos | Rachas (condición diaria o período seco) · Olas de calor y de frío · Períodos de retorno (GEV por L-momentos, comparando dos épocas) · Sequía (SPI de 1 a 24 meses, con calendario) |
| Comparar | Comparador de años · Comparar períodos (día a día o distribución) · Dos estaciones |
| Toda España | Evolución (red fija o variable, promedio por área o por estación, año/estación/mes) con reparto de estaciones por encima y por debajo de lo normal y clasificación de años · Mapa de anomalías año a año (con reproducción) o de tendencias · Regiones y franjas de altitud · Récords absolutos batidos en la red frente a lo esperado con un clima estable |

- **Período normal** global configurable en la barra superior (1991–2020 por defecto).
- Los gráficos se **recalculan solos** al cambiar cualquier control.
- **Tema claro/oscuro** (sigue al sistema; el botón ◐ lo fija).
- **Enlaces compartibles**: la URL recuerda la estación y el análisis, p. ej.
  `…/#9434/stripes` o `…/#espana/nacional`.
- **Exportar PNG** de los gráficos de cada análisis, listos para redes.
- Atajo de teclado: `/` enfoca el buscador.

## Estructura

- `index.html`, `css/style.css`, `js/app.js` — la aplicación (HTML/CSS/JS sin
  frameworks + Plotly). Los colores de los gráficos se leen de las variables CSS
  del tema (`refreshTheme()` en `app.js`).
- `scripts/build_data.py` — convierte los CSV diarios de AEMET OpenData a un JSON
  columnar por estación (`data/stations/{id}.json`) y al catálogo (`data/index.json`).
- `scripts/build_national.py` — agregados por estación para la pestaña España:
  medias/totales y extremos anuales → `data/national.json`; medias/totales
  mensuales → `data/national_monthly.json` (se carga solo al elegir una
  estación del año o un mes).
- `scripts/build_coords.py` — coordenadas de las estaciones → `data/coords.json`.
- `scripts/update_recent.py` — últimos 120 días de todas las estaciones →
  `data/recent.json`; la web lo fusiona con el histórico (lo reciente manda).
  Los días que la API no devuelve se rellenan con el fichero previo, y si la
  API está caída el fichero se conserva sin dar error.
- `.github/workflows/update.yml` — ejecuta `update_recent.py` cada día a las
  06:00 UTC (secreto `AEMET_API_KEY`) y amenda su propio commit para no engordar
  el historial.
- `data/` — generado por los scripts (no editar a mano).

## Generar los datos

```bash
python scripts/build_data.py --input-dir /ruta/a/csvs --output-dir data --workers 8
python scripts/build_national.py --data-dir data
export AEMET_API_KEY="tu_api_key"
python scripts/build_coords.py --output data/coords.json
python scripts/update_recent.py --index data/index.json --output data/recent.json
```

## Desarrollo local

```bash
python -m http.server 8000
# → http://localhost:8000
```

(Es necesario servir por HTTP: `fetch` no funciona con `file://`.)
Al cambiar CSS o JS, sube el `?v=` de `index.html` para invalidar la caché.

## Publicar

Settings → Pages → Deploy from branch → `main`, raíz del repo.
Si `data/` supera límites cómodos de Git, considerar Git LFS o un branch de datos.

## Formato de estación

Rejilla diaria densa desde `start`: arrays alineados a días consecutivos con
`null` en huecos, más cobertura anual por variable (`tmed, tmax, tmin, prec,
racha, sol`). La amplitud térmica (DTR) se deriva en el navegador. Ver el
docstring de `build_data.py`.

## Licencia

El código de este repositorio se distribuye bajo licencia MIT (ver `LICENSE`).
Los datos de `data/` NO están cubiertos por esa licencia: son información
elaborada por la Agencia Estatal de Meteorología (© AEMET), reutilizable
conforme a su aviso legal, citando a AEMET como fuente de los datos originales.
Las series no están homogeneizadas.
