# 01 · SALES ENGINE — Cierre & Conversión

> **Objetivo:** liberar al emprendedor del cuello de botella de atender clientes a mano.
> Cerrar ventas en minutos sin personal humano.
>
> Leyenda: ✅ construido · 🟡 parcial · 🔮 planeado

## Componentes

### 1. Agente IA "Closer" (voz + texto) 🟡
- **Hoy ✅:** voz WebRTC vendedor↔comprador con **LiveKit** (`seller-call-token`,
  `create-call-token`, overlay de llamada, ringtone) + grabación por Egress
  (`livekit-webhook`). Asistente IA para el **vendedor** en `BotIAPage.tsx`.
- **Costura lista ✅ (dormida):** hook `src/lib/useVoiceCloser.ts` que conecta un agente
  **ElevenLabs Conversational AI** al estado del checkout: le da **contexto dinámico**
  (paso, Lima/provincia, pago) y dispara un **nudge de voz a los 5s** de inactividad.
  El transporte de audio es **pluggable** (`VoiceTransport`); por defecto `noopTransport`
  → si no hay `VITE_ELEVENLABS_AGENT_ID` el hook queda dormido y no rompe nada.
  Signed URL efímera vía `elevenlabs-signed-url` (API key en backend).
- **Falta 🔮:** enchufar la tubería de audio real (`@elevenlabs/react`) en un
  `createElevenLabsTransport()` que implemente `VoiceTransport`, y crear el agente en
  ElevenLabs. Recién ahí la voz atiende y cierra sola.
- Al cerrar por voz, marcar `sale.closedBy = 'AI_CLOSER'` (columna lista; `register-buyer`
  ya acepta `closed_by`).

### 1.b Checkout multi-paso (refactor en curso) 🟡

**Núcleo ✅ construido** en `src/lib/checkout/`:

| Archivo | Rol |
|---|---|
| `types.ts` | Contrato de `CheckoutState`. Tipado estricto, sin `any` |
| `checkout.config.ts` | **TODA** regla de negocio: montos, umbrales, textos, modos |
| `machine.ts` | Reducer puro. `advanceAmount`, `deliveryMethod`, `needsLocationConfirmation` y `courierSurcharge` son **derivados**, nunca los setea la UI |
| `validation.ts` | Schemas por paso, sin dependencias (son 4 campos; una librería no se paga sola) |
| `persistence.ts` | Borrador en `localStorage` por `orderId`, TTL 24 h. Nunca revienta y **migra los borradores de versiones anteriores** |
| `analytics.ts` | `trackEvent()` con interfaz lista para enchufar Pixel/GA4 |
| `services/` | `DistrictCoverageService` (decide la venta), `CoverageService` (polígonos, post-venta), `AgencyService`, `PaymentVerificationService` |

- **3 pasos:** pack → datos+entrega → resumen+pago. El adelanto de provincia es
  **S/10** (`ADVANCE_PROVINCIA_PEN`); Lima va 100 % contraentrega.
- **Idempotencia:** cada checkout nace con un `orderId` uuid. `register-buyer` debe
  aceptarlo para que un doble tap no genere dos pedidos (pendiente, Fase 3).
- **No hay mapa en el checkout.** La cobertura se decide por **distrito** (178 cubiertos,
  483 seleccionables, 9,6 KB gzip). Coincide con los polígonos en el 94,9 % de los casos,
  y el mapa costaba un paso a todos para ganar precisión en el 5 %. Ver
  [`02-LOGISTICS §4`](./02-SMART-LOGISTICS.md). La coordenada se captura después de la
  venta, en el chat del pedido.
- **La rama de agencia siempre está abierta**: distrito sin cobertura, zona de visita
  semanal o simple preferencia del comprador — el pedido se cierra igual.
- 83 tests contra la data real del courier y de las dos agencias: `npm test`.

**UI ✅ construida** (Fase 2) en `src/components/checkout/`:

| Archivo | Rol |
|---|---|
| `CheckoutModal.tsx` | Shell: progreso, trap de foco, Esc con confirmación, CTA sticky en el safe area |
| `ExitOffer.tsx` | Diálogo centrado de retención al intentar salir (oferta o confirmación seca) |
| `steps/Step1Pack.tsx` | Packs con precio por unidad, ahorro explícito y badge `×N` de cantidad |
| `steps/Step2Delivery.tsx` | WhatsApp → nombre → Lima/Provincia → DNI (orden de compromiso creciente) |
| `steps/Step3Confirm.tsx` | Resumen + caja Yape + código de seguridad + captura opcional |
| `steps/OrderDone.tsx` | Pedido confirmado. Llegar aquí ES el KPI del refactor |
| `payment/YapeBox.tsx` | Número/titular de la tienda, copiar, deep link (móvil) y QR (desktop) |
| `payment/VoucherField.tsx` | Captura opcional, comprimida antes de subir |
| `services/OrderService.ts` | `submitOrder` (idempotente) + `uploadVoucher` al bucket privado |
| `branches/LimaBranch.tsx` | Distrito + dirección + referencia. COD, sin adelanto |
| `branches/ProvinciaBranch.tsx` | Distrito → veredicto → domicilio o agencia |
| `branches/AgencyPicker.tsx` | Shalom y Olva: 3 sedes más cercanas con distancia real |
| `fields/` | `Field`, `PhoneField`, `SearchSelect` (483 distritos, navegable con teclado) |
| `useCheckout.ts` | Cose reducer + persistencia + validación al blur + instrumentación |

- **Revisión sin Supabase:** `/checkout-demo` monta el modal con packs de ejemplo y data
  real de cobertura. Solo se registra en desarrollo (ver `App.tsx`).
