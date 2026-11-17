# Portafolio Fullstack

Proyectos de nivel intermedio/senior, construidos uno a uno con foco en decisiones de arquitectura, pruebas y operación real.

| # | Proyecto | Demuestra | Estado |
|---|---|---|---|
| 1 | [**Tenantly** — SaaS multi-tenant](./01-saas-multitenant) | RLS en PostgreSQL, RBAC, facturación Stripe, webhooks idempotentes, auditoría, límites de plan | ✅ Completo (29 tests) |
| 2 | [**Collab Board** — kanban en tiempo real](./02-realtime-collab) | CRDT propio (HLC + LWW + índices fraccionarios), WebSockets, offline-first, presencia, compactación de log | ✅ Completo (42 tests) |
| 3 | [**Orderflow** — pipeline orientado a eventos](./03-event-driven) | Outbox, broker propio sobre Postgres, reintentos + DLQ, consumidores idempotentes, saga con compensación, CQRS | ✅ Completo (41 tests) |
| 4 | [**Docs Assistant** — RAG con evaluación continua](./04-rag-assistant) | pgvector + búsqueda híbrida (RRF), streaming SSE, defensa de inyección, costes y presupuesto, caché semántica, puerta de calidad en CI | ✅ Completo (66 tests) |
| 5 | [**Pulse** — plataforma de observabilidad](./05-observability) | Ingesta ~100k pts/s, series temporales con rollups y retención, percentiles mergeables (DDSketch), alertas con máquina de estados, uptime, anti-SSRF | ✅ Completo (84 tests) |
| 6 | [**cronwise** — librería + CLI de cron](./06-cronwise) | Diseño de API, errores con posición exacta, DST correcto (oráculo de fuerza bruta + mutación), explicaciones EN/ES, lint, ESM/CJS/tipos, CHANGELOG, CI/release | ✅ Completo (147 tests) |
