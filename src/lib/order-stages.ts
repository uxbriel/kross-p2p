// ─── Etapas del pedido ───────────────────────────────────────────────────────
// Estaban copiadas en seis archivos. Cada copia era una oportunidad de que una
// pantalla mostrara un orden distinto al de otra — y con la llegada de
// `validando` eso dejó de ser hipotético.
//
// `validando` existe porque un pedido con adelanto quedaba en "Pedido" desde que
// el comprador pagaba hasta que alguien lo confirmaba: pagó y su barra no se
// movía. Sin señal de avance, el siguiente paso del comprador es escribir
// "¿llegó mi pago?" — justo el mensaje que este checkout existe para evitar.

export type OrderStage =
  | 'nuevo' | 'validando' | 'confirmado' | 'preparando' | 'en_camino' | 'entregado'

export interface StageStep {
  key: OrderStage
  label: string
  emoji: string
}

const NUEVO: StageStep      = { key: 'nuevo',      label: 'Pedido',     emoji: '📋' }
const VALIDANDO: StageStep  = { key: 'validando',  label: 'Validando',  emoji: '🔎' }
const RESTO: StageStep[] = [
  { key: 'confirmado', label: 'Confirmado', emoji: '📞' },
  { key: 'preparando', label: 'Preparando', emoji: '📦' },
  { key: 'en_camino',  label: 'En camino',  emoji: '🚚' },
  { key: 'entregado',  label: 'Entregado',  emoji: '✅' },
]

/**
 * Las etapas que le tocan a ESTE pedido.
 *
 * Sin adelanto (Lima, contraentrega puro) no hay nada que validar, así que el
 * paso no aparece: un punto que nunca se va a encender se lee como "algo se
 * atascó", y en la pantalla que el comprador mira para tranquilizarse eso es
 * exactamente lo contrario de lo que buscamos.
 */
export function stagesFor(advanceAmount: number | string | null | undefined): StageStep[] {
  const advance = Number(advanceAmount ?? 0)
  return advance > 0 ? [NUEVO, VALIDANDO, ...RESTO] : [NUEVO, ...RESTO]
}

/**
 * Índice de la etapa actual dentro de la lista que le toca al pedido.
 *
 * Un pedido que ya pasó por `validando` y termina en Lima —o al revés, uno que
 * quedó marcado `validando` y luego perdió el adelanto— no debe romper la barra:
 * si la etapa no está en la lista, se cae a la posición 0 en vez de a -1, que
 * pintaría la barra al revés.
 */
export function stageIndex(stage: string | null | undefined, steps: StageStep[]): number {
  const i = steps.findIndex(s => s.key === stage)
  return i >= 0 ? i : 0
}

/** Normaliza lo que venga de la BD. Una etapa desconocida cae a `nuevo`. */
export function toStage(value: string | null | undefined): OrderStage {
  const all: OrderStage[] = ['nuevo', 'validando', 'confirmado', 'preparando', 'en_camino', 'entregado']
  return all.includes(value as OrderStage) ? (value as OrderStage) : 'nuevo'
}
