-- ============================================================================
--  KROSS — SETUP COMPLETO
--  Pega TODO esto en Supabase → SQL Editor → RUN.
--  Es idempotente: puedes correrlo las veces que quieras, no rompe nada.
-- ============================================================================

-- ─── 0. TIENDAS (multi-tenant / white-label) ────────────────────────────────
-- Cada marca es una tienda con su subdominio (marca.kross.app), logo y colores.
CREATE TABLE IF NOT EXISTS stores (
  id            text        PRIMARY KEY,          -- = order_sessions.store_id / sellers.store_id
  slug          text        UNIQUE NOT NULL,      -- subdominio: <slug>.kross.app
  nombre        text        NOT NULL,
  logo_url      text,
  color_primary text        DEFAULT '#55C8F5',
  color_dark    text        DEFAULT '#060C1A',
  active        boolean     DEFAULT true,
  created_at    timestamptz DEFAULT now()
);
ALTER TABLE stores ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS stores_read ON stores;
CREATE POLICY stores_read ON stores FOR SELECT TO public USING (true);

-- Fallback por WhatsApp (Cloud API). Un token global (WHATSAPP_TOKEN, secret) +
-- el phone_number_id de cada marca → cada tienda envía desde su propio número.
-- Mientras wa_enabled sea false o falte el token, el fallback es no-op (no envía).
ALTER TABLE stores ADD COLUMN IF NOT EXISTS wa_enabled         boolean DEFAULT false;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS wa_phone_number_id text;   -- ID del número en WhatsApp Cloud API
ALTER TABLE stores ADD COLUMN IF NOT EXISTS wa_display_phone   text;   -- número visible de la marca (informativo)
ALTER TABLE stores ADD COLUMN IF NOT EXISTS wa_business_account_id text; -- WABA ID (para listar plantillas)

-- Ícono de notificación (PNG transparente/circular). Se muestra en los push como
-- el ícono de la tienda. Si falta, cae al logo.
ALTER TABLE stores ADD COLUMN IF NOT EXISTS notif_icon_url     text;

-- Retención: recompensa de bienvenida al reclamar (puntos) + mensaje.
ALTER TABLE stores ADD COLUMN IF NOT EXISTS welcome_points     integer DEFAULT 0;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS welcome_msg        text;
-- Canje de puntos: cuánto vale 1 punto en soles (0 = canje desactivado).
ALTER TABLE stores ADD COLUMN IF NOT EXISTS points_rate        numeric DEFAULT 0;
-- Retención Fase 3: ventanas de campaña (días desde la última entrega)
ALTER TABLE stores ADD COLUMN IF NOT EXISTS restock_days       integer DEFAULT 30;  -- reponer consumible
ALTER TABLE stores ADD COLUMN IF NOT EXISTS winback_days       integer DEFAULT 60;  -- cliente inactivo

-- Compradores pasan a ser por tienda (un cliente de una marca no es de otra)
ALTER TABLE buyers ADD COLUMN IF NOT EXISTS store_id text;
-- El mismo DNI puede existir en varias marcas → unicidad POR TIENDA, no global
DROP INDEX IF EXISTS idx_buyers_document_number;
DROP INDEX IF EXISTS idx_buyers_phone;
CREATE UNIQUE INDEX IF NOT EXISTS idx_buyers_store_doc   ON buyers(store_id, document_number);
CREATE UNIQUE INDEX IF NOT EXISTS idx_buyers_store_phone ON buyers(store_id, phone);

-- ─── 1. COMPRADORES (identificados por DNI) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS buyers (
  id              uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  document_type   text        NOT NULL DEFAULT 'DNI'
                              CHECK (document_type IN ('DNI','CE','PASAPORTE')),
  document_number text,        -- DNI: llave permanente del comprador
  phone           text,        -- respaldo (puede cambiar)
  nombre          text,
  address         text,
  score           integer     DEFAULT 50,
  puntos          integer     DEFAULT 0,
  created_at      timestamptz DEFAULT now()
);