- Verificado en navegador real a **360 px y 1440 px**: sin scroll horizontal, Lima cierra
  en ~2 s, el borrador sobrevive a la recarga y Esc con data pide confirmación.

- **Fase 3 ✅:** el paso 3 cierra pedidos de verdad (resumen, adelanto por Yape, submit
  idempotente, pantalla de confirmación). La landing lo sirve tras `?checkout=v2`.
- **Pendiente 🔮:** Fase 4 (instrumentación completa y pulido) y **medir v2 contra el
  checkout actual** antes de cambiar el que hoy vende — cambiarlo sin datos sería apostar.
- ⚠️ `src/lib/checkout-flow.ts` y el cuerpo de `CheckoutQuiz.tsx` quedan **en pie hasta
  que Fase 3 esté verde**, para no romper la landing. Se borran al cerrar el refactor.
  `useVoiceCloser.ts` todavía lee el estado viejo: se adapta al cerrar Fase 3.

#### Ajustes tras revisar Fase 2 (jul-2026) ✅

Confirmado con operaciones: **Shalom y Olva sí exigen DNI del destinatario** para
entregar el paquete. Eso valida la asimetría y el copy.

**a) El DNI sale de Lima ✅.** Lima cierra con teléfono + nombre y nada más: es el segmento
de mayor volumen y el DNI es el campo que más abandono genera. En provincia se queda,
porque ahí hay dinero adelantado y porque la agencia lo exige para entregar. El contrato
de identidad y sus riesgos están en
[00-CORE · Identidad del comprador](./00-CORE-ARCHITECTURE.md).

**b) Nombre y DNI dejan de competir ✅.** Se piden los dos porque el nombre del DNI
(titular, vía Decolecta) y "quién recibe" no son siempre la misma persona — en COD recibe
la mamá, el vecino, el portero. Pero el orden actual (nombre → DNI) hace que el
autocompletado casi nunca se aprovechara. Al quedar el DNI solo en provincia, ahí se
**invirtió**: DNI primero → Decolecta rellena el nombre → el microcopy
*"¿Lo recibe otra persona?"* cubre la minoría. Un campo menos de tipeo en el flujo más
largo. Orden final: WhatsApp → Lima/Provincia → [DNI si provincia] → nombre → distrito.

**c) Copy del DNI ✅.** El anterior —*"Para crear tu cuenta y que puedas seguir tu
pedido"*— planteaba un beneficio nuestro como si fuera suyo. Ahora dice **"La agencia te
lo pedirá para entregarte el paquete"**: un hecho de su mundo, verificable, no un trámite
del nuestro.

**e) El adelanto depende de la AGENCIA ✅.** Shalom cobra S/10 y **Olva S/20**, porque su
flete es más caro. `advanceFor(isProvincia, agency)` en `checkout.config.ts` es la única
fuente del monto. El adelanto se muestra **en la tarjeta de cada agencia, antes de
elegir** — que el número suba después de haber elegido se lee como cambio de precio a
mitad de compra. Efecto secundario deseable: Shalom, que ya era la recomendada por tener
listado estructurado, además se ve más barata.

**d) Descuento de retención al intentar salir ✅.** Al cerrar el modal con datos
ingresados se ofrecen **S/5 de descuento sobre cada pack** antes de dejarlo ir.

- **Disparador:** el toque en la X (o Esc en desktop). Se descartó `mouseleave`, el
  exit-intent clásico: no existe en móvil, y el tráfico de anuncios de Meta es casi todo
  móvil — habría disparado solo para una minoría.
- **Una sola vez por checkout.** `exitOfferShown` vive en el estado y se persiste, así que
  la regla sobrevive a una recarga. Insistir cada vez le enseña al comprador que salir es
  la forma de conseguir descuento. El segundo intento de salida muestra la confirmación
  seca, sin oferta.
- **Es un diálogo propio y centrado** (`ExitOffer.tsx`, `role="alertdialog"`), no una nota
  en el pie del modal. En el pie competía con el CTA y se leía como letra chica; al centro
  no hay nada más que decidir en ese instante. El monto va como héroe tipográfico y sale
  de `EXIT_DISCOUNT_PEN` — **el copy no lo escribe**, así que cambiar el descuento no deja
  textos mintiendo un monto viejo.
- **Esc y el clic en el fondo significan "quedarme"**, no "salir". Salir es un botón
  explícito. Perder una venta por una tecla repetida sería el peor intercambio posible.
  El diálogo trapea su propio Tab: si no, el trap del modal de abajo movía el foco a
  controles que el comprador no ve.
- **El ahorro por volumen se calcula sobre el precio de lista**, no sobre el descontado.
  Si no, el pack de 1 unidad —que no ahorra nada— mostraría "Ahorras S/5" y diluiría el
  anclaje hacia el de 2. El descuento se comunica aparte: precio tachado + banner verde.
- ⚠️ **Cuesta margen y puede enseñar a abandonar.** S/5 sobre una ganancia típica de
  S/49–78 por pedido es 7–10 %, y se paga también en los pedidos de quien iba a comprar
  igual. Los eventos `exit_offer_shown` y `exit_discount_applied` están instrumentados:
  **medirlo contra un grupo de control antes de darlo por bueno.** El monto se cambia en
  una línea de `checkout.config.ts`.

**f) Los borradores de versiones anteriores se migran, no se descartan ✅.** Al agregar
`discountPen` al estado, los borradores ya guardados volvían sin ese campo y el paso 1
hacía `precio - undefined`: **todos los packs mostraban `S/NaN`**. Un comprador que ve NaN
donde va el precio no compra, y el bug solo aparecía en quienes ya habían empezado un
checkout antes — o sea, en los más cerca de convertir.

