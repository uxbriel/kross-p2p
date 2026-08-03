// ─── SALES ENGINE · Cierre del pedido ────────────────────────────────────────
// Traduce el `CheckoutState` al contrato de `register-buyer` y sube el
// comprobante. Es lo único del checkout que habla con Supabase, para que los
// componentes no conozcan la forma del backend.
//
// Idempotencia: `checkout_id` es el uuid que nació al abrir el modal. Si el
// comprador toca dos veces con 4G lenta, el backend devuelve el pedido ya
// creado en vez de crear otro. Ver docs/01-SALES-ENGINE.md §3.1.

import { supabase } from '../../supabase'
import { IMAGE_PRESETS, downscaleImage } from '../../images/downscale'
import { VOUCHER } from '../checkout.config'
import type { CheckoutState } from '../types'

const BASE = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`
const ANON = import.meta.env.VITE_SUPABASE_ANON_KEY as string

export interface SubmitContext {
  storeId: string
  productId: string | null
  productName: string
  /** Precio del pack elegido, con el descuento de retención ya aplicado. */
  price: number
  packName: string | null
}

export interface SubmitResult {
  id: string
  order_id: string
  token: string
  /** El backend devolvió un pedido que ya existía: fue un doble envío. */
  idempotent?: boolean
}

/** Dirección legible del pedido, según la rama. Es lo que ve Logística. */
function addressOf(s: CheckoutState): string | null {
  if (s.locationType === 'LIMA') {
    const a = s.limaAddress
    if (!a) return null
    return [a.addressText, a.district].filter(Boolean).join(', ') || null
  }
  const p = s.provinciaConfig
  if (!p) return null
  if (p.deliveryMethod === 'DOMICILIO') {
    return [p.address?.addressText, p.district, p.province].filter(Boolean).join(', ') || null
  }
  // Agencia: la dirección del pedido es el destino, no la casa.
  return [p.district, p.province, p.department].filter(Boolean).join(', ') || null
}

/** Referencia de la puerta (domicilio) o sede de recojo (agencia). */
function referenceOf(s: CheckoutState): string | null {
  if (s.locationType === 'LIMA') return s.limaAddress?.reference?.trim() || null
  const p = s.provinciaConfig
  if (!p) return null
  if (p.deliveryMethod === 'DOMICILIO') return p.address?.reference?.trim() || null
  return p.selectedAgencyBranchId ?? p.olvaBranchText?.trim() ?? null
}

export async function submitOrder(s: CheckoutState, ctx: SubmitContext): Promise<SubmitResult> {
  const isProvincia = s.locationType === 'PROVINCIA'
  const usesAgency = isProvincia && s.provinciaConfig?.deliveryMethod === 'AGENCIA'

  const res = await fetch(`${BASE}/register-buyer`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      checkout_id: s.orderId,
      store_id: ctx.storeId,
      product_id: ctx.productId ?? undefined,
      product_name: ctx.productName,
      product_price: ctx.price,
      pack_name: ctx.packName ?? undefined,
      buyer_name: s.customerInfo.receiverName.trim(),
      buyer_phone: s.customerInfo.whatsapp,
      // El DNI solo existe en provincia; en Lima la cuenta se crea por teléfono.
      document_type: s.customerInfo.dni ? 'DNI' : undefined,
      document_number: s.customerInfo.dni || undefined,
      address: addressOf(s) ?? undefined,
      delivery_reference: referenceOf(s) ?? undefined,
      dispatch_type: usesAgency ? 'AGENCIA_PROVINCIA' : 'MOTORIZADO_LIMA',
      agency_name: usesAgency ? (s.provinciaConfig?.selectedAgency ?? undefined) : undefined,
      payment_method: s.advanceAmount > 0 ? 'YAPE_PLIN' : 'CONTRAENTREGA',
      closed_by: 'DIRECT_CHECKOUT',
      advance_amount: s.advanceAmount,
      advance_yape_code: s.advanceYapeCode || undefined,
      advance_voucher_url: s.paymentVoucher?.url || undefined,
    }),
  })

  if (!res.ok) {
    const detail = await res.json().catch(() => ({} as { error?: string }))
    throw new Error(detail.error ?? `register-buyer respondió ${res.status}`)
  }
  return await res.json() as SubmitResult
}

/**
 * Sube la captura del comprobante al bucket privado `vouchers` y devuelve su
 * ruta (no una URL pública: el bucket no lo es, y una captura de Yape lleva
 * nombre y teléfono). El equipo la abre con URL firmada desde el backend.
 *
 * Se reduce antes de subirla: el comprador está en 4G y la foto pesa megas.
 */
export async function uploadVoucher(file: File, orderId: string): Promise<string> {
  if (file.size > VOUCHER.maxBytes) throw new Error('La imagen pesa demasiado')

  const small = await downscaleImage(file, IMAGE_PRESETS.voucher)
  const path = `${orderId}/${Date.now()}.jpg`
  // Sin `upsert`: la ruta ya es única (orderId + timestamp), así que nunca hay
  // nada que reemplazar. Pedirlo obliga a Storage a resolver el camino de
  // UPDATE, y el bucket `vouchers` solo tiene política de INSERT — de ahí el
  // "violates row-level security policy" que veía el comprador al adjuntar. Es
  // el MISMO fallo que ya se corrigió en las fotos de producto.
  const { error } = await supabase.storage
    .from(VOUCHER.bucket).upload(path, small, { contentType: small.type })
  if (error) throw new Error(error.message)
  return path
}

/**
 * Estado del cruce del adelanto, para que la pantalla final deje de decir
 * "estamos verificando" cuando el yape ya cuadró.
 *
 * Nunca lanza: esto es un adorno sobre un pedido que YA está registrado, así
 * que un error de red se traga en silencio. Alarmar al comprador por una
 * consulta fallida sería peor que no mostrar nada.
 */
export async function fetchPaymentVerification(token: string): Promise<string | null> {
  try {
    const res = await fetch(`${BASE}/get-session`, { headers: { 'x-kross-token': token } })
    if (!res.ok) return null
    const body = await res.json() as { session?: { payment_verification?: string | null } }
    return body.session?.payment_verification ?? null
  } catch {
    return null
  }
}
