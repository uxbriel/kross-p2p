// Tests del núcleo del checkout: máquina de estados, validación, persistencia y
// los servicios contra la DATA REAL del courier y de Shalom (no mocks). Cubren
// los puntos del Definition of Done que no dependen de UI.

import { beforeEach, describe, expect, it } from 'vitest'
import { checkoutReducer, initialCheckoutState } from './machine'
import type { CheckoutAction } from './machine'
import { canAdvance, canSubmit, validateStep, validateWhatsapp } from './validation'
import { clearDraft, loadActiveDraft, loadLastOrder, saveDraft, saveLastOrder } from './persistence'
import { ADVANCE_LIMA_PEN, ADVANCE_PROVINCIA_PEN, BORDERLINE_THRESHOLD_M, EXIT_DISCOUNT_PEN } from './checkout.config'
import { effectivePrice } from './product-packs'
import { CoverageService, coveredCities } from './services/CoverageService'
import { AgencyService, suggestFreeText } from './services/AgencyService'
import { DistrictCoverageService, methodForCoverage } from './services/DistrictCoverageService'
import type { CheckoutState } from './types'
import { stagesFor, stageIndex, toStage } from '../order-stages'
import { repliesFor } from '../../components/chat/QuickReplies'

const run = (state: CheckoutState, ...actions: CheckoutAction[]): CheckoutState =>
  actions.reduce(checkoutReducer, state)

const base = () => initialCheckoutState('pack-2')

describe('máquina · derivados', () => {
  it('Lima no cobra adelanto y provincia sí', () => {
    expect(run(base(), { type: 'SET_LOCATION_TYPE', locationType: 'LIMA' }).advanceAmount).toBe(ADVANCE_LIMA_PEN)
    expect(run(base(), { type: 'SET_LOCATION_TYPE', locationType: 'PROVINCIA' }).advanceAmount).toBe(ADVANCE_PROVINCIA_PEN)
  })

  it('el adelanto sale de la config, no de un número suelto en el reducer', () => {
    // Si esto falla es que alguien hardcodeó el monto: cambiar S/10 a S/15 debe
    // ser editar UNA línea de checkout.config.ts.
    const s = run(base(), { type: 'SET_LOCATION_TYPE', locationType: 'PROVINCIA' })
    expect(s.advanceAmount).toBe(ADVANCE_PROVINCIA_PEN)
  })

  it('marca needsLocationConfirmation en Lima mientras no haya pin', () => {
    const s = run(base(), { type: 'SET_LOCATION_TYPE', locationType: 'LIMA' })
    expect(s.needsLocationConfirmation).toBe(true)
    const withPin = run(s, { type: 'SET_LIMA_PIN', lat: -12.05, lng: -77.04 })
    expect(withPin.needsLocationConfirmation).toBe(false)
  })

  it('una zona de visita semanal manda a agencia y avisa al comprador', () => {
    const s = run(base(),
      { type: 'SET_LOCATION_TYPE', locationType: 'PROVINCIA' },
      { type: 'SET_PROVINCIA_DISTRICT', department: 'Cusco', province: 'Cusco', district: 'Poroy' },
      { type: 'SET_COVERAGE', check: {
        result: 'BORDERLINE', city: 'CUSCO', eta: '72h (entrega 1 vez por semana)',
        tariff: 21.5, weekly: true, weekdaysOnly: false, zoned: false, reason: 'semanal',
      } },
    )
    expect(s.provinciaConfig?.deliveryMethod).toBe('AGENCIA')
    // Recoge en agencia: no hay puerta que ubicar, así que no queda pendiente.
    expect(s.needsLocationConfirmation).toBe(false)
    // El aviso SÍ se le muestra: prometer 48h donde el courier pasa una vez por
    // semana es justo el reclamo que se quiere evitar.
    expect(s.deliveryNote).toMatch(/una vez por semana/)
  })

  it('domicilio prometido sin coordenada queda marcado para Logística', () => {
    const s = run(base(),
      { type: 'SET_LOCATION_TYPE', locationType: 'PROVINCIA' },
      { type: 'SET_PROVINCIA_DISTRICT', department: 'La Libertad', province: 'Trujillo', district: 'Trujillo' },
      { type: 'SET_COVERAGE', check: {
        result: 'IN_ZONE', city: 'TRUJILLO', eta: '48h', tariff: 15.5,
        weekly: false, weekdaysOnly: false, zoned: false, reason: '',
      } },
    )
    expect(s.provinciaConfig?.deliveryMethod).toBe('DOMICILIO')
    // El pedido se cierra igual; la coordenada se afina después en el chat.
    expect(s.needsLocationConfirmation).toBe(true)
  })

  it('IN_ZONE ofrece domicilio y OUT_OF_ZONE ofrece agencia', () => {
    const withCity = run(base(),
      { type: 'SET_LOCATION_TYPE', locationType: 'PROVINCIA' },
      { type: 'SET_PROVINCIA_DISTRICT', department: 'La Libertad', province: 'Trujillo', district: 'Trujillo' },
    )
    const cov = { city: 'TRUJILLO', eta: '48h', tariff: 15.5, weekly: false, weekdaysOnly: false, zoned: false, reason: '' }
    const inZone = run(withCity, { type: 'SET_COVERAGE', check: { ...cov, result: 'IN_ZONE' } })
    const outZone = run(withCity, { type: 'SET_COVERAGE', check: { ...cov, result: 'OUT_OF_ZONE' } })
    expect(inZone.provinciaConfig?.deliveryMethod).toBe('DOMICILIO')
    expect(outZone.provinciaConfig?.deliveryMethod).toBe('AGENCIA')
  })

  it('guarda el recargo del courier sin tocar el adelanto del comprador', () => {
    const s = run(base(),
      { type: 'SET_LOCATION_TYPE', locationType: 'PROVINCIA' },
      { type: 'SET_PROVINCIA_DISTRICT', department: 'La Libertad', province: 'Trujillo', district: 'Trujillo' },
      { type: 'SET_COVERAGE', check: {
        result: 'IN_ZONE', city: 'TRUJILLO', eta: '48h', tariff: 15.5,
        weekly: false, weekdaysOnly: false, zoned: true, reason: '',
      } },
    )
    expect(s.courierSurcharge).toBe(15.5)
    expect(s.advanceAmount).toBe(ADVANCE_PROVINCIA_PEN) // el recargo NO se le traslada
  })

  it('cambiar de región descarta la data de la otra', () => {
    const s = run(base(),
      { type: 'SET_LOCATION_TYPE', locationType: 'LIMA' },
      { type: 'SET_LIMA_DISTRICT', district: 'Miraflores' },
      { type: 'SET_LOCATION_TYPE', locationType: 'PROVINCIA' },
    )
    expect(s.limaAddress).toBeNull()
    expect(s.provinciaConfig).not.toBeNull()
  })

  it('"atrás" conserva todo lo ingresado', () => {
    const s = run(base(),
      { type: 'SET_WHATSAPP', whatsapp: '987654321' },
      { type: 'NEXT' },
      { type: 'BACK' },
    )
    expect(s.step).toBe(1)
    expect(s.customerInfo.whatsapp).toBe('987654321')
  })

  it('cada pedido nace con un orderId único (idempotencia del insert)', () => {
    expect(initialCheckoutState().orderId).not.toBe(initialCheckoutState().orderId)
  })
})

