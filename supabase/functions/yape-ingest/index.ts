// ─── SALES ENGINE · Ingesta de pagos Yape ────────────────────────────────────
// Recibe un pago que le entró al Yape de la marca y trata de cuadrarlo con un
// pedido que está esperando su adelanto.
//
// **Es agnóstico de QUIÉN lee la notificación.** Ese es el punto: una PWA no
// puede leer notificaciones de otras apps (no existe Web API para eso), así que
// la lectura la hace algo externo. Cualquier fuente que hable este contrato
// sirve, y se puede cambiar sin tocar el checkout:
//
//   source=AUTOMATION      MacroDroid/Tasker en el Android del dueño → HTTP POST
//   source=ANDROID_LISTENER app nativa propia con NotificationListenerService
//   source=MANUAL          alguien del equipo lo escribe a mano
//
// Autenticación: `store_secrets.payment_ingest_token` (no la anon key). Es un
// secreto por tienda; si se filtra, se rota esa fila y listo.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { parseYapeNotification, yapeDedupeKey } from '../_shared/yape.ts'
import { matchPaymentToOrders } from '../_shared/yape-match.ts'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-ingest-token, x-store-id',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

/**
 * Ventana para cuadrar. El comprador yapea y sube su captura en el mismo minuto;
 * 2 horas cubre de sobra al que se distrae, sin llegar a cruzar el pedido de
 * ayer con el pago de hoy.
 */
