# 04 · APK Android (TWA) 🟡

> Empaquetar la PWA como app instalable en Android, sin reescribir la app.

## Rol del módulo

Un `.apk` que los dueños de tienda puedan instalar y probar, y que mañana sirva
para publicar en Play Store — **una app por marca**, con su nombre y su ícono.

## Por qué TWA y no Capacitor ✅ (decidido)

Un **TWA** (Trusted Web Activity) es una cáscara de ~1 MB que abre tu sitio con
el motor de Chrome del teléfono, a pantalla completa y sin barra de navegador.

La decisión la fuerza **el push**. Kross notifica con **Web Push (VAPID)**:

| | TWA | Capacitor / WebView |
|---|---|---|
| Web Push VAPID | ✅ sigue funcionando | ❌ **no existe** — hay que rehacerlo en FCM nativo |
| Micrófono LiveKit | ✅ permiso de Chrome | 🟡 hay que cablear permisos nativos |
| Publicar un cambio | `git push` a `main` — **sin rebuild del APK** | recompilar y redistribuir |
| Peso | ~1 MB | ~8 MB |

Capacitor solo gana si algún día necesitas algo que la web no da (leer SMS,
widgets, background nativo). Hoy no es el caso, y elegirlo costaría rehacer
todas las notificaciones desde cero.

## Una app por marca (no es opcional)

Android amarra cada app a **un origen**. `gadicaf.krossclub.app` solo puede
verificar el APK de Gadicaf. Así que:

| Marca | Origen | Package |
|---|---|---|
| Gadicaf | `gadicaf.krossclub.app` | `app.krossclub.gadicaf` |
| Kross | `kross.krossclub.app` | `app.krossclub.kross` |

Encaja con el producto: cada marca quiere **su** nombre en el cajón de apps, no
"Kross". Es el mismo principio del manifest por marca.

## El handshake · Digital Asset Links ✅

`/.well-known/assetlinks.json` es lo único que separa "app" de "acceso directo":
Android lo descarga al instalar y compara la huella del APK. Si no calza, la app
abre **con barra de navegador encima** y parece una web disfrazada.

- Lo sirve **`api/assetlinks.js`**, dinámico por subdominio (mismo patrón que
  `api/manifest.js` — una sola instalación de Vercel atiende a todas las marcas).
- El registro de apps vive en **`api/_android-apps.js`**.
- Sin APK registrado devuelve `[]`, que es válido: **se puede desplegar hoy**,
  antes de que exista la firma.

> **`vercel.json`**: el rewrite de `/.well-known/assetlinks.json` va **antes**
> del catch-all `/(.*)`. Si se invierte el orden, el SPA se traga la ruta y
> Android recibe HTML donde espera JSON — la app instala pero nunca verifica.

## Generar el APK

Necesitas **JDK 17+** y Node. Bubblewrap baja el SDK de Android solo.

> **Fuera del repo, a propósito.** Bubblewrap genera un proyecto Android entero
> (Gradle, `.keystore`, carpetas de build). Nada de eso va en `kross-p2p`: ensucia
> el árbol y arriesga commitear la firma. La rama solo sirve para pegar la huella
> **después**.

El equipo trabaja en **Windows/PowerShell**, así que van así — `mkdir -p`, `&&` y
`grep` no existen ahí:

```powershell
npm install -g @bubblewrap/cli

mkdir $HOME\kross-apk\gadicaf -Force
cd $HOME\kross-apk\gadicaf

bubblewrap init --manifest https://gadicaf.krossclub.app/api/manifest
```

Responde:

| Pregunta | Respuesta |
|---|---|
| Package name | `app.krossclub.gadicaf` |
| Signing key | crea uno nuevo la primera vez |
| Display mode | `standalone` |

Luego:

```powershell
bubblewrap build          # deja app-release-signed.apk
```

### Registrar la huella

```powershell
keytool -list -v -keystore android.keystore -alias android | Select-String SHA256
```

Pega el resultado en `api/_android-apps.js`, deploy, y **recién ahí** instala el
APK. Si lo instalas antes, Android cachea el fallo y hay que reinstalar.

> ⚠️ **El `.keystore` y su contraseña no entran al repo, ni al chat.** Si los
> pierdes, Play Store no te deja volver a publicar esa app **nunca**: la firma
> es la identidad. Guárdalos donde guardas los accesos de producción.

## Para que la prueben ya

`bubblewrap build` deja un APK firmado que se instala directo — mándalo por
WhatsApp o Drive. El teléfono avisa "orígenes desconocidos"; es normal fuera de
Play Store.

**Sin APK también se puede probar hoy**: en Chrome Android, *Menú → Instalar
aplicación* deja el ícono en la pantalla de inicio y corre igual de bien. El APK
suma cuando quieres Play Store, o cuando el dueño de tienda necesita ver algo que
se sienta app antes de confiar.

## El ícono va por `/api/icon` ✅

`bubblewrap init` moría con **`Cookie has domain set to a public suffix`**.

No es culpa del logo. El manifest apuntaba directo a Supabase Storage, y
`supabase.co` está en la **Public Suffix List** (Supabase la registró para aislar
subdominios). Cloudflare responde ahí con una cookie `__cf_bm` sobre ese dominio,
la librería de cookies de bubblewrap la rechaza por reglamento, y aborta el build
entero a mitad de "Generating Android Project".

La raíz era tener el ícono **en otro origen**. Ahora `api/icon.js` lo sirve desde
el dominio de la marca, así que además se cachea con el resto del sitio y el
manifest deja de depender de dónde guardamos el branding.

> Si Storage falla o la marca no tiene logo, redirige a `/icon-512.png` en vez de
> dar 404: un manifest con ícono roto no instala.

## Pendiente 🔮

- [ ] Registrar la huella de Gadicaf en `api/_android-apps.js`.
- [ ] Decidir el `start_url` del APK: hoy la PWA abre en `/` (vista del
      comprador). Para un dueño de tienda probablemente deba abrir el panel de
      Ventas — pero eso cambia el manifest **también para el comprador**, así
      que quizá necesite su propio APK.
- [ ] Ícono: tiene que ser **PNG cuadrado de 512×512**; si no, el build falla.
- [ ] Play Store: ficha, capturas y política de privacidad.
- [ ] iOS no tiene equivalente — ahí la PWA se instala desde Safari y ya.

## Ver también

- `docs/00-CORE-ARCHITECTURE.md` — multi-tenant por subdominio.
- `api/manifest.js` — manifest por marca, la entrada de todo esto.
