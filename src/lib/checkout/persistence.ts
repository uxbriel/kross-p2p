// ─── SALES ENGINE · Persistencia del borrador ────────────────────────────────
// Guarda el checkout en localStorage por `orderId`. Si el comprador recarga o
// vuelve del anuncio de Meta, retoma en el mismo paso con la data intacta.
// Expira a las 24 h. Ver docs/01-SALES-ENGINE.md.
//
// Nunca revienta: si localStorage está lleno, deshabilitado o en modo privado,
// el checkout sigue funcionando sin persistencia.

import { DRAFT_STORAGE_PREFIX, DRAFT_TTL_MS } from './checkout.config'
import { initialCheckoutState } from './machine'
import type { CheckoutState } from './types'

/** Puntero al borrador activo, para poder recuperarlo sin conocer el orderId. */
const ACTIVE_KEY = `${DRAFT_STORAGE_PREFIX}active`

interface StoredDraft {
  savedAt: number
  state: CheckoutState
}

const keyFor = (orderId: string): string => `${DRAFT_STORAGE_PREFIX}${orderId}`

export function saveDraft(state: CheckoutState): void {
  // Un pedido ya enviado no es un borrador: se limpia para no reabrirlo.
  if (state.status === 'SUBMITTED') return clearDraft(state.orderId)
  try {
    const payload: StoredDraft = { savedAt: Date.now(), state }
    localStorage.setItem(keyFor(state.orderId), JSON.stringify(payload))
    localStorage.setItem(ACTIVE_KEY, state.orderId)
  } catch {
    // Cuota llena o storage bloqueado: seguir sin persistir es preferible a
    // romperle el checkout al comprador.
  }
}

const finite = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

/**
 * Completa un borrador guardado por una versión ANTERIOR del checkout con los
 * valores por defecto de hoy. Rellenar es mejor que descartar: el borrador es el
 * avance del comprador, y tirarlo por un campo nuevo le cuesta la venta.
 *
 * Pasó de verdad: los borradores anteriores a `discountPen` volvían sin ese
 * campo, y el paso 1 hacía `precio - undefined` → **todos los packs mostraban
 * `S/NaN`**. Un comprador que ve NaN donde va el precio no compra.
 */
function hydrate(saved: CheckoutState): CheckoutState {
  const base = initialCheckoutState()
  return {
    ...base,
    ...saved,
    // Los objetos anidados se completan aparte: el spread de arriba los
    // reemplaza enteros, así que un campo nuevo dentro de ellos se perdería.
    customerInfo: { ...base.customerInfo, ...saved.customerInfo },
    payment: { ...base.payment, ...saved.payment },
    // Los números que entran a aritmética se validan de verdad, no solo por
    // ausencia: basta un `null` guardado para propagar NaN a toda la pantalla.
    discountPen: finite(saved.discountPen, base.discountPen),
    advanceYapeCode: typeof saved.advanceYapeCode === 'string' ? saved.advanceYapeCode : '',
    advanceAmount: finite(saved.advanceAmount, base.advanceAmount),
    // El estado de envío no sobrevive a la recarga: se retoma como borrador.
    status: 'DRAFT',
  }
}

function readDraft(orderId: string): CheckoutState | null {
  try {
    const raw = localStorage.getItem(keyFor(orderId))
    if (!raw) return null

    const parsed = JSON.parse(raw) as Partial<StoredDraft>
    if (!parsed?.state || typeof parsed.savedAt !== 'number') return null

    if (Date.now() - parsed.savedAt > DRAFT_TTL_MS) {
      clearDraft(orderId)
      return null
    }
    // Sin estas dos llaves no hay nada que retomar: eso sí se descarta.
    if (!parsed.state.orderId || typeof parsed.state.step !== 'number') return null

    return hydrate(parsed.state)
  } catch {
    return null
  }
}

/** Borrador activo si sigue vigente. Es lo que se llama al abrir el modal. */
export function loadActiveDraft(): CheckoutState | null {
  try {
    const orderId = localStorage.getItem(ACTIVE_KEY)
    return orderId ? readDraft(orderId) : null
  } catch {
    return null
  }
}

export function clearDraft(orderId: string): void {
  try {
    localStorage.removeItem(keyFor(orderId))
    if (localStorage.getItem(ACTIVE_KEY) === orderId) localStorage.removeItem(ACTIVE_KEY)
  } catch {
    // ignorar
  }
}

/** Barre borradores vencidos. Se llama al abrir el modal, no en cada guardado. */
export function purgeExpiredDrafts(): void {
  try {
    const now = Date.now()
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(DRAFT_STORAGE_PREFIX) || key === ACTIVE_KEY) continue
      try {
        const parsed = JSON.parse(localStorage.getItem(key) ?? '') as Partial<StoredDraft>
        if (typeof parsed?.savedAt !== 'number' || now - parsed.savedAt > DRAFT_TTL_MS) {
          localStorage.removeItem(key)
        }
      } catch {
        localStorage.removeItem(key) // entrada corrupta
      }
    }
  } catch {
    // ignorar
  }
}

// ─── Último pedido cerrado ───────────────────────────────────────────────────
// Al cerrar la ventana de confirmación, el comprador se queda en la landing sin
// ninguna vía de volver a su pedido: el token vivía solo en memoria del modal y
// se perdía. Feedback real de compradores. Guardarlo permite que la landing
// ofrezca "Ver mi pedido" mientras el pedido está fresco.
const LAST_ORDER_KEY = 'kross_last_order'
/** Se ofrece por 3 días: pasado ese plazo la entrega ya ocurrió o el chat dejó
 *  de ser lo relevante, y un botón viejo en la landing solo confunde. */
const LAST_ORDER_TTL_MS = 3 * 24 * 60 * 60 * 1000

export interface LastOrder {
  token: string
  orderCode: string
  productId: string | null
  savedAt: number
}

export function saveLastOrder(token: string, orderCode: string, productId: string | null): void {
  try {
    localStorage.setItem(LAST_ORDER_KEY, JSON.stringify({
      token, orderCode, productId, savedAt: Date.now(),
    } satisfies LastOrder))
  } catch { /* modo incógnito o storage lleno: perder esto no rompe nada */ }
}

export function loadLastOrder(): LastOrder | null {
  try {
    const raw = localStorage.getItem(LAST_ORDER_KEY)
    if (!raw) return null
    const o = JSON.parse(raw) as LastOrder
    if (!o?.token || Date.now() - o.savedAt > LAST_ORDER_TTL_MS) {
      localStorage.removeItem(LAST_ORDER_KEY)
      return null
    }
    return o
  } catch {
    return null
  }
}
