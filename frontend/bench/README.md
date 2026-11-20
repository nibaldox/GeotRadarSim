# Línea base TS

Desde `frontend/`, luego de `npm ci`. Todos los comandos ejecutan los handlers reales de los tres workers dentro de Node/Vitest; no miden transporte, structured clone, hilos, navegador ni GPU. `terrainEngine` genera el sintético. La grilla sintética es de 600 filas × 900 columnas, con una observación; el STL usa tres observaciones de GroundProbe (25 %, 50 %, 75 %) y además IBIS y Reutech al 50 %. Las posiciones usan la altura interpolada sobre el triángulo de la malla más 2 m, como el clic de `src/App.tsx:160`. Los modelos provienen de `listRadars`.

```sh
GEOT_BENCH_MODE=smoke npx vitest run --config bench/vitest.config.ts bench/baseline.test.ts
GEOT_BENCH_MODE=golden GEOT_BENCH_STL=/home/xodla/archivos/12_WindSurf/48-radar-monitoring-simulator/f8_relimit.stl npx vitest run --config bench/vitest.config.ts bench/baseline.test.ts
timeout 600s env GEOT_BENCH_MODE=full GEOT_BENCH_STL=/home/xodla/archivos/12_WindSurf/48-radar-monitoring-simulator/f8_relimit.stl npx vitest run --config bench/vitest.config.ts bench/baseline.test.ts
```

`smoke` y `golden` hacen una muestra sin calentamiento; `golden` agrega STL. `full` hace dos calentamientos y siete muestras por caso, conserva las muestras en milisegundos y limita la ejecución completa con `timeout`; un timeout es fallo, no un resultado. No se estimó si full terminará dentro de ese plazo. Validación y hashes se calculan fuera del tramo cronometrado. La ejecución mide la invocación del handler y su resultado, no el cálculo puro aislado. Ejecutar full sin otra carga de CPU.

La carpeta por defecto es `/home/xodla/.hermes/profiles/simulacion-radar/plans/rust-wasm/evidence/w1a/`; `GEOT_BENCH_OUT` la cambia. Cada modo reemplaza `golden-manifest.json` y `env.json`: usar directorios distintos para comparar, y no sobrescribir un golden completo con smoke. Si falta `GEOT_BENCH_STL`, los escenarios STL se omiten e indica por consola el motivo. Solo se registran muestras en full. SHA de código es `git rev-parse HEAD`; ejecutar desde un árbol limpio o registrar explícitamente las modificaciones no confirmadas.

El diálogo obtiene la sugerencia mediante `suggestResolutionForSpan` (`src/components/UploadTerrainDialog.tsx:50-54`), con pasos discretos y margen de 15 % (`src/utils/terrainLimits.ts:119-142`). La resolución fina se busca por bisección en doubles empleando el conteo real de nodos y el límite de un millón; puede no ser un paso del diálogo. El manifiesto incluye metadatos, porcentajes y hashes de bytes lógicos; Float64 se aplana en orden fila-columna y se registra la endianidad. Se excluye `terrain_id` de metadatos porque el sintético usa `Math.random` (`terrainEngine.ts:56`); las identidades de sensibilidad son fijas. La igualdad byte a byte de las huellas depende de la arquitectura y runtime registrados.

Comprobaciones del propio arnés: `npx vitest run --config bench/vitest.config.ts bench/harness.test.ts`; tipos estrictos: `npx tsc -p bench/tsconfig.json --noEmit`.
