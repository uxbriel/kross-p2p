// Registro de APKs por marca. Lo lee `/.well-known/assetlinks.json`.
//
// Estas huellas NO son secretas: la SHA-256 del certificado de firma va dentro
// de cada APK que publicas y el archivo assetlinks es público por diseño. Lo
// secreto es el .keystore y su contraseña — eso NUNCA entra al repo.
//
// Cada marca = un APK propio. No es capricho: Android amarra la app a UN
// origen, así que `gadicaf.krossclub.app` solo puede verificar el APK de
// Gadicaf. Y encaja con el producto: cada marca quiere su nombre y su ícono en
// el celular, no "Kross".
//
// Para dar de alta una marca:
//   1. genera su APK (ver docs/04-APK-ANDROID.md)
//   2. saca la huella:  keytool -list -v -keystore android.keystore -alias kross
//   3. pega el slug, el package y la huella acá
//   4. deploy — Android revalida en cuanto instalas
export const ANDROID_APPS = {
  // gadicaf: {
  //   packageName: 'app.krossclub.gadicaf',
  //   fingerprints: ['AA:BB:CC:...'],
  // },
}

/** `marca.krossclub.app` → `marca`. Misma lógica que `api/manifest.js`: si
 *  cambia una, cambia la otra o el APK deja de verificar. */
export function slugFromHost(host = '') {
  const h = host.split(':')[0]
  if (!h || h === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(h)) return null
  if (h.endsWith('vercel.app')) return null
  const parts = h.split('.')
  if (parts.length >= 3 && !['www', 'app'].includes(parts[0])) return parts[0]
  return null
}