- `persistence.ts` completa el borrador leído con los defaults de hoy
  (`initialCheckoutState()`), en vez de tirarlo: el borrador es el avance del comprador.
  Los objetos anidados (`customerInfo`, `payment`) se completan aparte, porque el spread
  los reemplaza enteros.
- Los números que entran a aritmética se validan **por valor, no por ausencia**: basta un
  `null` guardado para propagar NaN a toda la pantalla.
- `effectivePrice()` ignora cualquier entrada no finita. Es la única función que calcula
  el precio mostrado, así que ahí el `S/NaN` queda imposible venga de donde venga. En el
  peor caso se pierde el descuento —S/5—, nunca el precio.
- Dos tests de regresión en `checkout.test.ts`.

**g) Los packs siguen en filas horizontales, no en tarjetas verticales.** Se evaluó el
patrón tipo app de comida rápida (tarjeta vertical con foto grande) y **no aplica aquí**:

- En ese patrón cada ítem es un producto DISTINTO y la foto es lo que lo identifica. Aquí
  los tres packs son **el mismo producto en distinta cantidad**: la foto sería idéntica en
  las tres tarjetas, no distingue nada y empuja el precio fuera de la vista.
- A 360 px, tres tarjetas verticales son ~2 pantallas de scroll. Comparar precio por
  unidad y ahorro lado a lado —lo que mueve el ticket promedio— deja de ser posible de un
  vistazo, y el CTA se va abajo del fold. Contra la regla de decisión (gana lo que quita
  fricción), la fila gana.
- Lo que sí faltaba era una señal visual de cantidad: la fila ahora lleva un badge **`×N`**
  sobre la miniatura, venga o no venga foto.

**h) Foto por pack ✅ (opcional, la carga la marca).** `products.packs[].image` se sube
desde **Productos → editar → "+ Foto del pack"** (`ProductosPage.tsx`, bucket `products`).
`packs` es `jsonb`: no hubo migración.

- **La foto vende solo si muestra la CANTIDAD** — 1 frasco, 2 frascos, 3 frascos, mismo
  fondo. Convierte "llevas más" en algo que se ve antes de leer el precio. Si se sube la
  misma foto en los tres packs, es peor que no subir ninguna: no distingue nada y pesa en
  4G. El aviso está escrito en el propio editor, donde se toma la decisión.
- Sin foto propia, el fallback sigue siendo `images[0]` (la primera imagen de la landing).
- **Se reduce en el navegador antes de subirla** (`src/lib/images/downscale.ts`, preset
  `packThumb`: 400 px, calidad 0,82). Se muestra a 56 px y el comprador la carga en 4G;
  subir 4 MB para eso son segundos de espera en el paso donde se decide la venta. Si el
  navegador no puede procesarla, se sube tal cual: perder compresión es barato, perder la
  subida no. El mismo helper sirve para el comprobante de Yape en Fase 3.
- `/checkout-demo` trae tres SVG inline de 1, 2 y 3 frascos para poder revisar el patrón
  sin cargar nada.

### 2. Checkout CRO ultra-rápido ✅
- **Validación DNI con Decolecta (RENIEC)** → autocompleta el nombre y reduce campos:
  `supabase/functions/dni-lookup/index.ts` (secret `DECOLECTA_TOKEN`).
- Registro del comprador y creación del pedido: `register-buyer` (upsert por
  `document_number` o teléfono; asignación round-robin a un vendedor de **Ventas**;
  continuidad si ya tenía pedido activo con un vendedor).
- Landing de producto: `src/pages/LandingProductoPage.tsx`. Chat del pedido:
  `OrderChatPage.tsx` (Realtime).
- Escribe `customer.*` y `sale.productId` del estado central. ✅

### 3. Pagos locales sin fricción 🟡

- **Hoy ✅:** **Contraentrega (COD)** es el flujo real de cobro en Lima.
- **Hoy ✅ (backend, Fase 3):** verificación del **adelanto por Yape** en provincia —
  ingesta, cruce y estado del pedido. Ver §3.1.
- **Falta 🔮:** UI del paso 3 (caja Yape, subida del comprobante, pantalla de confirmación)
  y tarjeta.

#### 3.1 Verificación del adelanto por Yape ✅ backend · 🔮 UI

**⚠️ Restricción técnica que define todo el diseño: una PWA NO puede leer las
notificaciones de otras apps.** No existe Web API para eso, ni en Android ni en iOS. Lo
que sí existe es `NotificationListenerService`, una API **nativa de Android** que exige un
APK instalado y un permiso que se concede en una pantalla del sistema. Una PWA, aunque
esté "instalada", corre en el sandbox del navegador y no la ve. (`save-push-subscription`
va en la dirección contraria: sirve para *enviarle* notificaciones al equipo.)

Por eso el sistema **no depende de quién lee la notificación**. La lectura es una fuente
enchufable; todo lo demás es nuestro y no cambia si la fuente cambia.

```
  [ celular del dueño ]  ──POST──▶  yape-ingest  ──▶  payment_events
   lee la notificación                   │
   (fuente enchufable)                   ├──▶ cruza con order_sessions PENDING
                                         └──▶ chat del pedido + estado
```

