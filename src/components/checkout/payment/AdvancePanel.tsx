// ─── SALES ENGINE · Panel del adelanto (vista de Ventas) ─────────────────────
// Lo que el equipo necesita para decidir si despacha, en un solo bloque:
//   · si el adelanto cuadró y por qué medio,
//   · la advertencia del cruce, si la hubo (nombre distinto, código que no
//     calza) — la MISMA nota que el sistema ya escribió, no una interpretación,
//   · y el comprobante, que hasta ahora nadie podía abrir.
//
// El comprobante vive en un bucket privado sin política de lectura, así que la
// URL se pide firmada al backend en el momento y NO se guarda: una captura de
// Yape lleva nombre, teléfono parcial y número de operación del comprador.
// Por eso tampoco se precarga — solo se pide cuando alguien decide mirarla.

import { useState } from 'react'
import { AlertTriangle, Check, Clock, FileImage, Loader2 } from 'lucide-react'

const BASE = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`
const ANON = import.meta.env.VITE_SUPABASE_ANON_KEY as string

interface AdvancePanelProps {
  sessionId: string
  sellerAuthId: string | null
  advanceAmount: number
  verification: string | null
  /** Motivo escrito por el cruce automático. Puede venir aun habiendo cuadrado. */
  reason: string | null
  /** Los 3 dígitos que TECLEÓ el comprador. Es la llave con la que Ventas
   *  verifica a mano en la app de Yape cuando el cruce automático no llega. */
  yapeCode: string | null
  hasVoucher: boolean
}

export default function AdvancePanel({
  sessionId, sellerAuthId, advanceAmount, verification, reason, yapeCode, hasVoucher,
}: AdvancePanelProps) {
  const [url, setUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Sin adelanto no hay nada que verificar (Lima cobra todo al recibir).
  if (!advanceAmount || advanceAmount <= 0) return null

  const matched = verification === 'MATCHED'

  const openVoucher = async () => {
    if (!sellerAuthId) { setError('Vuelve a entrar: tu sesión venció.'); return }
    setLoading(true); setError(null)
    try {
      const res = await fetch(`${BASE}/voucher-url`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ seller_auth_id: sellerAuthId, order_session_id: sessionId }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) { setError(body.error === 'forbidden' ? 'No tienes permiso sobre este pedido.' : 'No se pudo abrir el comprobante.'); return }
      if (!body.url) { setError('El cliente no adjuntó comprobante.'); return }
      setUrl(body.url)
    } catch {
      setError('No se pudo abrir el comprobante. Revisa tu conexión.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mx-4 mt-2 rounded-2xl bg-white px-3 py-2.5" style={{ border: '1.5px solid #F0F0F0' }}>
      <div className="flex items-center gap-2">
        {matched
          ? <Check size={15} className="flex-shrink-0" style={{ color: '#16A34A' }} />
          : <Clock size={15} className="flex-shrink-0" style={{ color: '#F59E0B' }} />}
        <p className="flex-1 min-w-0 text-[9px] font-black uppercase tracking-wide text-gray-400 leading-tight">
          Adelanto S/{advanceAmount}
          <span className="ml-1 whitespace-nowrap" style={{ color: matched ? '#16A34A' : '#F59E0B' }}>
            {matched ? '✓ Verificado' : '· Sin cruzar'}
          </span>
        </p>

        {/* Solo se ofrece si hay algo que abrir: un botón que siempre falla
            enseña a no confiar en el botón. */}
        {hasVoucher && !url && (
          <button onClick={openVoucher} disabled={loading}
            className="flex items-center gap-1 text-[11px] font-black px-2.5 py-1.5 rounded-xl flex-shrink-0 disabled:opacity-50"
            style={{ background: '#EEF9FF', color: 'var(--brand)' }}>
            {loading ? <Loader2 size={11} className="animate-spin" /> : <FileImage size={11} />}
            {loading ? 'Abriendo…' : 'Ver comprobante'}
          </button>
        )}
      </div>

      {/* La advertencia del cruce, literal. Es la razón por la que este panel
          existe: sin poder abrir la captura, la nota no se podía resolver. */}
      {reason && (
        <p className="flex items-start gap-1.5 text-[11px] text-amber-700 bg-amber-50 rounded-lg px-2 py-1.5 mt-2">
          <AlertTriangle size={12} className="flex-shrink-0 mt-0.5" />
          <span>{reason}</span>
        </p>
      )}

      {/* El código tecleado es lo ÚNICO accionable cuando el cruce no llega:
          con él se busca el pago en la app de Yape sin depender de nadie. Antes
          el panel decía "sin comprobante" y ahí se acababa la ayuda. */}
      {!matched && yapeCode && (
        <p className="text-[11px] text-gray-500 mt-1.5">
          El cliente dice haber yapeado con el código{' '}
          <strong className="font-black tracking-widest text-gray-800">{yapeCode}</strong>
          {' '}· búscalo en tu Yape si no cruza solo.
        </p>
      )}

      {!hasVoucher && (
        <p className="text-[11px] text-gray-400 mt-1.5">
          Sin comprobante adjunto — es lo normal: el cruce usa el código, no la captura.
        </p>
      )}

      {error && <p className="text-[11px] text-red-500 mt-1.5">{error}</p>}

      {/* La imagen se muestra en el mismo panel, no en pestaña nueva: en el
          celular del vendedor, salir de la app para volver es fricción real, y
          la URL firmada muere en 5 minutos de todos modos. */}
      {url && (
        <a href={url} target="_blank" rel="noreferrer" className="block mt-2">
          <img src={url} alt="Comprobante del adelanto"
            className="w-full max-h-72 object-contain rounded-xl bg-gray-50 border" />
          <span className="block text-[10px] text-gray-400 mt-1">
            Toca para ampliar · el enlace caduca en 5 minutos
          </span>
        </a>
      )}
    </div>
  )
}
