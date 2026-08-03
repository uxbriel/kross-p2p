// Vercel serverless function — serves a per-brand PWA manifest.
// Linked from index.html as <link rel="manifest" href="/api/manifest">.
// It reads the subdomain from the Host header (marca.krossclub.app → "marca"),
// looks up the store in Supabase and returns its name/icons/colors so the PWA
// installs with the BRAND's identity, not Kross.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const ANON = process.env.VITE_SUPABASE_ANON_KEY

function slugFromHost(host = '') {
  const h = host.split(':')[0]
  if (!h || h === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(h)) return null
  if (h.endsWith('vercel.app')) return null
  const parts = h.split('.')
  if (parts.length >= 3 && !['www', 'app'].includes(parts[0])) return parts[0]
  return null
}

const KROSS = {
  nombre: 'Kross', color_primary: '#55C8F5', color_dark: '#060C1A', logo_url: null,
}

export default async function handler(req, res) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || ''
  const slug = slugFromHost(host)

  let store = KROSS
  if (slug && SUPABASE_URL && ANON) {
    try {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/stores?slug=eq.${encodeURIComponent(slug)}&active=eq.true&select=nombre,logo_url,color_primary,color_dark&limit=1`,
        { headers: { apikey: ANON, Authorization: `Bearer ${ANON}` } }
      )
      if (r.ok) {
        const rows = await r.json()
        if (rows[0]) store = rows[0]
      }
    } catch { /* fall back to Kross */ }
  }

  // Siempre por `/api/icon`, del MISMO origen — nunca la URL de Storage directa.
  // Apuntar a `supabase.co` rompía el empaquetado del APK (ver api/icon.js) y
  // ataba el manifest a dónde guardamos el branding hoy.
  const icons = store.logo_url
    ? [
        { src: '/api/icon', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/api/icon', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
      ]
    : [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
      ]

  const manifest = {
    // `id` fija la identidad de la app entre versiones. Sin él, tocar
    // `start_url` hace que Android/Chrome la traten como una app NUEVA: el
    // usuario termina con dos íconos y la instalada deja de recibir push.
    id: '/',
    name: store.nombre,
    short_name: store.nombre,
    description: 'Sigue tu pedido y chatea con tu asesor',
    start_url: '/',
    display: 'standalone',
    background_color: store.color_dark || '#060C1A',
    theme_color: store.color_dark || '#060C1A',
    orientation: 'portrait',
    icons,
    categories: ['shopping', 'utilities'],
    prefer_related_applications: false,
  }

  res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8')
  res.setHeader('Cache-Control', 'public, max-age=300')
  res.status(200).send(JSON.stringify(manifest))
}