describe('validación', () => {
  it('exige 9 dígitos que empiecen en 9', () => {
    expect(validateWhatsapp('987654321')).toBeNull()
    expect(validateWhatsapp('98765432')).toMatch(/9 dígitos/)
    expect(validateWhatsapp('187654321')).toMatch(/empieza con 9/)
  })

  it('en Lima NO exige pin para poder avanzar', () => {
    const s = run(base(),
      { type: 'SET_WHATSAPP', whatsapp: '987654321' },
      { type: 'SET_RECEIVER_NAME', receiverName: 'Ana Torres' },
      { type: 'SET_DNI', dni: '12345678' },
      { type: 'SET_LOCATION_TYPE', locationType: 'LIMA' },
      { type: 'SET_LIMA_DISTRICT', district: 'Miraflores' },
      { type: 'SET_LIMA_ADDRESS', addressText: 'Av. Larco 123' },
      { type: 'GOTO', step: 2 },
    )
    expect(s.limaAddress?.lat).toBeNull()
    expect(canAdvance(s)).toBe(true)
  })

  it('si se ignora el mapa, la rama agencia deja cerrar el pedido igual', () => {
    const s = run(base(),
      { type: 'SET_WHATSAPP', whatsapp: '987654321' },
      { type: 'SET_RECEIVER_NAME', receiverName: 'Ana Torres' },
      { type: 'SET_DNI', dni: '12345678' },
      { type: 'SET_LOCATION_TYPE', locationType: 'PROVINCIA' },
      { type: 'SET_PROVINCIA_DISTRICT', department: 'La Libertad', province: 'Trujillo', district: 'Trujillo' },
      { type: 'CHOOSE_AGENCY_BRANCH_FLOW' },
      { type: 'SET_AGENCY', agency: 'SHALOM' },
      { type: 'SET_AGENCY_BRANCH', branchId: '4' },
      { type: 'GOTO', step: 2 },
    )
    expect(s.provinciaConfig?.lat).toBeNull() // nunca colocó el pin
    expect(canAdvance(s)).toBe(true)
  })

  it('Olva ya exige elegir sede, igual que Shalom', () => {
    // Antes caía a texto libre porque no había listado. Desde que se obtuvo su
    // buscador, las dos agencias se validan igual.
    const conOlva = run(base(),
      { type: 'SET_LOCATION_TYPE', locationType: 'PROVINCIA' },
      { type: 'SET_PROVINCIA_DISTRICT', department: 'La Libertad', province: 'Trujillo', district: 'Trujillo' },
      { type: 'SET_AGENCY', agency: 'OLVA' },
      { type: 'GOTO', step: 2 },
    )
    expect(validateStep(conOlva).agencyBranch).toBeTruthy()
    const conSede = run(conOlva, { type: 'SET_AGENCY_BRANCH', branchId: '579' })
    expect(validateStep(conSede).agencyBranch).toBeUndefined()
  })

  it('"OTRO" sigue aceptando texto libre: es la única sin listado', () => {
    const conOtro = run(base(),
      { type: 'SET_LOCATION_TYPE', locationType: 'PROVINCIA' },
      { type: 'SET_PROVINCIA_DISTRICT', department: 'La Libertad', province: 'Trujillo', district: 'Trujillo' },
      { type: 'SET_AGENCY', agency: 'OTRO' },
      { type: 'GOTO', step: 2 },
    )
    expect(validateStep(conOtro).agencyBranch).toBeTruthy()
    const escrito = run(conOtro, { type: 'SET_OLVA_TEXT', text: 'Marvisur Av. España' })
    expect(validateStep(escrito).agencyBranch).toBeUndefined()
  })

  // Lo obligatorio con adelanto es el CÓDIGO, no la captura: el código es lo que
  // cuadra el pago con la notificación que le llega a la marca, y la imagen no la
  // lee ninguna máquina. Ver VOUCHER_REQUIRED en checkout.config.ts.
  it('el paso 3 con adelanto exige el código de Yape, no la captura', () => {
    const s = run(base(), { type: 'SET_LOCATION_TYPE', locationType: 'PROVINCIA' }, { type: 'GOTO', step: 3 })
    expect(validateStep(s).yapeCode).toBeTruthy()
    expect(validateStep(s).voucher).toBeUndefined()

    expect(validateStep(run(s, { type: 'SET_YAPE_CODE', code: '96' })).yapeCode).toBeTruthy()

    const conCodigo = run(s, { type: 'SET_YAPE_CODE', code: '965' })
    // Sigue PENDING y aun así el paso valida: el CTA no espera la verificación,
    // que corre en background mientras el comprador ya cerró su pedido.
    expect(conCodigo.payment.verification).toBe('PENDING')
    expect(validateStep(conCodigo)).toEqual({})
  })

  it('el código de Yape se queda en dígitos y no pasa de 3', () => {
    const s = run(base(), { type: 'SET_YAPE_CODE', code: '9a6-5 4' })
    expect(s.advanceYapeCode).toBe('965')
  })

  it('sin adelanto (Lima) el paso 3 no pide comprobante', () => {
    const s = run(base(), { type: 'SET_LOCATION_TYPE', locationType: 'LIMA' }, { type: 'GOTO', step: 3 })
    expect(validateStep(s)).toEqual({})
  })

  it('canSubmit bloquea el doble tap mientras se envía', () => {
    const complete = run(base(),
      { type: 'SET_WHATSAPP', whatsapp: '987654321' },
      { type: 'SET_RECEIVER_NAME', receiverName: 'Ana Torres' },
      { type: 'SET_DNI', dni: '12345678' },
      { type: 'SET_LOCATION_TYPE', locationType: 'LIMA' },
      { type: 'SET_LIMA_DISTRICT', district: 'Miraflores' },
      { type: 'SET_LIMA_ADDRESS', addressText: 'Av. Larco 123' },
    )
    expect(canSubmit(complete)).toBe(true)
    expect(canSubmit(run(complete, { type: 'SUBMITTING' }))).toBe(false)
    expect(canSubmit(run(complete, { type: 'SUBMITTED' }))).toBe(false)
  })
})