-- Por si la tabla ya existía de una versión anterior sin estas columnas:
ALTER TABLE buyers ADD COLUMN IF NOT EXISTS document_number text;
ALTER TABLE buyers ADD COLUMN IF NOT EXISTS document_type   text NOT NULL DEFAULT 'DNI';
ALTER TABLE buyers ADD COLUMN IF NOT EXISTS phone           text;
ALTER TABLE buyers ADD COLUMN IF NOT EXISTS nombre          text;
ALTER TABLE buyers ADD COLUMN IF NOT EXISTS address         text;
ALTER TABLE buyers ADD COLUMN IF NOT EXISTS score           integer DEFAULT 50;
ALTER TABLE buyers ADD COLUMN IF NOT EXISTS puntos          integer DEFAULT 0;
-- Llamadas salientes del comprador: solo para clientes TOP (se activa a mano)
ALTER TABLE buyers ADD COLUMN IF NOT EXISTS can_call        boolean DEFAULT false;
-- Retención: de dónde vino el comprador y si ya reclamó su recompensa de bienvenida
ALTER TABLE buyers ADD COLUMN IF NOT EXISTS source          text DEFAULT 'order';   -- 'order' | 'import'
ALTER TABLE buyers ADD COLUMN IF NOT EXISTS welcome_granted boolean DEFAULT false;
ALTER TABLE buyers ADD COLUMN IF NOT EXISTS activated_at    timestamptz;            -- primer login del cliente
ALTER TABLE buyers ADD COLUMN IF NOT EXISTS invited_at      timestamptz;            -- última invitación masiva enviada
ALTER TABLE buyers ADD COLUMN IF NOT EXISTS last_campaign_at timestamptz;            -- última campaña de retención (cooldown 7d)

-- Acciones de gamificación completadas (para subir el score)
CREATE TABLE IF NOT EXISTS buyer_actions (
  id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  buyer_id   uuid REFERENCES buyers(id),
  action_key text NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE (buyer_id, action_key)
);

-- Únicos COMPLETOS (permiten varios NULL, pero no duplican DNI ni teléfono).
-- Deben ser índices únicos completos — NO parciales — para que el upsert
-- "onConflict: document_number / phone" de las Edge Functions funcione.
CREATE UNIQUE INDEX IF NOT EXISTS idx_buyers_document_number ON buyers(document_number);
CREATE UNIQUE INDEX IF NOT EXISTS idx_buyers_phone           ON buyers(phone);

-- Contienen PII (DNI/teléfono): solo las Edge Functions (service role) las tocan.
ALTER TABLE buyers        ENABLE ROW LEVEL SECURITY;
ALTER TABLE buyer_actions ENABLE ROW LEVEL SECURITY;


-- ─── 2. VENDEDORES (ligados a usuarios de Supabase Auth) ────────────────────
CREATE TABLE IF NOT EXISTS sellers (
  id            uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  auth_user_id  uuid        UNIQUE,        -- = auth.users.id
  store_id      text        NOT NULL,
  nombre        text        NOT NULL,
  role_label    text        NOT NULL DEFAULT 'Ventas',
  avatar_url    text,
  active        boolean     DEFAULT true,
  created_at    timestamptz DEFAULT now()
);

ALTER TABLE sellers ADD COLUMN IF NOT EXISTS avatar_url text;
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS active     boolean DEFAULT true;
-- Turno on/off: si está en false, no recibe pedidos nuevos ni de sus clientes recurrentes
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS available  boolean DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_sellers_auth  ON sellers(auth_user_id);
CREATE INDEX IF NOT EXISTS idx_sellers_store ON sellers(store_id);


-- ─── 3. PEDIDOS (order_sessions) — columnas nuevas ──────────────────────────
ALTER TABLE order_sessions ADD COLUMN IF NOT EXISTS buyer_id      uuid REFERENCES buyers(id);
ALTER TABLE order_sessions ADD COLUMN IF NOT EXISTS address       text;
ALTER TABLE order_sessions ADD COLUMN IF NOT EXISTS seller_name   text;
ALTER TABLE order_sessions ADD COLUMN IF NOT EXISTS seller_role   text;
ALTER TABLE order_sessions ADD COLUMN IF NOT EXISTS seller_avatar text;

CREATE INDEX IF NOT EXISTS idx_order_sessions_buyer_id ON order_sessions(buyer_id);


-- ─── 4. NOTIFICACIONES push por cuenta de comprador ─────────────────────────
ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS buyer_id uuid REFERENCES buyers(id);
CREATE INDEX IF NOT EXISTS idx_push_subs_buyer_id ON push_subscriptions(buyer_id, sub_role);
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY; -- solo service role (Edge Functions)