| Fuente (`source`) | Qué es | Cuándo |
|---|---|---|
| `AUTOMATION` | MacroDroid / Tasker / Automate en el Android del dueño: una regla "notificación de Yape → HTTP POST" | **Se puede usar hoy**, sin publicar nada |
| `ANDROID_LISTENER` | APK propio con `NotificationListenerService` | Cuando valga la pena mantener una app nativa |
| `MANUAL` | alguien del equipo lo escribe | Siempre disponible como respaldo |

- **iOS no puede hacer esto de ninguna forma.** Si el dueño usa iPhone, el lector tiene
  que vivir en un Android (puede ser un equipo viejo dedicado) o el cruce es manual.

**Cómo cuadra un pago con un pedido** — `supabase/functions/_shared/yape-match.ts`, puro y
con tests. La regla vive en UN solo lugar porque el cruce ocurre en los **dos sentidos**:
el comprador suele yapear *antes* de terminar el pedido, así que `register-buyer` también
busca pagos ya guardados al crear el pedido. Sin esa segunda pasada, todo pedido de
provincia quedaría esperando un pago que ya había llegado.

1. **Código de seguridad** que teclea el comprador. Es lo único que no se puede adivinar
   mirando el monto: si calza, cuadra.
2. **Monto, y solo si hay un único candidato.** Con dos pedidos esperando S/10, elegir "el
   más antiguo" acierta la mitad de las veces — y la otra mitad le da por pagado el pedido
   a quien no pagó. Eso va a revisión humana.
3. **El nombre NUNCA decide.** En COD paga la mamá, el vecino o el esposo. Se compara
   tolerando el apellido abreviado de Yape ("JUAN C. P."), y si difiere se anota el aviso
   pero **el match se mantiene**.

**Decisiones de seguridad del dinero:**

- Un pago **saliente** ("¡Yapeaste S/20 a…!") se descarta explícitamente. Si entrara,
  nuestro propio gasto podría cuadrar un adelanto y darlo por pagado.
- **Deduplicación obligatoria** (índice único `store_id + dedupe_key`): la misma
  notificación llega dos veces con frecuencia (el automatizador reintenta, el celular la
  re-emite al desbloquear). Sin esto un pago cuadraría dos pedidos.
- **Todo pago se guarda, cuadre o no**, con su `raw`. Un pago sin pedido ahora puede ser
  el de un pedido que entra en 30 segundos, y el texto crudo permite reprocesar si el
  parser resultó corto. Nunca se pierde plata por un fallo de parseo.
- **`yape_autoconfirm` arranca en `false`** (columna por tienda). Un match marca el pedido
  como `MATCHED` y lo escribe en el chat, pero la persona sigue confirmando. Primero se
  mide cuánto acierta el cruce; después se le da el gatillo, sin deploy.
- **Al comprador jamás se le dice que su pago no existe.** `payment_reason` es para quien
  revisa. Un `UNMATCHED` es un fallo nuestro hasta que se demuestre lo contrario.
- El token de ingesta es **por tienda** y no la anon key. Vive en **`store_secrets`**, no
  en `stores`: esa tabla tiene `SELECT` público (política `stores_read`) y **RLS es por
  fila, no por columna** — puesto ahí, cualquiera con la anon key podría leerlo y ensuciar
  la caja. `store_secrets` no tiene políticas: solo entra el service role. Si el token se
  filtra se rota esa fila. Sin token configurado la tienda no ingesta nada.

**El texto real de la notificación ✅ (capturado 29-jul-2026, Android):**

```
título: Confirmación de Pago
cuerpo: Leonardo Pac* te envió un pago por S/ 1. El cód. de seguridad es: 965
```

Tres cosas que solo se supieron al verlo, y que el parser reconstruido erraba:

1. **Yape corta el apellido con un asterisco**, no con un punto ("Leonardo Pac*"). Sin
   normalizarlo, `PAC*` nunca calzaba con `PACAHUALA` y **todo** pago quedaba marcado como
   "nombre no coincide".
2. **El código sí viaja en la notificación**, pero abreviado y con preposición: *"El cód.
   de seguridad es: 965"*. La etiqueta que se esperaba (`código de seguridad`) no calzaba.
3. **El título se cuela** si el automatizador manda título + cuerpo juntos: el nombre salía
   "Confirmación de Pago Leonardo Pac*". Se quita antes de leer el nombre.

Que el código venga en la notificación es lo que hace viable el cruce automático: es la
llave fuerte, y el comprador la copia de su propio comprobante. El **n° de operación NO
viaja** en la notificación (solo está en el comprobante del pagador), así que la
deduplicación se apoya en monto + nombre + código por día.

**Un pago hecho desde PLIN a un número Yape ✅ (real, 30-jul-2026):**

```
Confirmación de Pago
Yape! JHOANN PACAHUALA te envió un pago por S/ 1.5
```

Otro cuerpo, con `Yape!` delante del nombre y —lo importante— **sin código de seguridad**.
No es un fallo: el código lo genera Yape para sus propios pagos, así que con Plin nunca va
a venir. Ahí el cruce cae al modo débil (monto con candidato único), y **por eso el paso 3
le pide el código al comprador**: cuando la notificación no lo trae, lo pone él.

**El monto no puede tragarse el punto de la oración.** *"…por S/ 0.1. El cód…"* devolvía
`"0.1."` y `Number()` daba `NaN`: el pago se descartaba por "sin monto legible". Con
`S/ 1.` no se notaba porque JS sí parsea `"1."`. Los decimales ahora se exigen después del
punto. Lo encontró un pago real de S/0.10, no una prueba inventada.

