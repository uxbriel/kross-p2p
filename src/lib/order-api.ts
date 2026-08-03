import type { OrderStage } from './order-stages'
const BASE = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`
const ANON = import.meta.env.VITE_SUPABASE_ANON_KEY as string

export interface OrderSession {
  id: string
  order_id: string
  store_id: string | null
  product_id: string | null
  buyer_id: string | null
  buyer_name: string | null
  product_name: string | null
  product_price: number | null
  pack_name: string | null
  status: 'active' | 'delivered' | 'rejected' | 'expired' | 'cancelado'
  stage: OrderStage
  expires_at: string | null
  seller_name: string | null
  seller_role: string | null
  seller_avatar: string | null
  address?: string | null
  address_verified?: boolean
  address_lat?: number | null
  address_lng?: number | null
  nota?: string | null
  /** Cómo se entrega: `MOTORIZADO_LIMA` (a la puerta) o `AGENCIA_PROVINCIA`
   *  (mostrador). Decide si tiene sentido pedir GPS — en agencia no lo tiene. */
  dispatch_type?: string | null
  agency_name?: string | null
  delivery_reference?: string | null
  /** Estado del cruce del adelanto por Yape. */
  payment_verification?: string | null
  /** Motivo escrito por el cruce: nombre distinto, código que no calza, etc. */
  payment_reason?: string | null
  /** Ruta en el bucket privado `vouchers`. NUNCA es una URL abrible: se pide
   *  firmada a la función `voucher-url` en el momento de mirarla. */
  advance_voucher_url?: string | null
  advance_yape_code?: string | null
  advance_amount?: number | string | null
  items?: OrderItem[] | null
  buyer_can_call?: boolean
  assigned_seller_id?: string | null
  involved_seller_ids?: string[] | null
  writer_seller_ids?: string[] | null
  participants?: Participant[]
}

export interface OrderItem {
  product_id?: string | null
  nombre: string
  precio: number          // total de la línea (qty incluida)
  unit_price?: number     // precio de 1 unidad
  qty?: number
  pack_name?: string | null
  image?: string | null
}

export interface Participant {
  id: string
  nombre: string
  role_label: string
  avatar_url: string | null
  can_write: boolean
  is_owner?: boolean
  invited_by?: string | null
}

export interface OrderMessage {
  id: string
  session_id: string
  sender_role: 'buyer' | 'seller' | 'courier' | 'system' | 'sofia'
  sender_name: string | null
  sender_role_label?: string | null
  visibility?: 'all' | 'sellers' | null
  type: 'text' | 'audio' | 'image' | 'call_log' | 'status_update' | 'offer'
  body: string | null
  media_url: string | null
  offer?: { product_id?: string; nombre: string; precio: number; image?: string | null; accepted?: boolean } | null
  created_at: string
  read_at: string | null
}

export interface SessionData {
  session: OrderSession
  messages: OrderMessage[]
}

export async function getSession(token: string): Promise<SessionData> {
  const res = await fetch(`${BASE}/get-session`, {
    headers: {
      Authorization: `Bearer ${ANON}`,
      'x-kross-token': token,
    },
  })
  if (res.status === 404) throw new Error('not_found')
  if (!res.ok) throw new Error('server_error')
  return res.json()
}

export async function sendMessage(
  token: string,
  payload: { type: 'text' | 'audio' | 'image'; body?: string; media_url?: string }
): Promise<OrderMessage> {
  const res = await fetch(`${BASE}/send-message`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ANON}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ token, ...payload }),
  })
  if (!res.ok) throw new Error('send_failed')
  return res.json()
}

export async function markRead(token: string): Promise<void> {
  await fetch(`${BASE}/mark-read`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ANON}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ token }),
  })
}
