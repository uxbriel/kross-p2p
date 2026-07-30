// ─── SALES ENGINE · Dónde está el código de seguridad ────────────────────────
// El campo del código era el único punto del checkout donde el comprador tenía
// que APRENDER algo nuevo, y en la primera venta real a un tercero hubo que
// explicárselo por chat. Una explicación que se da por chat no escala: el
// próximo comprador no tiene a quién preguntarle.
//
// La respuesta no es más texto —ya había un hint y no alcanzó— sino
// RECONOCIMIENTO: se reproduce la franja exacta que el comprador acaba de ver
// en Yape, para que compare en vez de interpretar.
//
// Va en SVG y no en imagen a propósito. Además de pesar ~1 KB en vez de ~20 en
// la pantalla donde se cobra —y el comprador está en 4G—, se ve nítido en
// cualquier densidad y no incrusta material de marca ajeno: es una
// reconstrucción tipográfica, no una captura. La franja recortada tampoco
// muestra monto (chocaría con los S/20 de Olva) ni datos de la transacción.

export default function YapeCodeHint() {
  return (
    <div className="rounded-2xl overflow-hidden mb-2"
      style={{ background: '#F7F1FD', border: '1px solid #E9DDF9' }}>
      <svg viewBox="0 0 320 62" className="w-full block" role="img"
        aria-label="En tu pantalla de Yape, la fila Código de seguridad muestra tres números.">
        {/* Cantos morados de la tarjeta de Yape: bastan para que se reconozca la
            pantalla sin reproducirla entera. */}
        <rect width="320" height="62" fill="#742384" />
        <rect x="8" width="304" height="62" fill="#fff" />
        {/* Las hairlines que enmarcan la fila en la app real. */}
        <rect x="24" y="7" width="272" height="1" fill="#EDEDF2" />
        <rect x="24" y="54" width="272" height="1" fill="#EDEDF2" />

        {/* 10.5px con poco letter-spacing: a 11.5 el rótulo se comía el ícono.
            El margen hasta el punto de info se deja holgado a propósito, porque
            el ancho real depende de la fuente del sistema y no es calculable. */}
        <text x="24" y="36" fontSize="10.5" fontWeight="700" letterSpacing="0.2"
          fill="#6B6B7B" fontFamily="system-ui, sans-serif">CÓDIGO DE SEGURIDAD</text>
        {/* El puntito de info del original: sin él la fila no se reconoce igual. */}
        <circle cx="168" cy="31" r="7" fill="#3FC7A8" />
        <text x="168" y="34.5" textAnchor="middle" fontSize="8.5" fontWeight="700"
          fill="#fff" fontFamily="system-ui, sans-serif">i</text>

        {/* Los 3 dígitos: lo único que el comprador tiene que copiar. Alineados
            a x=296 para dejar el mismo margen que el rótulo tiene a la
            izquierda; antes quedaban pegados al borde. Se marcan con el morado
            de Yape y no con neón porque esta es la pantalla del cobro, y ahí la
            confianza pesa más que la llamada de atención. */}
        <g>
          <rect x="216" y="17" width="24" height="28" rx="5" fill="#F1F1F5" />
          <rect x="244" y="17" width="24" height="28" rx="5" fill="#F1F1F5" />
          <rect x="272" y="17" width="24" height="28" rx="5" fill="#F1F1F5" />
          <text x="228" y="37" textAnchor="middle" fontSize="15" fontWeight="700"
            fill="#2B2B36" fontFamily="system-ui, sans-serif">3</text>
          <text x="256" y="37" textAnchor="middle" fontSize="15" fontWeight="700"
            fill="#2B2B36" fontFamily="system-ui, sans-serif">2</text>
          <text x="284" y="37" textAnchor="middle" fontSize="15" fontWeight="700"
            fill="#2B2B36" fontFamily="system-ui, sans-serif">9</text>
          <rect x="211" y="12" width="90" height="38" rx="9" fill="none"
            stroke="#742384" strokeWidth="2" />
        </g>
      </svg>

      <p className="text-[11px] leading-snug text-gray-600 px-3.5 py-2.5">
        Apenas terminas de yapear, esta fila aparece en tu pantalla.
        {' '}<strong className="text-gray-800">Copia esos 3 números aquí abajo</strong> —
        con eso reconocemos tu pago al toque.
      </p>
    </div>
  )
}
