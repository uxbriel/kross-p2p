// Digital Asset Links — el handshake que convierte la PWA en app Android.
//
// Sirve `/.well-known/assetlinks.json` (ver el rewrite en vercel.json). Android
// lo descarga al instalar el APK: si la huella del APK aparece acá, la app abre
// a pantalla completa; si no, sale una barra de navegador arriba y parece una
// página web disfrazada. Es lo único que separa "app" de "acceso directo".
//
// Es dinámico —y no un archivo estático— por lo mismo que el manifest: una sola
// instalación de Vercel atiende todos los subdominios, y cada marca tiene su
// propio APK. Un estático obligaría a tocar el repo y redesplegar cada vez que
// entra una marca.
import { ANDROID_APPS, slugFromHost } from './_android-apps.js'

export default function handler(req, res) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || ''
  const app = ANDROID_APPS[slugFromHost(host) ?? '']

  // Sin APK registrado se devuelve `[]`, que es un assetlinks válido y vacío.
  // Así el endpoint se puede desplegar HOY, antes de que exista la firma, sin
  // romper nada: las marcas sin app simplemente no tienen nada que verificar.
  const statements = app
    ? [{
        relation: [
          'delegate_permission/common.handle_all_urls',
          // Sin esto el usuario tendría que volver a escribir su contraseña
          // dentro del APK: las credenciales guardadas en Chrome no cruzan al
          // paquete Android si no lo declaras.
          'delegate_permission/common.get_login_creds',
        ],
        target: {
          namespace: 'android_app',
          package_name: app.packageName,
          sha256_cert_fingerprints: app.fingerprints,
        },
      }]
    : []

  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  // Corto a propósito: si te equivocas en una huella, un TTL largo te deja
  // horas con la barra del navegador encima sin poder arreglarlo.
  res.setHeader('Cache-Control', 'public, max-age=300')
  res.status(200).send(JSON.stringify(statements))
}