**⚠️ Android 15 puede censurar el código.** MacroDroid avisa que a partir de Android 15 los
contenidos tipo OTP se bloquean para los lectores de notificaciones. El código de seguridad
es exactamente ese patrón. En el equipo probado **sí llega** (se verificó con un pago real:
notificación `956` = comprobante `956`), pero si algún día el `raw` empieza a llegar sin
código en pagos Yape→Yape, hay que apagar **"Notificaciones mejoradas"** en los ajustes de
notificaciones del equipo.

**Orden de despliegue: primero el SQL, después la función.** Al revés, la función escribe
columnas que la base no tiene y responde 500 — y como el automatizador no reintenta, ese
pago se pierde. Por eso un fallo de inserción ahora vuelca el pago completo al log de la
función: es la última red para recuperarlo a mano.

**Nada se descarta en silencio ✅.** Un texto ilegible, un pago saliente o una variable del
automatizador sin expandir se guardan igual en `payment_events` con `ignored_reason`. Antes
respondían 200 sin dejar fila: costó una tarde de depuración a ciegas descubrir que
MacroDroid mandaba el marcador literal. Ahora "por qué no entró este pago" se responde con
una consulta.

El parser sigue siendo tolerante a propósito y el `raw` se guarda siempre: si Yape cambia
la redacción, se reprocesa sin haber perdido ningún pago. **Toda notificación nueva que se
vea en producción se agrega como caso de test** en `src/lib/checkout/yape.test.ts`.

**Idempotencia ✅.** `order_sessions.checkout_id` (único) es el uuid que nace al abrir el
modal. Un doble tap en "Terminar pedido" con 4G lenta devuelve el pedido ya creado en vez
de crear otro con otro vendedor asignado y otro mensaje de bienvenida.

**Datos de cobro por tienda ✅.** `stores.yape_number`, `yape_holder`, `yape_qr_url`. Kross
es multi-tenant: cada marca cobra a su propio Yape, así que **nunca** van en código ni en
`checkout.config.ts`. Si la marca no los configuró, el paso 3 **no inventa un número**: le
dice al comprador que un asesor coordina, y el pedido se cierra igual.

#### 3.2 Qué se le exige al comprador en el paso 3 — y qué no

**Obligatorio: el código de seguridad. Opcional: la captura.** (`VOUCHER_REQUIRED = false`).

Es la decisión de fricción más importante de la fase, y por una vez la conversión y la
calidad del dato apuntan al mismo lado:

- **La imagen no la lee ninguna máquina.** No hay OCR en el sistema. Exigir una foto de
  4 MB en 4G, justo antes del botón de cerrar, cuesta conversión real y no compra nada
  automático — solo evidencia para un humano.
- **El código sí es dato de máquina.** Viaja en la notificación que le llega a la marca y
  es la llave que desambigua dos pedidos del mismo monto. Son 3 dígitos que el comprador
  tiene en pantalla.
- La captura queda como acción secundaria, se sube comprimida (`downscale`, preset
  `voucher`) al bucket **privado** `vouchers`, y **si la subida falla no bloquea el
  pedido**: el código ya identifica el pago.
- El bucket permite `INSERT` a `anon` (el comprador no tiene sesión) y **ningún `SELECT`**:
  las capturas llevan nombre y teléfono, y el equipo las abre con URL firmada.

**Paridad desktop ✅.** En móvil hay deep link `yape://`; en desktop no resuelve, así que
ese botón se oculta y manda el QR + el número copiable. Ninguna pantalla dice "ábrelo en
tu celular": el flujo entero se puede grabar desde una laptop.

## Métricas del módulo
- Tiempo landing→pedido, % de campos autocompletados por DNI, tasa de cierre por canal
  (`closedBy`), pedidos por vendedor (carga round-robin).

## Estándares
- El closer y el checkout deben **siempre** poblar `customer` y `sale` del
  `MerchantCustomerSession` (ver [00-CORE](./00-CORE-ARCHITECTURE.md)) para que Logística
  y Loyalty no re-pregunten datos.
- DNI: normalizar a 8 dígitos; nunca hardcodear `DECOLECTA_TOKEN`.

## Estado de la base de datos (costuras Sales en `order_sessions`)
`payment_method` (def `CONTRAENTREGA`) · `dispatch_type` (def `MOTORIZADO_LIMA`) ·
`agency_name` · `delivery_reference` · `closed_by` (def `DIRECT_CHECKOUT`). Todas
aditivas/nullable. `register-buyer` ya persiste `payment_method` + `closed_by`.

Fase 3 (bloque 13 de `setup-kross.sql`, todo aditivo): `checkout_id` (único, idempotencia) ·
`advance_amount` · `advance_voucher_url` · `advance_yape_code` · `payment_verification` ·
`payment_matched_at` · `payment_reason` · `payment_event_id`. Tabla nueva `payment_events`
y bucket privado `vouchers`. En `stores`: `yape_number`, `yape_holder`, `yape_qr_url`,
`yape_autoconfirm` (públicas: el checkout se las muestra al comprador). El token del
ingestor va aparte, en la tabla `store_secrets`, sin políticas.

## Endpoints / archivos de este módulo
- `supabase/functions/dni-lookup` — DNI → nombre (Decolecta/RENIEC). Secret `DECOLECTA_TOKEN`.
- `supabase/functions/register-buyer` — crea el pedido (idempotente por `checkout_id`);
  acepta `payment_method`, `closed_by` y el adelanto; cruza pagos ya recibidos.
