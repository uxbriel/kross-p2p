# 00 · CORE ARCHITECTURE — Base de datos, Autenticación y Panel Admin

> Módulo base del **Sistema Operativo de E-commerce Perú (Kross)**. Todo lo demás
> (Sales, Logistics, Loyalty) se apoya en lo que aquí se define. Antes de tocar otro
> módulo, respeta estos estándares.
>
> Leyenda: ✅ construido · 🟡 parcial · 🔮 planeado

## Rol del módulo

Provee: multi-tenancy white-label, autenticación de equipo, panel de administración y
el **estado central del cliente** (`MerchantCustomerSession`) que los tres módulos leen
y actualizan.

## Stack ✅

- **Frontend:** React 19 + Vite + TypeScript + Tailwind CSS 4. Deploy en Vercel.
- **Backend:** Supabase — Postgres + RLS, Edge Functions (Deno), Storage (buckets
  públicos `branding` y `products`, privado `call-recordings`), Realtime (broadcast).
  Las imágenes que sube el panel se reducen en el navegador antes de subirlas
  (`src/lib/images/downscale.ts`): el comprador las descarga en 4G.
- **Multi-tenant:** subdominio → tienda vía `src/lib/store-context.tsx`
  (`marca.krossclub.app`). `isPlatformHost()` separa la plataforma de una marca.
  Branding por marca con variable CSS `--brand`.

## Autenticación & roles ✅

- **Supabase Auth** para el equipo (`sellers.auth_user_id`).
- **Super Admin (plataforma Kross):** `sellers.is_super_admin`. Solo ve "Marcas" y
  **Entra** a una marca para operarla (impersonación `acting`/`effective` en
  `src/lib/seller-session.ts`).
- **Admin de tienda:** `is_admin`, scoped a su `store_id`.
- **Roles de equipo (`role_label`):** Ventas · Logística · Soporte · Motorizado.
- **Comprador:** identificado por DNI/teléfono (`buyers`), sin login de contraseña; entra
  por su subdominio (`/acceso`). NO hay login de comprador en el host de plataforma.

### Identidad del comprador: DNI vs. teléfono ✅ (implementado)

`buyers` tiene **dos** índices únicos por tienda: `(store_id, document_number)` y
`(store_id, phone)`. O sea que el teléfono **ya es** una llave de identidad válida, y
`register-buyer` ya trae la rama que crea la cuenta solo con teléfono. No hace falta
tocar el esquema para dejar de pedir DNI.

**Decisión de producto (jul-2026):** el DNI se pide **solo en provincia**, no en Lima.
La asimetría es real y no arbitraria:

| | Lima | Provincia |
|---|---|---|
| Dinero por adelantado | no (COD puro) | sí (adelanto de flete) |
| ¿Quién absorbe el no-recibido? | el motorizado, en el momento | la marca, ya pagó el envío |
| ¿Alguien más exige el DNI? | nadie | **la agencia, para entregar el paquete** |

✅ **Confirmado con operaciones:** Shalom y Olva exigen DNI del destinatario para liberar
el paquete. En provincia el campo no es burocracia nuestra sino de ellos, y el copy lo
dice así porque es un motivo que el comprador acepta sin discutir.

**Riesgos de identificar solo por teléfono, con los ojos abiertos:**
- En Perú los números se reciclan: alguien podría heredar el historial y los puntos de otro.
- Una familia comparte un número → historiales que se mezclan.
- El `score` del comprador pierde filo: quien no recibe pedidos cambia de número y vuelve.

**Mitigación propuesta 🔮 — captura diferida del DNI.** Lima cierra la venta solo con
teléfono, y el DNI se pide **después**, en el chat del pedido, cuando le sirve al comprador:
para ver "Mis pedidos", acumular puntos o reclamar la recompensa de bienvenida. Deja de ser
un peaje antes de comprar y pasa a ser lo que desbloquea un beneficio. Es el mismo patrón
que ya se aplicó al pin de ubicación (ver [02-LOGISTICS §4](./02-SMART-LOGISTICS.md)).
La infraestructura ya existe: `buyer-login` resuelve por `document_number`, y `ScorePage`
y `MisPedidosPage` son justamente las pantallas que lo justifican.

## Modelo de datos (núcleo) ✅

- `stores` — una marca por fila: branding, slug, `active`, config WhatsApp (`wa_*`),
  retención (`welcome_points`, `points_rate`, `restock_days`, `winback_days`).
- `sellers` — equipo: `role_label`, `is_admin`, `is_super_admin`, `available`.
- `buyers` — clientes: `document_number`, `phone`, `nombre`, `score`, `puntos`,
  `address_lat/lng/verified`, `source`, `activated_at`.
- `order_sessions` — pedidos: `stage` (`nuevo→confirmado→preparando→en_camino→entregado`),
  `assigned_seller_id`, `product_price`, `items`, `token` público.
- `chat_messages`, `push_subscriptions`, `notifications_log`, `call_recordings`.

## Panel Admin ✅

Edge Function `manage-store` (list/create/update/wa_usage/client_stats). El super admin
crea marcas + su primer admin sin SQL. Navegación por rol en `src/components/BottomNav.tsx`.

