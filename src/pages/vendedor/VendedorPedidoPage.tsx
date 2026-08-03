import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Send, Phone, PhoneOff, Mic, MicOff, Package, ArrowLeft, CheckCircle2, Bell, Users, UserPlus, Eye, X, ShoppingCart, PackagePlus, MessageCircle } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import IncomingCallOverlay from '../../components/IncomingCallOverlay'
import AddressBar from '../../components/AddressBar'
import AdvancePanel from '../../components/checkout/payment/AdvancePanel'
import OrderDetailModal from '../../components/OrderDetailModal'
import OfferCard from '../../components/OfferCard'
import { sendCallCancel, listenCallReject } from '../../lib/call-signal'
import { useSeller } from '../../lib/seller-session'
import type { OrderSession, OrderMessage } from '../../lib/order-api'
import type { RealtimeChannel } from '@supabase/supabase-js'

const BASE = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`
const ANON = import.meta.env.VITE_SUPABASE_ANON_KEY as string

// Ventas SÍ ve `validando` siempre: necesita distinguir un pedido que espera
// cruce de uno recién creado, aunque el comprador de Lima nunca pase por ahí.
const STAGES = ['nuevo','validando','confirmado','preparando','en_camino','entregado']

// ─── Seller-initiated call modal ──────────────────────────────────────────────
type CallState = 'connecting' | 'connected' | 'ended' | 'error'

function SellerCallModal({
  sessionId,
  sellerName,
  channelRef,
  onClose,
}: {
  sessionId: string
  sellerName: string
  channelRef: React.RefObject<RealtimeChannel | null>
  onClose: () => void
}) {
  const [callState, setCallState] = useState<CallState>('connecting')
  const [muted, setMuted] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const roomRef = useRef<InstanceType<typeof import('livekit-client')['Room']> | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const audioEls = useRef<HTMLAudioElement[]>([])
  const wakeLockRef = useRef<any>(null)

  useEffect(() => {
    let cancelled = false
    async function connect() {
      try {
        const res = await fetch(`${BASE}/seller-call-token`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId, seller_name: sellerName }),
        })
        if (!res.ok) throw new Error('token_failed')
        const { livekit_url, livekit_token } = await res.json() as { livekit_url: string; livekit_token: string }

        const { Room, RoomEvent, createLocalTracks, Track } = await import('livekit-client')
        const room = new Room()
        roomRef.current = room

        room.on(RoomEvent.Disconnected, () => { if (!cancelled) setCallState('ended') })

        // End call when remote party hangs up
        room.on(RoomEvent.ParticipantDisconnected, () => {
          if (!cancelled && room.remoteParticipants.size === 0) {
            if (timerRef.current) clearInterval(timerRef.current)
            setCallState('ended')
            setTimeout(onClose, 1500)
          }
        })

        // Only mark "connected" when the buyer actually answers
        room.on(RoomEvent.ParticipantConnected, () => {
          if (!cancelled) {
            setCallState('connected')
            if (!timerRef.current) timerRef.current = setInterval(() => setElapsed(e => e + 1), 1000)
          }
        })

        room.on(RoomEvent.TrackSubscribed, (track) => {
          if (track.kind === Track.Kind.Audio) {
            const el = track.attach()
            el.autoplay = true
            el.setAttribute('playsinline', '')
            document.body.appendChild(el)
            el.play().catch(() => {})
            audioEls.current.push(el)
          }
        })

        await room.connect(livekit_url, livekit_token)
        const tracks = await createLocalTracks({ audio: true, video: false })
        for (const track of tracks) await room.localParticipant.publishTrack(track)

        if (!cancelled) {
          // Wake lock: keep screen on during call
          if ('wakeLock' in navigator) {
            (navigator as any).wakeLock.request('screen')
              .then((wl: any) => { wakeLockRef.current = wl })
              .catch(() => {})
          }
          // MediaSession: keep audio alive in background
          if ('mediaSession' in navigator) {
            navigator.mediaSession.metadata = new MediaMetadata({
              title: 'En llamada · Kross',
              artist: 'Cliente',
            })
            navigator.mediaSession.playbackState = 'playing'
          }
          // If the buyer is somehow already in the room, connect right away;
          // otherwise stay "Esperando que conteste…" until ParticipantConnected
          if (room.remoteParticipants.size > 0) {
            setCallState('connected')
            timerRef.current = setInterval(() => setElapsed(e => e + 1), 1000)
          }
          // Notify buyer that seller is calling
          channelRef.current?.send({
            type: 'broadcast',
            event: 'seller_call_request',
            payload: { session_id: sessionId },
          })
        }
      } catch {
        if (!cancelled) setCallState('error')
      }
    }
    connect()
    return () => {
      cancelled = true
      if (timerRef.current) clearInterval(timerRef.current)
      wakeLockRef.current?.release(); wakeLockRef.current = null
      audioEls.current.forEach(el => { el.srcObject = null; el.remove() })
      audioEls.current = []
      roomRef.current?.disconnect()
    }
  }, [sessionId])

  const toggleMute = () => {
    const lp = roomRef.current?.localParticipant
    if (!lp) return
    lp.audioTrackPublications.forEach(pub => {
      if (pub.track) muted ? pub.track.unmute() : pub.track.mute()
    })
    setMuted(!muted)
  }

  const endCall = (notifyRemote: boolean) => {
    if (timerRef.current) clearInterval(timerRef.current)
    wakeLockRef.current?.release(); wakeLockRef.current = null
    audioEls.current.forEach(el => { el.srcObject = null; el.remove() })
    audioEls.current = []
    // Buyer never answered — tell their phone to stop ringing
    if (notifyRemote && (roomRef.current?.remoteParticipants.size ?? 0) === 0) {
      sendCallCancel(sessionId)
    }
    roomRef.current?.disconnect()
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none'
    setCallState('ended')
    setTimeout(onClose, 1200)
  }

  const hangUp = () => endCall(true)

  // Buyer rejected the call — end on this side too
  useEffect(() => listenCallReject(sessionId, () => endCall(false)), [sessionId])

  const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center" style={{ background: 'rgba(0,0,0,0.65)' }}>
      <div className="w-full max-w-[430px] rounded-t-3xl pb-10 pt-8 px-6 text-center" style={{ background: '#111' }}>
        <div className="w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-4 text-3xl"
          style={{ background: callState === 'connected' ? '#4ADE80' : callState === 'error' ? '#EF4444' : '#FFD400' }}>
          📞
        </div>
        <p className="text-white font-black text-xl mb-1">Llamada al cliente</p>
        <p className="text-sm mb-6" style={{ color: 'rgba(255,255,255,0.55)' }}>
          {callState === 'connecting' && 'Esperando que conteste…'}
          {callState === 'connected' && `En llamada · ${fmt(elapsed)}`}
          {callState === 'ended' && 'Llamada finalizada'}
          {callState === 'error' && 'No se pudo conectar'}
        </p>

        {callState === 'connected' && (
          <div className="flex items-center justify-center gap-1 mb-8">
            {[10,18,26,18,10,26,14,22,10,18].map((h, i) => (
              <div key={i} className="w-1 rounded-full animate-pulse"
                style={{ height: `${h}px`, background: '#4ADE80', animationDelay: `${i * 80}ms` }} />
            ))}
          </div>
        )}
        {callState !== 'connected' && <div className="mb-8" />}

        {(callState === 'connecting' || callState === 'connected') && (
          <div className="flex items-center justify-center gap-6">
            <button onClick={toggleMute}
              className="w-14 h-14 rounded-full flex items-center justify-center"
              style={{ background: muted ? '#EF4444' : 'rgba(255,255,255,0.15)' }}>
              {muted ? <MicOff size={22} className="text-white" /> : <Mic size={22} className="text-white" />}
            </button>
            <button onClick={hangUp}
              className="w-16 h-16 rounded-full flex items-center justify-center shadow-lg"
              style={{ background: '#EF4444' }}>
              <PhoneOff size={26} className="text-white" />
            </button>
          </div>
        )}

        {(callState === 'ended' || callState === 'error') && (
          <button onClick={onClose}
            className="w-full py-3 rounded-2xl font-black text-sm"
            style={{ background: '#FFD400', color: '#111' }}>
            Cerrar
          </button>
        )}
      </div>
    </div>
  )
}

// ─── Stage selector ───────────────────────────────────────────────────────────
function StageSelector({ current, sessionId, canWrite, onAdvanced }: {
  current: string
  sessionId: string
  canWrite: boolean
  onAdvanced: (next: string, handedOff: boolean) => void
}) {
  const [busy, setBusy] = useState(false)
  const stageLabel: Record<string, string> = {
    nuevo: 'Nuevo', validando: 'Validando', confirmado: 'Confirmado', preparando: 'Preparando', en_camino: 'En camino', entregado: 'Entregado'
  }

  const advance = async () => {
    const idx = STAGES.indexOf(current)
    if (idx >= STAGES.length - 1 || busy) return
    const next = STAGES[idx + 1]
    setBusy(true)
    try {
      // Persisted server-side (service role) — client writes were blocked by RLS.
      const res = await fetch(`${BASE}/order-manage`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'advance', session_id: sessionId, stage: next }),
      })
      if (!res.ok) throw new Error('advance_failed')
      const { assignment } = await res.json() as { assignment: unknown | null }
      onAdvanced(next, !!assignment)
    } catch {
      alert('No se pudo cambiar el estado. Intenta de nuevo.')
    } finally {
      setBusy(false)
    }
  }

  const idx = STAGES.indexOf(current)
  return (
    <div className="flex items-center gap-2 px-4 py-2 bg-white border-b border-gray-100">
      <span className="text-[10px] font-black uppercase tracking-wider text-gray-400">Estado:</span>
      <span className="text-xs font-bold px-2 py-0.5 rounded-full" style={{ background: 'var(--brand)', color: 'white' }}>
        {stageLabel[current] || current}
      </span>
      {canWrite && idx < STAGES.length - 1 && (
        <button onClick={advance} disabled={busy}
          className="ml-auto text-[10px] font-black px-3 py-1 rounded-full disabled:opacity-50"
          style={{ background: '#FFD400', color: '#111' }}>
          {busy ? '…' : `→ ${stageLabel[STAGES[idx + 1]]}`}
        </button>
      )}
    </div>
  )
}

function roleColor(role?: string | null) {
  const r = (role ?? '').toLowerCase()
  if (r.includes('venta')) return '#55C8F5'
  if (r.includes('logist') || r.includes('despacho')) return '#863bff'
  if (r.includes('soporte')) return '#14B8A6'
  if (r.includes('motoriz')) return '#FF8C00'
  if (r.includes('admin')) return '#111'
  return '#888'
}

// ─── Message bubble ───────────────────────────────────────────────────────────
function MessageBubble({ msg }: { msg: OrderMessage }) {
  const isSeller = msg.sender_role === 'seller'
  const time = new Date(msg.created_at).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' })

  if (msg.type === 'status_update') {
    return (
      <div className="flex justify-center mb-3">
        <div className="flex items-center gap-1.5 bg-white rounded-full px-3 py-1 shadow-sm" style={{ border: '1px solid var(--brand)' }}>
          <Package size={11} style={{ color: 'var(--brand)' }} />
          <p className="text-[11px] font-semibold" style={{ color: 'var(--brand)' }}>{msg.body}</p>
        </div>
      </div>
    )
  }

  if (msg.offer) {
    return <OfferCard offer={msg.offer} role="seller" />
  }

  const roleC = roleColor(msg.sender_role_label)
  return (
    <div className={`flex ${isSeller ? 'justify-end' : 'justify-start'} mb-3`}>
      <div className={`max-w-[80%] flex flex-col ${isSeller ? 'items-end' : 'items-start'}`}>
        {/* Sender distinction: who wrote it + their role */}
        <p className="text-[9px] mb-0.5 mx-1 font-bold flex items-center gap-1"
          style={{ color: isSeller ? roleC : '#9CA3AF' }}>
          {isSeller
            ? <>{msg.sender_name?.split(' ')[0] || 'Kross'}{msg.sender_role_label && <span className="px-1 rounded" style={{ background: `${roleC}22` }}>{msg.sender_role_label}</span>}</>
            : (msg.sender_name || 'Cliente')}
        </p>
        <div className="px-4 py-2.5 rounded-2xl text-sm"
          style={isSeller
            ? { background: '#FFD400', color: '#111', fontWeight: 600, borderRadius: '18px 18px 4px 18px' }
            : { background: 'var(--brand)', color: 'white', borderRadius: '18px 18px 18px 4px' }
          }>
          {(msg.body || '').split('\n').map((line, i, arr) => (
            <span key={i}>{line}{i < arr.length - 1 && <br />}</span>
          ))}
        </div>
        <p className="text-[10px] text-gray-400 mt-1 mx-1">{time}</p>
      </div>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function VendedorPedidoPage() {
  const { token } = useParams<{ token: string }>()
  const navigate = useNavigate()
  const { effective, isAdmin } = useSeller()
  const sellerName = effective?.nombre ?? 'Kross'
  const sellerRole = effective?.role_label ?? null

  const [session, setSession] = useState<OrderSession | null>(null)
  const [messages, setMessages] = useState<OrderMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [showCall, setShowCall] = useState(false)
  const [buyerTyping, setBuyerTyping] = useState(false)
  const [buyerOnline, setBuyerOnline] = useState(false)
  const [showInvite, setShowInvite] = useState(false)
  const [showDetail, setShowDetail] = useState(false)
  const [showOffer, setShowOffer] = useState(false)
  const [showWa, setShowWa] = useState(false)
  const [team, setTeam] = useState<{ auth_user_id: string; nombre: string; role_label: string }[]>([])
  const bottomRef = useRef<HTMLDivElement>(null)
  const channelRef = useRef<RealtimeChannel | null>(null)
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sendTypingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Load session by token (also used to refresh after assignment/participant changes)
  const reloadSession = useCallback(async (withSpinner = false) => {
    if (!token) { setLoading(false); return }
    if (withSpinner) setLoading(true)
    try {
      const res = await fetch(`${BASE}/get-session?viewer=seller`, {
        headers: { Authorization: `Bearer ${ANON}`, 'x-kross-token': token },
      })
      if (!res.ok) return
      const { session: s, messages: m } = await res.json() as { session: OrderSession; messages: OrderMessage[] }
      setSession(s)
      setMessages(m)
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => { reloadSession(true) }, [reloadSession])

  // Mark the buyer's messages as read whenever the seller has this chat open
  const markRead = useCallback((sid: string) => {
    fetch(`${BASE}/mark-chat-read`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sid, reader: 'seller' }),
    }).catch(() => {})
  }, [])

  useEffect(() => { if (session?.id) markRead(session.id) }, [session?.id, markRead])

  // Realtime
  useEffect(() => {
    if (!session) return
    const ch = supabase.channel(`order:${session.id}`)
      .on('broadcast', { event: 'new_message' }, ({ payload }) => {
        const msg = payload as OrderMessage
        setMessages(prev => {
          if (prev.some(m => m.id === msg.id)) return prev
          return [...prev.filter(m => !(m.id.startsWith('opt-') && m.sender_role === msg.sender_role)), msg]
        })
        if (msg.sender_role === 'buyer') markRead(session.id)
      })
      .on('broadcast', { event: 'stage_update' }, ({ payload }) => {
        setSession(prev => prev ? { ...prev, stage: payload.stage as OrderSession['stage'] } : prev)
      })
      .on('broadcast', { event: 'assignment_update' }, () => { reloadSession() })
      .on('broadcast', { event: 'participants_update' }, () => { reloadSession() })
      .on('broadcast', { event: 'address_update' }, ({ payload }) => {
        setSession(prev => prev ? { ...prev, address: payload.address, address_verified: payload.address_verified, address_lat: payload.address_lat, address_lng: payload.address_lng } : prev)
      })
      .on('broadcast', { event: 'order_cancelled' }, () => {
        setSession(prev => prev ? { ...prev, status: 'cancelado' } : prev)
      })
      .on('broadcast', { event: 'order_recreated' }, () => {
        setSession(prev => prev ? { ...prev, status: 'active', stage: 'nuevo' } : prev)
      })
      .on('broadcast', { event: 'nota_update' }, ({ payload }) => {
        setSession(prev => prev ? { ...prev, nota: payload.nota } : prev)
      })
      .on('broadcast', { event: 'items_update' }, ({ payload }) => {
        setSession(prev => prev ? { ...prev, items: payload.items, product_price: payload.total } : prev)
      })
      .on('broadcast', { event: 'message_update' }, ({ payload }) => {
        setMessages(prev => prev.map(m => m.id === payload.id ? { ...m, offer: payload.offer } : m))
      })
      .on('broadcast', { event: 'typing' }, ({ payload }) => {
        if (payload.role === 'buyer') {
          setBuyerTyping(true)
          if (typingTimerRef.current) clearTimeout(typingTimerRef.current)
          typingTimerRef.current = setTimeout(() => setBuyerTyping(false), 3000)
        }
      })
      .subscribe()
    channelRef.current = ch
    return () => {
      supabase.removeChannel(ch)
      channelRef.current = null
    }
  }, [session?.id])

  // Track the buyer's real presence (online anywhere in the app)
  useEffect(() => {
    const buyerId = session?.buyer_id
    if (!buyerId) return
    const ch = supabase
      .channel('presence:buyers')
      .on('presence', { event: 'sync' }, () => {
        setBuyerOnline(buyerId in ch.presenceState())
      })
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [session?.buyer_id])

  // Scroll to bottom
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, buyerTyping])

  const broadcastTyping = useCallback(() => {
    if (!channelRef.current || !session) return
    if (sendTypingTimerRef.current) return
    channelRef.current.send({ type: 'broadcast', event: 'typing', payload: { role: 'seller' } })
    sendTypingTimerRef.current = setTimeout(() => { sendTypingTimerRef.current = null }, 2000)
  }, [session])

  const handleSend = useCallback(async () => {
    if (!input.trim() || !session || sending) return
    const body = input.trim()
    setInput('')
    setSending(true)
    const optimisticId = `opt-${Date.now()}`
    const optimistic: OrderMessage = {
      id: optimisticId,
      session_id: session.id,
      sender_role: 'seller',
      sender_name: sellerName,
      sender_role_label: sellerRole,
      type: 'text',
      body,
      media_url: null,
      created_at: new Date().toISOString(),
      read_at: null,
    }
    setMessages(prev => [...prev, optimistic])
    try {
      const res = await fetch(`${BASE}/seller-send-message`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: session.id,
          seller_name: sellerName,
          seller_role: sellerRole,
          body,
          type: 'text',
        }),
      })
      if (!res.ok) throw new Error('send_failed')
      const saved: OrderMessage = await res.json()
      // Replace optimistic with real message; seller-send-message already broadcasts to buyer
      setMessages(prev => prev.map(m => m.id === optimisticId ? saved : m))
      // Also broadcast so this seller view deduplicates cleanly
      channelRef.current?.send({ type: 'broadcast', event: 'new_message', payload: saved })
    } catch {
      setMessages(prev => prev.filter(m => m.id !== optimisticId))
      setInput(body)
    } finally {
      setSending(false)
    }
  }, [input, session, sending, sellerName, sellerRole])

  if (loading) {
    return (
      <div className="flex flex-col h-screen items-center justify-center" style={{ background: '#FFFDF5' }}>
        <div className="w-10 h-10 rounded-full border-4 border-gray-200 border-t-[var(--brand)] animate-spin" />
      </div>
    )
  }

  if (!session) {
    return (
      <div className="flex flex-col h-screen items-center justify-center px-8 text-center" style={{ background: '#FFFDF5' }}>
        <Package size={40} className="text-gray-300 mb-4" />
        <p className="font-black text-gray-800">Sesión no encontrada</p>
        <button onClick={() => navigate('/vendedor/chats')} className="mt-4 text-sm text-[var(--brand)] font-semibold">
          Volver a chats
        </button>
      </div>
    )
  }

  const meId = effective?.auth_user_id
  const participants = session.participants ?? []
  const onShift = effective?.available !== false // turno (lo asigna el admin)
  const canWrite = isAdmin
    || (onShift && (session.assigned_seller_id === meId || (session.writer_seller_ids ?? []).includes(meId ?? '')))

  const openInvite = async () => {
    setShowInvite(true)
    if (team.length === 0 && session.store_id) {
      const { data } = await supabase
        .from('sellers')
        .select('auth_user_id, nombre, role_label')
        .eq('store_id', session.store_id)
        .eq('active', true)
        .not('auth_user_id', 'is', null)
      setTeam((data as any) ?? [])
    }
  }

  const invite = async (sellerAuthId: string) => {
    setShowInvite(false)
    await fetch(`${BASE}/order-manage`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'invite', session_id: session.id, invite_seller_id: sellerAuthId, by_seller_id: meId }),
    })
    reloadSession()
  }

  const expel = async (sellerAuthId: string) => {
    await fetch(`${BASE}/order-manage`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'expel', session_id: session.id, invite_seller_id: sellerAuthId, by_seller_id: meId }),
    })
    reloadSession()
  }

  return (
    <div className="flex flex-col h-screen max-w-[430px] mx-auto" style={{ background: '#FFFDF5' }}>

      {/* IncomingCallOverlay — disabled when seller already has a call open */}
      <IncomingCallOverlay storeId={effective?.store_id ?? session.store_id ?? undefined} disabled={showCall || !canWrite} />

      {/* Header */}
      <div className="flex-shrink-0 px-4 pt-3 pb-4 text-white"
        style={{ background: '#111', borderRadius: '0 0 24px 24px' }}>
        <div className="flex items-center gap-3">
          <button onClick={() => navigate('/vendedor/chats')}
            className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
            style={{ background: 'rgba(255,255,255,0.1)' }}>
            <ArrowLeft size={18} className="text-white" />
          </button>

          <div className="relative flex-shrink-0">
            <div className="w-10 h-10 rounded-2xl flex items-center justify-center text-lg font-black"
              style={{ background: '#FFD400', color: '#111' }}>
              {(session.buyer_name || 'C')[0]}
            </div>
            <div className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2"
              style={{ borderColor: '#111', background: buyerOnline ? '#4ADE80' : '#6B7280' }} />
          </div>

          <button onClick={() => setShowDetail(true)} className="flex-1 min-w-0 text-left">
            <p className="font-black text-white text-base leading-tight">{session.buyer_name || 'Comprador'}</p>
            <p className="text-xs" style={{ color: buyerOnline ? '#4ADE80' : 'rgba(255,255,255,0.6)' }}>
              {buyerOnline ? 'En línea ahora' : ((session.items && session.items.length > 1) ? `${session.items.length} productos · S/${session.product_price}` : `${session.product_name} · S/${session.product_price}`)}
            </p>
            <p className="text-[10px] mt-0.5 flex items-center gap-1" style={{ color: 'rgba(255,255,255,0.7)' }}><ShoppingCart size={11} /> Ver pedido</p>
          </button>

          <button
            onClick={() => channelRef.current?.send({ type: 'broadcast', event: 'request_push_permission', payload: {} })}
            className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0"
            style={{ background: 'rgba(255,255,255,0.15)' }}
            title="Invitar al cliente a instalar la app">
            <Bell size={16} className="text-white" />
          </button>
          <button
            onClick={() => setShowWa(true)}
            className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0"
            style={{ background: '#25D366' }}
            title="Enviar aviso por WhatsApp">
            <MessageCircle size={16} className="text-white" />
          </button>
          {canWrite && (
            <button onClick={() => setShowCall(true)}
              className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0"
              style={{ background: '#4ADE80' }}>
              <Phone size={16} className="text-white" />
            </button>
          )}
        </div>

        {/* Participants of the value chain */}
        {participants.length > 0 && (
          <div className="flex items-center gap-1.5 mt-3 overflow-x-auto">
            <Users size={12} className="text-white/40 flex-shrink-0" />
            {participants.map(p => {
              const c = roleColor(p.role_label)
              const isCurrent = !!p.is_owner
              // Only whoever invited them (or an admin) can expel an invited guest
              const canExpel = !isCurrent && (p.invited_by === meId || isAdmin)
              return (
                <span key={p.id}
                  className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold flex-shrink-0"
                  style={{ background: isCurrent ? c : 'rgba(255,255,255,0.12)', color: isCurrent ? '#fff' : 'rgba(255,255,255,0.85)' }}>
                  {p.nombre.split(' ')[0]} · {p.role_label}
                  {canExpel && (
                    <button onClick={() => expel(p.id)} title="Retirar del chat" className="ml-0.5">
                      <X size={11} />
                    </button>
                  )}
                </span>
              )
            })}
            {canWrite && (
              <button onClick={openInvite}
                className="flex items-center gap-0.5 px-2 py-0.5 rounded-full text-[10px] font-black flex-shrink-0"
                style={{ background: 'rgba(255,255,255,0.15)', color: '#fff' }}>
                <UserPlus size={11} /> Invitar
              </button>
            )}
          </div>
        )}
      </div>

      {/* Cancelado */}
      {session.status === 'cancelado' && (
        <div className="mx-4 mt-2 rounded-xl px-3 py-2 flex items-center gap-2" style={{ background: '#FEE2E2', border: '1.5px solid #FECACA' }}>
          <span>❌</span>
          <p className="text-xs font-black" style={{ color: '#DC2626' }}>Pedido cancelado — abre “Ver pedido” para reactivarlo</p>
        </div>
      )}

      {/* Stage selector */}
      {session.status !== 'cancelado' && (
      <StageSelector
        current={session.stage}
        sessionId={session.id}
        canWrite={canWrite}
        onAdvanced={(next, handedOff) => {
          setSession(s => s ? { ...s, stage: next as OrderSession['stage'] } : s)
          // Ceded the lead → back to my list; otherwise refresh in place
          if (handedOff) navigate('/vendedor/chats')
          else reloadSession()
        }}
      />
      )}

      {/* Dirección de entrega */}
      {/* Antes que la dirección: si el adelanto no cuadró, eso decide si se
          despacha o no — la dirección recién importa después. */}
      <AdvancePanel
        sessionId={session.id}
        sellerAuthId={effective?.auth_user_id ?? null}
        advanceAmount={Number(session.advance_amount ?? 0)}
        verification={session.payment_verification ?? null}
        reason={session.payment_reason ?? null}
        yapeCode={session.advance_yape_code ?? null}
        hasVoucher={!!session.advance_voucher_url}
      />

      <AddressBar
        sessionId={session.id}
        address={session.address ?? null}
        verified={!!session.address_verified}
        lat={session.address_lat}
        lng={session.address_lng}
        role="seller"
        dispatchType={session.dispatch_type}
        agencyName={session.agency_name}
        onUpdated={(address, address_verified, address_lat, address_lng) => setSession(s => s ? { ...s, address, address_verified, address_lat, address_lng } : s)}
      />

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <CheckCircle2 size={40} className="text-gray-200 mb-3" />
            <p className="text-sm text-gray-400">Sin mensajes aún</p>
          </div>
        )}
        {messages.map(msg => <MessageBubble key={msg.id} msg={msg} />)}

        {/* Typing indicator */}
        {buyerTyping && (
          <div className="flex justify-start mb-3">
            <div className="flex items-center gap-1.5 px-4 py-2.5 rounded-2xl"
              style={{ background: 'var(--brand)', borderRadius: '18px 18px 18px 4px' }}>
              {[0,1,2].map(i => (
                <div key={i} className="w-1.5 h-1.5 rounded-full animate-bounce"
                  style={{ background: 'white', animationDelay: `${i * 150}ms` }} />
              ))}
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input — only writers (current owner + invited) or admin can send */}
      <div className="flex-shrink-0 border-t border-gray-100 px-3 py-3 bg-white">
        {canWrite ? (
          <div className="flex items-center gap-2">
            <button onClick={() => setShowOffer(true)}
              className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: '#FEF3C7', color: '#D97706' }}
              title="Enviar oferta">
              <PackagePlus size={16} />
            </button>
            <input
              value={input}
              onChange={e => { setInput(e.target.value); broadcastTyping() }}
              onKeyDown={e => e.key === 'Enter' && handleSend()}
              placeholder="Escribe al cliente…"
              className="flex-1 rounded-full px-4 py-2.5 text-sm outline-none placeholder-gray-400"
              style={{ background: '#F0F0F0' }}
            />
            <button
              onClick={handleSend}
              disabled={!input.trim() || sending}
              className="w-10 h-10 rounded-full flex items-center justify-center text-white shadow-sm disabled:opacity-40"
              style={{ background: '#111' }}>
              <Send size={16} />
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-center gap-2 py-2 text-center">
            <Eye size={14} className="text-gray-400" />
            <p className="text-xs text-gray-500">
              {!onShift
                ? 'Estás fuera de turno · el administrador debe activarte para poder atender.'
                : `Solo lectura · este pedido lo atiende ${session.seller_name?.split(' ')[0] || 'otro agente'}. Pídele que te invite para participar.`}
            </p>
          </div>
        )}
      </div>

      {/* Invite modal */}
      {showInvite && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end justify-center" onClick={() => setShowInvite(false)}>
          <div className="w-full max-w-[430px] bg-white rounded-t-3xl p-5" onClick={e => e.stopPropagation()}>
            <h3 className="font-black text-gray-900 mb-1">Invitar a participar</h3>
            <p className="text-xs text-gray-400 mb-4">Podrá escribir y llamar en este pedido.</p>
            <div className="space-y-2 max-h-[50vh] overflow-y-auto">
              {team
                .filter(t => !participants.some(p => p.id === t.auth_user_id && p.can_write))
                .map(t => (
                  <button key={t.auth_user_id} onClick={() => invite(t.auth_user_id)}
                    className="w-full flex items-center gap-3 p-3 rounded-2xl border border-gray-100 text-left">
                    <div className="w-9 h-9 rounded-xl flex items-center justify-center font-black text-sm flex-shrink-0"
                      style={{ background: `${roleColor(t.role_label)}22`, color: roleColor(t.role_label) }}>
                      {t.nombre.charAt(0).toUpperCase()}
                    </div>
                    <div className="flex-1">
                      <p className="font-bold text-sm text-gray-900">{t.nombre}</p>
                      <p className="text-xs text-gray-400">{t.role_label}</p>
                    </div>
                    <UserPlus size={16} className="text-gray-300" />
                  </button>
                ))}
            </div>
            <button onClick={() => setShowInvite(false)} className="w-full mt-4 py-3 rounded-2xl bg-gray-100 text-gray-600 font-bold text-sm">
              Cerrar
            </button>
          </div>
        </div>
      )}

      {showCall && session && (
        <SellerCallModal
          sessionId={session.id}
          sellerName={sellerName}
          channelRef={channelRef}
          onClose={() => setShowCall(false)}
        />
      )}

      {showDetail && (
        <OrderDetailModal
          session={session}
          role="seller"
          onClose={() => setShowDetail(false)}
          onPatch={(patch) => setSession(s => s ? { ...s, ...patch } : s)}
        />
      )}

      {showOffer && (
        <OfferSheet
          storeId={effective?.store_id ?? session.store_id ?? ''}
          onClose={() => setShowOffer(false)}
          onSend={async (offer) => {
            setShowOffer(false)
            try {
              const res = await fetch(`${BASE}/seller-send-message`, {
                method: 'POST', headers: { Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ session_id: session.id, seller_name: sellerName, seller_role: sellerRole, type: 'text', offer, body: `🎁 Oferta: ${offer.nombre} — S/${offer.precio}` }),
              })
              if (res.ok) {
                const saved: OrderMessage = await res.json()
                setMessages(prev => prev.some(m => m.id === saved.id) ? prev : [...prev, saved])
                channelRef.current?.send({ type: 'broadcast', event: 'new_message', payload: saved })
              } else {
                alert('No se pudo enviar la oferta. Falta desplegar seller-send-message y la columna "offer".')
              }
            } catch {
              alert('No se pudo enviar la oferta. Revisa tu conexión.')
            }
          }}
        />
      )}

      {showWa && (
        <WaTemplatesSheet
          storeId={effective?.store_id ?? session.store_id ?? ''}
          sessionId={session.id}
          sellerName={sellerName}
          onClose={() => setShowWa(false)}
        />
      )}
    </div>
  )
}

// Catalog of order variables a template variable can map to
const WA_VARS = [
  { key: 'name', label: 'Nombre del cliente' },
  { key: 'product', label: 'Producto' },
  { key: 'link', label: 'Link del pedido' },
  { key: 'price', label: 'Precio' },
  { key: 'address', label: 'Dirección' },
  { key: 'order_id', label: 'N° de pedido' },
]
const DEFAULT_MAP = ['name', 'product', 'link', 'price', 'address', 'order_id']

interface WaTemplate { name: string; language: string; params: number; preview: string }

// Seller picks a WhatsApp template + maps each variable, then sends to the buyer.
function WaTemplatesSheet({ storeId, sessionId, sellerName, onClose }: {
  storeId: string; sessionId: string; sellerName: string; onClose: () => void
}) {
  const [templates, setTemplates] = useState<WaTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [open, setOpen] = useState<WaTemplate | null>(null)     // the template being configured
  const [mapping, setMapping] = useState<string[]>([])

  useEffect(() => {
    fetch(`${BASE}/list-wa-templates`, {
      method: 'POST', headers: { Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ store_id: storeId }),
    })
      .then(r => (r.ok ? r.json() : { templates: [] }))
      .then(d => setTemplates(d.templates ?? []))
      .catch(() => setTemplates([]))
      .finally(() => setLoading(false))
  }, [storeId])

  const pick = (t: WaTemplate) => {
    if (t.params === 0) { send(t, []) }               // no variables → send directly
    else { setOpen(t); setMapping(DEFAULT_MAP.slice(0, t.params)) }
  }

  const send = async (t: WaTemplate, map: string[]) => {
    setSending(true)
    try {
      const res = await fetch(`${BASE}/send-wa-template`, {
        method: 'POST', headers: { Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, template: t.name, language: t.language, params: t.params, mapping: map, seller_name: sellerName }),
      })
      const r = await res.json().catch(() => ({}))
      if (r.ok) { setDone(t.name); setTimeout(onClose, 900) }
      else alert('No se pudo enviar: ' + (r.error || 'revisa la plantilla o el número.'))
    } finally { setSending(false) }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end justify-center" onClick={onClose}>
      <div className="w-full max-w-[430px] bg-white rounded-t-3xl p-5 max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <h3 className="font-black text-gray-900 flex items-center gap-2"><MessageCircle size={18} style={{ color: '#25D366' }} /> Enviar por WhatsApp</h3>
          <button onClick={() => (open ? setOpen(null) : onClose())}><X size={18} className="text-gray-400" /></button>
        </div>

        {open ? (
          // ── Configure the template's variables ──
          <>
            <p className="text-xs text-gray-500 mb-3">Plantilla <b>{open.name}</b>. Elige qué dato va en cada variable:</p>
            <div className="space-y-2 mb-4">
              {mapping.map((mk, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="text-xs font-black text-gray-500 w-10">{`{{${i + 1}}}`}</span>
                  <select value={mk} onChange={e => setMapping(m => m.map((x, k) => k === i ? e.target.value : x))}
                    className="flex-1 bg-gray-100 rounded-xl px-3 py-2.5 text-sm outline-none">
                    {WA_VARS.map(v => <option key={v.key} value={v.key}>{v.label}</option>)}
                  </select>
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <button onClick={() => setOpen(null)} className="px-4 py-3 rounded-2xl font-black text-sm bg-gray-100 text-gray-600">Atrás</button>
              <button onClick={() => send(open, mapping)} disabled={sending}
                className="flex-1 py-3 rounded-2xl font-black text-sm text-white disabled:opacity-50" style={{ background: '#25D366' }}>
                {sending ? 'Enviando…' : 'Enviar WhatsApp'}
              </button>
            </div>
          </>
        ) : (
          // ── List of templates ──
          <>
            <p className="text-xs text-gray-400 mb-4">Elige la plantilla que le llegará al cliente. Tú decides cuándo enviar.</p>
            {loading ? (
              <div className="flex justify-center py-10"><div className="w-7 h-7 rounded-full border-4 border-gray-200 border-t-[#25D366] animate-spin" /></div>
            ) : templates.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-8">No hay plantillas disponibles. Revisa que la marca tenga su WABA ID y plantillas aprobadas.</p>
            ) : (
              <div className="space-y-2">
                {templates.map(t => (
                  <button key={t.name + t.language} onClick={() => pick(t)} disabled={sending}
                    className="w-full text-left p-3 rounded-2xl border disabled:opacity-50"
                    style={{ borderColor: done === t.name ? '#25D366' : '#eee', borderWidth: 1.5 }}>
                    <div className="flex items-center justify-between">
                      <span className="font-black text-sm text-gray-900">{t.name}</span>
                      <span className="text-[10px] font-black px-2 py-0.5 rounded-full" style={{ background: '#DCFCE7', color: '#16A34A' }}>
                        {done === t.name ? 'Enviado ✓' : `${t.params} var${t.params === 1 ? '' : 's'}`}
                      </span>
                    </div>
                    {t.preview && <p className="text-[11px] text-gray-400 mt-1 line-clamp-2">{t.preview}</p>}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ─── Offer / upsell composer ──────────────────────────────────────────────────
function OfferSheet({ storeId, onClose, onSend }: {
  storeId: string
  onClose: () => void
  onSend: (offer: { product_id?: string; nombre: string; precio: number; image?: string | null }) => void
}) {
  const [products, setProducts] = useState<{ id: string; nombre: string; precio: number; images: string[] }[]>([])
  const [productId, setProductId] = useState<string | undefined>()
  const [nombre, setNombre] = useState('')
  const [precio, setPrecio] = useState('')
  const [image, setImage] = useState<string | null>(null)

  useEffect(() => {
    if (!storeId) return
    supabase.from('products').select('id, nombre, precio, images').eq('store_id', storeId)
      .then(({ data }) => setProducts((data as any) ?? []))
  }, [storeId])

  const pick = (p: { id: string; nombre: string; precio: number; images: string[] }) => {
    setProductId(p.id); setNombre(p.nombre); setPrecio(String(p.precio || '')); setImage(p.images?.[0] ?? null)
  }
  const send = () => {
    if (!nombre.trim() || !precio) return
    onSend({ product_id: productId, nombre: nombre.trim(), precio: Number(precio) || 0, image })
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end justify-center" onClick={onClose}>
      <div className="w-full max-w-[430px] bg-white rounded-t-3xl p-5 max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-black text-gray-900 flex items-center gap-2"><PackagePlus size={18} /> Enviar oferta</h3>
          <button onClick={onClose}><X size={18} className="text-gray-400" /></button>
        </div>

        {products.length > 0 && (
          <>
            <p className="text-[10px] font-black uppercase tracking-wide text-gray-400 mb-2">Elige un producto</p>
            <div className="flex gap-2 overflow-x-auto pb-2 mb-3">
              {products.map(p => (
                <button key={p.id} onClick={() => pick(p)}
                  className="flex-shrink-0 w-24 rounded-xl overflow-hidden border text-left"
                  style={{ borderColor: productId === p.id ? '#16A34A' : '#f0f0f0', borderWidth: productId === p.id ? 2 : 1 }}>
                  {p.images?.[0]
                    ? <img src={p.images[0]} alt={p.nombre} className="w-full h-20 object-cover" />
                    : <div className="w-full h-20 bg-gray-100" />}
                  <div className="p-1.5">
                    <p className="text-[10px] font-bold text-gray-800 truncate">{p.nombre}</p>
                    <p className="text-[10px] font-black" style={{ color: '#16A34A' }}>S/{p.precio}</p>
                  </div>
                </button>
              ))}
            </div>
          </>
        )}

        <p className="text-[10px] font-black uppercase tracking-wide text-gray-400 mb-1">O escribe la oferta</p>
        <input value={nombre} onChange={e => setNombre(e.target.value)} placeholder="Nombre de la oferta"
          className="w-full bg-gray-100 rounded-2xl px-4 py-3 text-sm outline-none mb-2" />
        <input value={precio} onChange={e => setPrecio(e.target.value.replace(/[^\d.]/g, ''))} inputMode="decimal" placeholder="Precio S/"
          className="w-full bg-gray-100 rounded-2xl px-4 py-3 text-sm outline-none mb-4" />

        <button onClick={send} disabled={!nombre.trim() || !precio}
          className="w-full py-3 rounded-2xl font-black text-sm text-white disabled:opacity-40" style={{ background: '#16A34A' }}>
          Enviar oferta al cliente
        </button>
      </div>
    </div>
  )
}