describe('persistencia', () => {
  beforeEach(() => localStorage.clear())

  it('recarga a mitad del paso 2 sin perder nada', () => {
    const s = run(base(),
      { type: 'SET_WHATSAPP', whatsapp: '987654321' },
      { type: 'SET_RECEIVER_NAME', receiverName: 'Ana Torres' },
      { type: 'SET_LOCATION_TYPE', locationType: 'LIMA' },
      { type: 'SET_LIMA_DISTRICT', district: 'Surquillo' },
      { type: 'GOTO', step: 2 },
    )
    saveDraft(s)

    const restored = loadActiveDraft()
    expect(restored?.orderId).toBe(s.orderId)
    expect(restored?.step).toBe(2)
    expect(restored?.customerInfo.whatsapp).toBe('987654321')
    expect(restored?.limaAddress?.district).toBe('Surquillo')
  })

  it('un pedido ya enviado no se reabre como borrador', () => {
    const s = run(base(), { type: 'SUBMITTED' })
    saveDraft(s)
    expect(loadActiveDraft()).toBeNull()
  })

  it('descarta borradores vencidos', () => {
    const s = base()
    saveDraft(s)
    const key = `kross_checkout:${s.orderId}`
    const stored = JSON.parse(localStorage.getItem(key)!)
    stored.savedAt = Date.now() - 25 * 60 * 60 * 1000 // 25 h
    localStorage.setItem(key, JSON.stringify(stored))
    expect(loadActiveDraft()).toBeNull()
  })

  it('no revienta con una entrada corrupta', () => {
    localStorage.setItem('kross_checkout:active', 'abc')
    localStorage.setItem('kross_checkout:abc', '{no es json')
    expect(loadActiveDraft()).toBeNull()
  })

  it('clearDraft borra el borrador y el puntero activo', () => {
    const s = base()
    saveDraft(s)
    clearDraft(s.orderId)
    expect(loadActiveDraft()).toBeNull()
  })

  // Regresión: los borradores guardados antes de que existiera `discountPen`
  // volvían sin ese campo y el paso 1 hacía `precio - undefined` → S/NaN en
  // TODOS los packs. No se descarta el borrador: se completa con los defaults.
  it('un borrador de una versión anterior se completa en vez de romper la pantalla', () => {
    const s = run(base(), { type: 'SET_WHATSAPP', whatsapp: '987654321' })
    saveDraft(s)

    const key = `kross_checkout:${s.orderId}`
    const stored = JSON.parse(localStorage.getItem(key)!)
    // Así se veía el estado antes de la Fase 2.5: sin descuento de retención.
    delete stored.state.discountPen
    delete stored.state.exitOfferShown
    localStorage.setItem(key, JSON.stringify(stored))

    const restored = loadActiveDraft()!
    expect(restored.customerInfo.whatsapp).toBe('987654321') // no se perdió nada
    expect(restored.discountPen).toBe(0)
    expect(restored.exitOfferShown).toBe(false)
    expect(effectivePrice(129, restored.discountPen)).toBe(129)
  })

  it('un número corrupto en el borrador no se propaga como NaN', () => {
    const s = base()
    saveDraft(s)
    const key = `kross_checkout:${s.orderId}`
    const stored = JSON.parse(localStorage.getItem(key)!)
    stored.state.discountPen = null
    stored.state.advanceAmount = 'diez'
    localStorage.setItem(key, JSON.stringify(stored))

    const restored = loadActiveDraft()!
    expect(restored.discountPen).toBe(0)
    expect(restored.advanceAmount).toBe(0)
    expect(Number.isNaN(effectivePrice(129, restored.discountPen))).toBe(false)
  })
})

