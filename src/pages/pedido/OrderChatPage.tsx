import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { stagesFor, stageIndex } from '../../lib/order-stages'
import { Send, Play, Pause, Mic, Phone, PhoneOff, Package, Truck, MicOff, ArrowLeft, ShoppingCart } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { getSession, sendMessage, markRead } from '../../lib/order-api'
import { subscribePush, notifPermission } from '../../lib/push'
import { startRingtone } from '../../lib/ringtone'
import { sendCallReject, sendCallCancel, listenCallReject, listenCallCancel } from '../../lib/call-signal'
import InstallBanner, { isInstalled } from '../../components/InstallBanner'
import AddressBar from '../../components/AddressBar'
import OrderDetailModal from '../../components/OrderDetailModal'
import OfferCard from '../../components/OfferCard'
import type { OrderSession, OrderMessage } from '../../lib/order-api'
import type { RealtimeChannel } from '@supabase/supabase-js'

const BASE = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`
const ANON = import.meta.env.VITE_SUPABASE_ANON_KEY as string

// ─── Tracker ─────────────────────────────────────────────────────────────────
// Las etapas dependen del pedido: sin adelanto no existe "Validando". Ver
// `lib/order-stages.ts`, que es la única definición del orden.
function OrderTracker({ stage, advanceAmount }: { stage: string; advanceAmount?: number | string | null }) {
  const STAGES = stagesFor(advanceAmount)
  const currentIdx = stageIndex(stage, STAGES)
  const ACCENT = 'var(--brand)'
  const current = STAGES[currentIdx]
  const pct = STAGES.length > 1 ? (currentIdx / (STAGES.length - 1)) * 100 : 0

  return (
    <div className="mx-4 mt-3 mb-1 bg-white rounded-2xl px-4 py-3.5 shadow-sm" style={{ border: '1.5px solid #F0F0F0' }}>
      <div className="flex items-center justify-between mb-3">
        <p className="text-[10px] font-black uppercase tracking-widest" style={{ color: '#9CA3AF' }}>Estado de tu pedido</p>
        <p className="text-[11px] font-black" style={{ color: ACCENT }}>{current?.emoji} {current?.label}</p>
      </div>

      <div className="relative">
        {/* connector line (behind the dots) */}
        <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-[3px] rounded-full" style={{ background: '#EEF1F4' }} />
        <div className="absolute left-0 top-1/2 -translate-y-1/2 h-[3px] rounded-full transition-all" style={{ background: ACCENT, width: `${pct}%` }} />

        <div className="relative flex items-center justify-between">
          {STAGES.map((s, i) => {
            const done = i < currentIdx
            const isCurrent = i === currentIdx
            return (
              <div key={s.key} className="flex flex-col items-center" style={{ width: 20 }}>
                <div className="rounded-full flex items-center justify-center"
                  style={isCurrent
                    ? { width: 20, height: 20, background: ACCENT, boxShadow: `0 0 0 4px ${ACCENT}33` }
                    : done
                    ? { width: 16, height: 16, background: ACCENT }
                    : { width: 16, height: 16, background: '#fff', border: '2px solid #E5E7EB' }
                  }>
                  {done && <svg width="9" height="9" viewBox="0 0 24 24"><path d="M5 12l5 5L20 6" stroke="#fff" strokeWidth="3.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                  {isCurrent && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* labels */}
      <div className="flex items-center justify-between mt-1.5">
        {STAGES.map((s, i) => {
          const isCurrent = i === currentIdx
          return (
            <p key={s.key} className="text-[8px] font-bold text-center leading-tight" style={{ width: 46, color: isCurrent ? '#111' : i < currentIdx ? ACCENT : '#C4C9CF' }}>
              {s.label}
            </p>
          )
        })}
      </div>
    </div>
  )
}

// ─── Audio bubble ─────────────────────────────────────────────────────────────
function AudioBubble({ durationLabel }: { durationLabel?: string }) {
  const [playing, setPlaying] = useState(false)
  return (
    <div className="flex items-center gap-3 rounded-2xl px-4 py-3 min-w-[200px]" style={{ background: '#FFD400' }}>
      <button onClick={() => setPlaying(!playing)}
        className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0"
        style={{ background: '#111', color: '#FFD400' }}>
        {playing ? <Pause size={16} /> : <Play size={16} />}
      </button>
      <div className="flex-1">
        <div className="flex items-end gap-0.5 h-6">
          {[4,9,14,7,16,11,6,18,8,5,13,9,12,16,7,11,4,13,9,6,15,10].map((h, i) => (
            <div key={i} className="w-0.5 rounded-full"
              style={{ height: `${h}px`, background: '#111' }} />
          ))}
        </div>
        <p className="text-[11px] mt-1 font-bold" style={{ color: '#111' }}>{durationLabel || '0:42'}</p>
      </div>
      <Mic size={14} style={{ color: '#111' }} />
    </div>
  )
}

// ─── Message bubble ───────────────────────────────────────────────────────────
function MessageBubble({ msg, onAcceptOffer }: { msg: OrderMessage; onAcceptOffer?: (offer: NonNullable<OrderMessage['offer']>, messageId: string) => void }) {
  const isBuyer = msg.sender_role === 'buyer'
  const time = new Date(msg.created_at).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' })

  if (msg.offer) {
    return <OfferCard offer={msg.offer} role="buyer" onAccept={onAcceptOffer ? () => onAcceptOffer(msg.offer!, msg.id) : undefined} />
  }

  if (msg.type === 'audio') {
    return (
      <div className={`flex ${isBuyer ? 'justify-end' : 'justify-start'} mb-3`}>
        <div>
          <AudioBubble />
          <p className="text-[10px] text-gray-400 mt-1 ml-1">{time}</p>
        </div>
      </div>
    )
  }

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

  if (msg.type === 'call_log') {
    return (
      <div className="flex justify-center mb-3">
        <div className="flex items-center gap-1.5 bg-gray-50 rounded-full px-3 py-1">
          <Phone size={11} className="text-gray-400" />
          <p className="text-[11px] text-gray-400">{msg.body}</p>
        </div>
      </div>
    )
  }

  return (
    <div className={`flex ${isBuyer ? 'justify-end' : 'justify-start'} mb-3`}>
      <div className={`max-w-[80%] flex flex-col ${isBuyer ? 'items-end' : 'items-start'}`}>
        {/* Who is writing — so the buyer knows which agent (Ventas/Despacho/Motorizado) */}
        {!isBuyer && (msg.sender_name || msg.sender_role_label) && (
          <p className="text-[9px] mb-0.5 mx-1 font-bold" style={{ color: '#111' }}>
            {msg.sender_name?.split(' ')[0]}
            {msg.sender_role_label && <span className="text-gray-400 font-semibold"> · {msg.sender_role_label}</span>}
          </p>
        )}
        <div className="px-4 py-2.5 rounded-2xl text-sm"
          style={isBuyer
            ? { background: 'var(--brand)', color: 'white', borderRadius: '18px 18px 4px 18px' }
            : { background: '#FFD400', color: '#111', fontWeight: 600, borderRadius: '18px 18px 18px 4px' }
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

// ─── Call modal (buyer initiates or answers seller call) ──────────────────────
type CallState = 'connecting' | 'connected' | 'ended' | 'error'

function CallModal({ token, sessionId, buyerName, sellerName, sellerRole, sellerAvatar, onClose }: { token: string; sessionId: string; buyerName: string; sellerName?: string | null; sellerRole?: string | null; sellerAvatar?: string | null; onClose: () => void }) {
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
        const res = await fetch(`${BASE}/create-call-token`, {
          headers: { Authorization: `Bearer ${ANON}`, 'x-kross-token': token },
        })
        if (!res.ok) throw new Error('token_failed')
        const { livekit_url, livekit_token } = await res.json() as { livekit_url: string; livekit_token: string }

        const { Room, RoomEvent, createLocalTracks, Track } = await import('livekit-client')

        const room = new Room()
        roomRef.current = room

        room.on(RoomEvent.Disconnected, () => {
          if (!cancelled) setCallState('ended')
        })

        // End call when remote party hangs up
        room.on(RoomEvent.ParticipantDisconnected, () => {
          if (!cancelled && room.remoteParticipants.size === 0) {
            if (timerRef.current) clearInterval(timerRef.current)
            setCallState('ended')
            setTimeout(onClose, 1500)
          }
        })

        // Only mark "connected" when the other party actually joins
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
          if ('wakeLock' in navigator) {
            (navigator as any).wakeLock.request('screen')
              .then((wl: any) => { wakeLockRef.current = wl })
              .catch(() => {})
          }
          // MediaSession: keep audio alive in background
          if ('mediaSession' in navigator) {
            navigator.mediaSession.metadata = new MediaMetadata({
              title: 'En llamada · Kross',
              artist: 'Teddy · Kross',
            })
            navigator.mediaSession.playbackState = 'playing'
          }
          // Answering a seller call: they're already in the room → connected.
          // Buyer-initiated call: wait for the seller to answer.
          if (room.remoteParticipants.size > 0) {
            setCallState('connected')
            timerRef.current = setInterval(() => setElapsed(e => e + 1), 1000)
          }
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
  }, [token])

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
    // If the other side never joined the room, tell them to stop ringing
    if (notifyRemote && (roomRef.current?.remoteParticipants.size ?? 0) === 0) {
      sendCallCancel(sessionId)
    }
    roomRef.current?.disconnect()
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none'
    setCallState('ended')
    setTimeout(onClose, 1200)
  }

  const hangUp = () => endCall(true)

  // The callee rejected while we were still waiting — end on this side too
  useEffect(() => listenCallReject(sessionId, () => endCall(false)), [sessionId])

  const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center" style={{ background: 'rgba(0,0,0,0.65)' }}
      onClick={e => e.target === e.currentTarget && callState === 'ended' && onClose()}>
      <div className="w-full max-w-[430px] rounded-t-3xl pb-10 pt-8 px-6 text-center"
        style={{ background: '#111' }}>

        <div className="w-24 h-24 rounded-full overflow-hidden border-4 mx-auto mb-4 flex items-center justify-center"
          style={{ borderColor: callState === 'connected' ? '#4ADE80' : callState === 'error' ? '#EF4444' : '#FFD400', background: '#FFD400' }}>
          {sellerAvatar ? (
            <img src={sellerAvatar} alt={sellerName ?? 'Kross'} className="w-full h-full object-cover" />
          ) : (
          <svg viewBox="0 0 64 64" width="96" height="96" xmlns="http://www.w3.org/2000/svg">
            <circle cx="32" cy="32" r="32" fill="#FFF9E0"/>
            <ellipse cx="32" cy="48" rx="14" ry="11" fill="#D4A05A"/>
            <circle cx="32" cy="28" r="16" fill="#E8B86D"/>
            <circle cx="17" cy="16" r="6" fill="#D4A05A"/>
            <circle cx="47" cy="16" r="6" fill="#D4A05A"/>
            <circle cx="17" cy="16" r="3.5" fill="#F5C98A"/>
            <circle cx="47" cy="16" r="3.5" fill="#F5C98A"/>
            <ellipse cx="32" cy="31" rx="10" ry="8" fill="#F5C98A"/>
            <circle cx="26" cy="26" r="2.5" fill="#1A1A1A"/>
            <circle cx="38" cy="26" r="2.5" fill="#1A1A1A"/>
            <circle cx="26.8" cy="25.2" r="0.9" fill="white"/>
            <circle cx="38.8" cy="25.2" r="0.9" fill="white"/>
            <ellipse cx="32" cy="31" rx="2.5" ry="1.8" fill="#1A1A1A"/>
            <path d="M28.5 33.5 Q32 36.5 35.5 33.5" stroke="#1A1A1A" strokeWidth="1.3" fill="none" strokeLinecap="round"/>
          </svg>
          )}
        </div>

        <p className="text-white font-black text-xl mb-1">
          {sellerName ? `${sellerName.split(' ')[0]}${sellerRole ? ` · ${sellerRole}` : ''}` : 'Kross'}
        </p>
        <p className="text-sm mb-6" style={{ color: 'rgba(255,255,255,0.55)' }}>
          {callState === 'connecting' && 'Llamando…'}
          {callState === 'connected' && `En llamada · ${fmt(elapsed)}`}
          {callState === 'ended' && 'Llamada finalizada'}
          {callState === 'error' && 'No se pudo conectar'}
        </p>

        {callState === 'connected' && (
          <div className="flex items-center justify-center gap-1 mb-8">
            {[12,20,28,20,12,28,16,24,12,20].map((h, i) => (
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

        <p className="text-[10px] mt-4" style={{ color: 'rgba(255,255,255,0.3)' }}>
          Hola {buyerName}, solo Kross puede llamarte desde este número · 🔴 Esta llamada puede ser grabada para calidad
        </p>
      </div>
    </div>
  )
}

// ─── Incoming call from seller ────────────────────────────────────────────────
function BuyerIncomingCall({ sessionId, onAnswer, onReject, sellerName, sellerRole, sellerAvatar }: { sessionId: string; onAnswer: () => void; onReject: () => void; sellerName?: string | null; sellerRole?: string | null; sellerAvatar?: string | null }) {
  useEffect(() => {
    const stop = startRingtone()
    return stop
  }, [])

  // The seller hung up before we answered — stop ringing
  useEffect(() => listenCallCancel(sessionId, onReject), [sessionId])

  const reject = () => {
    sendCallReject(sessionId)
    onReject()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center" style={{ background: 'rgba(0,0,0,0.65)' }}>
      <div className="w-full max-w-[430px] rounded-t-3xl pb-10 pt-8 px-6 text-center" style={{ background: '#111' }}>
        <div className="w-24 h-24 rounded-full overflow-hidden flex items-center justify-center mx-auto mb-4 text-3xl animate-bounce border-4"
          style={{ background: '#FFD400', borderColor: '#FFD400' }}>
          {sellerAvatar
            ? <img src={sellerAvatar} alt={sellerName ?? 'Kross'} className="w-full h-full object-cover" />
            : '📞'}
        </div>
        <p className="text-white font-black text-xl mb-1">
          {sellerName ? `${sellerName.split(' ')[0]}${sellerRole ? ` · ${sellerRole}` : ''}` : 'Kross'}
        </p>
        <p className="text-sm mb-2 font-semibold" style={{ color: 'rgba(255,255,255,0.55)' }}>
          Llamada entrante…
        </p>
        <p className="text-[10px] mb-6" style={{ color: 'rgba(255,255,255,0.35)' }}>🔴 Esta llamada puede ser grabada para calidad</p>
        <div className="flex items-center justify-center gap-10">
          <div className="flex flex-col items-center gap-2">
            <button onClick={reject}
              className="w-16 h-16 rounded-full flex items-center justify-center"
              style={{ background: '#EF4444' }}>
              <PhoneOff size={26} className="text-white" />
            </button>
            <p className="text-xs text-gray-400">Rechazar</p>
          </div>
          <div className="flex flex-col items-center gap-2">
            <button onClick={onAnswer}
              className="w-16 h-16 rounded-full flex items-center justify-center animate-pulse"
              style={{ background: '#4ADE80' }}>
              <Phone size={26} className="text-white" />
            </button>
            <p className="text-xs text-gray-400">Contestar</p>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Skeleton loader ──────────────────────────────────────────────────────────
function Skeleton() {
  return (
    <div className="flex flex-col h-screen" style={{ background: 'var(--brand)' }}>
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center text-white">
          <div className="w-16 h-16 rounded-2xl bg-white/20 flex items-center justify-center mx-auto mb-4 animate-pulse">
            <Package size={32} className="text-white/60" />
          </div>
          <p className="font-black text-lg">Cargando tu pedido…</p>
          <p className="text-white/70 text-sm mt-1">Un momento</p>
        </div>
      </div>
    </div>
  )
}

// ─── Error states ─────────────────────────────────────────────────────────────
function ErrorPage({ type }: { type: 'not_found' | 'expired' | 'error' }) {
  const msgs = {
    not_found: { title: 'Pedido no encontrado', body: 'El link que usaste no es válido. Revisa el mensaje que te enviamos por WhatsApp.' },
    expired:   { title: 'Link vencido',         body: 'Este link de seguimiento ya venció. Contáctanos por WhatsApp para obtener uno nuevo.' },
    error:     { title: 'Algo salió mal',        body: 'No pudimos cargar tu pedido. Intenta de nuevo en unos minutos.' },
  }
  const { title, body } = msgs[type]
  return (
    <div className="flex flex-col h-screen items-center justify-center px-8 text-center" style={{ background: '#FFFDF5' }}>
      <div className="w-20 h-20 rounded-3xl flex items-center justify-center mb-6" style={{ background: '#FFD400' }}>
        <Package size={36} style={{ color: '#111' }} />
      </div>
      <p className="font-black text-xl text-gray-900 mb-2">{title}</p>
      <p className="text-sm text-gray-500 leading-relaxed">{body}</p>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function OrderChatPage() {
  const { token } = useParams<{ token: string }>()
  const navigate = useNavigate()
  const [state, setState] = useState<'loading' | 'not_found' | 'expired' | 'error' | 'ok'>('loading')
  const [session, setSession] = useState<OrderSession | null>(null)
  const [messages, setMessages] = useState<OrderMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [showInstall, setShowInstall] = useState(false)
  const [showCall, setShowCall] = useState(false)
  const [showDetail, setShowDetail] = useState(false)
  const [sellerCalling, setSellerCalling] = useState(false)
  const [sellerTyping, setSellerTyping] = useState(false)

  // Auto-open the call when arriving from a global incoming-call notification (?call=1)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('call') === '1') {
      setShowCall(true)
      window.history.replaceState({}, '', window.location.pathname)
    }
  }, [])
  const bottomRef = useRef<HTMLDivElement>(null)
  const channelRef = useRef<RealtimeChannel | null>(null)
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sendTypingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Load session
  useEffect(() => {
    if (!token) { setState('not_found'); return }
    getSession(token)
      .then(({ session: s, messages: m }) => {
        if (s.status === 'expired') { setState('expired'); return }
        setSession(s)
        setMessages(m)
        setState('ok')
        markRead(token).catch(() => {})
        // Auto-login: if the buyer reached this chat from a link/push without a
        // session, log them in from the order's buyer so their home (Mis pedidos +
        // score) works on the back arrow AND the seller sees them as "En línea".
        if (!localStorage.getItem('buyer_session') && s.buyer_id) {
          fetch(`${BASE}/buyer-login`, {
            method: 'POST', headers: { Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ buyer_id: s.buyer_id, store_id: s.store_id }),
          })
            .then(r => (r.ok ? r.json() : null))
            .then(session => {
              if (session?.buyer) {
                localStorage.setItem('buyer_session', JSON.stringify(session))
                window.dispatchEvent(new Event('buyer-session-changed'))
              }
            })
            .catch(() => {})
        }
        // Notifications: once the PWA is installed the buyer gets push by default
        // (we turn it on for them). If it's not installed yet, invite to install
        // — that's what unlocks real-time order alerts.
        // Only prompt buyers who already have a session (i.e. logged in / ordered),
        // never on a first anonymous glance, so it doesn't distract them.
        const loggedIn = !!localStorage.getItem('buyer_session')
        if (isInstalled()) {
          if (notifPermission() !== 'denied') subscribePush({ sessionId: s.id, role: 'buyer' }).catch(() => {})
        } else if (loggedIn) {
          setTimeout(() => setShowInstall(true), 3000)
        }
      })
      .catch((e: Error) => setState(e.message === 'not_found' ? 'not_found' : 'error'))
  }, [token])

  // Realtime broadcast subscription
  useEffect(() => {
    if (!session) return
    const ch = supabase
      .channel(`order:${session.id}`)
      .on('broadcast', { event: 'new_message' }, ({ payload }) => {
        const msg = payload as OrderMessage
        // The buyer never sees seller-only entries (e.g. expulsions)
        if (msg.visibility === 'sellers') return
        setMessages(prev => {
          if (prev.some(m => m.id === msg.id)) return prev
          // Replace optimistic message from same role if exists
          return [...prev.filter(m => !(m.id.startsWith('opt-') && m.sender_role === msg.sender_role)), msg]
        })
      })
      .on('broadcast', { event: 'stage_update' }, ({ payload }) => {
        setSession(prev => prev ? { ...prev, stage: payload.stage } : prev)
      })
      .on('broadcast', { event: 'assignment_update' }, ({ payload }) => {
        setSession(prev => prev ? {
          ...prev,
          seller_name: payload.seller_name ?? prev.seller_name,
          seller_role: payload.seller_role ?? prev.seller_role,
          seller_avatar: payload.seller_avatar ?? prev.seller_avatar,
        } : prev)
      })
      .on('broadcast', { event: 'address_update' }, ({ payload }) => {
        setSession(prev => prev ? { ...prev, address: payload.address, address_verified: payload.address_verified, address_lat: payload.address_lat, address_lng: payload.address_lng } : prev)
      })
      .on('broadcast', { event: 'order_cancelled' }, () => {
        setSession(prev => prev ? { ...prev, status: 'cancelado' } : prev)
      })
      .on('broadcast', { event: 'order_recreated' }, () => {
        setSession(prev => prev ? { ...prev, status: 'active', stage: 'nuevo' } : prev)
      })
      .on('broadcast', { event: 'items_update' }, ({ payload }) => {
        setSession(prev => prev ? { ...prev, items: payload.items, product_price: payload.total } : prev)
      })
      .on('broadcast', { event: 'message_update' }, ({ payload }) => {
        setMessages(prev => prev.map(m => m.id === payload.id ? { ...m, offer: payload.offer } : m))
      })
      .on('broadcast', { event: 'seller_call_request' }, () => {
        setSellerCalling(true)
      })
      .on('broadcast', { event: 'request_push_permission' }, () => {
        // Seller tapped the bell on the order. Not installed → invite to install
        // the app; already installed → make sure push is on.
        if (!isInstalled()) {
          setShowInstall(true)
        } else if (notifPermission() !== 'granted') {
          subscribePush({ sessionId: session.id, role: 'buyer' }).catch(() => {})
        }
      })
      .on('broadcast', { event: 'typing' }, ({ payload }) => {
        if (payload.role === 'seller') {
          setSellerTyping(true)
          if (typingTimerRef.current) clearTimeout(typingTimerRef.current)
          typingTimerRef.current = setTimeout(() => setSellerTyping(false), 3000)
        }
      })
      .subscribe()
    channelRef.current = ch
    return () => {
      supabase.removeChannel(ch)
      channelRef.current = null
    }
  }, [session?.id])

  // Scroll to bottom
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, sellerTyping])

  // Register Service Worker
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {})
    }
  }, [])

  const broadcastTyping = useCallback(() => {
    if (!channelRef.current || !session) return
    if (sendTypingTimerRef.current) return // debounce — only send once per 2s
    channelRef.current.send({ type: 'broadcast', event: 'typing', payload: { role: 'buyer' } })
    sendTypingTimerRef.current = setTimeout(() => { sendTypingTimerRef.current = null }, 2000)
  }, [session])

  const handleSend = useCallback(async () => {
    if (!input.trim() || !token || sending) return
    const body = input.trim()
    setInput('')
    setSending(true)
    const optimisticId = `opt-${Date.now()}`
    const optimistic: OrderMessage = {
      id: optimisticId,
      session_id: session!.id,
      sender_role: 'buyer',
      sender_name: session?.buyer_name ?? null,
      type: 'text',
      body,
      media_url: null,
      created_at: new Date().toISOString(),
      read_at: null,
    }
    setMessages(prev => [...prev, optimistic])
    try {
      const saved = await sendMessage(token, { type: 'text', body })
      // Replace optimistic with real message and broadcast to seller
      setMessages(prev => prev.map(m => m.id === optimisticId ? saved : m))
      channelRef.current?.send({ type: 'broadcast', event: 'new_message', payload: saved })
    } catch {
      setMessages(prev => prev.filter(m => m.id !== optimisticId))
      setInput(body)
    } finally {
      setSending(false)
    }
  }, [input, token, session, sending])

  const acceptOffer = useCallback(async (offer: NonNullable<OrderMessage['offer']>, messageId: string) => {
    if (!session) return
    // Disable the button immediately so it can't be accepted twice
    setMessages(prev => prev.map(m => m.id === messageId && m.offer ? { ...m, offer: { ...m.offer, accepted: true } } : m))
    try {
      const res = await fetch(`${BASE}/order-manage`, {
        method: 'POST', headers: { Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'accept_offer', session_id: session.id, offer, message_id: messageId }),
      })
      const r = await res.json()
      // Merged into the same order → stay here (items_update refreshes the cart).
      // New separate order → open it.
      if (!r.merged && r.token) navigate(`/p/${r.token}`)
    } catch { /* ignore */ }
  }, [session, navigate])

  if (state === 'loading') return <Skeleton />
  if (state === 'not_found') return <ErrorPage type="not_found" />
  if (state === 'expired') return <ErrorPage type="expired" />
  if (state === 'error') return <ErrorPage type="error" />
  if (!session) return null

  const firstName = session.buyer_name?.split(' ')[0] ?? 'Cliente'

  return (
    <div className="flex flex-col h-screen max-w-[430px] mx-auto" style={{ background: '#FFFDF5' }}>

      {/* ── Header ── */}
      <div className="flex-shrink-0 px-4 pt-3 pb-5 text-white"
        style={{ background: 'var(--brand)', borderRadius: '0 0 32px 32px' }}>
        <div className="flex items-center gap-3">
          <button onClick={() => navigate('/mis-pedidos')}
            className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
            style={{ background: 'rgba(255,255,255,0.25)' }}
            title="Mis pedidos">
            <ArrowLeft size={18} className="text-white" />
          </button>

          <div className="relative flex-shrink-0">
            <div className="w-11 h-11 rounded-full overflow-hidden border-2 border-white/60">
              {session?.seller_avatar ? (
                <img src={session.seller_avatar} alt={session.seller_name ?? 'Vendedor'}
                  className="w-full h-full object-cover" />
              ) : (
              <svg viewBox="0 0 64 64" width="44" height="44" xmlns="http://www.w3.org/2000/svg">
                <circle cx="32" cy="32" r="32" fill="#FFF9E0"/>
                <ellipse cx="32" cy="48" rx="14" ry="11" fill="#D4A05A"/>
                <circle cx="32" cy="28" r="16" fill="#E8B86D"/>
                <circle cx="17" cy="16" r="6" fill="#D4A05A"/>
                <circle cx="47" cy="16" r="6" fill="#D4A05A"/>
                <circle cx="17" cy="16" r="3.5" fill="#F5C98A"/>
                <circle cx="47" cy="16" r="3.5" fill="#F5C98A"/>
                <ellipse cx="32" cy="31" rx="10" ry="8" fill="#F5C98A"/>
                <circle cx="26" cy="26" r="2.5" fill="#1A1A1A"/>
                <circle cx="38" cy="26" r="2.5" fill="#1A1A1A"/>
                <circle cx="26.8" cy="25.2" r="0.9" fill="white"/>
                <circle cx="38.8" cy="25.2" r="0.9" fill="white"/>
                <ellipse cx="32" cy="31" rx="2.5" ry="1.8" fill="#1A1A1A"/>
                <path d="M28.5 33.5 Q32 36.5 35.5 33.5" stroke="#1A1A1A" strokeWidth="1.3" fill="none" strokeLinecap="round"/>
                <ellipse cx="32" cy="13" rx="13" ry="4" fill="var(--brand)"/>
                <rect x="19" y="9" width="26" height="8" rx="4" fill="var(--brand)"/>
                <rect x="23" y="6" width="18" height="7" rx="3.5" fill="#2BB5EE"/>
                <circle cx="32" cy="6" r="2.5" fill="#FFD400"/>
              </svg>
              )}
            </div>
            <div className="absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-white"
              style={{ background: '#4ADE80' }} />
          </div>

          <div className="flex-1 min-w-0">
            <p className="font-black text-white text-base leading-tight">
              {session?.seller_name
                ? `${session.seller_name.split(' ')[0]}${session.seller_role ? ` · ${session.seller_role}` : ' · Kross'}`
                : 'Kross'}
            </p>
            <p className="text-xs font-semibold" style={{ color: 'rgba(255,255,255,0.85)' }}>
              ¡Hola {firstName}! En línea ahora
            </p>
          </div>

          {session?.buyer_can_call && (
            <button
              onClick={() => setShowCall(true)}
              className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 bg-white"
              style={{ border: '2px solid #111' }}>
              <Phone size={16} style={{ color: '#111' }} />
            </button>
          )}
        </div>

        <button onClick={() => setShowDetail(true)}
          className="mt-3 w-full rounded-2xl px-2.5 py-2 flex items-center gap-2.5 text-left"
          style={{ background: 'rgba(255,255,255,0.2)' }}>
          <div className="w-10 h-10 rounded-xl overflow-hidden flex-shrink-0" style={{ background: 'rgba(255,255,255,0.25)' }}>
            {session.items?.[0]?.image
              ? <img src={session.items[0].image!} alt="" className="w-full h-full object-cover" />
              : <ShoppingCart size={16} className="m-auto mt-3 text-white/70" />}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-semibold flex items-center gap-1" style={{ color: 'rgba(255,255,255,0.85)' }}>
              <ShoppingCart size={11} /> Ver pedido
            </p>
            <p className="text-sm font-black text-white truncate max-w-[180px]">
              {(session.items && session.items.length > 1)
                ? `${session.items[0].nombre} +${session.items.length - 1} más`
                : (session.product_name || 'Producto Kross')}
            </p>
          </div>
          <p className="font-black text-lg text-white flex-shrink-0 ml-1">
            {session.product_price ? `S/${session.product_price}` : ''}
          </p>
        </button>
      </div>

      {/* ── Cancelado ── */}
      {session.status === 'cancelado' && (
        <div className="flex-shrink-0 mx-4 mt-2 rounded-2xl px-4 py-2.5 flex items-center gap-2"
          style={{ background: '#FEE2E2', border: '1.5px solid #FECACA' }}>
          <span className="text-lg">❌</span>
          <p className="text-xs font-black" style={{ color: '#DC2626' }}>Pedido cancelado</p>
        </div>
      )}

      {/* ── Tracker ── */}
      {session.status !== 'cancelado' && (
      <div className="flex-shrink-0">
        <OrderTracker stage={session.stage} advanceAmount={session.advance_amount} />
      </div>
      )}

      {/* ── Dirección de entrega ── */}
      <div className="flex-shrink-0">
        <AddressBar
          sessionId={session.id}
          address={session.address ?? null}
          verified={!!session.address_verified}
          lat={session.address_lat}
          lng={session.address_lng}
          role="buyer"
          dispatchType={session.dispatch_type}
          agencyName={session.agency_name}
          onUpdated={(address, address_verified, address_lat, address_lng) => setSession(s => s ? { ...s, address, address_verified, address_lat, address_lng } : s)}
        />
      </div>

      {/* ── Instala la app (banner inline, no tapa el input) ── */}
      {showInstall && (
        <div className="flex-shrink-0">
          <InstallBanner inline onInstalled={() => {
            setShowInstall(false)
            subscribePush({ sessionId: session.id, role: 'buyer' }).catch(() => {})
          }} />
        </div>
      )}

      {/* ── Messages ── */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <Truck size={40} style={{ color: 'var(--brand)' }} className="mb-3 opacity-40" />
            <p className="text-sm text-gray-400">Tu pedido está en camino.<br/>Pronto recibirás novedades aquí.</p>
          </div>
        )}
        {messages.map(msg => <MessageBubble key={msg.id} msg={msg} onAcceptOffer={acceptOffer} />)}

        {/* Typing indicator */}
        {sellerTyping && (
          <div className="flex justify-start mb-3">
            <div className="flex items-center gap-1.5 px-4 py-2.5 rounded-2xl"
              style={{ background: '#FFD400', borderRadius: '18px 18px 18px 4px' }}>
              {[0,1,2].map(i => (
                <div key={i} className="w-1.5 h-1.5 rounded-full animate-bounce"
                  style={{ background: '#111', animationDelay: `${i * 150}ms` }} />
              ))}
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* ── Input ── */}
      <div className="flex-shrink-0 border-t border-gray-100 px-3 py-3 bg-white">
        <div className="flex items-center gap-2">
          <input
            value={input}
            onChange={e => { setInput(e.target.value); broadcastTyping() }}
            onKeyDown={e => e.key === 'Enter' && handleSend()}
            placeholder="Escribe tu mensaje…"
            className="flex-1 rounded-full px-4 py-2.5 text-sm outline-none placeholder-gray-400"
            style={{ background: '#F0F0F0' }}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || sending}
            className="w-10 h-10 rounded-full flex items-center justify-center text-white shadow-sm disabled:opacity-40"
            style={{ background: 'var(--brand)' }}>
            <Send size={16} />
          </button>
        </div>
      </div>

      {/* ── Call modals ── */}
      {sellerCalling && !showCall && (
        <BuyerIncomingCall
          sessionId={session.id}
          onAnswer={() => { setSellerCalling(false); setShowCall(true) }}
          onReject={() => setSellerCalling(false)}
          sellerName={session?.seller_name}
          sellerRole={session?.seller_role}
          sellerAvatar={session?.seller_avatar}
        />
      )}

      {showCall && token && (
        <CallModal
          token={token}
          sessionId={session.id}
          buyerName={firstName}
          sellerName={session?.seller_name}
          sellerRole={session?.seller_role}
          sellerAvatar={session?.seller_avatar}
          onClose={() => setShowCall(false)}
        />
      )}

      {showDetail && (
        <OrderDetailModal
          session={session}
          role="buyer"
          onClose={() => setShowDetail(false)}
          onPatch={(patch) => setSession(s => s ? { ...s, ...patch } : s)}
        />
      )}
    </div>
  )
}
