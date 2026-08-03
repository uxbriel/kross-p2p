// Sirve el logo de la marca DESDE EL PROPIO DOMINIO (`/api/icon`).
//
// El manifest apuntaba directo a Supabase Storage, y eso rompía el empaquetado
// del APK: `supabase.co` está en la Public Suffix List, Cloudflare responde con
// una cookie `__cf_bm` sobre ese dominio, y la librería de cookies de bubblewrap
// la rechaza y aborta el build entero ("Cookie has domain set to a public
// suffix"). Nada de eso es culpa del logo — es el cruce de orígenes.
//
// Sirviéndolo desde acá el ícono viaja por el mismo origen que la PWA, así que
// además: se cachea con el resto del sitio, y si mañana cambia dónde guardamos
// el branding, el manifest no se entera.
import { slugFromHost } from './_android-apps.js'

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const ANON = process.env.VITE_SUPABASE_ANON_KEY

export default async function handler(req, res) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || ''
  const slug = slugFromHost(host)

  let logoUrl = null
  if (slug && SUPABASE_URL && ANON) {
    try {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/stores?slug=eq.${encodeURIComponent(slug)}&active=eq.true&select=logo_url&limit=1`,
        { headers: { apikey: ANON, Authorization: `Bearer ${ANON}` } }
      )
      if (r.ok) logoUrl = (await r.json())[0]?.logo_url ?? null
    } catch { /* cae al ícono de Kross */ }
  }

  // Sin logo propio —o si Storage falla— se redirige al ícono de Kross, que es
  // un archivo estático de este mismo dominio. Nunca se devuelve un 404: un
  // manifest con ícono roto no instala.
  if (!logoUrl) {
    res.setHeader('Cache-Control', 'public, max-age=300')
    res.redirect(302, '/icon-512.png')
    return
  }

  try {
    const img = await fetch(logoUrl)
    if (!img.ok) throw new Error(String(img.status))
    const buf = Buffer.from(await img.arrayBuffer())
    res.setHeader('Content-Type', img.headers.get('content-type') || 'image/png')
    // Una hora: el logo casi nunca cambia, y cuando cambia el subdominio se
    // repuebla solo. Más agresivo dejaría marcas con el logo viejo días.
    res.setHeader('Cache-Control', 'public, max-age=3600')
    res.status(200).send(buf)
  } catch {
    res.redirect(302, '/icon-512.png')
  }
}
