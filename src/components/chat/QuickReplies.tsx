// ─── Respuestas rápidas del comprador ────────────────────────────────────────
// Fichas tocables encima del campo de texto, al estilo de las plantillas de
// WhatsApp. Sirven a dos cosas a la vez:
//
//   · bajan el costo de la primera interacción —escribir de cero a un
//     desconocido cuesta más que tocar un botón—, y
//   · le enseñan que ESTE chat es donde se resuelve su pedido, que es lo que
//     sostiene la tasa de entrega.
//
// Se DERIVAN del estado del pedido, no se guardan en la base. Guardadas por
// mensaje quedarían obsoletas: "¿Ya llegó mi pago?" seguiría ofreciéndose una
// semana después de que el pago cuadró. Así la ficha siempre corresponde a lo
// que le pasa al pedido en este momento.

interface QuickRepliesProps {
  stage: string | null | undefined
  /** Se ocultan en cuanto el comprador escribe: ya cumplieron su trabajo, y
   *  dejarlas para siempre convierte la ayuda en estorbo sobre el teclado. */
  buyerHasWritten: boolean
  onPick: (text: string) => void
}

function repliesFor(stage: string | null | undefined): string[] {
  switch (stage) {
    // Pagó y estamos cuadrando. Las dos dudas reales de ese momento —y la
    // segunda además nos trae el comprobante justo cuando puede hacer falta,
    // en vez de pedírselo a todos por si acaso en el checkout.
    case 'validando':
      return ['¿Ya llegó mi pago?', 'Te envío mi comprobante']
    case 'confirmado':
    case 'preparando':
      return ['¿Cuándo llega mi pedido?', 'Quiero cambiar mi dirección']
    case 'en_camino':
      return ['¿Cuánto falta?', 'No voy a estar, ¿pueden venir después?']
    case 'entregado':
      return ['Ya lo recibí, gracias', 'Tengo un problema con mi pedido']
    default:
      return ['¿Cuándo llega mi pedido?', 'Quiero cambiar mi dirección']
  }
}

export default function QuickReplies({ stage, buyerHasWritten, onPick }: QuickRepliesProps) {
  if (buyerHasWritten) return null
  const replies = repliesFor(stage)
  if (replies.length === 0) return null

  return (
    <div className="flex gap-2 overflow-x-auto px-4 pb-2 -mb-1"
      style={{ scrollbarWidth: 'none' }}>
      {replies.map(text => (
        <button
          key={text}
          type="button"
          onClick={() => onPick(text)}
          className="flex-shrink-0 text-[12px] font-bold px-3.5 py-2 rounded-full bg-white
            border active:scale-95 transition-transform
            focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1"
          style={{ borderColor: 'var(--brand)', color: 'var(--brand)' }}
        >
          {text}
        </button>
      ))}
    </div>
  )
}

export { repliesFor }
