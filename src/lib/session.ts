import { toStage } from './order-stages'
import type { OrderStage } from './order-stages'
// ─── CONTRATO CENTRAL DEL CLIENTE (Core) ─────────────────────────────────────
// Fuente única de verdad que los 3 módulos (Sales / Logistics / Loyalty) leen y
// escriben. NO es una tabla: se ENSAMBLA en lectura desde `buyers` + `order_sessions`.
// Ver docs/00-CORE-ARCHITECTURE.md. Este archivo reemplaza al viejo src/types/index.ts
// (que era el modelo mock de seed.ts) para todo lo que toque datos reales.

export type PaymentMethod = 'YAPE_PLIN' | 'CONTRAENTREGA' | 'TARJETA'
export type DispatchType = 'MOTORIZADO_LIMA' | 'AGENCIA_PROVINCIA'
export type AgencyName = 'SHALOM' | 'OLVA' | 'OTRO'
export type ClosedBy = 'AI_CLOSER' | 'DIRECT_CHECKOUT'

// Etapas REALES del pedido (alineadas a order_sessions.stage)
// El tipo vive en `order-stages.ts` junto con el orden y las etiquetas: tenerlo
// aquí duplicado ya provocó que una pantalla mostrara un orden y otra, otro.
export type { OrderStage } from './order-stages'

// El objeto que define el spec (docs). Es la vista unificada del cliente + su pedido.
export interface MerchantCustomerSession {
  customer: {
    dni: string | null
    fullName: string | null
    phone: string | null
  }
  delivery: {
    lat: number | null
    lng: number | null
    addressText: string | null
    reference: string | null
    dispatchType: DispatchType
    agencyName?: AgencyName | null
  }
  sale: {
    productId: string | null
    productName: string | null
    productPrice: number | null
    paymentMethod: PaymentMethod
    closedBy: ClosedBy
    stage: OrderStage
  }
  loyalty: {
    points: number
    pointsEarned: number
    nextReorderDate: string | null // derivado en Loyalty; null hasta que se calcule
  }
}

// Forma cruda que devuelve get-session (order_sessions) — solo lo que consumimos aquí.
export interface RawOrderSession {
  buyer_phone?: string | null
  buyer_name?: string | null
  product_id?: string | null
  product_name?: string | null
  product_price?: number | null
  stage?: string | null
  address?: string | null
  address_lat?: number | null
  address_lng?: number | null
  payment_method?: string | null
  dispatch_type?: string | null
  agency_name?: string | null
  delivery_reference?: string | null
  closed_by?: string | null
}

// Datos del comprador (buyers) que enriquecen la sesión.
export interface RawBuyer {
  document_number?: string | null
  nombre?: string | null
  phone?: string | null
  puntos?: number | null
}

// ─── LECTOR ÚNICO ─────────────────────────────────────────────────────────────
// Ensambla el estado central desde el pedido (+ opcionalmente el comprador). Todos
// los módulos deben leer la sesión por aquí, no armando su propia forma.
export function toCustomerSession(order: RawOrderSession, buyer?: RawBuyer | null): MerchantCustomerSession {
  const asStage = (s?: string | null): OrderStage =>
    toStage(s)

  return {
    customer: {
      dni: buyer?.document_number ?? null,
      fullName: buyer?.nombre ?? order.buyer_name ?? null,
      phone: buyer?.phone ?? order.buyer_phone ?? null,
    },
    delivery: {
      lat: order.address_lat ?? null,
      lng: order.address_lng ?? null,
      addressText: order.address ?? null,
      reference: order.delivery_reference ?? null,
      dispatchType: (order.dispatch_type as DispatchType) ?? 'MOTORIZADO_LIMA',
      agencyName: (order.agency_name as AgencyName) ?? null,
    },
    sale: {
      productId: order.product_id ?? null,
      productName: order.product_name ?? null,
      productPrice: order.product_price ?? null,
      paymentMethod: (order.payment_method as PaymentMethod) ?? 'CONTRAENTREGA',
      closedBy: (order.closed_by as ClosedBy) ?? 'DIRECT_CHECKOUT',
      stage: asStage(order.stage),
    },
    loyalty: {
      points: buyer?.puntos ?? 0,
      pointsEarned: 0,
      nextReorderDate: null,
    },
  }
}
