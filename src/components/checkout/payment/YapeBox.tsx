// ─── Caja de Yape ────────────────────────────────────────────────────────────
// El número y el titular salen de la TIENDA (`stores.yape_*`), no de config:
// Kross es multi-tenant y cada marca cobra al suyo.
//
// Paridad móvil/desktop, que aquí no es un lujo: el flujo se graba en tutoriales
// desde una laptop. Manda el número copiable, y en desktop además el QR. Ninguna
// pantalla dice "ábrelo en tu celular" — eso sería un callejón sin salida para
// quien compra desde la PC.
//
// NO hay botón de "Abrir Yape". Hubo uno con `yape://` y estaba muerto: era un
// esquema supuesto, nunca verificado contra la app. Y aunque funcionara, tres
// cosas lo condenan:
//   · Chrome Android no abre esquemas custom desde un enlace normal; exige
//     `intent://` con el nombre de paquete.
//   · En iOS, si la app no declaró el esquema, Safari muestra su pantalla de
//     error — un callejón sin salida JUSTO en el paso del cobro.
//   · Aun abriendo, cae en la pantalla de inicio de Yape: no puede pre-llenar
//     número ni monto, porque eso requiere el deep link de pago comercial.
// O sea, ahorraba un cambio de app a cambio de arriesgar la venta. Copiar el
// número funciona siempre, en los dos sistemas. Ver docs/01-SALES-ENGINE.md.

import { useEffect, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { COPY, YAPE } from '../../../lib/checkout/checkout.config'
import type { StoreYape } from '../CheckoutModal'

export default function YapeBox({ yape, amount }: { yape: StoreYape | null; amount: number }) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), YAPE.copiedFeedbackMs)
    return () => clearTimeout(t)
  }, [copied])

  const copy = async () => {
    if (!yape?.number) return
    try {
      await navigator.clipboard.writeText(yape.number)
      setCopied(true)
    } catch {
      // Sin permiso de portapapeles el número igual está a la vista y se puede
      // seleccionar a mano: no se le bloquea nada al comprador.
    }
  }

  // Sin datos de cobro configurados no se inventa un número: se le dice que un
  // asesor coordina. Mostrar un campo vacío donde va una cuenta destruye la
  // confianza justo en el momento del pago.
  if (!yape?.number) {
    return (
      <div className="rounded-2xl px-4 py-3 text-xs" style={{ background: '#FEF3C7', color: '#92400E' }}>
        Un asesor te va a escribir por WhatsApp para coordinar el adelanto de S/{amount}.
        Puedes terminar tu pedido igual.
      </div>
    )
  }

  return (
    <div className="rounded-2xl border-2 p-4" style={{ borderColor: '#742284', background: '#FAF5FB' }}>
      <p className="text-[11px] font-black uppercase tracking-wide mb-2" style={{ color: '#742284' }}>
        Yapea S/{amount}
      </p>
      <p className="text-xs text-gray-600 mb-3">{COPY.yapeIntro}</p>

      <p className="text-2xl font-black text-gray-900 tracking-wide leading-none">{yape.number}</p>
      <p className="text-xs text-gray-500 mt-1 mb-3">{yape.holder}</p>

      {/* Acción única y a todo el ancho. Antes competía con un botón muerto;
          una acción confiable vale más que dos donde una falla. */}
      <button
        type="button"
        onClick={copy}
        className="w-full flex items-center justify-center gap-2 px-3 py-3 rounded-xl text-sm font-black text-white
          focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-green-500"
        style={{ background: '#742284' }}
      >
        {copied ? <Check size={16} /> : <Copy size={16} />}
        {copied ? COPY.yapeCopied : COPY.yapeCopy}
      </button>

      {yape.qrUrl && (
        <div className="hidden sm:block mt-3">
          <p className="text-[11px] text-gray-500 mb-1.5">O escanea con tu Yape:</p>
          <img src={yape.qrUrl} alt="Código QR para yapear" className="w-32 h-32 rounded-xl bg-white" loading="lazy" />
        </div>
      )}
    </div>
  )
}
