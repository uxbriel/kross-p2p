# 02 · SMART LOGISTICS — Despacho & Motorizados

> **Objetivo:** que el producto llegue a la puerta correcta sin llamadas del motorizado
> preguntando *"¿dónde queda su casa?"*. Entregar sin fallos y en tiempo récord.
>
> Leyenda: ✅ construido · 🟡 parcial · 🔮 planeado

## Componentes

### 1. Geolocalización precisa ✅ / 🔮

> El pin **no está en el checkout**: se captura después de cerrar la venta, en el chat del
> pedido. Ver §4 — la cobertura la decide el distrito, no la coordenada.

- **Hoy ✅:** captura de GPS "mejor fix" en `src/components/AddressBar.tsx` — junta varias
  lecturas por unos segundos y guarda la más precisa (como las apps de taxi), evitando el
  fix grueso del primer intento. Rechaza fixes imprecisos (típico laptop/WiFi). Hace
  reverse-geocode y persiste `address_lat/lng` + `address_verified`. El **comprador** es el
  único que fija/cambia su ubicación; el vendedor la ve read-only (abrir en Google
  Maps/Waze, copiar coordenadas).
- **Falta 🔮:** **pin arrastrable** sobre un mapa para micro-ajustar la casa (hoy es
  "un toque = GPS", sin arrastrar). Es el siguiente salto de precisión, sobre todo iOS.
- **Falta 🔮:** campo `delivery.reference` (referencia de la puerta) en el flujo.

### 2. Hoja de ruta para motorizados (Lima) 🟡
- **Hoy ✅:** rol **Motorizado** en el pipeline; el pedido se le cede en `en_camino`
  (`order-manage`, `HANDOFF`), acompañado por Soporte como co-escritor. Vista del pedido
  con dirección, GPS y teléfono.
- **Falta 🔮:** una **UI/route-sheet dedicada** para el repartidor: lista de entregas del
  día, mapa con referencia exacta, teléfono a un clic y cobranza (COD/Yape) marcada por
  parada. Hoy opera dentro del chat del pedido, no como hoja de ruta optimizada.
- Debe leer `delivery.*` con `dispatchType = 'MOTORIZADO_LIMA'`.

### 3. Gestor de envíos a provincia 🟡
- **Hoy ✅ (data + servicios, sin UI):** cobertura real del courier y listado real de
  agencias, ambos detrás de una interfaz que permite cambiar a API sin tocar componentes.
  Ver §4 y §5.
- **Falta 🔮:** generación de **etiquetas/datos formateados para agencias** (Shalom / Olva
  Courier): nombre, DNI, teléfono, destino, contenido.
- Debe setear `delivery.dispatchType = 'AGENCIA_PROVINCIA'` y `delivery.agencyName`.

### 4. Cobertura del courier (Aliclic / Alidriver) ✅ data · 🔮 UI

Hay **dos fuentes** de cobertura y cada una tiene un rol distinto. No se mezclan.

#### 4.1 Por DISTRITO — es la que decide la venta ✅

`src/lib/checkout/services/DistrictCoverageService.ts`

- **Fuente:** tarifario oficial del courier (hoja "COBERTURA OFICIAL" de
  *COBERTURA ALIDRIVER - ALICLIK*) → `scripts/sources/aliclic-cobertura-distritos.csv` →
  `aliclic-districts.json` + `peru-districts.json` vía `npm run build:data`.
- **178 distritos con cobertura a domicilio** en 28 ciudades; **483 distritos
  seleccionables** en total. Solo **9,6 KB gzip** entre ambos, en chunks aparte.
- El selector muestra **todo el país**, cubierto o no: quien vive donde el motorizado no
  llega igual compra, por agencia. Nunca hay callejón sin salida.
- El índice es la **unión** de `peru-geo.ts` y el tarifario: a `peru-geo.ts` le faltaban
  **53 de los 178** distritos cubiertos, y esos compradores habrían ido a agencia sin
  necesidad.
- Veredicto: `IN_ZONE` → domicilio · `BORDERLINE` → agencia (visita semanal, o ciudad en
  `AGENCY_ONLY_CITIES`) · `OUT_OF_ZONE` → agencia.
- Distritos homónimos (hay un Miraflores en Lima y otro en Arequipa) se desambiguan por
  `departamento|provincia|distrito`.

