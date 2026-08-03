// ─── SALES ENGINE · Regla de cruce pago ↔ pedido ─────────────────────────────
// El cruce ocurre en los DOS sentidos y con segundos de diferencia:
//
//   · el comprador yapea y DESPUÉS termina el pedido → el pago ya estaba guardado
//   · el comprador termina el pedido y DESPUÉS yapea → el pago llega al rato
//
// Las dos direcciones tienen que decidir igual, así que la regla vive aquí una
// sola vez y la usan `yape-ingest` y `register-buyer`. Funciones puras: se
// prueban sin base de datos.
//
// Jerarquía de la decisión, de fuerte a débil:
//   1. Código de seguridad tecleado por el comprador. Es lo único que no se
//      puede adivinar mirando el monto. Si calza, cuadra.
//   2. Monto, y SOLO si hay un único candidato. Con dos pedidos de S/10
//      esperando, elegir "el más antiguo" acierta la mitad de las veces — y la
//      otra mitad le da por pagado el pedido a quien no pagó.
//   3. Nada. Va a revisión humana con el motivo escrito.
//
// El NOMBRE nunca decide. En COD paga la mamá, el vecino o el esposo: rechazar
// por nombre distinto sería rechazar pagos reales. Solo se anota como aviso.

import { nameMatches } from './yape.ts'

export interface PendingOrder {
  id: string
  order_id: string
  buyer_name: string | null
  advance_amount: number | string | null
  /** Código que TECLEÓ el comprador al subir su comprobante. */
  advance_yape_code: string | null
}

export interface StoredPayment {
  id: string
  amount_pen: number | string | null
  sender_name: string | null
  security_code: string | null
}

export interface MatchDecision<T> {
  chosen: T | null
  /** Por qué no cuadró, o qué revisar aunque haya cuadrado. Nunca se le muestra
   *  al comprador: decirle "tu pago no existe" por un fallo nuestro es fatal. */
  reason: string | null
  /**
   * El código identifica el pago sin lugar a dudas, pero el MONTO no alcanza.
   * El pedido y el pago se enlazan igual —para que Ventas los vea juntos— pero
   * **NO se da por verificado**: falta plata, y eso lo resuelve una persona.
   *
   * Pasó de verdad: un comprador tecleó 195, pagó S/0.50 de los S/10 y el
   * algoritmo filtraba por monto ANTES de mirar el código. Los dos quedaban
   * huérfanos y nadie sabía que iban juntos.
   */
  shortPaid?: boolean
}

/** Dinero en céntimos: `10.1 - 10` no da 0 en punto flotante. */
const cents = (n: number | string | null | undefined): number => Math.round(Number(n ?? 0) * 100)

const code = (s: string | null | undefined): string => (s ?? '').trim()

/** Un pago recién llegado contra los pedidos que esperan adelanto. */
export function matchPaymentToOrders(
  payment: StoredPayment,
  orders: PendingOrder[],
): MatchDecision<PendingOrder> {
  const amount = cents(payment.amount_pen)
  const sameAmount = orders.filter(o => cents(o.advance_amount) === amount)

  // El código se busca en TODOS los pedidos, no solo en los del mismo monto: es
  // la evidencia más fuerte que existe —el comprador lo tecleó ANTES de pagar—
  // y filtrar por monto primero la desperdiciaba.
  const byCode = code(payment.security_code)
    ? orders.find(o => code(o.advance_yape_code) === code(payment.security_code))
    : undefined
  if (byCode) {
    const short = cents(byCode.advance_amount) !== amount
    return {
      chosen: byCode,
      shortPaid: short || undefined,
      reason: short
        ? `Pagó S/${money(payment.amount_pen)} de los S/${money(byCode.advance_amount)} esperados (código ${code(payment.security_code)}). Falta cobrar la diferencia.`
        : nameWarning(payment.sender_name, byCode.buyer_name),
    }
  }

  if (sameAmount.length === 1) {
    const only = sameAmount[0]
    return {
      chosen: only,
      reason: codeWarning(code(only.advance_yape_code), code(payment.security_code))
        ?? nameWarning(payment.sender_name, only.buyer_name),
    }
  }
  if (sameAmount.length > 1) {
    return { chosen: null, reason: `${sameAmount.length} pedidos esperan S/${money(payment.amount_pen)}: sin código no se puede decidir` }
  }
  return { chosen: null, reason: `Sin pedido pendiente por S/${money(payment.amount_pen)}` }
}

/** Un pedido recién creado contra los pagos que entraron y nadie consumió. */
export function matchOrderToPayments(
  order: PendingOrder,
  payments: StoredPayment[],
): MatchDecision<StoredPayment> {
  const amount = cents(order.advance_amount)
  const sameAmount = payments.filter(p => cents(p.amount_pen) === amount)

  // Igual que en el otro sentido: el código manda sobre el monto.
  const byCode = code(order.advance_yape_code)
    ? payments.find(p => code(p.security_code) === code(order.advance_yape_code))
    : undefined
  if (byCode) {
    const short = cents(byCode.amount_pen) !== amount
    return {
      chosen: byCode,
      shortPaid: short || undefined,
      reason: short
        ? `Pagó S/${money(byCode.amount_pen)} de los S/${money(order.advance_amount)} esperados (código ${code(order.advance_yape_code)}). Falta cobrar la diferencia.`
        : nameWarning(byCode.sender_name, order.buyer_name),
    }
  }

  if (sameAmount.length === 1) {
    const only = sameAmount[0]
    return {
      chosen: only,
      reason: codeWarning(code(order.advance_yape_code), code(only.security_code))
        ?? nameWarning(only.sender_name, order.buyer_name),
    }
  }
  if (sameAmount.length > 1) {
    return { chosen: null, reason: `${sameAmount.length} pagos de S/${money(order.advance_amount)} sin asignar: los revisa una persona` }
  }
  return { chosen: null, reason: null } // lo normal: el pago todavía no llega
}

/**
 * El comprador tecleó un código y el pago traía OTRO, pero el monto calzaba y
 * era el único candidato. Se acepta —tipear mal 3 dígitos es de lo más común y
 * el monto ya es evidencia fuerte— pero queda anotado: es el mismo síntoma de
 * alguien copiando el código de un comprobante ajeno, y eso lo mira una persona.
 */
function codeWarning(typed: string, fromYape: string): string | null {
  if (!typed || !fromYape || typed === fromYape) return null
  return `Cuadró por monto, pero el código no coincide (tecleado: ${typed} · Yape: ${fromYape})`
}

function nameWarning(fromYape: string | null, fromBuyer: string | null): string | null {
  if (!fromYape || !fromBuyer) return null
  return nameMatches(fromYape, fromBuyer)
    ? null
    : `Monto correcto pero el nombre no coincide (Yape: ${fromYape} · pedido: ${fromBuyer})`
}

const money = (n: number | string | null | undefined): string => String(Number(n ?? 0))
