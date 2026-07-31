import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Package, ChevronRight, Star, LogOut, Bell, MessageCircle, RefreshCw, ShoppingBag } from 'lucide-react'
import { subscribePush, notifPermission } from '../../lib/push'
import { supabase } from '../../lib/supabase'
import { useStore } from '../../lib/store-context'

const BASE = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`
const ANON = import.meta.env.VITE_SUPABASE_ANON_KEY as string

const STAGE_LABEL: Record<string, string> = {
  nuevo:      '📋 Pedido creado',
  validando: '🔎 Validando pago',
  confirmado: '📞 Confirmado',
  preparando: '📦 Preparando',
  en_camino:  '🚚 En camino',
  entregado:  '✅ Entregado',
  cancelado:  '❌ Cancelado',
}

const STAGE_COLOR: Record<string, string> = {
  nuevo:      '#FFD400',
  validando: '#F59E0B',
  confirmado: '#55C8F5',
  preparando: '#863bff',
  en_camino:  '#FF8C00',
  entregado:  '#4ADE80',
  cancelado:  '#EF4444',
}

interface BuyerSession {
  buyer: {
    id: string
    nombre: string
    phone: string
    document_number?: string
    score: number
    puntos: number
    address: string | null
  }
  sessions: Array<{
    id: string
    token: string
    order_id: string
    product_name: string
    product_price: number
    pack_name: string | null
    stage: string
    status: string
    created_at: string
    address: string | null
    unread_count?: number
  }>
}

export default function MisPedidosPage() {
  const navigate = useNavigate()
  const { store } = useStore()
  const [data, setData] = useState<BuyerSession | null>(null)

  const [notifGranted, setNotifGranted] = useState(notifPermission() === 'granted')
  const [welcome, setWelcome] = useState<{ points: number; msg: string | null } | null>(() => {
    try { const w = localStorage.getItem('welcome_reward'); if (w) { localStorage.removeItem('welcome_reward'); return JSON.parse(w) } } catch { /* */ }
    return null
  })
  const [bumps, setBumps] = useState<Record<string, number>>({})
  const seenRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    const raw = localStorage.getItem('buyer_session')
    if (!raw) { navigate('/acceso', { replace: true }); return }
    let parsed: BuyerSession
    try {
      parsed = JSON.parse(raw)
      setData(parsed)
      if (parsed.buyer?.id && notifPermission() === 'granted') {
        subscribePush({ buyerId: parsed.buyer.id, role: 'buyer' as const }).catch(() => {})
      }
    } catch { navigate('/acceso', { replace: true }); return }

    // Refresh from the server so cancellations, stages and unread are up to date
    const doc = parsed.buyer?.document_number
    if (doc) {
      fetch(`${BASE}/buyer-login`, {
        method: 'POST', headers: { Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ document_number: doc, store_id: store.id }),
      })
        .then(r => (r.ok ? r.json() : null))
        .then(fresh => {
          if (fresh?.buyer) {
            setData(fresh)
            try { localStorage.setItem('buyer_session', JSON.stringify(fresh)) } catch { /* */ }
          }
        })
        .catch(() => {})
    }
  }, [navigate])

  // Live unread: bump the counter when the seller writes, in real time
  const sessionIds = (data?.sessions ?? []).map(s => s.id).join(',')
  useEffect(() => {
    const sess = data?.sessions ?? []
    if (sess.length === 0) return
    const channels = sess.map(s =>
      supabase.channel(`order:${s.id}`)
        .on('broadcast', { event: 'new_message' }, ({ payload }) => {
          const m = payload as { id: string; sender_role: string; visibility?: string }
          // Count only messages the buyer would see, from the other side
          if (m.sender_role === 'buyer' || m.visibility === 'sellers' || seenRef.current.has(m.id)) return
          seenRef.current.add(m.id)
          setBumps(b => ({ ...b, [s.id]: (b[s.id] ?? 0) + 1 }))
        })
        .subscribe()
    )
    return () => channels.forEach(c => supabase.removeChannel(c))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionIds])

  const enableNotifications = async () => {
    const raw = localStorage.getItem('buyer_session')
    if (!raw) return
    const { buyer } = JSON.parse(raw)
    const ok = await subscribePush({ buyerId: buyer.id, role: 'buyer' as const })
    if (ok) setNotifGranted(true)
  }

  const openOrder = (s: { id: string; token: string }) => {
    // Optimistically clear this order's unread so it doesn't reappear on return
    setBumps(b => ({ ...b, [s.id]: 0 }))
    setData(d => {
      if (!d) return d
      const sessions = d.sessions.map(x => x.id === s.id ? { ...x, unread_count: 0 } : x)
      const nd = { ...d, sessions }
      try { localStorage.setItem('buyer_session', JSON.stringify(nd)) } catch { /* ignore */ }
      return nd
    })
    navigate(`/p/${s.token}`)
  }

  const logout = () => {
    localStorage.removeItem('buyer_session')
    window.dispatchEvent(new Event('buyer-session-changed'))
    navigate('/acceso', { replace: true })
  }

  const [reordering, setReordering] = useState<string | null>(null)
  const reorder = async (s: { id: string; product_name: string; product_price: number; pack_name: string | null }) => {
    if (!data || !store.id) return
    setReordering(s.id)
    try {
      const res = await fetch(`${BASE}/register-buyer`, {
        method: 'POST', headers: { Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          store_id: store.id, product_name: s.product_name, product_price: s.product_price, pack_name: s.pack_name,
          buyer_name: data.buyer.nombre, buyer_phone: data.buyer.phone, document_type: 'DNI', document_number: data.buyer.document_number,
        }),
      })
      if (res.ok) { const { token } = await res.json(); navigate(`/p/${token}`) }
      else alert('No se pudo repetir el pedido. Intenta de nuevo.')
    } finally { setReordering(null) }
  }

  if (!data) return null

  const { buyer, sessions } = data
  const scoreColor = buyer.score >= 80 ? '#4ADE80' : buyer.score >= 50 ? '#FFD400' : '#EF4444'
  const scoreLabel = buyer.score >= 80 ? 'Comprador confiable' : buyer.score >= 50 ? 'Comprador estándar' : 'Nuevo comprador'

  return (
    <div className="min-h-screen" style={{ background: '#FFFDF5' }}>
      {/* Header */}
      <div className="px-4 pt-10 pb-6 text-white"
        style={{ background: `linear-gradient(135deg, ${store.color_primary} 0%, #863bff 100%)` }}>
        <div className="max-w-[430px] mx-auto">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <img src={store.logo_url || '/icon-192.png'} alt={store.nombre} className="w-8 h-8 rounded-xl object-cover" />
              <span className="font-black text-xl tracking-tight">{store.nombre}</span>
            </div>
            <div className="flex items-center gap-2">
              {!notifGranted && (
                <button onClick={enableNotifications}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-black"
                  style={{ background: 'rgba(255,255,255,0.2)', color: '#fff' }}>
                  <Bell size={12} /> Activar avisos
                </button>
              )}
              <button onClick={logout} className="p-2 rounded-xl" style={{ background: 'rgba(255,255,255,0.2)' }}>
                <LogOut size={16} />
              </button>
            </div>
          </div>

          <p className="text-white/70 text-sm">Hola,</p>
          <h1 className="font-black text-2xl">{buyer.nombre.split(' ')[0]}</h1>

          {/* Score card — tap to see how to level up */}
          <button onClick={() => navigate('/mi-score')}
            className="mt-4 w-full p-4 rounded-2xl flex items-center gap-4 text-left"
            style={{ background: 'rgba(255,255,255,0.15)', backdropFilter: 'blur(8px)' }}>
            <div className="relative w-14 h-14 flex-shrink-0">
              <svg viewBox="0 0 36 36" className="w-14 h-14 -rotate-90">
                <circle cx="18" cy="18" r="15.9" fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth="3" />
                <circle cx="18" cy="18" r="15.9" fill="none" stroke={scoreColor} strokeWidth="3"
                  strokeDasharray={`${buyer.score} 100`} strokeLinecap="round" />
              </svg>
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="font-black text-sm text-white">{buyer.score}</span>
              </div>
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-black text-white text-sm">{scoreLabel}</p>
              <div className="flex items-center gap-1 mt-0.5">
                <Star size={12} fill="#FFD400" color="#FFD400" />
                <span className="text-xs text-white/80">{buyer.puntos} puntos acumulados</span>
              </div>
              <p className="text-xs font-bold text-white/90 mt-0.5 flex items-center gap-1">
                Ver cómo subir tu score <ChevronRight size={12} />
              </p>
            </div>
          </button>
        </div>
      </div>

      {/* Welcome reward (once, when an imported customer activates) */}
      {welcome && (
        <div className="max-w-[430px] mx-auto px-4 pt-4">
          <div className="rounded-2xl p-4 flex items-center gap-3" style={{ background: 'linear-gradient(135deg, #FFF7E6, #FFFDF5)', border: '1.5px solid #FFD400' }}>
            <span className="text-2xl">🎁</span>
            <div className="flex-1">
              <p className="font-black text-sm text-gray-900">¡Bienvenido, {buyer.nombre.split(' ')[0]}!</p>
              <p className="text-xs text-gray-600">{welcome.msg || `Ganaste ${welcome.points} puntos por ser cliente. ¡Gracias!`}</p>
            </div>
            <button onClick={() => setWelcome(null)} className="text-gray-400 text-xs font-bold">✕</button>
          </div>
        </div>
      )}

      {/* Repurchase CTA — the whole point of retention */}
      <div className="max-w-[430px] mx-auto px-4 pt-4">
        <button onClick={() => navigate('/tienda')}
          className="w-full py-3.5 rounded-2xl font-black text-sm text-white flex items-center justify-center gap-2 shadow-sm"
          style={{ background: `linear-gradient(135deg, ${store.color_primary} 0%, #863bff 100%)` }}>
          <ShoppingBag size={16} /> Comprar de nuevo
        </button>
      </div>

      {/* Orders list */}
      <div className="max-w-[430px] mx-auto px-4 py-5">
        <h2 className="font-black text-lg mb-3" style={{ color: '#111' }}>
          Mis pedidos ({sessions.length})
        </h2>

        {sessions.length === 0 ? (
          <div className="text-center py-12">
            <Package size={40} className="mx-auto mb-3 opacity-30" />
            <p className="text-sm" style={{ color: '#888' }}>Aún no tienes pedidos</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {sessions.map(s => {
              const date = new Date(s.created_at).toLocaleDateString('es-PE', {
                day: 'numeric', month: 'short', year: 'numeric'
              })
              const isCancelled = s.status === 'cancelado'
              const stageColor = isCancelled ? '#EF4444' : (STAGE_COLOR[s.stage] ?? '#ccc')
              const stageLabel = isCancelled ? '❌ Pedido cancelado' : (STAGE_LABEL[s.stage] ?? s.stage)
              const unread = (s.unread_count ?? 0) + (bumps[s.id] ?? 0)

              return (
                <div key={s.id} className="rounded-2xl shadow-sm overflow-hidden"
                  style={{ background: '#fff', border: unread > 0 ? '1.5px solid var(--brand)' : '1.5px solid #f0f0f0' }}>
                <button onClick={() => openOrder(s)}
                  className="w-full text-left p-4 flex items-center gap-3">
                  <div className="relative w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0"
                    style={{ background: `${stageColor}22` }}>
                    <Package size={20} style={{ color: stageColor }} />
                    {unread > 0 && (
                      <span className="absolute -top-1.5 -right-1.5 min-w-5 h-5 px-1 rounded-full flex items-center justify-center text-white text-[10px] font-black"
                        style={{ background: '#EF4444' }}>{unread}</span>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-black text-sm truncate" style={{ color: '#111' }}>
                      {s.product_name}
                    </p>
                    <p className="text-xs mt-0.5" style={{ color: '#888' }}>
                      S/{s.product_price} · {date}
                    </p>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="inline-block px-2 py-0.5 rounded-full text-xs font-bold"
                        style={{ background: `${stageColor}22`, color: stageColor }}>
                        {stageLabel}
                      </span>
                      {unread > 0 && (
                        <span className="inline-flex items-center gap-1 text-xs font-black" style={{ color: 'var(--brand)' }}>
                          <MessageCircle size={12} /> Leer chat
                        </span>
                      )}
                    </div>
                  </div>
                  <ChevronRight size={16} style={{ color: '#ccc' }} />
                </button>
                {!isCancelled && (
                  <button onClick={() => reorder(s)} disabled={reordering === s.id}
                    className="w-full py-2.5 text-xs font-black flex items-center justify-center gap-1.5 border-t disabled:opacity-50"
                    style={{ color: 'var(--brand)', borderColor: '#f0f0f0' }}>
                    <RefreshCw size={13} /> {reordering === s.id ? 'Creando…' : 'Volver a pedir'}
                  </button>
                )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
