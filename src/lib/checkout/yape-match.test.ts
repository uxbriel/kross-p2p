// Tests de la regla que decide si un pago Yape cuadra con un pedido.
// Es la lógica con más consecuencia del checkout: un falso positivo le da por
// pagado el adelanto a alguien que no pagó, y el paquete sale igual.
//
// Importa el módulo compartido que corre en las dos Edge Functions
// (`yape-ingest` y `register-buyer`), no una copia.

import { describe, expect, it } from 'vitest'
import {
  matchOrderToPayments, matchPaymentToOrders,
} from '../../../supabase/functions/_shared/yape-match'
import type { PendingOrder, StoredPayment } from '../../../supabase/functions/_shared/yape-match'

const order = (o: Partial<PendingOrder> = {}): PendingOrder => ({
  id: 'o1', order_id: 'ORD-1', buyer_name: 'Juan Carlos Pérez',
  advance_amount: 10, advance_yape_code: null, ...o,
})

const payment = (p: Partial<StoredPayment> = {}): StoredPayment => ({
  id: 'p1', amount_pen: 10, sender_name: 'Juan Carlos P.', security_code: null, ...p,
})

describe('pago → pedido', () => {
  it('el código de seguridad manda sobre todo lo demás', () => {
    const orders = [
      order({ id: 'a', advance_yape_code: '111' }),
      order({ id: 'b', advance_yape_code: '222' }),
    ]
    expect(matchPaymentToOrders(payment({ security_code: '222' }), orders).chosen?.id).toBe('b')
  })

  it('sin código, un único pedido del mismo monto cuadra', () => {
    expect(matchPaymentToOrders(payment(), [order({ id: 'a' })]).chosen?.id).toBe('a')
  })

  // El caso que hace perder plata: dos pedidos esperando lo mismo. Elegir "el
  // más antiguo" acierta la mitad de las veces y la otra mitad regala un envío.
  it('con dos pedidos del mismo monto y sin código NO elige: va a revisión', () => {
    const d = matchPaymentToOrders(payment(), [order({ id: 'a' }), order({ id: 'b' })])
    expect(d.chosen).toBeNull()
    expect(d.reason).toMatch(/2 pedidos/)
  })

  it('un monto distinto no cuadra nunca', () => {
    const d = matchPaymentToOrders(payment({ amount_pen: 20 }), [order({ advance_amount: 10 })])
    expect(d.chosen).toBeNull()
    expect(d.reason).toMatch(/Sin pedido pendiente/)
  })

  it('compara céntimos, no flotantes', () => {
    expect(matchPaymentToOrders(
      payment({ amount_pen: 10.1 }), [order({ advance_amount: '10.10' })],
    ).chosen).not.toBeNull()
  })

  // En COD paga la mamá, el vecino o el esposo. Rechazar por nombre distinto
  // sería rechazar pagos reales: cuadra igual, pero deja el aviso escrito.
  it('un nombre distinto NO bloquea el match, solo avisa', () => {
    const d = matchPaymentToOrders(payment({ sender_name: 'Rosa Quispe' }), [order()])
    expect(d.chosen).not.toBeNull()
    expect(d.reason).toMatch(/nombre no coincide/)
  })

  it('el apellido abreviado de Yape no cuenta como nombre distinto', () => {
    expect(matchPaymentToOrders(payment({ sender_name: 'Juan Carlos P.' }), [order()]).reason).toBeNull()
  })
})

describe('pedido → pago (el pago llegó primero)', () => {
  it('encuentra el pago que ya estaba guardado', () => {
    expect(matchOrderToPayments(order(), [payment({ id: 'p9' })]).chosen?.id).toBe('p9')
  })

  it('el código también manda en este sentido', () => {
    const pagos = [payment({ id: 'x', security_code: '111' }), payment({ id: 'y', security_code: '222' })]
    expect(matchOrderToPayments(order({ advance_yape_code: '222' }), pagos).chosen?.id).toBe('y')
  })

  it('dos pagos iguales sin código van a revisión', () => {
    const d = matchOrderToPayments(order(), [payment({ id: 'x' }), payment({ id: 'y' })])
    expect(d.chosen).toBeNull()
    expect(d.reason).toMatch(/2 pagos/)
  })

  // Lo más común: el comprador todavía no yapea. No es un problema y no debe
  // ensuciar el chat del pedido con una advertencia.
  it('sin pagos pendientes no cuadra y no inventa un motivo', () => {
    const d = matchOrderToPayments(order(), [])
    expect(d.chosen).toBeNull()
    expect(d.reason).toBeNull()
  })

  it('Lima (adelanto 0) no cuadra con un pago de S/10', () => {
    expect(matchOrderToPayments(order({ advance_amount: 0 }), [payment()]).chosen).toBeNull()
  })
})

