// ─── SALES ENGINE · URL firmada del comprobante ──────────────────────────────
// El bucket `vouchers` es PRIVADO y no tiene política de lectura, a propósito:
// una captura de Yape lleva nombre, teléfono parcial y número de operación del
// comprador. Pero eso dejaba al equipo sin poder abrir ni una — veían la
// advertencia de "el nombre no coincide" y no tenían con qué resolverla.
//
// Esta función es la única puerta. Comprueba que quien pide sea vendedor DE LA
// TIENDA dueña del pedido y devuelve una URL firmada de vida corta.
//
// El cruce de tienda no es ceremonia: sin él, cualquier vendedor de cualquier
// marca de Kross podría leer los comprobantes de las demás con solo tener el id
// de un pedido.

import { createClient } from 'npm:@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

/** Vida de la URL. Suficiente para mirarla y decidir; corta para que un enlace
 *  reenviado por error no siga sirviendo mañana. */
const SIGNED_URL_TTL_S = 300

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const body = await req.json().catch(() => ({})) as {
    seller_auth_id?: string
    order_session_id?: string
  }
  if (!body.seller_auth_id || !body.order_session_id) {
    return json({ error: 'missing_params' }, 400)
  }

  const { data: seller } = await supabase
    .from('sellers')
    .select('store_id, is_super_admin, active')
    .eq('auth_user_id', body.seller_auth_id)
    .maybeSingle()
  if (!seller || seller.active === false) return json({ error: 'forbidden' }, 403)

  const { data: order } = await supabase
    .from('order_sessions')
    .select('store_id, advance_voucher_url')
    .eq('id', body.order_session_id)
    .maybeSingle()
  if (!order) return json({ error: 'not_found' }, 404)

  // Un vendedor solo abre comprobantes de SU tienda. El super admin de la
  // plataforma sí puede, porque es quien atiende los reclamos de las marcas.
  if (!seller.is_super_admin && seller.store_id !== order.store_id) {
    return json({ error: 'forbidden' }, 403)
  }

  // Sin comprobante no es un error: la mayoría de pedidos cuadra por código y
  // nunca sube captura. Se responde 200 con `url: null` para que la UI muestre
  // "no adjuntó comprobante" en vez de una pantalla de fallo.
  if (!order.advance_voucher_url) return json({ url: null })

  const { data: signed, error } = await supabase.storage
    .from('vouchers')
    .createSignedUrl(order.advance_voucher_url, SIGNED_URL_TTL_S)

  if (error || !signed?.signedUrl) {
    return json({ error: error?.message ?? 'sign_failed' }, 500)
  }
  return json({ url: signed.signedUrl, expires_in: SIGNED_URL_TTL_S })
})