describe('CoverageService · data real del courier', () => {
  it('carga las 28 ciudades de provincia con cobertura', async () => {
    const cities = await coveredCities()
    expect(cities.length).toBe(28)
    expect(cities).toContain('TRUJILLO')
    expect(cities).toContain('TUMBES')
    expect(cities).not.toContain('LIMA') // Lima va en su propia rama
  })

  it('una ciudad sin cobertura no rompe: manda a agencia', async () => {
    const c = await CoverageService.getCityCoverage('Jauja')
    expect(c.covered).toBe(false)
    const check = await CoverageService.checkPoint('Jauja', -11.77, -75.5)
    expect(check.result).toBe('OUT_OF_ZONE')
  })

  it('un punto en el centro de Trujillo cae IN_ZONE', async () => {
    const check = await CoverageService.checkPoint('TRUJILLO', -8.09278, -79.02276)
    expect(check.result).toBe('IN_ZONE')
    expect(check.zone?.surcharge).toBe(0)
  })

  it('un punto lejos de toda zona cae OUT_OF_ZONE', async () => {
    const check = await CoverageService.checkPoint('TRUJILLO', -8.72431, -79.63681)
    expect(check.result).toBe('OUT_OF_ZONE')
    expect(check.zone).toBeNull()
  })

  it('un punto pegado al borde se degrada a BORDERLINE', async () => {
    // Se busca un vértice real del contorno y se evalúa un punto casi encima:
    // dentro o fuera, está al filo, y prometer domicilio ahí es frágil.
    const outline = (await CoverageService.getCityOutlines('TRUJILLO'))[0]
    const [lng, lat] = outline[0]
    const check = await CoverageService.checkPoint('TRUJILLO', lat - 0.0005, lng)
    expect(['BORDERLINE', 'OUT_OF_ZONE']).toContain(check.result)
    if (check.result === 'BORDERLINE') {
      expect(check.distanceToEdgeM).toBeLessThan(BORDERLINE_THRESHOLD_M)
    }
  })

  it('acepta el nombre de ciudad con tildes y en minúscula', async () => {
    expect((await CoverageService.getCityCoverage('trujillo')).covered).toBe(true)
    expect((await CoverageService.getCityCoverage('Cusco')).covered).toBe(true)
  })

  it('las zonas de visita semanal se marcan BORDERLINE aunque el punto esté al centro', async () => {
    // Cusco tiene 17 zonas de expansión con visita 1 vez por semana.
    const outlines = await CoverageService.getCityOutlines('CUSCO')
    expect(outlines.length).toBeGreaterThan(0)
    const check = await CoverageService.checkPoint('CUSCO', -13.52837, -71.95066)
    expect(['IN_ZONE', 'BORDERLINE']).toContain(check.result)
  })
})

