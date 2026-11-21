# A/B TS y WASM

Desde `frontend/`, después de `npm ci` y `CARGO_TARGET_DIR=... npm run build:wasm`. Ejecuta los handlers reales en Node/Vitest; no mide IPC, structured clone, hilos, navegador ni GPU. El terreno y STL siempre son TS y se calculan una vez como contexto. Sintético: 600×900, una observación. STL: GroundProbe a 25/50/75 %, IBIS y Reutech a 50 %, y tres observaciones para sensibilidad. La resolución fina solo tiene terreno, como W1-A.

```sh
GEOT_BENCH_MODE=smoke npx vitest run --config bench/vitest.config.ts bench/baseline.test.ts
GEOT_BENCH_MODE=golden GEOT_BENCH_STL=/ruta/f8_relimit.stl npx vitest run --config bench/vitest.config.ts bench/baseline.test.ts
GEOT_BENCH_MODE=full GEOT_BENCH_STL=/ruta/f8_relimit.stl GEOT_BENCH_OUT=/ruta/salida npx vitest run --config bench/vitest.config.ts bench/baseline.test.ts
GEOT_BENCH_MODE=freeze GEOT_BENCH_STL=/ruta/f8_relimit.stl GEOT_BENCH_OUT=/ruta/salida npx vitest run --config bench/vitest.config.ts bench/baseline.test.ts
```

`freeze` ejecuta los mismos 11 casos, exige TS ≡ WASM byte a byte, no compara contra el ancla y escribe `golden-manifest.json` (schema `geot-ts-baseline-v1`) en la salida. Requiere worktree sin cambios versionados.

> Ancla v2 (`w1a-frozen-ab195fe`): refleja la corrección exacta del punto final del rayo; difiere de v1 solo en casos sintéticos con sombras falsas eliminadas, confirmadas por el oráculo (22526 celdas SHADOW→VISIBLE). Se regenera con `GEOT_BENCH_MODE=freeze`; la v1 se conserva intacta para la base.

`golden` comprueba sin medición los 11 casos contra el manifiesto congelado y entre motores; la sensibilidad prueba también observaciones cruzadas. `full` hace lo mismo, dos calentamientos y siete muestras por motor intercaladas por caso. Las muestras son milisegundos de la llamada completa al handler; las huellas y verificaciones se hacen fuera del cronómetro. El bootstrap de la razón de medianas usa semilla fija y 10 000 réplicas independientes por motor. Init en frío incluye lectura del archivo y `initSync` de Node; el aplanado se mide por separado y también se incluye en el handler WASM. El terreno es compartido, no hay motor WASM para él. Los hashes W1-A no contienen bytes para localizar la primera celda contra el golden; para TS/WASM sí se compara byte por byte e informa la primera celda.

La salida por defecto es `${TMPDIR:-/tmp}/geot-bench-<timestamp>` y se rechazan rutas que contienen `w1a-frozen`. `GEOT_BENCH_OUT` permite elegir otra carpeta; `env.json` y `equivalence.json` se reemplazan en cada ejecución. `full` genera además `samples-<timestamp>.json` y `summary-<timestamp>.json`. La ejecución debe ligarse a un commit limpio; registrar carga y procesos antes y después, esperar hasta tres minutos si la carga de un minuto excede 1,5 y no correr otros trabajos en paralelo. El manifiesto congelado se valida con SHA-256 antes de iniciar.

Puertas: `npx tsc -p bench/tsconfig.json --noEmit`, `npx vitest run --config bench/vitest.config.ts bench/harness.test.ts`, `npm test`, smoke, golden y full.