// ─── El comprador tecleó un código que no era ────────────────────────────────
// Tipear mal 3 dígitos es lo más común del mundo, así que el monto sigue
// mandando y el pedido cuadra. Pero es TAMBIÉN el síntoma de alguien copiando
// el código de un comprobante ajeno: se acepta y se deja anotado para revisión.
describe('código tecleado que no coincide', () => {
  it('cuadra igual por monto, pero deja la advertencia', () => {
    const d = matchPaymentToOrders(
      payment({ security_code: '746' }),
      [order({ advance_yape_code: '123' })],
    )
    expect(d.chosen?.id).toBe('o1')
    expect(d.reason).toMatch(/código no coincide.*123.*746/)
  })

  it('avisa igual en el sentido inverso (el pedido llega después del pago)', () => {
    const d = matchOrderToPayments(
      order({ advance_yape_code: '123' }),
      [payment({ security_code: '746' })],
    )
    expect(d.chosen?.id).toBe('p1')
    expect(d.reason).toMatch(/código no coincide/)
  })

  it('sin código tecleado no inventa advertencia: no todos suben comprobante', () => {
    const d = matchPaymentToOrders(payment({ security_code: '746' }), [order()])
    expect(d.chosen?.id).toBe('o1')
    expect(d.reason).toBeNull()
  })

  it('cuando el código SÍ calza, no hay nada que advertir', () => {
    const d = matchPaymentToOrders(
      payment({ security_code: '746' }),
      [order({ advance_yape_code: '746' })],
    )
    expect(d.reason).toBeNull()
  })
})

// ─── Pagó de menos ───────────────────────────────────────────────────────────
// Caso REAL (31-jul-2026): el comprador tecleó 195, su pedido esperaba S/10 y
// yapeó S/0.50 con ese mismo código. El algoritmo filtraba por monto ANTES de
// mirar el código, así que pago y pedido quedaban huérfanos y nadie sabía que
// iban juntos. El código es la evidencia más fuerte que existe —se teclea ANTES
// de pagar— y ahora manda sobre el monto.
describe('el código manda sobre el monto', () => {
  it('identifica el pedido aunque el monto no alcance', () => {
    const d = matchPaymentToOrders(
      payment({ amount_pen: 0.5, security_code: '195' }),
      [order({ advance_amount: 10, advance_yape_code: '195' })],
    )
    expect(d.chosen?.id).toBe('o1')
    expect(d.shortPaid).toBe(true)
    expect(d.reason).toMatch(/0\.5.*10.*[Ff]alta cobrar/)
  })

  it('con el monto completo NO marca falta de pago', () => {
    const d = matchPaymentToOrders(
      payment({ amount_pen: 10, security_code: '195' }),
      [order({ advance_amount: 10, advance_yape_code: '195' })],
    )
    expect(d.shortPaid).toBeUndefined()
  })

  it('avisa igual en el sentido inverso', () => {
    const d = matchOrderToPayments(
      order({ advance_amount: 10, advance_yape_code: '195' }),
      [payment({ amount_pen: 0.5, security_code: '195' })],
    )
    expect(d.chosen?.id).toBe('p1')
    expect(d.shortPaid).toBe(true)
  })

  it('sin código no inventa cruces entre montos distintos', () => {
    // Aquí NO hay evidencia de que vayan juntos: sin código, un monto distinto
    // es simplemente otro pago. Enlazarlos sería adivinar.
    const d = matchPaymentToOrders(
      payment({ amount_pen: 0.5, security_code: null }),
      [order({ advance_amount: 10, advance_yape_code: '195' })],
    )
    expect(d.chosen).toBeNull()
  })
})
