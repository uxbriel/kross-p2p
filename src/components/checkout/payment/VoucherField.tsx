// ─── Captura del comprobante (opcional) ──────────────────────────────────────
// Acción SECUNDARIA a propósito. Lo que cuadra el pago es el código de
// seguridad, que ya se pidió arriba; la imagen no la lee ninguna máquina y
// exigir una foto en 4G cuesta conversión sin comprar nada automático.
// Ver VOUCHER_REQUIRED en checkout.config.ts.

import { useRef, useState } from 'react'
import { Check, Paperclip } from 'lucide-react'
import { COPY, VOUCHER, VOUCHER_REQUIRED } from '../../../lib/checkout/checkout.config'
import type { PaymentVoucher } from '../../../lib/checkout/types'

interface VoucherFieldProps {
  voucher: PaymentVoucher | null
  onSelect: (file: File) => Promise<void>
  error?: string
}

export default function VoucherField({ voucher, onSelect, error }: VoucherFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)

  const pick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setBusy(true)
    setFailed(null)
    try {
      await onSelect(file)
    } catch (err) {
      // Que falle la subida NO puede bloquear el pedido: el código ya identifica
      // el pago. Se avisa y se sigue.
      setFailed(err instanceof Error ? err.message : 'No se pudo subir la imagen')
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        className="flex items-center gap-2 text-xs font-bold text-gray-500 underline disabled:opacity-50
          focus:outline-none focus-visible:ring-2 focus-visible:ring-green-500 rounded"
      >
        {voucher ? <Check size={14} className="text-green-600" /> : <Paperclip size={14} />}
        {busy ? 'Subiendo…' : voucher ? `${COPY.voucherAttached} · ${COPY.voucherReplace}` : COPY.voucherOptional}
        {VOUCHER_REQUIRED && <span aria-hidden="true">*</span>}
      </button>
      {/* SIN `capture`: forzaba la cámara trasera, y el comprobante ya es una
          CAPTURA DE PANTALLA que vive en la galería. Abrirle la cámara lo dejaba
          enfocando la nada y teniendo que salir a buscar la galería a mano — o
          peor, fotografiando la pantalla de otro teléfono. */}
      <input
        ref={inputRef}
        type="file"
        accept={VOUCHER.accept}
        className="hidden"
        onChange={pick}
        aria-label={COPY.voucherOptional}
      />

      {(failed || error) && (
        <p role="alert" className="text-[11px] font-semibold mt-1.5 text-red-600">{failed ?? error}</p>
      )}
    </div>
  )
}
