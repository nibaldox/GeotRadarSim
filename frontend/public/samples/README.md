# Terreno de ejemplo: rajo sintético

El botón «Terreno sintético» carga estos archivos.

- `rajo-sintetico-2m.bin`: 680 × 536 alturas `Uint16` little-endian, fila por fila (filas en Y desde `min_y`,
  columnas en X desde `min_x`). Cada valor `q` da `z = z0 + q / 100` m. `0xFFFF` es un nodo sin dato: el
  importador lo deja en NaN (fuera del contorno del rajo) y se decodifica como NaN. Pesa 728 960 bytes.
- `rajo-sintetico-2m.json`: dimensiones, resolución, origen, `z0`, escala, nodata, límites exactos del importador,
  envolvente de los puntos del STL, SHA-256 del `.bin` y del STL fuente, y el error máximo de cuantización
  (≤ 0,005 m).

## Procedencia

Es un rajo minero **sintético**, generado desde cero con parámetros y una semilla fija (`20261122`). No contiene
puntos, contornos ni DEM de ninguna topografía real. La fuente es `topo-sintetica-rajo.stl` (647 760 triángulos,
cabecera `GeotRadarSim synthetic open pit v1`, SHA-256
`c335f6902922fa515167f73803b9c3c913857c45ac6bd7ef35faf919938eb55b`), que no se incluye en el repositorio.

La grilla es exactamente la que produce el importador STL de la app a 2 m (`generateDTM`, en
`src/workers/terrainDtm.ts`), cuantizada a 1 cm. A una resolución mayor que 2 m, la app la reconstruye desde esta base
con el mismo criterio del importador (IDW sobre los nodos de 2 m, dentro de la envolvente del STL).

## Cómo regenerarlo

Desde `frontend/`, con `npm ci` hecho:

```sh
GEOT_SAMPLE_STL=/ruta/a/topo-sintetica-rajo.stl node scripts/build-sample-terrain.mjs
```

El script verifica el SHA-256 del STL, ejecuta el Worker de importación real y escribe los dos archivos. La salida es
determinista: regenerarlo da los mismos SHA-256. Con `GEOT_SAMPLE_COMPARE=4,8` no escribe nada y mide la diferencia
entre el remuestreo de la app y una importación del STL a esas resoluciones.