- `supabase/functions/yape-ingest` — ingesta de pagos Yape. Auth por
  `store_secrets.payment_ingest_token` (cabecera `x-ingest-token`), **no** por anon key.
  Se despliega con **`--no-verify-jwt`**: quien llama es un automatizador en un celular,
  no un navegador con sesión, y su credencial es el token de tienda. Sin ese flag Supabase
  exige un JWT y la macro recibe 401 sin explicación.
  Acepta el cuerpo como **texto plano** (el cuerpo ES la notificación, `store_id` por query
  o cabecera) o como JSON. El texto plano es el recomendado para MacroDroid/Tasker:
  interpolar la notificación dentro de un JSON se rompe con una comilla o un salto de
  línea, y un 400 ahí significa **perder el pago en silencio** porque el automatizador no
  reintenta. Por eso un JSON malformado tampoco se rechaza: degrada a texto plano.
- `supabase/functions/_shared/yape.ts` — parser de la notificación (con tests).
- `supabase/functions/_shared/yape-match.ts` — regla de cruce pago ↔ pedido (con tests).
- `supabase/functions/elevenlabs-signed-url` — signed URL del agente. Secrets
  `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`.
- `src/lib/checkout-flow.ts` — state machine del quiz de checkout.
- `src/lib/useVoiceCloser.ts` — hook del Voice Closer (dormido sin agente).
- `src/lib/session.ts` — contrato `MerchantCustomerSession` (ver 00-CORE).

## Secrets / env pendientes de configurar
Backend: `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`. Frontend: `VITE_ELEVENLABS_AGENT_ID`
(sin esto el Voice Closer queda dormido, que es el estado esperado hasta crear el agente).

## Pendientes priorizados (dónde retomar)
0. 🔮 **Ajustes de Fase 2** (ver §1.b): sacar el DNI de Lima, invertir DNI↔nombre en
   provincia, copy del DNI y descuento de retención al salir. Antes de construir el
   descuento hay que decidir su disparador en móvil y su tope.
1. 🟡 **Fase 3 del checkout:** backend ✅ (esquema, `yape-ingest`, cruce en los dos
   sentidos, idempotencia). Falta la **UI del paso 3**: caja Yape con número/QR de la
   tienda, subida del comprobante con compresión, campo del código de seguridad,
   suscripción Realtime al veredicto y pantalla de confirmación.
2. 🟡 **Lead parcial (`DRAFT`)**: `save-checkout-draft` + tabla `checkout_drafts` ya
   existen y el checkout los llama. Falta **desplegar la función** y correr el SQL, y
   construir la vista de recuperación de abandonos para Ventas.
3. 🟡 **Verificación del yape**: el cruce está construido y el parser fijado contra el
   texto REAL de la notificación (§3.1). Falta **montar la fuente que lee la
   notificación** en el Android del dueño (MacroDroid hoy / APK propio después) y
   configurar `payment_ingest_token` de la tienda.
   La costura está en `services/PaymentVerificationService.ts` — el mock deja todo en
   `PENDING` a propósito: hasta que exista el real, todo adelanto va a revisión humana,
   que es lo que pasa hoy en producción.
4. 🔮 `createElevenLabsTransport()` (implementar `VoiceTransport` con `@elevenlabs/react`)
   + crear el agente en ElevenLabs → activar la voz.
5. 🔮 Cobro Yape/Plin integrado (QR dinámico / confirmación de operación).

### Pantalla final: por qué el chat va ahí

En esa pantalla la venta YA está cerrada, así que lo que se optimiza no es
conversión sino **tasa de entrega** — que en COD es donde se gana o se pierde
plata de verdad. Un pedido que no se recoge cuesta flete de ida, de vuelta y
producto inmovilizado, y la causa número uno es que **el cliente no reconoce
quién le escribe** cuando llega el mensaje de coordinación.

De ahí las tres decisiones:

1. El botón nombra el beneficio ("coordinar la entrega"), no la mecánica.
2. Debajo va el aviso de que por ahí le escribiremos: es la vacuna contra el
   "¿quién eres?" del día de la entrega.
3. Se ofrece, no se empuja. Nada de redirección automática —después de que
   entregó su plata se siente a arrebato— y "Listo" se queda para quien quiera
   cerrar.

El chat tiene que tener algo cuando llegue: el acuse `visibility: 'all'` del
cruce es el primer mensaje de la marca. Un chat vacío desperdicia el viaje y
enseña a no volver.

**No se premia entrar al chat.** Un descuento por abrirlo enseña que ahí se
regatea, y llena el canal de gente pidiendo rebaja en vez de coordinando.

**El KPI es % de pedidos entregados al primer intento**, no clics al chat. El
clic es un proxy: si sube el clic y no sube la entrega, el cambio no sirvió.

### El comprobante se queda opcional

Obligatorio ya está el código. Cada campo obligatorio en el último paso es una
puerta donde alguien se cae, y la captura es la más frágil: depende de salir de
Yape, encontrar la galería y volver. Además **no hace falta para cobrar** — el
cruce funciona solo con el código. La captura sirve cuando el cruce falla, y ahí
el problema suele ser nuestro (el lector caído), no del comprador: cobrarle a él
con fricción el seguro de nuestra falla está al revés.

## El checkout multi-paso es el default

Desde este cambio, la landing abre el checkout de 3 pasos. El viejo (`CheckoutQuiz`)
queda detrás de `?checkout=v1` **solo como escotilla**: si algo sale mal en
producción se vuelve al anterior cambiando la URL, sin esperar un deploy. No es un
experimento, es el botón de emergencia.

El motivo del cambio no es que el nuevo sea más bonito: el viejo **solo pedía
datos**. No tenía forma de llevar al comprador al chat del pedido, y de ahí sale la
tasa de entrega — el número que decide si un COD gana o pierde plata. Un checkout
que cierra la venta pero deja al cliente sin saber por dónde le van a escribir
optimiza la mitad del problema.

