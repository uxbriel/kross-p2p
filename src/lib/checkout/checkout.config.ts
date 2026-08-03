// ─── SALES ENGINE · Reglas de negocio del Checkout ───────────────────────────
// TODA regla de negocio del checkout vive aquí: montos, umbrales, textos, modos
// de cobertura. Cero números mágicos en el JSX. Cambiar el adelanto de S/10 a
// S/15 debe ser editar UNA línea de este archivo.
//
// Lo que NO vive aquí: los precios y las imágenes de los packs. Kross es
// multi-tenant y cada marca tiene los suyos — vienen de `products.packs` en la
// BD. Aquí solo están las REGLAS sobre esos packs (cuál se preselecciona, qué
// badge lleva, cómo se calcula el ahorro).

import type { AgencyName, CoverageMode } from './types'

// ─── Adelanto ────────────────────────────────────────────────────────────────

/** Lima paga 100 % contraentrega: sin adelanto, el flujo más corto. */
export const ADVANCE_LIMA_PEN = 0

/** Provincia adelanta el flete por Yape; el saldo se paga al recibir/recoger. */
export const ADVANCE_PROVINCIA_PEN = 10

/**
 * Adelanto por agencia, cuando difiere del base. Olva cobra más flete, así que
 * su adelanto es mayor. Se le muestra al comprador **en la tarjeta de cada
 * agencia**, antes de elegir: que el monto salte después de haber elegido se
 * lee como cambio de precio a mitad de compra.
 *
 * La entrega a domicilio (sin agencia) usa el base.
 */
export const ADVANCE_BY_AGENCY: Partial<Record<AgencyName, number>> = {
  OLVA: 20,
}

/** Adelanto que le toca a este pedido. Única fuente de verdad del monto. */
export function advanceFor(isProvincia: boolean, agency: AgencyName | null): number {
  if (!isProvincia) return ADVANCE_LIMA_PEN
  return (agency && ADVANCE_BY_AGENCY[agency]) || ADVANCE_PROVINCIA_PEN
}

// ─── Cobertura ───────────────────────────────────────────────────────────────

/**
 * Modo de cobertura por región. Ambas van por DISTRITO, y es una decisión
 * medida, no una simplificación.
 *
 * Se comparó el veredicto por distrito contra los polígonos del courier usando
 * las 487 sedes de Shalom como muestra de dónde hay gente: **coinciden en el
 * 94,9 % de los casos**. Cobrarle un paso de mapa al 100 % de los compradores
 * para ganar precisión en el 5 % restante cambia conversión por exactitud, y
 * aquí gana la conversión.
 *
 * Los polígonos NO se descartan: se evalúan en silencio cuando existe una
 * coordenada (dirección guardada del comprador, o el pin que captura
 * `AddressBar` en el chat DESPUÉS de cerrar la venta) y su resultado se guarda
 * en el pedido. Sirven para enrutar logística y para negociar cobertura, sin
 * costar un tap.
 */
export const COVERAGE_MODE: Record<'LIMA' | 'PROVINCIA', CoverageMode> = {
  LIMA: 'DISTRICT',
  PROVINCIA: 'DISTRICT',
}

/**
 * Ciudades que van SIEMPRE a agencia aunque el courier declare cobertura a
 * domicilio. Es una palanca operativa: si una ciudad empieza a fallar entregas,
 * se agrega aquí y deja de prometerse domicilio, sin tocar código.
 *
 * Vacío a propósito. La data ya resuelve por sí sola los tres casos que se
 * habían identificado como riesgosos: Tumbes no figura en el tarifario (queda
 * como no cubierto), y los 13 distritos de visita semanal de Cusco se degradan
 * solos por `weekly`. Blacklistear ciudades enteras encima de eso sería
 * castigar compradores que sí reciben en casa.
 */
export const AGENCY_ONLY_CITIES: string[] = []

/**
 * Un punto dentro de zona pero a menos de esta distancia del borde se trata como
 * BORDERLINE. Solo aplica al análisis por polígono (post-venta), no al checkout.
 */
export const BORDERLINE_THRESHOLD_M = 500

// ─── Packs ───────────────────────────────────────────────────────────────────

/**
 * Índice del pack preseleccionado y destacado, sobre la lista ordenada de menor
 * a mayor precio. `1` = el segundo más barato, que en un catálogo típico es el
 * pack de 2 unidades: es el anclaje que mueve el ticket promedio sin asustar.
 * Si la marca tiene menos packs, se recorta al último disponible.
 */
export const DEFAULT_PACK_INDEX = 1

/** Aplica DEFAULT_PACK_INDEX a una lista real de packs, sin salirse del rango. */
export function defaultPackIndex(packCount: number): number {
  if (packCount <= 0) return 0
  return Math.min(DEFAULT_PACK_INDEX, packCount - 1)
}

