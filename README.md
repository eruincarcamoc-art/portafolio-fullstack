# Portafolio Fullstack

Proyectos de nivel intermedio/senior, construidos uno a uno con foco en decisiones de arquitectura, pruebas y operación real.

| # | Proyecto | Demuestra | Estado |
|---|---|---|---|
| 1 | [**Tenantly** — SaaS multi-tenant](./01-saas-multitenant) | RLS en PostgreSQL, RBAC, facturación Stripe, webhooks idempotentes, auditoría, límites de plan | ✅ Completo (29 tests) |
| 2 | [**Collab Board** — kanban en tiempo real](./02-realtime-collab) | CRDT propio (HLC + LWW + índices fraccionarios), WebSockets, offline-first, presencia, compactación de log | ✅ Completo (42 tests) |
| 3 | [**Orderflow** — pipeline orientado a eventos](./03-event-driven) | Outbox, broker propio sobre Postgres, reintentos + DLQ, consumidores idempotentes, saga con compensación, CQRS | ✅ Completo (41 tests) |
| 4 | [**Docs Assistant** — RAG con evaluación continua](./04-rag-assistant) | pgvector + búsqueda híbrida (RRF), streaming SSE, defensa de inyección, costes y presupuesto, caché semántica, puerta de calidad en CI | ✅ Completo (66 tests) |
| 5 | Plataforma de observabilidad | Ingesta, series temporales, agregaciones | ⏳ Pendiente |
| 6 | Herramienta open source (CLI/SDK) | Diseño de API, versionado, documentación | ⏳ Pendiente |
