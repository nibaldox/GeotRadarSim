# 📡 GeotRadarSim — Visor Geométrico de LOS para Monitoreo de Taludes

**Herramienta en navegador para inspeccionar la línea de visión (LOS) geométrica sobre terreno proporcionado por el usuario.** Clasifica muestras de la cuadrícula del terreno según una posición de radar/observador y límites configurables de rango, azimut y elevación.

> [Read in English 🇬🇧](README.md)

> Es una ayuda para analizar geometría del terreno, no un simulador validado de radar ni de radiofrecuencia (RF). **No** calcula ni mide SNR, potencia recibida, probabilidad de detección ni desempeño en terreno.

🌐 **Aplicación en vivo:** [https://nibaldox.github.io/GeotRadarSim/](https://nibaldox.github.io/GeotRadarSim/)

---

## El problema

Al evaluar posiciones para radares de monitoreo de taludes, puede ser útil inspeccionar qué muestras del terreno quedan geométricamente despejadas desde cada posición propuesta y cuáles quedan fuera del rango o límites angulares configurados. GeotRadarSim ayuda a visualizar esas relaciones sobre una cuadrícula del terreno.

Permite explorar preguntas geométricas:

- ¿Qué muestras de talud están dentro del rango horizontal y campo de visión configurados?
- ¿Qué triángulos válidos del terreno obstruyen la línea recta desde el observador?
- ¿Cómo cambia la unión geométrica al seleccionar análisis desde varias posiciones?

No permite determinar si un radar real recibirá una señal adecuada a una distancia dada. Para decisiones operacionales, usa datos del fabricante, validación en faena y análisis RF apropiados.

---

## Características

| Característica | Descripción |
|---|---|
| 🗺️ **Entrada de terreno** | Carga datos DXF de puntos/líneas/polilíneas o una superficie STL y conviértelos a una cuadrícula regular de elevaciones |
| 🏗️ **Terreno sintético** | Genera una superficie de ejemplo tipo cuenco para probar la interfaz y la geometría |
| 📡 **LOS geométrica** | Clasifica muestras como visibles, en sombra, fuera de límites configurados, sin datos o con rayo desconocido |
| 🎯 **Límites configurables** | Selecciona un perfil local incluido y modifica límites de rango, elevación y azimut |
| 🔴 **Múltiples análisis** | Selecciona entradas compatibles del historial para combinar su visibilidad geométrica por celda |
| 🧮 **Sensibilidad geométrica** | Proyecta la dirección de máxima pendiente del terreno sobre una o más direcciones LOS visibles individualmente |
| 📊 **Métricas de cuadrícula** | Muestra cobertura de celdas candidatas, completitud, área visible de cuadrícula, componentes de sombra y sensibilidad |
| 📄 **Exportación PDF / CSV** | Exporta el análisis compatible activo, incluidos los estados LOS por celda en el CSV |
| 🖼️ **Captura PNG** | Captura la vista 3D actual |
| 🌐 **Procesamiento local** | El terreno y LOS se calculan en Web Workers del navegador; no hay un backend de análisis |

---

## Inicio rápido

### En línea

Abre la [aplicación alojada](https://nibaldox.github.io/GeotRadarSim/).

### Ejecución local

```bash
git clone https://github.com/nibaldox/GeotRadarSim.git
cd GeotRadarSim/frontend
npm install
npm run dev
```

Abre [http://localhost:5173/GeotRadarSim/](http://localhost:5173/GeotRadarSim/) en tu navegador.

---

## Cómo usar

### Análisis LOS desde una posición

1. **Cargar terreno** — sube un archivo DXF o STL, o genera el ejemplo sintético.
2. **Elegir perfil y límites** — selecciona uno de los perfiles locales incluidos; si hace falta, modifica rango, elevación o azimut.
3. **Ubicar el observador** — haz clic sobre el terreno o ingresa coordenadas. Un clic lo coloca 2 m sobre la superficie muestreada y ejecuta el análisis LOS automáticamente.
4. **Inspeccionar el resultado** — consulta los estados por celda y las métricas de celdas candidatas descritos abajo.

### Combinar varios análisis

1. Crea análisis separados cambiando la posición del observador y/o los límites configurados.
2. En **History/Historial**, selecciona las entradas que deseas incluir. Sus estados LOS por celda se combinan sobre la misma cuadrícula; para muestras con terreno finito, la celda combinada queda como `VISIBLE` si al menos un análisis individual seleccionado la clasifica así.
3. Las métricas combinadas se recalculan a partir de los estados fusionados. Es una unión geométrica, no una combinación de señales de radar.

### Sensibilidad geométrica

1. Selecciona uno o más análisis individuales compatibles en **History/Historial**.
2. En **Geometric Sensitivity 3D / Sensibilidad Geométrica 3D**, elige **Sensitivity (3D) / Sensibilidad (3D)** y calcula el mapa. **Quality LOS (1D) / Calidad LOS (1D)** muestra el puntaje geométrico LOS individual.
3. En cada celda finita donde ambos ejes del gradiente se calculan con vecinos centrales o unilaterales disponibles, solo contribuyen los análisis seleccionados cuyo estado LOS **individual** sea `VISIBLE`. `observer_count` es el número de análisis contribuyentes por celda; un contribuyente aporta `|dot|` y varios usan `sqrt(sum(dot_i²) / observer_count)` (RMS). El resultado es una proyección geométrica adimensional, no SNR, sensibilidad RF ni un modelo físico 3D del radar.
4. Un estado LOS `VISIBLE` por sí solo no basta: si falta cualquiera de los dos ejes del gradiente del terreno, ese análisis no contribuye. Las celdas con `observer_count = 0` quedan sin datos/transparentes (`NaN`); un valor finito igual a cero con `observer_count > 0` es un resultado medido.

Las etiquetas **1D** y **3D** de la interfaz describen el puntaje geométrico y su agregación/visualización para varias posiciones. No representan modos físicos distintos del radar.

---

## Modelo geométrico y significado de los resultados

La LOS se evalúa sobre una cuadrícula regular del terreno. El recorrido del rayo visita cruces con las líneas de la cuadrícula y sus diagonales, y evalúa los triángulos de la superficie muestreada. No intersecta directamente las caras STL originales. El rango horizontal se mide en el plano del mapa; los límites de elevación y azimut son restricciones geométricas.

| Estado de celda | Significado |
|---|---|
| `NODATA` | La muestra objetivo de la cuadrícula no tiene una elevación finita |
| `OUT_OF_RANGE` | El objetivo está fuera del rango horizontal mínimo/máximo configurado |
| `OUTSIDE_FOV` | El objetivo está fuera de los límites configurados de elevación o azimut |
| `UNKNOWN_RAY` | El rayo atraviesa una parte de la cuadrícula sin un triángulo de terreno válido |
| `SHADOW` | Un triángulo válido del terreno obstruye el rayo geométrico recto |
| `VISIBLE` | El objetivo está dentro de los límites configurados y ningún triángulo recorrido obstruye el rayo |

Son clasificaciones geométricas de la superficie cuadriculada de entrada. No representan una detección de radar ni calidad de señal medida.

Las métricas LOS usan muestras candidatas en estado `VISIBLE`, `SHADOW` o `UNKNOWN_RAY`:

- **Cobertura (%)** = `VISIBLE / (VISIBLE + SHADOW + UNKNOWN_RAY) × 100`.
- **Completitud (%)** = `(VISIBLE + SHADOW) / (VISIBLE + SHADOW + UNKNOWN_RAY) × 100`.
- Las muestras `NODATA`, `OUT_OF_RANGE` y `OUTSIDE_FOV` se excluyen de ambos denominadores. Si no hay muestras candidatas, cobertura y completitud valen `null` (se muestran como sin datos), no 0 %.
- **Área visible** = `cantidad de muestras VISIBLE × resolución de cuadrícula²`; es una estimación planimétrica de cuadrícula, no un área medida de superficie inclinada 3D.
- Las **zonas de sombra** son componentes conectados de muestras `SHADOW` usando vecindad de cuatro direcciones.

La capa **Quality LOS (1D) / Calidad LOS (1D)** también es geométrica: su valor combina la orientación de la línea de visión respecto de la normal local del terreno con una atenuación basada en la distancia al rango máximo configurado. Cuando se combinan varios análisis, la capa usa por celda el puntaje máximo entre los análisis individuales clasificados como `VISIBLE`. No es SNR, potencia recibida, un modelo de propagación ni calidad de radar validada.

---

## Perfiles de radar incluidos

La aplicación contiene **perfiles de software locales** codificados en el cliente. Los nombres de modelo son etiquetas; los valores siguientes son defaults de la aplicación, **no especificaciones del fabricante ni límites operacionales validados de manera independiente**. Modifícalos según un escenario verificado por separado.

| Etiqueta del perfil local | Rango por defecto | Intervalo de elevación | Sector azimutal por defecto |
|---|---:|---:|---:|
| GroundProbe SSR-FX | 50–2500 m | −60° a +60° | −75° a +75° (150° total) |
| IBIS-ArcSAR360 | 50–2500 m | −60° a +60° | 360° |
| Reutech MSR | 50–2500 m | −60° a +60° | −75° a +75° (150° total) |

La herramienta no consulta ni valida especificaciones de radar del fabricante. Un rango máximo configurado es solo un corte geométrico; no afirma que un instrumento real pueda detectar un objetivo a esa distancia.

---

## Formatos de archivo y procesamiento del terreno

| Formato | Extensión | Tratamiento de entrada |
|---|---|---|
| DXF | `.dxf` | Lee coordenadas/vértices de puntos, líneas, caras 3D, polilíneas y polilíneas ligeras |
| STL | `.stl` | Lee caras triangulares en formato ASCII y binario |

Las coordenadas de entrada se convierten a una cuadrícula regular de elevaciones mediante interpolación local de distancia inversa ponderada (IDW) y un índice espacial por contenedores. Luego, el recorrido LOS evalúa triángulos de esa cuadrícula generada; no realiza una triangulación de Delaunay de los puntos importados ni intersecta directamente las caras STL originales. Para STL de más de 500.000 caras, el importador muestrea las caras para limitar los datos usados en la generación de la cuadrícula. Zonas de cuadrícula vacías o inválidas pueden producir `UNKNOWN_RAY` o `NODATA`; no se consideran automáticamente terreno visible.

Los nodos de la cuadrícula se espacian desde cada mínimo X/Y según la resolución elegida. Si la extensión dividida por la resolución es un entero dentro de la tolerancia de coma flotante, se incluye el extremo; si no, la cuadrícula termina en `mínimo + floor(extensión / resolución) × resolución`, sin agregar un intervalo parcial. `max_x`/`max_y` en los metadatos indican el último nodo muestreado, no el resto sin muestrear (por ejemplo, una extensión de 200 m a 3 m de resolución termina en 198 m). Por eso, una extensión sintética de 200 m genera 101 nodos a 2 m, 401 a 0,5 m y 67 a 3 m. Cada eje debe tener al menos dos nodos; se rechazan extensiones menores que una resolución. Los límites de 16.384 nodos por eje y 1.000.000 de celdas se verifican antes de asignar la cuadrícula.

> Elevación DXF: `POINT` usa su `position` parseada; en `LWPOLYLINE`, la Z finita del vértice prevalece y, si falta, se usa la elevación finita de la entidad. Las coordenadas/elevaciones requeridas ausentes o no finitas se rechazan en vez de convertirse en cero.

---

## Arquitectura técnica

```text
Aplicación en navegador
├── Visor de terreno React + Three.js
├── Terrain Web Worker: entrada DXF/STL → cuadrícula regular IDW
├── LOS Web Worker: recorrido geométrico de rayos sobre triángulos de la cuadrícula
├── Sensitivity Web Worker: proyecciones geométricas desde análisis visibles seleccionados
└── Estado local y exportaciones PDF/CSV en el cliente
```

Los cálculos de terreno, LOS y sensibilidad se realizan en Workers del navegador. No se calcula propagación RF ni relación señal/ruido.

---

## Limitaciones

- Las dimensiones de la cuadrícula se limitan a **16.384 nodos por eje** y **1.000.000 de entradas fila × columna en total**. Se aplican ambas restricciones.
- LOS también impone un límite conservador de trabajo estimado de **5.000.000 de intervalos de recorrido**; un análisis puede rechazarse aunque la cuadrícula no supere el máximo de tamaño.
- Las entradas STL con más de 500.000 caras se muestrean antes de generar la cuadrícula. La interpolación IDW y la resolución de la cuadrícula afectan la superficie resultante y las clasificaciones LOS.
- LOS es un trazado geométrico recto sobre la cuadrícula muestreada. No modela propagación RF, atenuación, SNR, probabilidad de detección, resolución de radar ni desempeño en terreno.
- Los valores de los perfiles locales no son especificaciones del fabricante validadas. Define y verifica los límites operacionales por separado.
- La memoria del navegador y los límites de WebGL/GPU dependen del dispositivo. No se afirma un tiempo de ejecución ni un benchmark de rendimiento universal.
- Entidades DXF sin elevación o con Z igual a cero pueden generar una superficie plana o inadecuada.

---

## Hoja de ruta

- [ ] Etiquetas de curvas de nivel y vista en planta 2D
- [ ] Visualización del cono del haz del radar
- [ ] Tabla comparativa de varios análisis
- [ ] Importar/exportar configuración de red de radares (JSON)
- [ ] Editor de perfiles locales personalizados
- [ ] Diseño adaptable a dispositivos móviles

---

## Contribuir

Las contribuciones son bienvenidas. La prioridad es mantener explícito el contrato geométrico, el manejo de datos faltantes y un comportamiento reproducible, no hacer afirmaciones físicas o de rendimiento sin sustento.

```bash
cd frontend
npm test
npm run build
```

---

## Licencia

MIT — Libre para usar, modificar y distribuir.

---

## Sobre el proyecto

GeotRadarSim es una herramienta en navegador para explorar geometría del terreno y escenarios LOS configurados. Puede apoyar una revisión geométrica inicial, pero no reemplaza la validación de los datos topográficos, la información del fabricante, el análisis RF ni la validación en terreno.

Sugerencias o problemas → [GitHub Issues](https://github.com/nibaldox/GeotRadarSim/issues)