/** Badge del pack recomendado. Configurable por marca más adelante. */
export const BEST_PACK_BADGE = '⭐ MÁS ELEGIDO · MEJOR PRECIO'

/** Muestra el ahorro explícito vs. comprar N unidades sueltas. */
export const SHOW_PACK_SAVINGS = true

// ─── Descuento de retención ──────────────────────────────────────────────────

/**
 * Descuento que se ofrece cuando el comprador intenta cerrar el modal con datos
 * ya ingresados. Se descuenta de CADA pack.
 *
 * Ojo con dos cosas al mover este número: se paga también en los pedidos de
 * quien iba a comprar igual, y sobre un margen típico de S/49–78 por pedido,
 * S/5 es 7–10 %. Por eso se ofrece UNA sola vez por checkout.
 */
export const EXIT_DISCOUNT_PEN = 5

/** Una sola oferta por checkout: si la rechaza, no se le vuelve a insistir. */
export const EXIT_DISCOUNT_ONCE = true

// ─── Yape ────────────────────────────────────────────────────────────────────

export const YAPE = {
  // Aquí vivía `deepLink: 'yape://'`, un esquema SUPUESTO que nunca se verificó
  // contra la app y que en producción no abría nada. Se eliminó junto con su
  // botón: ver el encabezado de YapeBox.tsx para las tres razones por las que
  // tampoco vale la pena reintentarlo con `intent://`.
  copiedFeedbackMs: 1500,
} as const

/** Dígitos del código de seguridad de Yape. Confirmado contra la app real. */
export const YAPE_CODE_LENGTH = 3

/**
 * ¿La captura del comprobante es obligatoria para terminar el pedido?
 *
 * **No, y es deliberado.** La imagen HOY no la lee ninguna máquina: no hay OCR
 * en el sistema. Lo que cuadra el pago es el **código de seguridad**, que viaja
 * en la notificación que le llega a la marca y que el comprador copia de su
 * propio comprobante. Exigir una foto de 4 MB en 4G cuesta conversión real y no
 * compra nada automático — solo evidencia para un humano, que el `payment_event`
 * ya provee mejor.
 *
 * Es un caso donde la regla de decisión (gana la conversión) y la calidad del
 * dato apuntan al mismo lado: el código es MEJOR dato que la imagen. La captura
 * se ofrece como acción secundaria y se sube si el comprador quiere.
 *
 * Ponerlo en `true` la vuelve obligatoria sin tocar componentes.
 */
export const VOUCHER_REQUIRED = false

// ─── Verificación del adelanto ───────────────────────────────────────────────

/**
 * Si a los 20 s la verificación sigue PENDING, se deja de bloquear la UI y pasa
 * a validación humana. El comprador no espera más que eso, y el pedido ya está
 * registrado — puede cerrar la ventana sin perderlo.
 */
export const VERIFICATION_TIMEOUT_MS = 20_000

/** Backoff del polling mientras se espera el match (ms). */
export const VERIFICATION_POLL_MS = [1000, 2000, 3000, 5000, 5000] as const

// ─── Comprobante ─────────────────────────────────────────────────────────────

export const VOUCHER = {
  /** El comprador está en 4G y las fotos pesan 4 MB: se comprime en el cliente. */
  maxWidthPx: 1600,
  jpegQuality: 0.8,
  maxBytes: 8 * 1024 * 1024,
  accept: 'image/jpeg,image/png,image/webp,image/heic,image/heif',
  bucket: 'vouchers',
} as const

// ─── Persistencia ────────────────────────────────────────────────────────────

export const DRAFT_STORAGE_PREFIX = 'kross_checkout:'

/** Un borrador vive 24 h: alcanza para volver del anuncio, no para confundir. */
export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000

// ─── Validación ──────────────────────────────────────────────────────────────

export const DNI_LENGTH = 8
export const PHONE_LENGTH_PE = 9
export const PHONE_COUNTRY_CODE_PE = '51'

// ─── Textos ──────────────────────────────────────────────────────────────────
// Centralizados para poder ajustar copy sin tocar componentes. El copy es parte
// de la conversión, así que se versiona igual que el código.

