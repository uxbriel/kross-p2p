import { createClient } from 'npm:@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-kross-token, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const token = req.headers.get('x-kross-token')
  if (!token) return new Response('Unauthorized', { status: 401, headers: corsHeaders })
  // Read viewer from the URL query (avoids adding a custom CORS header)
  const viewerIsSeller = new URL(req.url).searchParams.get('viewer') === 'seller'
    || req.headers.get('x-viewer-role') === 'seller'

  // Fetch session
  const { data: session, error } = await supabase
    .from('order_sessions')
    .select(`
      id, order_id, store_id, buyer_name, buyer_phone, buyer_id,
      product_id, product_name, product_price, pack_name, items,
      status, stage, assigned_seller_id,
      seller_name, seller_role, seller_avatar,
      involved_seller_ids, writer_seller_ids, invited_seller_ids, invited_by,
      address, address_verified, address_lat, address_lng, nota,
      dispatch_type, agency_name, delivery_reference,
      payment_verification, payment_reason, advance_voucher_url,
      advance_yape_code, advance_amount,
      expires_at, created_at
    `)
    .eq('token', token)
    .single()

  if (error || !session) {
    return new Response('Not found', { status: 404, headers: corsHeaders })
  }

  // Always resolve fresh seller info from sellers table (name/photo can change)
  let sellerName = session.seller_name
  let sellerRole = session.seller_role
  let sellerAvatar = session.seller_avatar

  if (session.assigned_seller_id) {
    const { data: seller } = await supabase
      .from('sellers')
      .select('nombre, role_label, avatar_url')
      .eq('auth_user_id', session.assigned_seller_id)
      .maybeSingle()

    if (seller) {
      sellerName = seller.nombre
      sellerRole = seller.role_label
      sellerAvatar = seller.avatar_url
      // Cache it back to the session if changed
      if (
        seller.nombre !== session.seller_name ||
        seller.role_label !== session.seller_role ||
        seller.avatar_url !== session.seller_avatar
      ) {
        await supabase
          .from('order_sessions')
          .update({ seller_name: seller.nombre, seller_role: seller.role_label, seller_avatar: seller.avatar_url })
          .eq('id', session.id)
      }
    }
  }

  // Whether this buyer may place outbound calls (enabled manually for top clients)
  let buyerCanCall = false
  if (session.buyer_id) {
    const { data: b } = await supabase
      .from('buyers')
      .select('can_call')
      .eq('id', session.buyer_id)
      .maybeSingle()
    buyerCanCall = !!b?.can_call
  }

  // Header participants = current OWNER + people EXPLICITLY invited (not the
  // whole hand-off history). Each carries who invited them so the client can
  // show an expel button only to the inviter.
  const invited: string[] = session.invited_seller_ids ?? []
  const invitedBy: Record<string, string | null> = session.invited_by ?? {}
  const chipIds = [session.assigned_seller_id, ...invited].filter(Boolean) as string[]
  let participants: {
    id: string; nombre: string; role_label: string; avatar_url: string | null
    can_write: boolean; is_owner: boolean; invited_by: string | null
  }[] = []
  if (chipIds.length > 0) {
    const { data: people } = await supabase
      .from('sellers')
      .select('auth_user_id, nombre, role_label, avatar_url')
      .in('auth_user_id', chipIds)
    participants = (people ?? []).map((p: any) => ({
      id: p.auth_user_id,
      nombre: p.nombre,
      role_label: p.role_label,
      avatar_url: p.avatar_url,
      is_owner: p.auth_user_id === session.assigned_seller_id,
      can_write: true,
      invited_by: invitedBy[p.auth_user_id] ?? null,
    }))
    // keep owner first, then invited in order
    participants.sort((a, b) => (a.is_owner === b.is_owner ? 0 : a.is_owner ? -1 : 1))
  }

  // Fetch messages — the buyer never sees seller-only entries (e.g. expulsions)
  let mq = supabase
    .from('chat_messages')
    .select('id, session_id, sender_role, sender_name, sender_role_label, type, body, media_url, offer, visibility, created_at, read_at')
    .eq('session_id', session.id)
    .order('created_at', { ascending: true })
  if (!viewerIsSeller) mq = mq.or('visibility.is.null,visibility.eq.all')
  const { data: messages } = await mq

  // Campos SOLO de Ventas. `payment_reason` es el veredicto interno del cruce
  // ("el nombre no coincide", "el código no calza") y `advance_voucher_url` es
  // la ruta del comprobante en el bucket privado. Mandárselos al comprador
  // repetiría la fuga que ya se corrigió en los mensajes del chat: da igual que
  // la UI no los pinte, viajan en la respuesta y quedan a la vista de cualquiera
  // que mire la red.
  const sellerOnly = viewerIsSeller
    ? {}
    : { payment_reason: undefined, advance_voucher_url: undefined }

  return new Response(
    JSON.stringify({
      session: {
        ...session, ...sellerOnly,
        seller_name: sellerName, seller_role: sellerRole, seller_avatar: sellerAvatar,
        participants, buyer_can_call: buyerCanCall,
      },
      viewer_is_seller: viewerIsSeller,
      messages: messages ?? [],
    }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  )
})