**Por qué distrito y no polígono.** Se comparó el veredicto de ambas fuentes usando las
487 sedes de Shalom como muestra de dónde hay gente y comercio: **coinciden en el 94,9 %**
(314/331). Cobrarle un paso de mapa al 100 % de los compradores para ganar precisión en el
5 % restante cambia conversión por exactitud, y aquí gana la conversión. Las tres ciudades
donde el distrito se queda corto (Tumbes 60 %, Cusco 67 %, Talara 67 %) las resuelve la
propia data: Tumbes no figura en el tarifario (queda no cubierto) y los 13 distritos
semanales de Cusco se degradan solos. Ese proxy es geográfico, no ponderado por demanda
real; se recalcula cuando haya pedidos con coordenadas.

#### 4.2 Por POLÍGONO — análisis post-venta, no decide la venta ✅

`src/lib/checkout/services/CoverageService.ts`

- **Fuente:** KML oficial del courier (`scripts/sources/aliclic-cobertura.kml`) →
  `aliclic-zones.json`. 29 ciudades, 148 anillos (9 agujeros = zonas excluidas dentro de
  un área cubierta), 3.682 vértices. ~27 KB gzip, chunk aparte.
- Se evalúa **cuando ya existe una coordenada**: la dirección guardada del comprador, o el
  pin que captura `AddressBar` en el chat del pedido después de cerrar la venta.
- **Los polígonos no son binarios.** Cada zona lleva un **recargo** (`ADICIONAL N` = +S/N
  sobre la tarifa base). Cotejado contra el tarifario y calza: Trujillo base S/15.50 y El
  Porvenir S/15.50–20.50 → delta 5 = capa `TRUJILLO ADICIONAL 5`. Ese recargo es **costo
  de la marca, no del comprador**, y jamás se le traslada.
- `surcharge: null` = la capa dice "ADICIONAL" sin monto (Cusco, Chiclayo, Lima). Hay
  recargo pero se desconoce cuánto; tratarlo como 0 subestimaría el costo.
- **Ciudades piloto:** en Ilo, Moquegua, Talara, Puerto Maldonado y Chincha la zona base
  viene rotulada "PRUEBA" en el mapa. **No es basura** — es la única zona base de esas
  ciudades y cae sobre su centro. Filtrarlas dejaba sin cobertura sus centros.

> **No hay mapa en el checkout.** El pin nunca fue para validar cobertura: según este
> mismo doc, es para que el motorizado llegue a la puerta correcta. Eso es valor
> operativo, no un requisito de venta — y se captura después, donde el comprador ya está
> comprometido. Sin mapa no hace falta Leaflet (~42 KB) ni proveedor de tiles.

### 5. Listado de agencias ✅ Shalom · ✅ Olva

`src/lib/checkout/services/AgencyService.ts` — **las dos agencias se resuelven con el
mismo código**. `OTRO` es la única sin listado: para esa la UI cae a texto libre y el
pedido queda marcado para verificación manual.

| | Sedes | Fuente | Adelanto |
|---|---|---|---|
| **Shalom** | 487 | CSV oficial → `scripts/build-agencies.mjs` | S/10 |
| **Olva** | 424 | su propio buscador → `scripts/build-olva.mjs` | S/20 |

- Shalom sigue siendo la **recomendada**: no por tener mejor data —ya empatan— sino
  porque su adelanto es la mitad. La ruta más barata para el comprador es la que se
  muestra primero.
- ⚠️ **El CSV de Shalom traía las coordenadas corruptas** (locale español: el punto
  decimal leído como separador de miles, 487 de 488 filas). El generador las reconstruye
  y desambigua con el centroide del departamento.
- ⚠️ **En Olva, 5 sedes traen lat y lng intercambiadas** (Ayacucho, San Sebastián,
  Pangoa…). Se detectan y corrigen solas: los rangos de latitud y longitud de Perú no se
  solapan, así que el intercambio es inequívoco.
- **9 sedes de Olva no traen coordenadas.** No se descartan: siguen apareciendo en el
  listado buscable para que alguien de ese distrito pueda elegirlas. Lo único que no
  pueden es ordenarse por cercanía.
- El teléfono del CSV de Shalom es el call center (7 valores para 488 sedes), no el de
  cada sede: se omite a propósito. Olva sí trae **horarios por día**, todavía sin usar.
- ⚠️ **La data de Olva no viene de un acuerdo con ellos**, sino de su buscador público.
  Puede cambiar de forma sin aviso y el generador se rompería. Lo sólido a mediano plazo
  es pedirles el listado oficial, como se hizo con Shalom.