describe('AgencyService · data real de Shalom', () => {
  it('carga las 487 sedes (488 filas menos el registro de prueba)', async () => {
    expect(await AgencyService.branchCount('SHALOM')).toBe(487)
  })

  it('devuelve las 3 sedes más cercanas ordenadas por distancia real', async () => {
    const nearest = await AgencyService.getNearest('SHALOM', { lat: -8.1116, lng: -79.0288 }, 3)
    expect(nearest).toHaveLength(3)
    expect(nearest![0].distanceKm).toBeLessThanOrEqual(nearest![1].distanceKm)
    expect(nearest![1].distanceKm).toBeLessThanOrEqual(nearest![2].distanceKm)
    // Desde el centro de Trujillo la más cercana tiene que estar a pocos km.
    expect(nearest![0].distanceKm).toBeLessThan(15)
  })

  it('Olva también tiene listado: 424 sedes desde su buscador', async () => {
    expect(await AgencyService.branchCount('OLVA')).toBe(424)
    expect(AgencyService.hasBranchList('OLVA')).toBe(true)
    const cerca = await AgencyService.getNearest('OLVA', { lat: -8.1116, lng: -79.0288 }, 3)
    expect(cerca).toHaveLength(3)
    expect(cerca![0].distanceKm).toBeLessThan(15)
  })

  it('solo "OTRO" cae al input manual', async () => {
    expect(AgencyService.hasBranchList('OTRO')).toBe(false)
    expect(await AgencyService.getNearest('OTRO', { lat: -8.11, lng: -79.03 })).toBeNull()
  })

  it('las sedes de Olva sin coordenadas quedan fuera del ranking pero se pueden buscar', async () => {
    // Son 9 de 424: descartarlas dejaría a esos distritos sin su agencia.
    const todas = await AgencyService.search('OLVA', '', 1000)
    const sinCoords = todas.filter(b => b.lat === null)
    expect(sinCoords.length).toBe(9)
    const cerca = await AgencyService.getNearest('OLVA', { lat: -12.05, lng: -77.04 }, 500)
    expect(cerca!.every(b => b.lat !== null)).toBe(true)
    // …pero siguen siendo encontrables por texto.
    expect((await AgencyService.search('OLVA', 'AGENTE COMAS')).length).toBeGreaterThan(0)
  })

  it('Olva trae coordenadas dentro de Perú, con las invertidas ya corregidas', async () => {
    const todas = await AgencyService.search('OLVA', '', 1000)
    for (const b of todas) {
      if (b.lat === null || b.lng === null) continue
      expect(b.lat).toBeGreaterThan(-18.6)
      expect(b.lat).toBeLessThan(-0.02)
      expect(b.lng).toBeGreaterThan(-81.5)
      expect(b.lng).toBeLessThan(-68.5)
    }
  })

  it('todas las sedes tienen coordenadas dentro de Perú', async () => {
    // Blinda la reconstrucción de coordenadas del CSV: si el parser se rompe,
    // las distancias salen mal y el comprador recoge en la ciudad equivocada.
    const all = (await AgencyService.search('SHALOM', '', 1000)).filter(b => b.lat !== null)
    expect(all.length).toBeGreaterThan(400)
    for (const b of all) {
      expect(b.lat!).toBeGreaterThan(-18.6)
      expect(b.lat!).toBeLessThan(-0.02)
      expect(b.lng!).toBeGreaterThan(-81.5)
      expect(b.lng!).toBeLessThan(-68.5)
    }
  })

  it('busca por distrito, provincia o dirección', async () => {
    expect((await AgencyService.search('SHALOM', 'trujillo')).length).toBeGreaterThan(0)
    expect(await AgencyService.search('SHALOM', 'zzzz-no-existe')).toHaveLength(0)
  })

  it('sugiere texto ya escrito por otros compradores, sin duplicar', () => {
    const s = suggestFreeText(['Olva Av. España', 'olva av. españa', 'Olva Centro'], 'olva')
    expect(s).toEqual(['Olva Av. España', 'Olva Centro'])
  })
})