**Queda pendiente medirlo.** El cambio se hizo por criterio de producto, no con
datos comparados: si a las semanas la conversión cae, la escotilla está ahí. Borrar
`CheckoutQuiz` recién tiene sentido cuando haya números que respalden el cambio.

## La fricción del código de seguridad

En la primera venta real a un tercero hubo que **explicarle por chat qué es el
código de seguridad de Yape**. Una explicación que hay que dar por chat no
escala: el próximo comprador no tiene a quién preguntarle.

Era el único punto del checkout donde el comprador tenía que aprender algo
nuevo. La respuesta no fue más texto —ya había un hint y no alcanzó— sino
**reconocimiento**: una miniatura de la pantalla de "¡Yapeaste!" con los 3
dígitos resaltados. Casi todo peruano ya vio esa pantalla; no hay nada que leer,
se compara y listo. El rótulo del campo también dejó de usar el término técnico
("Código de seguridad de tu Yape" → "Los 3 números que te dio Yape").

### Por qué el código NO puede volverse opcional

`ADVANCE_PROVINCIA_PEN = 10` y Olva `= 20`: **todos** los pedidos de Shalom
piden exactamente S/10 y todos los de Olva S/20. El monto no distingue nada en
cuanto hay más de un pedido esperando — el código es lo único que decide. Hoy
funciona sin él por volumen bajo, no por diseño; a volumen, sin código todo
caería a revisión humana.

### La alternativa de fondo (sin implementar)

Reemplazar el código por **céntimos únicos por pedido**: pedir S/10.07 en vez de
S/10, donde los céntimos son el discriminador. Elimina el campo y el concepto —
el comprador solo copia un monto, que ya tiene que escribir de todas formas.
Riesgo: que redondee a S/10 por costumbre, lo que degrada a revisión humana. Es
un cambio de instrucción de cobro, así que es decisión de negocio.

## El canal es el chat, no WhatsApp

La pantalla final prometía "Te escribimos por WhatsApp". **No es así**: WhatsApp
es el *fallback* para cuando el comprador no entra al chat del pedido.
Prometerlo mandaba a esperar por donde no escribimos primero, y de paso dejaba
el chat —que es lo que sostiene la tasa de entrega— sonando a algo secundario.

## "Ver mi pedido" en la landing

Al tocar "Listo" y cerrarse la ventana de confirmación, el comprador se quedaba
en la landing **sin ninguna vía de volver a su pedido**: el token vivía solo en
memoria del modal. Feedback de compradores reales.

Ahora el token se guarda en `localStorage` (`saveLastOrder`) y la barra inferior
ofrece **"Ver mi pedido"** junto a "¡Lo quiero!", en estilo secundario: la
landing sigue siendo para vender, no para dar seguimiento. Caduca a los 3 días
—después la entrega ya ocurrió y un botón viejo solo confunde— y un storage
corrupto o el modo incógnito no rompen nada.

## No hay botón de "Abrir Yape"

Hubo uno, con `yape://`, y estaba **muerto en producción**: era un esquema
supuesto que nunca se verificó contra la app real. No se reintenta con
`intent://` por tres razones:

1. **Chrome Android** no abre esquemas custom desde un `<a href>` normal; exige
   `intent://` con nombre de paquete, que habría que confirmar en un equipo.
2. **iOS**: si la app no declaró el esquema, Safari muestra su pantalla de error
   — un callejón sin salida *justo en el paso del cobro*, y no hay forma
   confiable de detectar el fallo antes de intentarlo.
3. **Aunque abriera**, cae en la pantalla de inicio de Yape: **no puede
   pre-llenar número ni monto**, porque eso requiere el deep link de pago
   comercial (Yape Empresas), no un esquema público.

O sea: ahorraba un cambio de app a cambio de arriesgar la venta. **Copiar el
número funciona siempre, en los dos sistemas**, y ahora es la acción única y a
todo el ancho — una acción confiable vale más que dos donde una falla.

Si algún día Kross accede al deep link de pago oficial, ahí sí vale la pena: ese
sí llega con monto y destinatario puestos, que es el único caso donde el botón
justifica su riesgo.
## Visor de comprobantes

El bucket `vouchers` es privado y sin política de lectura, a propósito: una
captura de Yape lleva nombre, teléfono parcial y número de operación. Pero eso
dejaba al equipo **viendo la advertencia del cruce sin poder resolverla** — "el
nombre no coincide" no sirve de nada si no puedes abrir la captura.

La función `voucher-url` es la única puerta:

- comprueba que quien pide sea vendedor **de la tienda dueña del pedido** (sin
  ese cruce, cualquier vendedor de cualquier marca leería los comprobantes de
  las demás con solo tener el id de un pedido);
- devuelve una URL firmada de **5 minutos**, que no se guarda ni se precarga —
  se pide solo cuando alguien decide mirarla;
- si no hay comprobante responde `200` con `url: null`, no un error: la mayoría
  de pedidos cuadra por código y nunca sube captura.

`AdvancePanel` lo muestra en el chat del vendedor, arriba de la dirección
—porque si el adelanto no cuadró, eso decide si se despacha— junto al estado del
cruce y su motivo literal.

**`get-session` filtra por rol.** `payment_reason` (el veredicto interno) y
`advance_voucher_url` (la ruta privada) se eliminan de la respuesta cuando el
que mira es el comprador. Da igual que la UI no los pinte: viajan en la
respuesta y quedan a la vista de cualquiera que abra la pestaña de red. Es la
misma fuga que ya se corrigió en los mensajes del chat, y por eso el filtro vive
en el backend y no en el componente.
## Etapa `validando` y confirmación automática