export const MATCH_WINDOW_MS = 2 * 60 * 60 * 1000

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  interface IngestBody {
    store_id?: string
    /** Texto crudo de la notificación. Es la entrada preferida. */
    raw?: string
    source?: string
    /** Campos ya parseados por la fuente. Solo se usan si el parser no los saca. */
    amount_pen?: number
    sender_name?: string
    security_code?: string
    operation_number?: string
    /** ISO. Si la fuente encoló offline, manda cuándo llegó de verdad. */
    received_at?: string
  }

  // ─── Dos formas de mandar el pago ──────────────────────────────────────────
  //
  //   texto plano  ← RECOMENDADA para automatizadores (MacroDroid, Tasker)
  //     El cuerpo ES la notificación, tal cual. `store_id` va por query o header.
  //
  //   JSON         ← para fuentes que ya parsean (app nativa, integración propia)
  //
  // El texto plano existe porque interpolar la notificación dentro de un JSON es
  // frágil: basta una comilla o un salto de línea en el texto de Yape para que el
  // JSON quede inválido. Con `return 400` eso significaba **perder el pago en
  // silencio** —el automatizador no reintenta— que es justo lo que este servicio
  // no puede permitirse. Por eso un JSON roto TAMPOCO se rechaza: se degrada a
  // texto plano y el parser hace lo suyo.
  const url = new URL(req.url)
  const rawBody = await req.text()
  const looksJson = rawBody.trimStart().startsWith('{')

  let body: IngestBody = {}
  if (looksJson) {
    try {
      body = JSON.parse(rawBody) as IngestBody
    } catch {
      body = { raw: rawBody } // JSON malformado: se trata como texto, no se pierde
    }
  } else {
    body = { raw: rawBody }
  }

  const storeId = String(
    body.store_id ?? url.searchParams.get('store_id') ?? req.headers.get('x-store-id') ?? '',
  ).trim()
  const raw = String(body.raw ?? '').trim()
  if (!storeId) return json({ error: 'Missing store_id' }, 400)
  if (!raw && typeof body.amount_pen !== 'number') return json({ error: 'Missing raw or amount_pen' }, 400)

  // ─── Auth por token de tienda ──────────────────────────────────────────────
  // El token vive en `store_secrets`, NO en `stores`: esa tabla tiene SELECT
  // público (política `stores_read`) y RLS es por fila, no por columna — puesto
  // ahí, cualquiera con la anon key podría leerlo y ensuciar la caja.
  const token = req.headers.get('x-ingest-token') ?? ''
  const { data: secret } = await supabase
    .from('store_secrets').select('payment_ingest_token').eq('store_id', storeId).maybeSingle()

  // Sin token configurado la tienda NO ingesta: es más seguro que aceptar todo
  // mientras alguien "todavía no lo configura".
  if (!secret?.payment_ingest_token || token !== secret.payment_ingest_token) {
    return json({ error: 'Unauthorized' }, 401)
  }

  // ─── Parseo ────────────────────────────────────────────────────────────────
  const parsed = parseYapeNotification(raw)
  // Lo que la fuente ya sepa completa lo que el parser no pudo. Nunca lo pisa:
  // el texto crudo es la fuente más confiable de las dos.
  const amountPen = parsed.amountPen ?? (typeof body.amount_pen === 'number' ? body.amount_pen : null)
  const senderName = parsed.senderName ?? (body.sender_name?.trim() || null)
  const securityCode = parsed.securityCode ?? (body.security_code?.trim() || null)
  const operationNumber = parsed.operationNumber ?? (body.operation_number?.trim() || null)

  const receivedAt = body.received_at && !Number.isNaN(Date.parse(body.received_at))
    ? new Date(body.received_at).toISOString()
    : new Date().toISOString()

  // ─── ¿Es utilizable? ───────────────────────────────────────────────────────
  // Un pago SALIENTE nunca debe cruzarse: nuestro propio gasto cuadraría el
  // adelanto de un pedido y lo daría por pagado sin que nadie pagara. Tampoco
  // sirve un texto sin monto.
  //
  // Pero descartar NO es responder 200 y desaparecer. Eso ya costó una tarde de
  // depuración a ciegas: la variable del automatizador llegaba sin expandir, la
  // función respondía 200, no se creaba fila y no había NADA que mirar. Ahora el
  // evento se guarda igual con `ignored_reason`, así que "por qué no entró este
  // pago" siempre se responde con una consulta.
  const ignoredReason =
    raw && !parsed.looksLikeYape ? 'No parece un pago Yape recibido (¿saliente, o texto sin expandir?)'
      : amountPen === null ? 'Sin monto legible en el texto'
        : null

  const source = ['ANDROID_LISTENER', 'AUTOMATION', 'MANUAL'].includes(body.source ?? '')
    ? body.source! : 'AUTOMATION'
  const dedupeKey = yapeDedupeKey(
    { amountPen, senderName, securityCode, operationNumber, looksLikeYape: true },
    receivedAt,
  )

  // ─── Guardar el pago ───────────────────────────────────────────────────────
  // Se guarda SIEMPRE, cuadre o no: un pago sin pedido ahora puede ser el de un
  // pedido que entra en 30 segundos, y `raw` permite reprocesar más adelante.
  const { data: event, error: insertErr } = await supabase
    .from('payment_events')
    .insert({
      store_id: storeId, source, raw: raw || '(sin texto crudo)',
      amount_pen: amountPen, sender_name: senderName,
      security_code: securityCode, operation_number: operationNumber,
      dedupe_key: dedupeKey, received_at: receivedAt,
      ignored_reason: ignoredReason,
    })
    .select('id')
    .single()

  if (insertErr) {
    // 23505 = choque con el índice único: la notificación ya había entrado.
    // Es el caso NORMAL cuando el automatizador reintenta, no un error.
    if (insertErr.code === '23505') return json({ ok: true, duplicate: true })

    // Cualquier otro fallo de BD (esquema desfasado, caída) deja el pago sin
    // guardar, y el automatizador NO reintenta: sería plata perdida sin rastro.
    // Volcarlo al log lo hace recuperable a mano — es la última red, y ya se
    // usó: la función se desplegó antes de correr el ALTER TABLE y respondía
    // 500 sin dejar ni una pista de qué pago se había caído.
    console.error('[yape-ingest] NO SE PUDO GUARDAR EL PAGO', JSON.stringify({
      store_id: storeId, error: insertErr.message, raw,
      amount_pen: amountPen, sender_name: senderName, security_code: securityCode,
      received_at: receivedAt,
    }))
    return json({ error: insertErr.message }, 500)
  }

  // Guardado pero inutilizable: queda visible en la tabla para diagnóstico y no
  // se intenta cruzar con nada.
  if (ignoredReason) return json({ ok: true, event_id: event.id, ignored: ignoredReason })

  // ─── Cuadrar con un pedido ─────────────────────────────────────────────────
  const since = new Date(Date.parse(receivedAt) - MATCH_WINDOW_MS).toISOString()
  const { data: candidates } = await supabase
    .from('order_sessions')
    .select('id, order_id, buyer_name, advance_amount, advance_yape_code, created_at')
    .eq('store_id', storeId)
    .eq('payment_verification', 'PENDING')
    .gte('created_at', since)
    .order('created_at', { ascending: true })

  // La regla de cruce vive en `_shared/yape-match.ts`: la comparten esta
  // función y `register-buyer`, para que las dos direcciones decidan igual.
  const { chosen, reason, shortPaid } = matchPaymentToOrders(
    { id: event.id, amount_pen: amountPen, sender_name: senderName, security_code: securityCode },
    candidates ?? [],
  )

  if (!chosen) {
    // El pago queda guardado y sin consumir. Cuando el pedido entre —o cuando
    // alguien lo revise— se vuelve a intentar. No se pierde plata.
    return json({ ok: true, event_id: event.id, matched: false, reason })
  }

  const matchedAt = new Date().toISOString()

  // El pedido lo mueve el BACKEND, nunca el front. Se marca MATCHED aunque
  // `reason` traiga una advertencia: el adelanto cuadró, el aviso es contexto
  // para quien revisa.
  // Con el monto incompleto el pago SÍ se enlaza —para que Ventas lo vea junto
  // al pedido en vez de dejar dos huérfanos— pero NO se da por verificado:
  // falta plata, y despachar sin cobrarla es regalar mercadería.
  const patch: Record<string, unknown> = {
    payment_verification: shortPaid ? 'PENDING' : 'MATCHED',
    payment_matched_at: matchedAt,
    payment_reason: reason,
    payment_event_id: event.id,
  }
  // Un cruce confirmado mueve el pedido a `confirmado`, sin flag de por medio.
  // Estaba detrás de `yape_autoconfirm` para medir primero cuánto acierta el
  // cruce, pero eso dejaba al comprador con el dinero cobrado y la barra
  // quieta en "validando" — la contradicción que genera el reclamo.
  // Las advertencias NO frenan el avance: viven en `payment_reason` y en el
  // mensaje interno, para que Ventas las revise antes de despachar.
  if (!shortPaid) patch.stage = 'confirmado'

  await supabase.from('order_sessions').update(patch).eq('id', chosen.id)
  await supabase.from('payment_events')
    .update({ matched_order_id: chosen.id, matched_at: matchedAt })
    .eq('id', event.id)

  // Dos mensajes, no uno. El de abajo iba sin `visibility` —o sea, visible para
  // TODOS— y le mostraba al comprador el veredicto interno: el ⚠️ de que su
  // nombre no coincide, el nombre de quien pagó (que puede ser un tercero) y una
  // instrucción dirigida a Ventas. Justo lo contrario de la regla del módulo:
  // al comprador no se le traslada nunca nuestra duda operativa.

  // Para Ventas: el veredicto completo, con el motivo y qué hacer.
  await supabase.from('chat_messages').insert({
    session_id: chosen.id,
    sender_role: 'system',
    sender_name: 'Kross',
    type: 'text',
    visibility: 'sellers',
    body: `✅ Adelanto de S/${amountPen} verificado automáticamente`
      + (senderName ? ` · pagó ${senderName}` : '')
      + (securityCode ? ` · código ${securityCode}` : '')
      + (reason ? `\n⚠️ ${reason}` : '')
      + (reason ? '\nRevísalo antes de despachar.' : ''),
  })

  // Para el comprador: el acuse que estaba esperando, sin una sola palabra de
  // nuestra cocina. Es además el PRIMER mensaje que recibe de la marca, así que
  // hace doble trabajo: confirma su plata y le enseña que este chat es el canal
  // por donde va a saber de su pedido.
  // El acuse al comprador SOLO si el adelanto entró completo. Decirle "recibimos
  // tu adelanto" cuando pagó de menos lo deja creyendo que ya está, y el
  // problema aparece recién en la puerta.
  if (!shortPaid) {
    await supabase.from('chat_messages').insert({
      session_id: chosen.id,
      sender_role: 'system',
      sender_name: 'Kross',
      type: 'status_update',
      visibility: 'all',
      body: `✅ ¡Recibimos tu adelanto de S/${amountPen}! Ya estamos preparando tu pedido.`
        + ' Por aquí te avisamos cuando salga.',
    })
  }

  return json({
    ok: true, event_id: event.id, matched: true,
    order_id: chosen.order_id, reason,
  })
})