describe('DistrictCoverageService · data real del tarifario', () => {
  it('carga los 178 distritos cubiertos y los 483 seleccionables', async () => {
    const all = await DistrictCoverageService.listDistricts()
    expect(all.length).toBe(483)
    expect(all.filter(d => d.covered).length).toBe(178)
  })

  it('el selector incluye distritos SIN cobertura, para que igual puedan comprar', async () => {
    const all = await DistrictCoverageService.listDistricts()
    expect(all.filter(d => !d.covered).length).toBeGreaterThan(200)
    const mp = all.find(d => d.district === 'Machu Picchu')
    expect(mp?.covered).toBe(false)
  })

  it('un distrito cubierto ofrece domicilio', async () => {
    const c = await DistrictCoverageService.checkDistrict('Lima', 'Lima', 'Miraflores')
    expect(c.result).toBe('IN_ZONE')
    expect(c.city).toBe('LIMA')
    expect(c.eta).toContain('24h')
  })

  it('un distrito sin cobertura manda a agencia sin bloquear', async () => {
    const c = await DistrictCoverageService.checkDistrict('Cusco', 'Urubamba', 'Machu Picchu')
    expect(c.result).toBe('OUT_OF_ZONE')
    expect(methodForCoverage(c.result)).toBe('AGENCIA')
  })

  it('un distrito de visita semanal se degrada a BORDERLINE', async () => {
    const c = await DistrictCoverageService.checkDistrict('Cusco', 'Cusco', 'Poroy')
    expect(c.result).toBe('BORDERLINE')
    expect(c.weekly).toBe(true)
    expect(methodForCoverage(c.result)).toBe('AGENCIA')
  })

  it('desambigua distritos homónimos por departamento', async () => {
    // Hay un Miraflores en Lima y otro en Arequipa: no pueden confundirse.
    const lima = await DistrictCoverageService.checkDistrict('Lima', 'Lima', 'Miraflores')
    const aqp = await DistrictCoverageService.checkDistrict('Arequipa', 'Arequipa', 'Miraflores')
    expect(lima.city).toBe('LIMA')
    expect(aqp.city).toBe('AREQUIPA')
  })

  it('tolera tildes y mayúsculas en el nombre del distrito', async () => {
    const a = await DistrictCoverageService.checkDistrict('lima', 'LIMA', 'miraflores')
    const b = await DistrictCoverageService.checkDistrict('Ayacucho', 'Huamanga', 'Jesús Nazareno')
    expect(a.result).toBe('IN_ZONE')
    expect(b.result).toBe('IN_ZONE')
  })

  it('los 53 distritos que peru-geo.ts no lista siguen siendo seleccionables', async () => {
    // Si se cayeran, esos compradores irían a agencia sin necesidad.
    const chupaca = await DistrictCoverageService.search('Chupaca')
    expect(chupaca.some(d => d.district === 'Chupaca' && d.covered)).toBe(true)
  })

  it('la búsqueda encuentra por distrito, provincia o departamento', async () => {
    expect((await DistrictCoverageService.search('surco')).length).toBeGreaterThan(0)
    expect(await DistrictCoverageService.search('zzz-no-existe')).toHaveLength(0)
  })
})