Un pedido con adelanto quedaba en **"Pedido"** desde que el comprador pagaba
hasta que alguien lo confirmaba: **pagó y su barra no se movía**. Sin señal de
avance, su siguiente paso es escribir "¿llegó mi pago?" — justo el mensaje que
este checkout existe para evitar.

- **Con adelanto** el pedido nace en `validando`, entre `nuevo` y `confirmado`.
- **Sin adelanto** (Lima, contraentrega puro) nace **`confirmado`**: no hay nada
  que validar, y mostrarle un paso pendiente que nunca va a ocurrir se lee como
  que algo se atascó.
- **Un cruce confirmado mueve a `confirmado`, sin flag de por medio.** Estaba
  detrás de `yape_autoconfirm` para medir primero cuánto acierta el cruce, pero
  eso dejaba al comprador con el dinero cobrado y la barra quieta.

**Las advertencias no frenan el avance.** Nombre distinto o código que no calza
quedan en `payment_reason` y en el mensaje interno, para que Ventas las revise
**antes de despachar** — que es el momento donde importan. Frenar la barra por
una advertencia le traslada al comprador una duda que es nuestra.

**El stepper se arma según el pedido** (`lib/order-stages.ts`, única definición
del orden: estaba copiado en seis archivos). Ventas sí ve `validando` siempre,
porque necesita distinguir un pedido que espera cruce de uno recién creado.

## Respuestas rápidas en el chat

Fichas tocables encima del campo de texto, al estilo de las plantillas de
WhatsApp. Hacen dos cosas a la vez: **bajan el costo de la primera
interacción** —escribirle de cero a un desconocido cuesta más que tocar un
botón— y **le enseñan que este chat es donde se resuelve su pedido**, que es lo
que sostiene la tasa de entrega.

**Se derivan del estado, no se guardan en la base.** Guardadas por mensaje
quedarían obsoletas: "¿Ya llegó mi pago?" seguiría ofreciéndose una semana
después de que el pago cuadró. Así la ficha siempre corresponde a lo que le pasa
al pedido ahora.

**Desaparecen en cuanto el comprador escribe.** Ya cumplieron su trabajo, y
dejarlas para siempre convierte la ayuda en estorbo sobre el teclado.

En `validando` la segunda ficha es **"Te envío mi comprobante"**: así la captura
se pide **solo a quien puede hacer falta**, en el momento en que importa, en vez
de pedírsela a todos por si acaso en el checkout.

## El código manda sobre el monto

Caso real (31-jul-2026): un comprador tecleó **195**, su pedido esperaba **S/10**, y
yapeó **S/0.50** con ese mismo código. El algoritmo filtraba por monto **antes** de mirar
el código, así que pago y pedido quedaron **huérfanos** — nadie podía saber que iban
juntos, ni siquiera mirándolos uno al lado del otro.

El código de seguridad es la evidencia más fuerte que existe: **el comprador lo teclea
ANTES de pagar**, así que no puede fabricarse a posteriori. Filtrar por monto primero la
desperdiciaba. Ahora el código se busca en **todos** los pedidos pendientes.

**Identificar no es cobrar.** Cuando el código calza pero el monto no:

- el pago **se enlaza** al pedido, para que Ventas los vea juntos en vez de tener dos
  huérfanos;
- `payment_verification` queda en **`PENDING`** y el pedido **no** pasa a `confirmado`:
  falta plata, y despachar sin cobrarla es regalar mercadería;
- el mensaje interno dice *"Pagó S/0.50 de los S/10 esperados. Falta cobrar la
  diferencia"*;
- **al comprador NO se le manda el acuse.** Decirle "recibimos tu adelanto" cuando pagó
  de menos lo deja creyendo que ya está, y el problema aparece recién en la puerta.

**Sin código no se cruzan montos distintos.** Ahí no hay evidencia de que vayan juntos:
un monto distinto es simplemente otro pago, y enlazarlos sería adivinar.

### Y el código se le muestra a Ventas

El panel del adelanto decía "sin comprobante adjunto" y ahí se acababa la ayuda. Ahora
muestra **los 3 dígitos que tecleó el comprador**: es lo único accionable cuando el cruce
automático no llega, porque con eso se busca el pago en la app de Yape sin depender de
nadie.

## El primer mensaje del chat dice el estado del pago ✅

El comprador acaba de yapear y tiene **una sola duda**: si su plata llegó. El
mensaje de bienvenida no la respondía, así que la única salida que le quedaba
era escribirle al vendedor por WhatsApp — justo lo que este chat existe para
evitar.

Ahora el saludo cierra con:

> ⏳ Estamos validando tu adelanto de S/10. Te aviso por aquí apenas cuadre.

**Siempre "estamos validando", nunca "ya está confirmado".** El cruce corre más
abajo en la misma función, así que a esa altura todavía no se sabe. Y no es un
consuelo: cuando cuadra, el propio cruce manda su *"✅ ¡Recibimos tu adelanto!"*
segundos después, y el comprador **ve el sistema trabajando en vivo** en lugar de
leer un estado ya resuelto.

Si no cruza, ese mensaje se queda como la única versión de los hechos — y dice
que lo estamos validando **nosotros**. Nunca que su pago no existe: en la mayoría
de esos casos el fallo es del lector, no suyo.

También se agregó *"escríbeme por aquí cualquier duda"* al mensaje de
**provincia**, que no lo tenía. Estaba solo en Lima, y era en provincia —donde el
comprador ya adelantó plata y espera días— donde más falta hacía decirle cuál es
el canal.
