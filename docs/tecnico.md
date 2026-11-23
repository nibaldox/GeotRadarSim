# GeotRadarSim: referencia técnica

> [Read in English](technical.md) · [Volver al README](../README.es.md)

Esta página reúne la semántica detallada del modelo geométrico, las métricas y los exportes. Las etiquetas de la
interfaz se citan tal como aparecen en la aplicación.

GeotRadarSim es una ayuda geométrica para analizar el terreno, no un simulador de radar ni de radiofrecuencia (RF)
validado. **No** calcula ni mide SNR, potencia recibida, probabilidad de detección ni desempeño en terreno.

## Contenido

- [Flujos de trabajo](#flujos-de-trabajo)
- [Estados de celda](#estados-de-celda)
- [Métricas de LOS](#métricas-de-los)
- [Capas de calidad geométrica (geometric-v2)](#capas-de-calidad-geométrica-geometric-v2)
- [Área a monitorear y sugerencia de ubicación](#área-a-monitorear-y-sugerencia-de-ubicación)
- [Exportes](#exportes)
- [Perfiles de radar incluidos](#perfiles-de-radar-incluidos)
- [Entrada y grillado del terreno](#entrada-y-grillado-del-terreno)
- [Arquitectura](#arquitectura)
- [Límites](#límites)

## Flujos de trabajo

### Una posición de radar

1. En **Terreno**, carga un archivo DXF o STL con **Cargar STL / DXF**, o carga el rajo de ejemplo con
   **Terreno sintético**.
2. En **Radar**, elige un **Modelo de radar**. En **Parámetros** puedes modificar rango, elevación, azimut y
   apertura.
3. Ubica el radar: usa la herramienta **Agregar radar** del visor y haz clic en el terreno, o escribe **E / N / Cota**
   y presiona **Aplicar**. Con un clic, el radar queda 2 m sobre la superficie muestreada; las coordenadas escritas se
   usan tal cual. Luego el análisis LOS se ejecuta solo.
4. Lee el resultado en la barra de cifras sobre el visor y en **Resultados**.

### Varias posiciones (unión geométrica)

1. Crea análisis separados cambiando la posición o los límites configurados. Cada uno queda como una línea en
   **Historial**.
2. Marca las entradas que quieres incluir. Sus estados LOS por celda se combinan sobre la misma grilla: para muestras
   con terreno finito, la celda combinada es `VISIBLE` si al menos un análisis individual seleccionado la clasifica
   así.
3. Las métricas combinadas se recalculan a partir de los estados fusionados. Es una unión geométrica, no una
   combinación de señales de radar.

### Capa de sensibilidad 3D

1. Selecciona uno o más análisis individuales compatibles en **Historial**.
2. En **Sensibilidad 3D**, elige el **Modo de capa del terreno** (**Incidencia superficial** o **Proyección del
   movimiento**) y presiona **Calcular mapa de sensibilidad**.
3. En cada celda finita donde ambos ejes del gradiente se pueden calcular con vecinos centrales o unilaterales
   disponibles, solo aportan los análisis seleccionados cuyo estado LOS **individual** es `VISIBLE`. `observer_count`
   es la cantidad de análisis que aportan en la celda; con uno, el valor es `|dot|`, y con varios,
   `sqrt(sum(dot_i²) / observer_count)` (RMS). El resultado es una proyección geométrica adimensional, no SNR,
   sensibilidad RF ni un modelo físico 3D del radar.
4. Un estado LOS `VISIBLE` no basta: si falta uno de los dos ejes del gradiente del terreno, esa observación no aporta.
   Las celdas con `observer_count = 0` quedan sin datos y transparentes (`NaN`); un cero finito con
   `observer_count > 0` es un valor medido.

Los modos de capa describen dos índices geométricos y cómo se agregan varias posiciones sobre el terreno 3D. No son
modos físicos distintos del radar.

## Estados de celda

El LOS se evalúa sobre la grilla regular del terreno. El recorrido del rayo visita los cruces con las líneas y las
diagonales de la grilla y revisa los triángulos que forman la superficie muestreada; no recorre las facetas originales
del STL. El rango horizontal se mide en planta; los límites de elevación y azimut son restricciones geométricas.

| Estado de celda | Significado |
|---|---|
| `NODATA` | La muestra de la grilla no tiene una elevación finita |
| `OUT_OF_RANGE` | El objetivo está fuera del rango horizontal mínimo/máximo configurado |
| `OUTSIDE_FOV` | El objetivo está fuera de los límites de elevación o azimut configurados |
| `UNKNOWN_RAY` | El rayo cruza una parte de la grilla sin un triángulo de terreno válido |
| `SHADOW` | Un triángulo de terreno válido obstruye el rayo geométrico recto |
| `VISIBLE` | El objetivo está dentro de los límites y ningún triángulo recorrido obstruye el rayo |

Son clasificaciones geométricas de la superficie grillada. No representan una detección de radar medida ni la calidad
de la señal.

## Métricas de LOS

Las métricas de LOS usan las muestras candidatas en estado `VISIBLE`, `SHADOW` o `UNKNOWN_RAY`:

- **Cobertura (%)** = `VISIBLE / (VISIBLE + SHADOW + UNKNOWN_RAY) × 100`. La aplicación la muestra como
  **Visibilidad (candidatos)** y como **Visibilidad** en la barra de cifras.
- **Completitud (%)** = `(VISIBLE + SHADOW) / (VISIBLE + SHADOW + UNKNOWN_RAY) × 100`.
- Las muestras `NODATA`, `OUT_OF_RANGE` y `OUTSIDE_FOV` quedan fuera de ambos denominadores. Si no hay candidatas, la
  cobertura y la completitud son `null` (se muestran como sin datos), no 0 %.
- **Área visible** = cantidad de muestras `VISIBLE` × resolución². Es una estimación planimétrica sobre la grilla, no
  un área 3D medida del talud.
- Las **zonas de sombra** son componentes conexas de muestras `SHADOW` con conectividad de cuatro vecinos.

## Capas de calidad geométrica (geometric-v2)

Las capas de calidad son índices geométricos que se pintan solo en celdas `VISIBLE`. No son SNR, potencia recibida, un
modelo de propagación ni una calidad de radar validada.

- **Incidencia superficial**: en celdas `VISIBLE`, la alineación (0–1) de la normal del terreno con la dirección del
  LOS desde el terreno hacia el radar. La distancia **no** multiplica el índice: el rango máximo configurado solo
  decide qué celdas son elegibles y no cambia el valor de una celda que sigue `VISIBLE`.
- **Proyección del movimiento**: la proyección del LOS sobre la dirección de máxima pendiente del terreno (la tangente
  normalizada pendiente abajo, con la vertical hacia abajo como respaldo en terreno plano). Con un análisis, el valor
  es `|dot|`; con varios, la RMS de arriba. Un cero medido tiene al menos un análisis que aporta; sin aportes no hay
  datos, no un cero. Es una proyección escalar bajo un movimiento supuesto de máxima pendiente, no una reconstrucción
  volumétrica ni una inversión de desplazamiento en 3 ejes.
- **Cobertura útil y distribución de lo visible**: las celdas útiles son las `VISIBLE` cuyo índice seleccionado está
  medido (finito, 0–1) y clasificado como medio o alto. La **Cobertura útil** es esa cantidad sobre el objetivo común
  **Topografía válida completa** (todos los nodos finitos de la grilla, sin importar el alcance del radar). El área del
  objetivo es nominal en planta (`celdas × resolución²`), no un área 3D inclinada. La distribución baja / media / alta
  / sin índice y la proporción media + alta se calculan solo sobre las celdas `VISIBLE`. El **Área útil** es la
  cantidad de celdas útiles × resolución². El resumen se calcula por métrica y queda ligado a la época del terreno y a
  la procedencia del análisis; si el resultado es antiguo, no tiene versión o viene de otro terreno o época, el índice
  se informa como no disponible y se pide recalcular. Nunca se informa un dato faltante como cero.
- **Bandas provisionales y configurables**: por defecto, `media ≥ 0.3` y `alta ≥ 0.7`; se editan en
  **Ajustes → Bandas de calidad**. Al cambiar los umbrales se reclasifican los valores existentes sin recalcular el
  LOS. Los umbrales no válidos (`0 ≤ media mínima < alta mínima ≤ 1`, distintos en precisión Float32) se rechazan con
  un aviso, sin reordenarlos. La clasificación usa Float32 (valores y umbrales se comparan después de redondear a
  Float32, para que los conteos coincidan siempre con los colores que pinta la GPU) con intervalos semiabiertos: baja
  `[0, media)`, media `[media, alta)`, alta `[alta, 1]`. Son rangos de un índice geométrico, no umbrales de detección
  certificados por un equipo.
- **Transparencia y cero medido**: `NODATA`, `OUT_OF_RANGE`, `OUTSIDE_FOV`, `UNKNOWN_RAY` y `SHADOW` no son
  observaciones y no se pintan: se ve el terreno base. Un índice faltante (por ejemplo, una celda `VISIBLE` sin
  gradiente calculable) también queda transparente. Un `0.0` medido es un dato y se pinta en la banda baja. La
  transparencia por sí sola no indica la causa; no significa sombra.
- **Colores**: la incidencia usa un degradado continuo anclado a los cortes de las bandas (baja rojo, media naranjo,
  alta verde); la proyección del movimiento usa un degradado continuo fijo violeta–azul–cian–verde. Ambos se pintan
  solo en celdas observadas. Los marcadores de radar en la vista 3D son íconos simples de núcleo y mástil.
- **Análisis combinados**: con varios análisis seleccionados, la incidencia combinada toma en cada celda `VISIBLE` el
  mayor valor finito individual, y la proyección combinada es la RMS de los análisis que aportan; los valores
  faltantes se excluyen en lugar de contarse como cero.

## Área a monitorear y sugerencia de ubicación

- **Área a monitorear**: herramienta del visor. Haz clic en el terreno para agregar vértices y cierra el polígono con
  un clic en el primer vértice o con doble clic; arrastra los vértices para editarlo y bórralo con **Borrar área**.
  **Resultados → Cobertura del área** y la barra de cifras muestran qué parte del área es visible y qué parte tiene
  cobertura útil.
- **Sugerir ubicación**: un cálculo determinista; con los mismos datos, da la misma respuesta. Genera candidatos en
  bermas, cresta y perímetro; si hay un área definida, también considera terreno abierto fuera de ella y dentro del
  alcance. Evalúa los candidatos con una pasada gruesa de línea de visión, elige radares de forma voraz y comprueba
  cada propuesta con el cálculo completo. Los resultados verificados quedan en **Historial**.
  - Opciones: **Radares** (1–4), **Objetivo** (**Cobertura útil (incidencia)**, **Área visible** o **Cobertura útil
    (proyección del movimiento)**), **Usar el área a monitorear**, **Conservar los radares seleccionados en el
    historial** y **Separación mínima (m)**.
  - Para los objetivos de visibilidad e incidencia, la selección voraz garantiza al menos el 63 % del óptimo
    (`1 − 1/e`); para proyección no existe esa garantía. El presupuesto de tiempo por defecto es de 90 segundos y el
    cálculo se puede detener con **Detener**. El resultado se descarta si cambia el terreno, la política de bandas o
    el área.

## Exportes

Los exportes están al pie de la barra lateral y usan el análisis activo compatible.

- **Informe para reunión**: un PDF con portada 3D, una tabla de radares con coordenadas, un mapa por radar y un mapa
  consolidado que distingue las zonas vistas por un solo radar de las vistas por dos o más. Con dos o más radares
  agrega un mapa de calidad consolidada (bandas roja, amarilla y verde en incidencia, con los colores de los mapas por
  radar): cada zona toma la mejor incidencia entre los radares que la ven, o la media cuadrática de sus proyecciones,
  igual que la combinación de la app, así que su área útil es la de la unión. El **Título del informe**,
  opcional, aparece en la portada. Sus cifras coinciden con las de la interfaz.
- **PDF técnico** y **CSV**: llevan la misma política de clasificación y procedencia que el resumen en pantalla:
  umbrales marcados como provisionales (sin precisión certificada), la precisión de clasificación Float32, la
  métrica, el modelo de calidad `geometric-v2`, el id y la época del terreno y los ids de los análisis.
  - En resultados geometric-v2, las columnas por celda del CSV son `row,col,state,incidence,projection,shadowed` (los
    resultados antiguos mantienen `row,col,state,quality,shadowed`). `incidence` y `projection` se escriben solo para
    celdas `VISIBLE` con índice medido, como tokens Float32 de ida y vuelta (el decimal más corto que vuelve al mismo
    Float32; un cero medido se escribe `0`, y el campo queda vacío en celdas no visibles o sin índice), en lugar de un
    redondeo a 4 decimales que podría cruzar un umbral.
  - El informe de calidad se agrega solo desde un contexto capturado al hacer clic en exportar que siga coincidiendo
    con la instantánea y el resultado exportados; cada cifra se vuelve a derivar del resultado exportado, y un contexto
    que no coincide se rechaza. Los resultados antiguos o sin versión se exportan sin informe de calidad, en lugar de
    inventarlo.
- **PNG**: una captura de la vista 3D actual.

## Perfiles de radar incluidos

La aplicación trae **perfiles locales de software** fijos. Los nombres de modelo son etiquetas; los valores son
valores por defecto de la aplicación, **no especificaciones del fabricante ni límites de operación validados**.
Modifícalos en **Parámetros** para ajustarlos a un escenario verificado por separado.

| Perfil local | Rango por defecto | Intervalo de elevación | Sector de azimut por defecto |
|---|---:|---:|---:|
| GroundProbe SSR-FX | 50–2500 m | −60° a +60° | −75° a +75° (150° en total) |
| IBIS-ArcSAR360 | 50–2500 m | −60° a +60° | 360° |
| Reutech MSR | 50–2500 m | −60° a +60° | −75° a +75° (150° en total) |

La herramienta no descarga ni valida especificaciones del fabricante. Un rango máximo configurado es solo un corte
geométrico, no una afirmación de que un equipo detecte un objetivo a esa distancia.

## Entrada y grillado del terreno

| Formato | Extensión | Lectura |
|---|---|---|
| DXF | `.dxf` | Lee vértices de puntos, líneas, caras 3D, polilíneas y polilíneas livianas |
| STL | `.stl` | Lee facetas triangulares ASCII y binarias |

- Los puntos de entrada se convierten en una grilla regular de elevación por ponderación inversa a la distancia local
  (IDW dentro de 3 × la resolución, con el punto más cercano de las 3 × 3 celdas vecinas como respaldo, y sin dato si
  no hay puntos cerca). Luego el LOS revisa los triángulos de esa grilla; no es una triangulación de Delaunay de los
  puntos importados ni una prueba de rayos contra las facetas originales del STL.
- Los STL con más de 500 000 facetas se muestrean antes del grillado.
- La resolución se elige con **Resolución de importación**, entre 0,5 y 5 m.
- Los nodos se ubican desde el mínimo de X e Y, separados por la resolución. Si el largo dividido por la resolución es
  entero dentro de la tolerancia de punto flotante, se incluye el extremo; si no, la grilla termina en
  `min + floor(largo / resolución) × resolución`, sin un intervalo parcial. Los metadatos `max_x` / `max_y` indican el
  último nodo muestreado (por ejemplo, un largo de 200 m a 3 m de resolución termina en 198 m). Así, un largo de 200 m
  da 101 nodos a 2 m, 401 a 0,5 m y 67 a 3 m. Cada eje necesita al menos dos nodos; los largos menores que una
  resolución se rechazan. Los límites de tamaño de la grilla (ver [Límites](#límites)) se verifican antes de reservar
  la grilla.
- Elevación en DXF: `POINT` usa su posición leída; en `LWPOLYLINE`, una Z finita del vértice tiene prioridad y, si
  falta, se usa la elevación finita de la entidad. Las coordenadas requeridas que faltan o no son finitas se rechazan,
  no se convierten en cero.
- Las zonas de la grilla sin datos o no válidas dan `UNKNOWN_RAY` o `NODATA`, nunca terreno visible.

### Terreno de ejemplo

**Terreno sintético** carga un rajo sintético de unos 1,4 × 1,1 km (680 × 536 nodos a 2 m) con bancos, bermas,
rampa, fases, botadero y unos 301 m de relieve. Se generó desde cero con una semilla fija y no contiene datos de ningún
levantamiento real. Se carga a 2 m o se reconstruye a la resolución de importación elegida, si es mayor. La
procedencia y el comando para regenerarlo están en
[`frontend/public/samples/README.md`](../frontend/public/samples/README.md).

## Arquitectura

```text
Navegador (sitio estático, sin backend de análisis)
├── Visor React + Three.js y barra lateral compacta
├── Worker de terreno       DXF/STL → grilla regular de elevación (IDW)
├── Worker de LOS           recorrido de rayos sobre triángulos de la grilla + índices de calidad
├── Worker de sensibilidad  proyección del movimiento desde los análisis visibles seleccionados
├── Worker del optimizador  «Sugerir ubicación»: candidatos, LOS grueso, selección voraz
└── Estado local y exportes PDF / CSV / PNG en el cliente
```

- Los cálculos de LOS, sensibilidad y optimización usan el núcleo en Rust (`rust/radar-core`) compilado a
  WebAssembly (`rust/radar-wasm`). Sigue disponible una implementación en TypeScript de LOS y sensibilidad, que se
  elige con el parámetro de URL `?engine=ts`.
- Los Workers arrancan desde un `blob:` para heredar la política de seguridad de contenido (CSP) de la página. La
  compilación de producción fija `default-src 'self'` y `connect-src 'self'`: la aplicación no puede conectarse a
  orígenes externos, y el terreno y los resultados quedan en el equipo del usuario.

## Límites

- Tamaño de grilla: como máximo **16 384 nodos por eje** y **1 000 000 de celdas en total**; se aplican ambos.
- Cada cálculo de LOS tiene un plazo de **120 segundos** (más un vigilante de 125 segundos en el Worker); un análisis
  puede rechazarse por tiempo aunque la grilla esté bajo el límite de tamaño.
- Los STL con más de 500 000 facetas se muestrean. El remuestreo IDW y la resolución de la grilla afectan la superficie
  y la clasificación LOS.
- El LOS es un rayo geométrico recto sobre la grilla muestreada. No modela propagación RF, atenuación, SNR,
  probabilidad de detección, resolución del radar ni desempeño en terreno.
- Las coordenadas usan el marco propio del terreno; la aplicación no guarda datum ni zona.
- La memoria del navegador y los límites de WebGL dependen del equipo. No se declara ningún benchmark de rendimiento.
- Las entidades DXF sin elevación o con elevación cero pueden generar una superficie plana o inadecuada.