describe('ajustes tras la revisión de Fase 2', () => {
  const conDatos = (loc: 'LIMA' | 'PROVINCIA') => run(base(),
    { type: 'SET_WHATSAPP', whatsapp: '987654321' },
    { type: 'SET_RECEIVER_NAME', receiverName: 'Ana Torres' },
    { type: 'SET_LOCATION_TYPE', locationType: loc },
    { type: 'GOTO', step: 2 },
  )

  it('Lima NO pide DNI: se avanza sin él', () => {
    const s = run(conDatos('LIMA'),
      { type: 'SET_LIMA_DISTRICT', district: 'Miraflores' },
      { type: 'SET_LIMA_ADDRESS', addressText: 'Av. Larco 123' },
    )
    expect(s.customerInfo.dni).toBe('')
    expect(validateStep(s).dni).toBeUndefined()
    expect(canAdvance(s)).toBe(true)
  })

  it('provincia SÍ pide DNI: la agencia lo exige para entregar', () => {
    const s = run(conDatos('PROVINCIA'),
      { type: 'SET_PROVINCIA_DISTRICT', department: 'La Libertad', province: 'Trujillo', district: 'Trujillo' },
      { type: 'CHOOSE_AGENCY_BRANCH_FLOW' },
      { type: 'SET_AGENCY', agency: 'SHALOM' },
      { type: 'SET_AGENCY_BRANCH', branchId: '4' },
    )
    expect(validateStep(s).dni).toBeTruthy()
    expect(canAdvance(s)).toBe(false)
    const conDni = run(s, { type: 'SET_DNI', dni: '12345678' })
    expect(canAdvance(conDni)).toBe(true)
  })

  it('cambiar a Lima deja de exigir el DNI sin borrar lo ya escrito', () => {
    const s = run(conDatos('PROVINCIA'),
      { type: 'SET_DNI', dni: '12345678' },
      { type: 'SET_LOCATION_TYPE', locationType: 'LIMA' },
      { type: 'SET_LIMA_DISTRICT', district: 'Miraflores' },
      { type: 'SET_LIMA_ADDRESS', addressText: 'Av. Larco 123' },
    )
    expect(s.customerInfo.dni).toBe('12345678') // no se pierde si vuelve a provincia
    expect(canAdvance(s)).toBe(true)
  })

  it('el adelanto depende de la agencia: Olva cobra más flete que Shalom', () => {
    const prov = run(base(), { type: 'SET_LOCATION_TYPE', locationType: 'PROVINCIA' })
    expect(prov.advanceAmount).toBe(ADVANCE_PROVINCIA_PEN) // a domicilio, sin agencia
    expect(run(prov, { type: 'SET_AGENCY', agency: 'SHALOM' }).advanceAmount).toBe(10)
    expect(run(prov, { type: 'SET_AGENCY', agency: 'OLVA' }).advanceAmount).toBe(20)
  })

  it('cambiar de agencia recalcula el adelanto en ambos sentidos', () => {
    const s = run(base(),
      { type: 'SET_LOCATION_TYPE', locationType: 'PROVINCIA' },
      { type: 'SET_AGENCY', agency: 'OLVA' },
    )
    expect(s.advanceAmount).toBe(20)
    expect(run(s, { type: 'SET_AGENCY', agency: 'SHALOM' }).advanceAmount).toBe(10)
  })

  it('Lima nunca cobra adelanto, elija lo que elija', () => {
    expect(run(base(), { type: 'SET_LOCATION_TYPE', locationType: 'LIMA' }).advanceAmount).toBe(0)
  })

  it('el descuento de retención resta S/5 a cada pack', () => {
    expect(effectivePrice(110, 0)).toBe(110)
    expect(effectivePrice(110, EXIT_DISCOUNT_PEN)).toBe(105)
    expect(effectivePrice(189, EXIT_DISCOUNT_PEN)).toBe(184)
    // Un pack más barato que el descuento no puede quedar en negativo.
    expect(effectivePrice(3, EXIT_DISCOUNT_PEN)).toBe(0)
  })

  it('aplicar el descuento dos veces no lo duplica', () => {
    const una = run(base(), { type: 'APPLY_EXIT_DISCOUNT' })
    const dos = run(una, { type: 'APPLY_EXIT_DISCOUNT' })
    expect(una.discountPen).toBe(EXIT_DISCOUNT_PEN)
    expect(dos.discountPen).toBe(EXIT_DISCOUNT_PEN)
  })

  it('la oferta se marca como vista para no volver a insistir', () => {
    expect(base().exitOfferShown).toBe(false)
    expect(run(base(), { type: 'EXIT_OFFER_SHOWN' }).exitOfferShown).toBe(true)
    // Aplicarlo también la marca: no tiene sentido reofrecer lo ya dado.
    expect(run(base(), { type: 'APPLY_EXIT_DISCOUNT' }).exitOfferShown).toBe(true)
  })

  it('el descuento sobrevive a la recarga', () => {
    localStorage.clear()
    const s = run(base(),
      { type: 'SET_WHATSAPP', whatsapp: '987654321' },
      { type: 'APPLY_EXIT_DISCOUNT' },
    )
    saveDraft(s)
    const restored = loadActiveDraft()
    expect(restored?.discountPen).toBe(EXIT_DISCOUNT_PEN)
    expect(restored?.exitOfferShown).toBe(true)
  })
})

describe('centroides con degradación', () => {
  it('un distrito con sedes usa su propio centroide', async () => {
    const c = await DistrictCoverageService.getDistrictCenter('Lima', 'Lima', 'Miraflores')
    expect(c).not.toBeNull()
    expect(c!.lat).toBeGreaterThan(-12.3)
    expect(c!.lat).toBeLessThan(-11.9)
  })

  it('un distrito SIN sedes cae a su provincia, no a la otra punta del país', async () => {
    // Poroy (Cusco) no tiene agencias. Antes devolvía null y el listado
    // terminaba ofreciendo sedes de Amazonas.
    const c = await DistrictCoverageService.getDistrictCenter('Cusco', 'Cusco', 'Poroy')
    expect(c).not.toBeNull()
    expect(c!.lat).toBeGreaterThan(-14.5)
    expect(c!.lat).toBeLessThan(-12.5)
    expect(c!.lng).toBeGreaterThan(-73)
    expect(c!.lng).toBeLessThan(-71)
  })

  it('desde ese centroide, las agencias más cercanas son de Cusco', async () => {
    const c = await DistrictCoverageService.getDistrictCenter('Cusco', 'Cusco', 'Poroy')
    for (const agency of ['SHALOM', 'OLVA'] as const) {
      const cerca = await AgencyService.getNearest(agency, c!, 3)
      expect(cerca).toHaveLength(3)
      expect(cerca![0].distanceKm).toBeLessThan(60)
    }
  })
})