## Estado central compartido — `MerchantCustomerSession`

Contrato conceptual que unifica los tres módulos. Hoy vive **distribuido** en las tablas
`buyers` + `order_sessions` (no como un único objeto), pero esta es la forma canónica que
todo módulo debe poder leer/escribir:

```typescript
type MerchantCustomerSession = {
  customer:  { dni: string; fullName: string; phone: string }
  delivery:  { lat: number; lng: number; addressText: string; reference: string
               dispatchType: 'MOTORIZADO_LIMA' | 'AGENCIA_PROVINCIA'
               agencyName?: 'SHALOM' | 'OLVA' | 'OTRO' }
  sale:      { productId: string
               paymentMethod: 'YAPE_PLIN' | 'CONTRAENTREGA' | 'TARJETA'
               closedBy: 'AI_CLOSER' | 'DIRECT_CHECKOUT' }
  // Adelanto por Yape (provincia). Sales lo cobra y lo cruza; Logistics decide
  // con él si despacha. Por eso vive en el contrato y no dentro de Sales.
  advance:   { amountPen: number            // 0 en Lima, 10 Shalom, 20 Olva
               verification: 'NOT_REQUIRED' | 'PENDING' | 'MATCHED'
               yapeCode?: string            // 3 dígitos tecleados por el comprador
               voucherPath?: string         // ruta en el bucket PRIVADO `vouchers`
               reason?: string }            // veredicto interno — NUNCA al comprador
  stage:     'nuevo' | 'validando' | 'confirmado' | 'preparando' | 'en_camino' | 'entregado'
  loyalty:   { pointsEarned: number; nextReorderDate: Date }
}
```

**Tres reglas del bloque `advance` que cruzan módulos y no se negocian por pantalla:**

1. **`reason` y `voucherPath` no salen del backend hacia el comprador.** `reason` es el
   veredicto interno ("el nombre no coincide") y `voucherPath` apunta a un bucket privado.
   `get-session` los elimina de la respuesta cuando el que mira no es vendedor. Da igual
   que la UI no los pinte: viajan en el JSON y se ven en la pestaña de red.
2. **El comprobante nunca se sirve como URL directa.** Se pide firmado a la Edge Function
   `voucher-url`, que valida que el vendedor sea de la tienda dueña del pedido.
3. **`stage` avanza solo con el cruce**, y las advertencias no lo frenan: el pago entró,
   la duda es de operaciones. Ver `01-SALES-ENGINE.md`.

Lector único: **`src/lib/session.ts` → `toCustomerSession(order, buyer)`** ensambla este
objeto desde `order_sessions` + `buyers`. Todos los módulos leen la sesión por ahí.

Mapeo actual → objetivo:
| Campo | Hoy | Estado |
|---|---|---|
| `customer.*` | `buyers.document_number/nombre/phone` | ✅ |
| `delivery.lat/lng/addressText` | `order_sessions.address_*` / `buyers.address_*` | ✅ |
| `delivery.reference` | `order_sessions.delivery_reference` (columna lista, sin UI aún) | 🟡 |
| `delivery.dispatchType` | `order_sessions.dispatch_type` (def `MOTORIZADO_LIMA`) | ✅ |
| `delivery.agencyName` | `order_sessions.agency_name` (columna lista, provincia pendiente) | 🟡 |
| `sale.paymentMethod` | `order_sessions.payment_method` (def `CONTRAENTREGA`) — escrito por checkout | ✅ |
| `sale.closedBy` | `order_sessions.closed_by` (def `DIRECT_CHECKOUT`) — escrito por checkout | ✅ |
| `advance.amountPen` | `order_sessions.advance_amount` — lo deriva el checkout del destino | ✅ |
| `advance.verification` | `order_sessions.payment_verification` — la cruza `yape-ingest` | ✅ |
| `advance.yapeCode` | `order_sessions.advance_yape_code` | ✅ |
| `advance.voucherPath` | `order_sessions.advance_voucher_url` (bucket privado) | ✅ |
| `advance.reason` | `order_sessions.payment_reason` — solo Ventas | ✅ |
| `stage` | `order_sessions.stage` — orden en `src/lib/order-stages.ts` | ✅ |
| `loyalty.points` | `buyers.puntos` | ✅ |
| `loyalty.nextReorderDate` | derivado de `restock_days` en campañas | 🟡 |

## Estándares del módulo

- Toda Edge Function: CORS + validación de entrada + service role para escribir.
- RLS activo; el frontend no lee tablas sensibles directo, invoca funciones.
- Nunca secrets/tokens en código, commits ni chat.
- Cambios de datos que afecten a otro módulo → actualizar aquí el contrato primero.

## Ver también
- Capa estratégica: [`ICP Sales`](./ICP%20Sales/) y [`ICP LTV`](./ICP%20LTV/).
- Módulos: [01-SALES](./01-SALES-ENGINE.md) · [02-LOGISTICS](./02-SMART-LOGISTICS.md) · [03-LOYALTY](./03-LOYALTY-ENGINE.md).
