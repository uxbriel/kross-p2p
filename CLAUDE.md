# CLAUDE.md — Kross

> Léeme primero. Contexto para trabajar en este repo sin re-explicar nada.
> Al iniciar una sesión: lee este archivo y el `.md` del módulo que vayas a tocar en `/docs`.

## Qué es Kross

**Sistema Operativo de E-commerce contraentrega (COD) para Perú.** PWA white-label
multi-tenant: cada marca tiene su app instalable en `marca.krossclub.app`. Resuelve 3 fases:
**vender** (Sales) → **entregar** (Logistics) → **retener** (Loyalty).

## Stack

React 19 + Vite + TypeScript + Tailwind 4 · Supabase (Postgres/RLS, Edge Functions Deno,
Storage, Realtime) · Vercel (deploy desde `main`) · LiveKit (voz+grabación) · WhatsApp
Cloud API · Web Push (VAPID) · IA (Decolecta DNI, ElevenLabs closer 🔮).

- Supabase project ref: `ofdjghntvmrdfjhazfvz`.
- Deploy función: `supabase functions deploy <n> --project-ref ofdjghntvmrdfjhazfvz`
  (`livekit-webhook` va con `--no-verify-jwt`).
- Esquema idempotente: `supabase/setup-kross.sql` (correr en SQL Editor).

## Mapa de documentación (`/docs`)

**Léelos antes de tocar el área correspondiente.**

| Doc | Cubre |
|---|---|
| `docs/00-CORE-ARCHITECTURE.md` | BD, auth, panel admin, estado central `MerchantCustomerSession` |
| `docs/01-SALES-ENGINE.md` | IA Closer, DNI, checkout guiado (state machine), adelanto Yape verificado solo |
| `docs/02-SMART-LOGISTICS.md` | Geolocalización, motorizados, envíos a provincia |
| `docs/03-LOYALTY-ENGINE.md` | Recompra, puntos, campañas WhatsApp, LTV |
| `docs/04-APK-ANDROID.md` | APK Android (TWA), Digital Asset Links, una app por marca |
| `docs/GIT-FLOW.md` | Nomenclatura de ramas/commits y flujo de PR |
| `docs/ICP Sales/` · `docs/ICP LTV/` | Capa estratégica (por qué / para quién) |

Estado marcado con ✅ construido · 🟡 parcial · 🔮 planeado.

## Regla de ejecución

Al trabajar una funcionalidad, **consulta primero el `.md` del módulo** para respetar sus
estándares sin romper los demás. Todo cambio de datos que cruce módulos se refleja primero
en el contrato `MerchantCustomerSession` de `docs/00-CORE-ARCHITECTURE.md`. Los 3 módulos
comparten el mismo estado del cliente (Sales lo cierra, Logistics lo entrega, Loyalty lo retiene).

## Git Flow (resumen — detalle en `docs/GIT-FLOW.md`)

- **`main`** = producción. **NUNCA** commit/push directo; solo vía Pull Request.
- Trabajo en ramas `feat/*`, `fix/*`, `refactor/*`, `docs/*`, `chore/*` (Conventional Commits).
- Una rama = una tarea. El **PR lo abre/revisa el equipo** (3 devs), no la sesión de Claude.
- Antes de cada commit: `git status` para confirmar que NO estás en `main`.

## Convenciones de código

- Edge Functions: CORS + validación de entrada + service role para escribir.
- RLS activo; el frontend no lee tablas sensibles directo, invoca funciones.
- Nunca secrets/tokens en código, commits ni en el chat.
- Comprador identificado por DNI/teléfono; multi-tenant por subdominio (`src/lib/store-context.tsx`).
- El tipo real de sesión vive en `src/lib/session.ts` (no en el viejo `src/types/index.ts`, que es mock).