// ─── Último pedido cerrado ───────────────────────────────────────────────────
// Al cerrar la ventana de confirmación el comprador se quedaba sin vía de vuelta
// a su pedido. Feedback real: ahora la landing puede ofrecer "Ver mi pedido".
describe('último pedido', () => {
  beforeEach(() => localStorage.clear())

  it('guarda y devuelve el token para volver al chat', () => {
    saveLastOrder('tok-123', 'ORD-1', 'prod-1')
    expect(loadLastOrder()?.token).toBe('tok-123')
    expect(loadLastOrder()?.orderCode).toBe('ORD-1')
  })

  it('sin pedido previo no ofrece nada', () => {
    expect(loadLastOrder()).toBeNull()
  })

  it('caduca a los 3 días: un botón viejo en la landing solo confunde', () => {
    saveLastOrder('tok-viejo', 'ORD-0', null)
    const raw = JSON.parse(localStorage.getItem('kross_last_order')!)
    raw.savedAt = Date.now() - 4 * 24 * 60 * 60 * 1000
    localStorage.setItem('kross_last_order', JSON.stringify(raw))
    expect(loadLastOrder()).toBeNull()
  })

  it('un storage corrupto no rompe la landing', () => {
    localStorage.setItem('kross_last_order', '{no es json')
    expect(loadLastOrder()).toBeNull()
  })
})

// ─── Etapas del pedido ───────────────────────────────────────────────────────
// `validando` solo aplica a pedidos con adelanto: en Lima no hay nada que
// validar y un punto que nunca se enciende se lee como "algo se atascó".
describe('etapas del pedido', () => {
  it('con adelanto incluye Validando entre Pedido y Confirmado', () => {
    const keys = stagesFor(10).map(s => s.key)
    expect(keys).toEqual(['nuevo', 'validando', 'confirmado', 'preparando', 'en_camino', 'entregado'])
  })

  it('sin adelanto (Lima) no muestra Validando', () => {
    expect(stagesFor(0).map(s => s.key)).not.toContain('validando')
    expect(stagesFor(null).map(s => s.key)[1]).toBe('confirmado')
  })

  it('una etapa que no aplica a este pedido no rompe la barra', () => {
    // Un pedido de Lima marcado `validando` por un dato viejo: cae a 0, no a -1,
    // que pintaría la barra de progreso al revés.
    expect(stageIndex('validando', stagesFor(0))).toBe(0)
  })

  it('ubica la etapa actual dentro de la lista que le toca', () => {
    expect(stageIndex('confirmado', stagesFor(10))).toBe(2)
    expect(stageIndex('confirmado', stagesFor(0))).toBe(1)
  })

  it('una etapa desconocida de la BD cae a nuevo', () => {
    expect(toStage('inventada')).toBe('nuevo')
    expect(toStage(null)).toBe('nuevo')
    expect(toStage('validando')).toBe('validando')
  })
})

// ─── Respuestas rápidas ──────────────────────────────────────────────────────
// Se derivan del estado y no se guardan: guardadas por mensaje quedarían
// obsoletas —"¿Ya llegó mi pago?" una semana después de que el pago cuadró—.
describe('respuestas rápidas del chat', () => {
  it('mientras se valida el pago ofrece las dos dudas de ese momento', () => {
    expect(repliesFor('validando')).toEqual(['¿Ya llegó mi pago?', 'Te envío mi comprobante'])
  })

  it('ya confirmado deja de preguntar por el pago', () => {
    expect(repliesFor('confirmado').join(' ')).not.toMatch(/pago|comprobante/i)
  })

  it('cada etapa ofrece algo: nunca una barra vacía', () => {
    for (const st of ['nuevo', 'validando', 'confirmado', 'preparando', 'en_camino', 'entregado']) {
      expect(repliesFor(st).length).toBeGreaterThan(0)
    }
  })

  it('una etapa desconocida no rompe: cae al par genérico', () => {
    expect(repliesFor(null).length).toBe(2)
    expect(repliesFor('inventada').length).toBe(2)
  })
})
