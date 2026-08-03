import { createClient } from 'npm:@supabase/supabase-js@2'
import { matchOrderToPayments } from '../_shared/yape-match.ts'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

function randomToken() {
  const bytes = new Uint8Array(18)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, '').slice(0, 24)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const body = await req.json() as {
    store_id: string
    product_id?: string
    product_name: string
    product_price: number
    pack_name?: string
    buyer_name: string
    buyer_phone: string
    document_type?: string
    document_number?: string
    address?: string
    seller_ids?: string[]
    redeem_points?: number   // puntos que el cliente quiere canjear por descuento
    payment_method?: string  // YAPE_PLIN | CONTRAENTREGA | TARJETA (default COD)
    closed_by?: string       // AI_CLOSER | DIRECT_CHECKOUT (default directo)
    // Costuras de ENTREGA del checkout guiado (Quiz). Ver docs/01-SALES-ENGINE.md.
    dispatch_type?: string        // MOTORIZADO_LIMA | AGENCIA_PROVINCIA (default Lima)
    agency_name?: string          // SHALOM | OLVA | OTRO (solo provincia)
    delivery_reference?: string   // referencia de la dirección / agencia destino
    address_lat?: number          // pin GPS fijado en el checkout
    address_lng?: number
    advance_op_number?: string    // N° de operación del adelanto de flete (provincia)
    // ─── Fase 3 · adelanto por Yape ─────────────────────────────────────────
    checkout_id?: string          // uuid del modal: hace el alta IDEMPOTENTE
    advance_amount?: number       // S/0 en Lima, S/10 Shalom, S/20 Olva
    advance_voucher_url?: string  // ruta en el bucket privado `vouchers`
    advance_yape_code?: string    // código de seguridad tecleado por el comprador
  }

  // ─── Idempotencia ──────────────────────────────────────────────────────────
  // Un doble tap en "Terminar pedido" con 4G lenta manda dos veces. Sin esto se
  // crean dos pedidos, se le asignan dos vendedores y el comprador recibe dos
  // mensajes de bienvenida. El uuid nace al abrir el modal, así que los dos
  // envíos traen el MISMO y el segundo devuelve el pedido ya creado.
  const checkoutId = typeof body.checkout_id === 'string' && body.checkout_id.trim() ? body.checkout_id.trim() : null
  if (checkoutId) {
    const { data: existing } = await supabase
      .from('order_sessions').select('id, order_id, token').eq('checkout_id', checkoutId).maybeSingle()
    if (existing) {
      return new Response(JSON.stringify({ ...existing, idempotent: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
  }

  // Upsert buyer account — document_number as unique key if provided, fallback to phone
  let buyer: { id: string; score: number; puntos: number; address: string | null; address_lat: number | null; address_lng: number | null; address_verified: boolean } | null = null
  let buyerErr: { message: string } | null = null

  if (body.document_number) {
    const { data, error } = await supabase
      .from('buyers')
      .upsert(
        {
          store_id: body.store_id,
          document_type: body.document_type ?? 'DNI',
          document_number: body.document_number,
          phone: body.buyer_phone,
          nombre: body.buyer_name,
          address: body.address ?? null,
        },
        { onConflict: 'store_id,document_number', ignoreDuplicates: false }
      )
      .select('id, score, puntos, address, address_lat, address_lng, address_verified')
      .single()
    buyer = data
    buyerErr = error
  } else {
    // Fallback: upsert by phone (old registrations without DNI)
    const { data, error } = await supabase
      .from('buyers')
      .upsert(
        { store_id: body.store_id, phone: body.buyer_phone, nombre: body.buyer_name, address: body.address ?? null },
        { onConflict: 'store_id,phone', ignoreDuplicates: false }
      )
      .select('id, score, puntos, address, address_lat, address_lng, address_verified')
      .single()
    buyer = data
    buyerErr = error
  }

  if (buyerErr || !buyer) {
    return new Response(JSON.stringify({ error: buyerErr?.message ?? 'buyer upsert failed' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  // ─── Costuras de ENTREGA (estado central · delivery) ──────────────────────────
  // El checkout guiado ya trae el tipo de despacho, la agencia (provincia), una
  // referencia y —en Lima— el pin GPS. Un pin fresco actualiza la dirección guardada
  // del buyer para que los próximos pedidos la hereden sin re-preguntar.
  const dispatchType = body.dispatch_type === 'AGENCIA_PROVINCIA' ? 'AGENCIA_PROVINCIA' : 'MOTORIZADO_LIMA'
  const agencyName = ['SHALOM', 'OLVA', 'OTRO'].includes(body.agency_name ?? '') ? body.agency_name! : null
  const deliveryReference = body.delivery_reference?.trim() || null
  const pinLat = typeof body.address_lat === 'number' ? body.address_lat : null
  const pinLng = typeof body.address_lng === 'number' ? body.address_lng : null

  if (pinLat != null && pinLng != null) {
    await supabase.from('buyers')
      .update({ address_lat: pinLat, address_lng: pinLng, address_verified: true, address: body.address ?? buyer.address ?? null })
      .eq('id', buyer.id)
    // Refleja el pin localmente para que el insert del pedido lo herede.
    buyer.address_lat = pinLat
    buyer.address_lng = pinLng
    buyer.address_verified = true
    if (body.address) buyer.address = body.address
  }

  // Round-robin assignment among REAL sellers from the sellers table.
  // We resolve sellers server-side (by auth_user_id) so the assignment always
  // matches a real Supabase user — the frontend's local seller_ids are ignored.
  let assignedSellerId: string | null = null
  let assignedSellerName: string | null = null
  let assignedSellerRole: string | null = null
  let assignedSellerAvatar: string | null = null
  let assignedSellerStore: string | null = null

  // New orders always go to a SALES person (role Ventas) — never to Despacho,
  // Motorizado or Admin. We prefer sellers scoped to this store; if that store
  // has no sales rep, fall back to any Ventas rep across stores.
  type Seller = { auth_user_id: string; nombre: string; role_label: string; avatar_url: string | null; store_id?: string }
  const isVentas = (s: any) => (s.role_label ?? '').toLowerCase().includes('venta')
  // A seller off-shift (available=false) doesn't receive new orders. Missing
  // column (undefined) is treated as available so it works before the migration.
  const isAvailable = (s: any) => s.available !== false

  // Only sellers of THIS store — never assign across tenants
  let sellerPool: Seller[] = []
  {
    const { data: scoped } = await supabase
      .from('sellers')
      .select('auth_user_id, nombre, role_label, avatar_url, is_admin, available, store_id')
      .eq('store_id', body.store_id)
      .eq('active', true)
      .not('auth_user_id', 'is', null)
    sellerPool = (scoped ?? []).filter((s: any) => !s.is_admin && isVentas(s) && isAvailable(s))
  }

  if (sellerPool.length > 0) {
    const ids = sellerPool.map(s => s.auth_user_id)

    // CONTINUITY FIRST: if this buyer already has active orders with an available
    // Ventas rep, keep them with the same person.
    let chosen: Seller | undefined
    const { data: buyerOrders } = await supabase
      .from('order_sessions')
      .select('assigned_seller_id, created_at')
      .eq('buyer_id', buyer.id as string)
      .eq('status', 'active')
      .in('assigned_seller_id', ids)
      .order('created_at', { ascending: false })

    const stickyId = buyerOrders?.[0]?.assigned_seller_id
    if (stickyId) chosen = sellerPool.find(s => s.auth_user_id === stickyId)

    // Otherwise least-loaded among available Ventas reps
    if (!chosen) {
      const counts: Record<string, number> = {}
      for (const id of ids) counts[id] = 0
      const { data: existing } = await supabase
        .from('order_sessions')
        .select('assigned_seller_id')
        .eq('status', 'active')
        .in('assigned_seller_id', ids)
      for (const row of existing ?? []) {
        if (row.assigned_seller_id) counts[row.assigned_seller_id] = (counts[row.assigned_seller_id] ?? 0) + 1
      }
      const leastId = ids.reduce((a, b) => counts[a] <= counts[b] ? a : b)
      chosen = sellerPool.find(s => s.auth_user_id === leastId)
    }

    if (chosen) {
      assignedSellerId = chosen.auth_user_id
      assignedSellerName = chosen.nombre
      assignedSellerRole = chosen.role_label
      assignedSellerAvatar = chosen.avatar_url
      assignedSellerStore = chosen.store_id ?? null
    }
  }

  // Points redemption → discount on this order. usedPoints capped by balance AND
  // by the order price, so you can't over-redeem.
  let finalPrice = body.product_price
  let discount = 0
  if (body.redeem_points && body.redeem_points > 0) {
    const { data: st } = await supabase.from('stores').select('points_rate').eq('id', body.store_id).maybeSingle()
    const rate = Number(st?.points_rate ?? 0)
    if (rate > 0) {
      const maxByPrice = Math.floor(body.product_price / rate)
      const usedPoints = Math.min(body.redeem_points, buyer.puntos ?? 0, maxByPrice)
      if (usedPoints > 0) {
        discount = usedPoints * rate
        finalPrice = Math.max(0, body.product_price - discount)
        await supabase.from('buyers').update({ puntos: (buyer.puntos ?? 0) - usedPoints }).eq('id', buyer.id)
      }
    }
  }

  // First product image for the cart thumbnail
  let firstImage: string | null = null
  if (body.product_id) {
    const { data: prod } = await supabase.from('products').select('images').eq('id', body.product_id).maybeSingle()
    firstImage = (prod?.images as string[] | undefined)?.[0] ?? null
  }

  const token = randomToken()
  const orderId = `ORD-${Date.now()}`

  // ─── Adelanto por Yape ─────────────────────────────────────────────────────
  // El adelanto lo DERIVA el checkout del destino y de la agencia; aquí solo se
  // registra. `PENDING` significa "hay dinero que verificar", y es lo que hace
  // que el pedido aparezca en la cola de cruce de `yape-ingest`.
  const advanceAmount = typeof body.advance_amount === 'number' && body.advance_amount > 0 ? body.advance_amount : 0
  const advanceVoucherUrl = body.advance_voucher_url?.trim() || null
  const advanceYapeCode = body.advance_yape_code?.replace(/\D/g, '').slice(0, 6) || null
  const paymentVerification = advanceAmount > 0 ? 'PENDING' : 'NOT_REQUIRED'

  const { data, error } = await supabase
    .from('order_sessions')
    .insert({
      order_id: orderId,
      // Align the order to the assigned seller's store so it shows in the team's lists
      store_id: assignedSellerStore ?? body.store_id,
      token,
      buyer_id: buyer.id,
      buyer_name: body.buyer_name,
      buyer_phone: body.buyer_phone,
      // Inherit the buyer's already-verified address (so no need to re-verify)
      address: buyer.address ?? body.address ?? null,
      address_lat: buyer.address_lat ?? null,
      address_lng: buyer.address_lng ?? null,
      address_verified: buyer.address_verified ?? false,
      seller_name: assignedSellerName,
      seller_role: assignedSellerRole,
      seller_avatar: assignedSellerAvatar,
      product_id: body.product_id ?? null,
      product_name: body.product_name,
      product_price: finalPrice,
      pack_name: body.pack_name ?? null,
      items: [{ product_id: body.product_id ?? null, nombre: body.product_name, precio: finalPrice, unit_price: finalPrice, qty: 1, pack_name: body.pack_name ?? null, image: firstImage }],
      status: 'active',
      // Con adelanto arranca en `validando`: el comprador acaba de pagar y su
      // barra TIENE que moverse, o el siguiente paso que da es escribir
      // "¿llegó mi pago?" —el mensaje que este checkout existe para evitar—.
      // Sin adelanto (Lima, contraentrega puro) no hay nada que validar y el
      // pedido nace confirmado: mostrarle un paso pendiente que nunca va a
      // ocurrir se lee como que algo se atascó.
      stage: advanceAmount > 0 ? 'validando' : 'confirmado',
      // Costuras del estado central — el checkout las deja escritas desde el día 1
      payment_method: ['YAPE_PLIN', 'CONTRAENTREGA', 'TARJETA'].includes(body.payment_method ?? '') ? body.payment_method : 'CONTRAENTREGA',
      closed_by: body.closed_by === 'AI_CLOSER' ? 'AI_CLOSER' : 'DIRECT_CHECKOUT',
      dispatch_type: dispatchType,
      agency_name: agencyName,
      delivery_reference: deliveryReference,
      assigned_seller_id: assignedSellerId,
      involved_seller_ids: assignedSellerId ? [assignedSellerId] : [],
      writer_seller_ids: assignedSellerId ? [assignedSellerId] : [],
      checkout_id: checkoutId,
      advance_amount: advanceAmount,
      advance_voucher_url: advanceVoucherUrl,
      advance_yape_code: advanceYapeCode,
      payment_verification: paymentVerification,
    })
    .select('id, token')
    .single()

  if (error || !data) {
    return new Response(JSON.stringify({ error: error?.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const firstName = body.buyer_name ? ' ' + body.buyer_name.split(' ')[0] : ''
  const priceLine = `S/${finalPrice}${discount > 0 ? ` · usaste puntos: −S/${discount}` : ''}`
  // El estado del adelanto va en el PRIMER mensaje. El comprador acaba de
  // yapear y esa es su única duda: si su plata llegó. Callarlo lo empuja al
  // WhatsApp del vendedor a preguntar, que es justo lo que este chat evita.
  //
  // Siempre dice "estamos validando", nunca "ya está confirmado": el cruce
  // corre MÁS ABAJO en esta misma función, así que a esta altura todavía no se
  // sabe. Y no es un consuelo — cuando cuadra, el propio cruce manda su "✅
  // ¡Recibimos tu adelanto!" segundos después, y el comprador ve el sistema
  // trabajando en vivo en vez de leer un estado ya resuelto.
  //
  // Regla dura del módulo: **nunca se le dice que su pago no existe.** Si no
  // cruza, este mensaje se queda como la única versión de los hechos, y dice
  // que lo estamos validando nosotros — porque en la mayoría de esos casos el
  // fallo es del lector, no suyo.
  const advanceLine = advanceAmount > 0
    ? `\n\n⏳ Estamos validando tu adelanto de S/${advanceAmount}. Te aviso por aquí apenas cuadre.`
    : ''

  // "Pregúntame por aquí" estaba solo en el mensaje de Lima. Justo en provincia
  // —donde el comprador ya adelantó plata y espera días— era donde más falta
  // hacía decirle que este es el canal.
  const askLine = '\n\nEscríbeme por aquí cualquier duda y te ayudo al toque. 😊'

  const welcomeBody = dispatchType === 'AGENCIA_PROVINCIA'
    ? `¡Hola${firstName}! 🎉 Gracias por tu compra. Tu ${body.product_name} (${priceLine}) se enviará por agencia${agencyName ? ' ' + agencyName : ''} y el saldo lo pagas al recoger.${advanceLine}${askLine}`
    : `¡Hola${firstName}! 🎉 Gracias por tu compra. Tu ${body.product_name} (${priceLine}) llegará a tu puerta sin adelanto.${askLine}`

  await supabase.from('chat_messages').insert({
    session_id: data.id,
    sender_role: 'seller',
    sender_name: assignedSellerName ?? 'Kross',
    sender_role_label: assignedSellerRole ?? 'Ventas',
    type: 'text',
    body: welcomeBody,
  })

  // Adelanto de flete reportado en el checkout → deja constancia para que Ventas
  // verifique el Yape/Plin antes de despachar (verificación formal: pendiente #3).
  if (body.advance_op_number) {
    await supabase.from('chat_messages').insert({
      session_id: data.id,
      sender_role: 'system',
      sender_name: 'Kross',
      type: 'text',
      body: `📎 Adelanto de flete reportado por el cliente · N° de operación ${body.advance_op_number}. Verifica el Yape/Plin antes de despachar.`,
    })
  }

  // ─── Cruce inverso: el pago pudo llegar ANTES que el pedido ────────────────
  // Es el caso normal, no el raro: el comprador yapea, mira su captura, la sube
  // y recién ahí toca "Terminar pedido". Para cuando el pedido existe, su pago
  // ya está guardado y sin consumir. Sin esta pasada, todo pedido de provincia
  // quedaría PENDING esperando un pago que nunca va a volver a llegar.
  if (advanceAmount > 0) {
    const since = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    const { data: pending } = await supabase
      .from('payment_events')
      .select('id, amount_pen, sender_name, security_code')
      .eq('store_id', body.store_id)
      .is('matched_order_id', null)
      .gte('received_at', since)
      .order('received_at', { ascending: false })

    const { chosen, reason, shortPaid } = matchOrderToPayments(
      {
        id: data.id, order_id: orderId, buyer_name: body.buyer_name,
        advance_amount: advanceAmount, advance_yape_code: advanceYapeCode,
      },
      pending ?? [],
    )

    if (chosen) {
      const matchedAt = new Date().toISOString()
      const patch: Record<string, unknown> = {
        // Monto incompleto: se enlaza para que Ventas lo vea, pero no se da
        // por verificado — falta plata.
        payment_verification: shortPaid ? 'PENDING' : 'MATCHED', payment_matched_at: matchedAt,
        payment_reason: reason, payment_event_id: chosen.id,
      }
      // Un cruce confirmado mueve el pedido, sin flag de por medio: para el
      // comprador el pago YA ocurrió, y dejarlo en "validando" mientras el
      // dinero está cobrado es la contradicción que genera el reclamo.
      // Las advertencias (nombre distinto, código que no calza) NO frenan esto
      // — quedan en `payment_reason` y en el mensaje interno para que Ventas las
      // revise antes de despachar, que es el momento donde importan.
      if (!shortPaid) patch.stage = 'confirmado'

      await supabase.from('order_sessions').update(patch).eq('id', data.id)
      await supabase.from('payment_events')
        .update({ matched_order_id: data.id, matched_at: matchedAt })
        .eq('id', chosen.id)
      // El veredicto interno es SOLO para Ventas: lleva el nombre de quien pagó
      // (que puede ser un tercero) y nuestras dudas operativas.
      await supabase.from('chat_messages').insert({
        session_id: data.id, sender_role: 'system', sender_name: 'Kross', type: 'text',
        visibility: 'sellers',
        body: (shortPaid
          ? `⚠️ Pago identificado pero INCOMPLETO — S/${advanceAmount} esperados`
          : `✅ Adelanto de S/${advanceAmount} verificado automáticamente`)
          + (chosen.sender_name ? ` · pagó ${chosen.sender_name}` : '')
          + (reason ? `\n⚠️ ${reason}` : ''),
      })
      // El acuse al comprador SOLO si entró completo: decirle "recibimos tu
      // adelanto" cuando pagó de menos lo deja creyendo que ya está.
      if (!shortPaid) await supabase.from('chat_messages').insert({
        session_id: data.id, sender_role: 'system', sender_name: 'Kross',
        type: 'status_update', visibility: 'all',
        body: `✅ ¡Recibimos tu adelanto de S/${advanceAmount}! Ya estamos preparando tu pedido.`
          + ' Por aquí te avisamos cuando salga.',
      })
    } else if (advanceVoucherUrl) {
      // El comprobante está subido pero el pago aún no aparece. Se avisa para
      // que Ventas lo mire; NUNCA se le dice al comprador que su pago no existe
      // —de ahí que este mensaje sea `sellers` y no lleve respuesta al chat.
      await supabase.from('chat_messages').insert({
        session_id: data.id, sender_role: 'system', sender_name: 'Kross', type: 'text',
        visibility: 'sellers',
        body: `📎 Comprobante de adelanto (S/${advanceAmount}) subido por el cliente. Aún sin cruce automático${reason ? ` · ${reason}` : ''}. Revísalo antes de despachar.`,
      })
    }
  }

  // El lead deja de ser lead: no se persigue a quien ya compró.
  if (checkoutId) {
    await supabase.from('checkout_drafts')
      .update({ converted_at: new Date().toISOString() }).eq('order_id', checkoutId)
  }

  return new Response(
    JSON.stringify({
      token: data.token,
      session_id: data.id,
      buyer_id: buyer.id,
      score: buyer.score,
      puntos: buyer.puntos,
      assigned_seller_id: assignedSellerId,
    }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  )
})