### 6. Centroides para ordenar agencias ✅

`scripts/build-centroids.mjs` → `src/data/coverage/district-centroids.json`

Promedia las **911 sedes de ambas agencias** para obtener un punto por distrito (378),
provincia (165) y departamento (25). Sirve para ordenar las agencias por cercanía **sin
pedirle al comprador su ubicación**.

`getDistrictCenter` **degrada distrito → provincia → departamento**. Sin eso, alguien en
un distrito sin sedes se quedaba sin punto de referencia: se detectó en Poroy (Cusco), a
quien el checkout le ofrecía sedes de **Amazonas**. Corregido y con test.

Corre **después** de los generadores de agencias, porque lee sus JSON ya construidos.

## Datos que consume/produce (estado central)
- Lee: `customer.phone`, `delivery.lat/lng/addressText`.
- Escribe: `delivery.reference` 🔮, `delivery.dispatchType` 🔮, `delivery.agencyName` 🔮.

## Estándares
- El comprador es la única fuente de verdad de su ubicación; el motorizado NO la edita.
- No re-pedir dirección si ya está `address_verified` (heredar del `buyers`).
- Coordenadas siempre con precisión validada antes de guardar (ver AddressBar).

## Pendientes priorizados
1. 🔮 Pin arrastrable + campo referencia, en el chat del pedido (post-venta), no en el
   checkout.
2. 🔮 Route-sheet del motorizado (Lima) con cobranza por parada.
3. 🔮 Generador de envíos a provincia (Shalom/Olva).
4. 🔮 Persistir `courier_surcharge` y `coverage_result` en `order_sessions` — es la data
   con la que se negocia cobertura con Aliclic y se mide venta perdida por zona.

## Regenerar la data

```
npm run build:data     # KML + CSV + JSON de scripts/sources → src/data/
npm test               # valida geo, cobertura y agencias contra la data real
```

Las fuentes crudas viven versionadas en `scripts/sources/` para que los generadores sean
reproducibles y auditables. Los JSON de `src/data/` son **generados**: no se editan a mano.

## En agencia no se pide GPS

El chat mostraba "DIRECCIÓN DE ENTREGA · SIN VERIFICAR" con botón **Verificar
GPS** en TODOS los pedidos, también en los de recojo en agencia. Ahí el paquete
va a un mostrador, no a una puerta: pedir GPS no solo no aporta, sino que le
estampa al pedido **la coordenada de la casa del comprador**, y Logística
termina viendo un domicilio con botones de Maps y Waze para una entrega que es
de counter. Pasó de verdad — un pedido a Shalom en La Peca quedó con
`address_verified = true` y un pin de vivienda.

La máquina del checkout ya decidía bien (`needsLocationConfirmation` es false en
agencia, ver `01-SALES-ENGINE.md`); lo que faltaba era que el chat se enterara.
Ahora `get-session` devuelve `dispatch_type` / `agency_name` y `AddressBar`:

- rotula **"Recojo en agencia · SHALOM"** en vez de "Dirección de entrega";
- no muestra el botón de GPS ni el "sin verificar" naranja —el pedido está
  completo, no hay nada pendiente que reclamarle a nadie;
- no ofrece Maps/Waze sobre una coordenada que no corresponde al destino.

**Regla general:** todo lo que el checkout decide sobre la entrega tiene que
viajar al chat. Si el chat no conoce `dispatch_type`, vuelve a inventar
pendientes que el checkout ya había resuelto.

## Antes de despachar: el adelanto

Un pedido de provincia no se despacha por estar "confirmado": se despacha cuando el
adelanto está verificado **y sin advertencias pendientes**.

- `advance.verification = 'MATCHED'` y `reason` vacío → listo.
- `MATCHED` **con** `reason` (nombre distinto, código que no calza) → lo mira una persona.
  El pedido avanza igual en la barra del comprador —el pago entró, la duda es nuestra—
  pero el `AdvancePanel` del chat de Ventas muestra la advertencia y el comprobante.
- `PENDING` → el pago no ha cruzado. No se despacha.

El comprobante se abre desde ese panel con URL firmada de 5 minutos (`voucher-url`).
Nunca se sirve como enlace directo: lleva nombre, teléfono parcial y número de operación
del comprador. Contrato y reglas completas en `00-CORE-ARCHITECTURE.md`.