-- Bitácora de notificaciones: qué se intentó por push y si cayó a WhatsApp.
-- Sirve para medir cobertura de push vs. costo de WhatsApp por tienda.
CREATE TABLE IF NOT EXISTS notifications_log (
  id         uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  store_id   text,
  buyer_id   uuid,
  session_id text,
  kind       text,       -- 'message' | 'call' | 'status'
  push_count integer     DEFAULT 0,
  whatsapp   text,       -- 'sent' | 'skipped' | 'failed' | 'not_needed'
  detail     text,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE notifications_log ENABLE ROW LEVEL SECURITY; -- solo service role (Edge Functions)
CREATE INDEX IF NOT EXISTS idx_notiflog_store ON notifications_log(store_id, created_at DESC);

-- Grabaciones de llamadas (LiveKit Egress → Storage privado). El admin las escucha
-- desde el panel vía URLs firmadas que genera una Edge Function.
CREATE TABLE IF NOT EXISTS call_recordings (
  id           uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  store_id     text,
  session_id   text,
  egress_id    text,
  room_name    text,
  caller_role  text,       -- 'seller' | 'buyer'
  caller_name  text,
  buyer_name   text,
  file_path    text,       -- ruta dentro del bucket call-recordings
  duration_sec integer,
  status       text        DEFAULT 'recording',  -- 'recording' | 'done' | 'failed'
  created_at   timestamptz DEFAULT now()
);
ALTER TABLE call_recordings ENABLE ROW LEVEL SECURITY; -- solo service role
CREATE INDEX IF NOT EXISTS idx_callrec_store   ON call_recordings(store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_callrec_session ON call_recordings(session_id);

-- Bucket PRIVADO para los audios (acceso solo por URL firmada del admin)
INSERT INTO storage.buckets (id, name, public) VALUES ('call-recordings', 'call-recordings', false)
ON CONFLICT (id) DO NOTHING;


-- ─── 5. FOTOS DE PERFIL de vendedores (Storage) ─────────────────────────────
INSERT INTO storage.buckets (id, name, public)
VALUES ('avatars', 'avatars', true)
ON CONFLICT (id) DO NOTHING;

-- Sin SELECT policy: el bucket es público (URL pública funciona igual) pero
-- nadie puede listar su contenido completo desde el cliente.
DROP POLICY IF EXISTS "avatars_read"   ON storage.objects;
DROP POLICY IF EXISTS "avatars_upload" ON storage.objects;
CREATE POLICY "avatars_upload" ON storage.objects
  FOR INSERT TO authenticated WITH CHECK  (bucket_id = 'avatars');
DROP POLICY IF EXISTS "avatars_update" ON storage.objects;
CREATE POLICY "avatars_update" ON storage.objects
  FOR UPDATE TO authenticated USING       (bucket_id = 'avatars');


-- ─── 5a. PRODUCTOS (landing por imágenes que sube el admin) ─────────────────
CREATE TABLE IF NOT EXISTS products (
  id         uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  store_id   text,
  nombre     text        NOT NULL,
  precio     numeric     DEFAULT 0,
  images     text[]      DEFAULT '{}',   -- imágenes de la landing (full-bleed, en orden)
  packs      jsonb       DEFAULT '[]',   -- [{ nombre, descripcion, precio, image? }]
  active     boolean     DEFAULT true,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS products_read ON products;
CREATE POLICY products_read ON products FOR SELECT TO public USING (true);

-- Bucket para las imágenes de producto (lectura pública, sube el vendedor autenticado)
INSERT INTO storage.buckets (id, name, public) VALUES ('products', 'products', true)
ON CONFLICT (id) DO NOTHING;
DROP POLICY IF EXISTS products_img_read   ON storage.objects; -- sin listado público del bucket
DROP POLICY IF EXISTS products_img_upload ON storage.objects;
CREATE POLICY products_img_upload ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'products');
DROP POLICY IF EXISTS products_img_update ON storage.objects;
CREATE POLICY products_img_update ON storage.objects FOR UPDATE TO authenticated USING (bucket_id = 'products');


-- ─── 5c. BRANDING (logos de cada marca — onboarding de tiendas) ─────────────
INSERT INTO storage.buckets (id, name, public) VALUES ('branding', 'branding', true)
ON CONFLICT (id) DO NOTHING;
DROP POLICY IF EXISTS branding_read   ON storage.objects; -- sin listado público del bucket
DROP POLICY IF EXISTS branding_upload ON storage.objects;
CREATE POLICY branding_upload ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'branding');
DROP POLICY IF EXISTS branding_update ON storage.objects;
CREATE POLICY branding_update ON storage.objects FOR UPDATE TO authenticated USING (bucket_id = 'branding');


-- ─── 5b. CADENA DE VALOR: participación en el chat ──────────────────────────
-- involved_seller_ids: todos los agentes que han estado en el pedido (ven el chat)
-- writer_seller_ids:   quiénes pueden escribir/llamar ahora (dueño actual + invitados)
-- sender_role_label:   rol del que envió cada mensaje (para el distintivo en el chat)
ALTER TABLE order_sessions ADD COLUMN IF NOT EXISTS involved_seller_ids uuid[] DEFAULT '{}';
ALTER TABLE order_sessions ADD COLUMN IF NOT EXISTS writer_seller_ids   uuid[] DEFAULT '{}';
-- Invitados EXPLÍCITOS (para el chip bar) + quién invitó a cada uno (para expulsar)
ALTER TABLE order_sessions ADD COLUMN IF NOT EXISTS invited_seller_ids  uuid[] DEFAULT '{}';
ALTER TABLE order_sessions ADD COLUMN IF NOT EXISTS invited_by          jsonb  DEFAULT '{}';
ALTER TABLE chat_messages  ADD COLUMN IF NOT EXISTS sender_role_label   text;
-- Visibilidad del mensaje de sistema: 'all' (comprador y vendedores) o 'sellers'
ALTER TABLE chat_messages  ADD COLUMN IF NOT EXISTS visibility          text DEFAULT 'all';

-- Producto del pedido (para ver sus imágenes de la landing en el detalle)
ALTER TABLE order_sessions ADD COLUMN IF NOT EXISTS product_id uuid;
-- Carrito multi-producto: [{ product_id, nombre, precio, pack_name }]. product_price = total del pedido
ALTER TABLE order_sessions ADD COLUMN IF NOT EXISTS items jsonb DEFAULT '[]';

-- Dirección verificada a nivel de comprador (aplica a todos sus pedidos)
ALTER TABLE buyers ADD COLUMN IF NOT EXISTS address_lat      double precision;
ALTER TABLE buyers ADD COLUMN IF NOT EXISTS address_lng      double precision;
ALTER TABLE buyers ADD COLUMN IF NOT EXISTS address_verified boolean DEFAULT false;
-- Nota/sub-tag del CRM: cancelado, no_contesta, recuperado, anulado…
ALTER TABLE order_sessions ADD COLUMN IF NOT EXISTS nota text;
-- Oferta de upsell adjunta a un mensaje del chat
ALTER TABLE chat_messages  ADD COLUMN IF NOT EXISTS offer jsonb;

-- Dirección de entrega + validación por GPS del comprador
ALTER TABLE order_sessions ADD COLUMN IF NOT EXISTS address_lat      double precision;
ALTER TABLE order_sessions ADD COLUMN IF NOT EXISTS address_lng      double precision;
ALTER TABLE order_sessions ADD COLUMN IF NOT EXISTS address_verified boolean DEFAULT false;

-- ─── COSTURAS DEL ESTADO CENTRAL (MerchantCustomerSession) ───────────────────
-- Columnas-costura para conectar los 3 módulos sin refactor. Aditivas y con default
-- seguro para el MVP (todo es COD / motorizado Lima / cierre directo hasta que exista
-- el pago integrado, provincia o el AI closer). Ver docs/00-CORE-ARCHITECTURE.md.
ALTER TABLE order_sessions ADD COLUMN IF NOT EXISTS payment_method text DEFAULT 'CONTRAENTREGA'; -- YAPE_PLIN | CONTRAENTREGA | TARJETA
ALTER TABLE order_sessions ADD COLUMN IF NOT EXISTS dispatch_type  text DEFAULT 'MOTORIZADO_LIMA'; -- MOTORIZADO_LIMA | AGENCIA_PROVINCIA
ALTER TABLE order_sessions ADD COLUMN IF NOT EXISTS agency_name    text;                          -- SHALOM | OLVA | OTRO (solo provincia)
ALTER TABLE order_sessions ADD COLUMN IF NOT EXISTS delivery_reference text;                      -- referencia de la puerta
ALTER TABLE order_sessions ADD COLUMN IF NOT EXISTS closed_by      text DEFAULT 'DIRECT_CHECKOUT'; -- AI_CLOSER | DIRECT_CHECKOUT


-- ─── 6. PERMISOS (RLS) sobre sellers ────────────────────────────────────────
-- Los compradores nunca leen 'sellers' directo (van por Edge Functions con
-- service role, que ignora RLS). Aquí solo permitimos que la app de vendedor
-- lea nombres y que cada vendedor edite su propia fila (para su foto).
ALTER TABLE sellers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sellers_read" ON sellers;
CREATE POLICY "sellers_read" ON sellers
  FOR SELECT TO public USING (true);

DROP POLICY IF EXISTS "sellers_self_update" ON sellers;
CREATE POLICY "sellers_self_update" ON sellers
  FOR UPDATE TO authenticated USING (auth_user_id = auth.uid());


-- ─── 8. ADMIN / DUEÑO (uxbriel) ─────────────────────────────────────────────
-- Columna que marca quién es administrador (ve a TODO el equipo y puede
-- "entrar como" cualquier miembro). Los admin NO reciben pedidos nuevos.
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS is_admin boolean DEFAULT false;
-- Super admin = dueño de la PLATAFORMA (Kross). Puede dar de alta marcas nuevas
-- (crear tienda + su primer admin) y editar el branding de cualquier tienda.
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS is_super_admin boolean DEFAULT false;

-- Tienda de la PLATAFORMA (Kross HQ). NO es una marca visible: es la "casa" del
-- super admin, separada de las marcas de clientes. Id dedicado 'platform'.
INSERT INTO stores (id, slug, nombre, color_primary, color_dark, active)
VALUES ('platform', 'kross', 'Kross', '#55C8F5', '#060C1A', true)
ON CONFLICT (id) DO NOTHING;

-- Crea (o actualiza) la fila de vendedor para el admin uxbriel@gmail.com.
-- El super admin SIEMPRE pertenece a la tienda plataforma 'platform' (Kross HQ),
-- separada de cualquier marca de cliente/demo.
INSERT INTO sellers (auth_user_id, store_id, nombre, role_label, is_admin, is_super_admin, active)
SELECT u.id, 'platform', 'Uxbriel', 'Admin', true, true, true
FROM auth.users u
WHERE lower(u.email) = 'uxbriel@gmail.com'
ON CONFLICT (auth_user_id)
DO UPDATE SET is_admin = true, is_super_admin = true, role_label = 'Admin', store_id = 'platform';


-- ============================================================================
--  9. DATOS DE PRUEBA
-- ============================================================================

-- Ligar el DNI 48296862 al comprador con teléfono 925951393 (para tu prueba).
UPDATE buyers
SET document_number = '48296862', document_type = 'DNI'
WHERE (phone = '925951393' OR phone = '51925951393')
  AND document_number IS NULL;

-- (Opcional) Ver cómo quedaron los compradores:
-- SELECT nombre, phone, document_type, document_number, score FROM buyers;

-- (Opcional) Ver tus vendedores y su store_id (debe existir al menos uno activo):
-- SELECT nombre, role_label, store_id, auth_user_id, active FROM sellers;


-- ─── 12. LEADS PARCIALES DEL CHECKOUT ───────────────────────────────────────
-- Pedido a medio llenar, guardado apenas el WhatsApp es válido. Es lo que
-- permite recuperar abandonos. NO va en order_sessions a propósito: ahí
-- contaminaría el CRM y el round-robin le asignaría un vendedor a cada lead que
-- nunca compró. Ver docs/01-SALES-ENGINE.md.
CREATE TABLE IF NOT EXISTS checkout_drafts (
  order_id        uuid        PRIMARY KEY,   -- mismo uuid que usará el pedido
  store_id        text        NOT NULL,
  phone           text        NOT NULL,      -- con prefijo país (51XXXXXXXXX)
  buyer_name      text,
  document_number text,
  product_id      text,
  pack_name       text,
  location_type   text,                      -- LIMA | PROVINCIA
  district        text,
  last_step       integer     DEFAULT 1,     -- hasta dónde llegó
  -- Se marca cuando el lead termina convirtiendo, para no perseguir a quien ya compró.
  converted_at    timestamptz,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

-- Contiene PII (teléfono/DNI): solo las Edge Functions con service role la tocan.
ALTER TABLE checkout_drafts ENABLE ROW LEVEL SECURITY;

-- Recuperación de abandonos: los más recientes de la tienda que aún no compraron.
CREATE INDEX IF NOT EXISTS idx_checkout_drafts_recovery
  ON checkout_drafts(store_id, updated_at DESC)
  WHERE converted_at IS NULL;


-- ─── 13. ADELANTO POR YAPE (Fase 3 del checkout) ────────────────────────────
-- Provincia adelanta el flete por Yape. El comprador sube su comprobante; en
-- paralelo entra el pago real por `yape-ingest` y el backend los cruza.
-- Ver docs/01-SALES-ENGINE.md §3.

-- 13.a Datos de cobro POR TIENDA. Kross es multi-tenant: cada marca cobra a su
-- propio Yape. Nunca en código ni en config del front.
ALTER TABLE stores ADD COLUMN IF NOT EXISTS yape_number  text;   -- 9 dígitos
ALTER TABLE stores ADD COLUMN IF NOT EXISTS yape_holder  text;   -- titular, tal como lo muestra Yape
ALTER TABLE stores ADD COLUMN IF NOT EXISTS yape_qr_url  text;   -- QR en bucket público (desktop)
-- ¿Un match automático pasa el pedido a confirmado, o siempre lo confirma una
-- persona? Arranca en false a propósito: primero se mide cuánto acierta.
ALTER TABLE stores ADD COLUMN IF NOT EXISTS yape_autoconfirm boolean DEFAULT false;

-- ⚠️ Estas tres columnas son PÚBLICAS a propósito: el checkout se las muestra al
-- comprador para que yapee. `stores` tiene SELECT público (política
-- `stores_read`), y RLS es por FILA, no por columna: cualquier cosa que se
-- agregue a esta tabla queda legible con la anon key. Por eso el token del
-- ingestor NO vive aquí sino en `store_secrets` (13.a-bis).

-- 13.a-bis Secretos por tienda. Tabla aparte justamente porque `stores` se lee
-- en público. Sin políticas: solo el service role de las Edge Functions entra.
CREATE TABLE IF NOT EXISTS store_secrets (
  store_id             text PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
  -- Lo lleva el celular que lee las notificaciones de Yape. Si se filtra, se
  -- rota esta fila y el lector vuelve a configurarse; nada más cambia.
  payment_ingest_token text NOT NULL,
  created_at           timestamptz DEFAULT now()
);
ALTER TABLE store_secrets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON store_secrets FROM anon, authenticated;

-- 13.b Columnas de pago del pedido.
-- `checkout_id` es el uuid que nace al abrir el modal: hace el alta IDEMPOTENTE.
-- Sin esto, un doble tap en "Terminar pedido" con 4G lenta crea dos pedidos.
ALTER TABLE order_sessions ADD COLUMN IF NOT EXISTS checkout_id          uuid;
ALTER TABLE order_sessions ADD COLUMN IF NOT EXISTS advance_amount       numeric DEFAULT 0;
ALTER TABLE order_sessions ADD COLUMN IF NOT EXISTS advance_voucher_url  text;
-- Código de seguridad que TECLEA el comprador. Es la llave fuerte del cruce.
ALTER TABLE order_sessions ADD COLUMN IF NOT EXISTS advance_yape_code    text;
ALTER TABLE order_sessions ADD COLUMN IF NOT EXISTS payment_verification text DEFAULT 'NOT_REQUIRED'; -- NOT_REQUIRED | PENDING | MATCHED | UNMATCHED
ALTER TABLE order_sessions ADD COLUMN IF NOT EXISTS payment_matched_at   timestamptz;
ALTER TABLE order_sessions ADD COLUMN IF NOT EXISTS payment_reason       text;  -- por qué NO cuadró; para quien revisa, jamás para el comprador
ALTER TABLE order_sessions ADD COLUMN IF NOT EXISTS payment_event_id     uuid;  -- el pago que lo cuadró

CREATE UNIQUE INDEX IF NOT EXISTS idx_order_sessions_checkout_id
  ON order_sessions(checkout_id) WHERE checkout_id IS NOT NULL;
-- Cola de revisión: los adelantos que esperan veredicto, primero los más viejos.
CREATE INDEX IF NOT EXISTS idx_order_sessions_payment_pending
  ON order_sessions(store_id, created_at)
  WHERE payment_verification = 'PENDING';

-- 13.c Pagos leídos del celular del dueño. Se guardan TODOS, cuadren o no:
-- un pago sin pedido hoy puede ser el de un pedido que entra en 30 segundos, y
-- `raw` permite reprocesar si el parser resultó corto.
CREATE TABLE IF NOT EXISTS payment_events (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id      text        NOT NULL,
  source        text        NOT NULL,          -- ANDROID_LISTENER | AUTOMATION | MANUAL
  raw           text        NOT NULL,          -- texto crudo de la notificación
  amount_pen    numeric,
  sender_name   text,
  security_code text,
  operation_number text,
  -- Llave anti-duplicado: la misma notificación llega dos veces con frecuencia.
  dedupe_key    text        NOT NULL,
  -- Pedido que consumió este pago. NULL = todavía no cuadró con ninguno.
  matched_order_id uuid,
  matched_at    timestamptz,
  received_at   timestamptz DEFAULT now(),
  created_at    timestamptz DEFAULT now()
);

-- Un pago entra UNA vez por tienda, y cuadra UN solo pedido.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_events_dedupe
  ON payment_events(store_id, dedupe_key);
-- Búsqueda del cruce: pagos de la tienda aún sin consumir, por monto.
CREATE INDEX IF NOT EXISTS idx_payment_events_unmatched
  ON payment_events(store_id, amount_pen, received_at DESC)
  WHERE matched_order_id IS NULL;

-- Contiene el nombre de quien paga (PII) y el token de cobro: solo service role.
ALTER TABLE payment_events ENABLE ROW LEVEL SECURITY;

-- 13.d Bucket de comprobantes. PRIVADO: una captura de Yape lleva nombre y
-- teléfono. El equipo la ve por URL firmada desde la Edge Function.
INSERT INTO storage.buckets (id, name, public)
VALUES ('vouchers', 'vouchers', false)
ON CONFLICT (id) DO NOTHING;

-- 13.e El comprador sube su comprobante con la anon key (no tiene sesión). Se
-- le permite ESCRIBIR en el bucket, nunca leer: el bucket es privado y el
-- equipo abre las capturas con URL firmada desde una Edge Function.
DROP POLICY IF EXISTS vouchers_public_insert ON storage.objects;
CREATE POLICY vouchers_public_insert ON storage.objects
  FOR INSERT TO anon, authenticated
  WITH CHECK (bucket_id = 'vouchers');

-- 13.f Motivo por el que un pago entrante NO se procesó (texto ilegible, pago
-- saliente, variable del automatizador sin expandir…). Antes esos casos
-- respondían 200 y no dejaban rastro: la fila no existía y no había forma de
-- saber por qué. Un pago que no se ve es un pago perdido.
ALTER TABLE payment_events ADD COLUMN IF NOT EXISTS ignored_reason text;
-- El índice de cruce solo debe mirar pagos utilizables.
DROP INDEX IF EXISTS idx_payment_events_unmatched;
CREATE INDEX IF NOT EXISTS idx_payment_events_unmatched
  ON payment_events(store_id, amount_pen, received_at DESC)
  WHERE matched_order_id IS NULL AND ignored_reason IS NULL;

-- ─── 14. Etapa `validando` ───────────────────────────────────────────────────
-- Un pedido con adelanto quedaba en "Pedido" desde que el comprador pagaba
-- hasta que alguien lo confirmaba: pagó y su barra no se movía. Sin señal de
-- avance, su siguiente paso es escribir "¿llegó mi pago?" — justo el mensaje
-- que el checkout existe para evitar.
--
-- Va ENTRE `nuevo` y `confirmado`. Los pedidos sin adelanto no la usan: en Lima
-- no hay nada que validar y el pedido nace confirmado.
ALTER TABLE order_sessions DROP CONSTRAINT IF EXISTS order_sessions_stage_check;
ALTER TABLE order_sessions ADD CONSTRAINT order_sessions_stage_check
  CHECK (stage = ANY (ARRAY[
    'nuevo'::text, 'validando'::text, 'confirmado'::text,
    'preparando'::text, 'en_camino'::text, 'entregado'::text
  ]));