export const COPY = {
  step2Title: '¡Genial! ¿Quién recibe el pedido?',
  // El DNI solo se pide en provincia, y el motivo es de ELLOS, no nuestro: la
  // agencia no entrega el paquete sin el documento del destinatario. Un hecho
  // que el comprador puede verificar convierte mejor que "para crear tu cuenta".
  dniWhy: 'La agencia te lo pedirá para entregarte el paquete.',
  dniOtherReceiver: '¿Lo recibe otra persona?',
  referencePlaceholder: 'Portón negro, frente a la bodega',

  inZone: '¡Sí llegamos a tu puerta!',
  outOfZone: 'En tu zona la entrega es en agencia.',
  outOfZoneBenefit: 'Recoges cuando quieras, y pagas el resto ahí.',
  agencyNeutral: 'Elige tu agencia de recojo',
  retryDomicilio: 'Prefiero intentar entrega a domicilio',

  advanceHeadsUp: `Para envíos a provincia se paga un adelanto de S/${ADVANCE_PROVINCIA_PEN} y el resto al recibir.`,
  advanceHeadsUpShort: 'El resto lo pagas al recibir tu pedido.',
  voucherRequired: 'Sube tu comprobante para terminar',

  // ─── Paso 3 ────────────────────────────────────────────────────────────────
  step3Title: 'Último paso: confirma tu pedido',
  step3TitleAdvance: 'Último paso: adelanta tu envío',
  yapeIntro: 'Yapea el adelanto a este número y copia tu código de seguridad.',
  yapeCopy: 'Copiar número',
  yapeCopied: '¡Copiado!',
  // Se nombra por lo que el comprador VE, no por el término técnico. El
  // rótulo de Yape va entre comillas para que lo reconozca sin traducir nada.
  yapeCodeLabel: 'Los 3 números que te dio Yape',
  // El "dónde" es lo que evita el abandono: sin esto el comprador no sabe que
  // el número está en su propia pantalla de confirmación.
  // La explicación larga ahora la hace el dibujo (YapeCodeHint). Este texto
  // solo dice DÓNDE mirar, sin repetir lo que ya se ve.
  yapeCodeHint: 'Aparecen en tu pantalla de Yape como “Código de seguridad”.',
  yapeCodePlaceholder: '000',
  voucherOptional: 'Adjuntar captura (opcional)',
  voucherAttached: 'Captura adjunta',
  voucherReplace: 'Cambiar',
  submit: 'Terminar mi pedido',
  submitting: 'Registrando tu pedido…',
  submitError: 'No pudimos registrar tu pedido. Toca para reintentar.',

  // Confirmación
  doneTitle: '¡Pedido confirmado! 🎉',
  // El canal es el CHAT del pedido, no WhatsApp. WhatsApp es solo el fallback
  // cuando el comprador no entra al chat, así que prometerlo aquí manda a
  // esperar por donde no vamos a escribir primero — y deja el chat, que es lo
  // que sostiene la tasa de entrega, sonando a algo secundario.
  doneCod: 'Pagas al recibir. Coordinamos la entrega por el chat de tu pedido.',
  doneAdvance: 'Ya registramos tu adelanto. Coordinamos el envío por el chat de tu pedido.',
  doneClose: 'Listo',
  // Nombra el BENEFICIO, no la mecánica: "abrir el chat" describe un botón,
  // "coordinar la entrega" describe lo que el comprador gana entrando.
  doneOpenChat: 'Ver mi pedido y coordinar la entrega',
  // La frase que hace el trabajo de verdad. Lo que se juega en esta pantalla no
  // es conversión —la venta ya está cerrada— sino la TASA DE ENTREGA: en COD el
  // motivo número uno de que un pedido no se recoja es que el cliente no
  // reconoce quién le escribe. Avisarle aquí de dónde vendrá el mensaje es la
  // vacuna, y este es el único momento de atención garantizada que queda.
  doneChatHint: 'Por aquí te escribiremos para coordinar tu entrega.',

  verifying: 'Estamos verificando tu pago…',
  verifyingCanClose: 'Puedes cerrar esta ventana: tu pedido ya está registrado.',
  verifyMatched: '¡Pago confirmado! Tu pedido está en camino.',
  verifyUnmatched: 'Recibimos tu comprobante, un asesor lo está validando.',

  // El monto NO va escrito en el copy: lo pone el componente desde
  // EXIT_DISCOUNT_PEN. Así cambiar el descuento es editar un solo número y no
  // deja textos mintiendo un monto viejo.
  exitBadge: 'SOLO POR ESTA VEZ',
  exitTitle: '¡Espera! No te vayas con las manos vacías',
  exitAmountLabel: 'de descuento en tu pedido',
  exitBody: 'Se aplica a cualquier pack que elijas. Si sales ahora, lo pierdes.',
  exitApply: 'Aplicar mi descuento',
  exitLeave: 'No, gracias',
  exitApplied: '🎉 Descuento aplicado a todos los packs',

  // Variante sin descuento: cuando ya se le ofreció una vez, o ya lo aceptó.
  exitConfirmTitle: '¿Salir sin terminar?',
  exitConfirmBody: 'Guardamos tu avance por 24 horas: puedes volver donde lo dejaste.',
  exitConfirmStay: 'Seguir comprando',
  exitConfirmLeave: 'Salir',

  olvaQuestion: '¿En qué agencia Olva vas a recoger?',
  olvaFinderUrl: 'https://www.olvacourier.com/agencias/',
} as const
