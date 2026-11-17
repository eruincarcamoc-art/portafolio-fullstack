import type { Db } from './index.js';

const SCHEMA = `
-- ===== Servicio de pedidos (modelo de escritura) =====
CREATE TABLE orders (
  id            uuid PRIMARY KEY,
  customer_id   text NOT NULL,
  items         jsonb NOT NULL,
  total_cents   bigint NOT NULL,
  status        text NOT NULL,
  cancel_reason text,
  created_at    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL
);

-- Idempotencia de la API: la misma Idempotency-Key devuelve la misma respuesta, sin duplicar el pedido.
CREATE TABLE idempotency_keys (
  key          text PRIMARY KEY,
  request_hash text NOT NULL,
  status_code  int,
  response     jsonb,
  created_at   timestamptz NOT NULL
);

-- ===== Transactional outbox: el evento se escribe en la MISMA transaccion que el cambio de estado =====
CREATE TABLE outbox (
  id           bigserial PRIMARY KEY,
  message_id   uuid NOT NULL UNIQUE,
  source       text NOT NULL,
  topic        text NOT NULL,
  key          text NOT NULL,
  payload      jsonb NOT NULL,
  created_at   timestamptz NOT NULL,
  published_at timestamptz
);
CREATE INDEX outbox_unpublished ON outbox(id) WHERE published_at IS NULL;

-- ===== Broker (pub/sub con grupos de consumidores, sobre Postgres) =====
CREATE TABLE subscriptions (
  consumer text NOT NULL,
  topic    text NOT NULL,
  PRIMARY KEY (consumer, topic)
);

CREATE TABLE messages (
  id           uuid PRIMARY KEY,           -- deduplica publicaciones repetidas
  topic        text NOT NULL,
  key          text NOT NULL,              -- clave de orden: mismo key => orden FIFO por consumidor
  payload      jsonb NOT NULL,
  published_at timestamptz NOT NULL
);

CREATE TABLE deliveries (
  id           bigserial PRIMARY KEY,      -- el orden de este id ES el orden de entrega
  message_id   uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  consumer     text NOT NULL,
  key          text NOT NULL,
  state        text NOT NULL CHECK (state IN ('pending','processing','done','dead')),
  attempts     int NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL,       -- no antes de esta fecha (backoff)
  locked_until timestamptz,                -- lease: si vence, otro worker puede tomarlo
  locked_by    text,
  last_error   text,
  created_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL,
  completed_at timestamptz,
  UNIQUE (consumer, message_id)
);
CREATE INDEX deliveries_claim ON deliveries(consumer, id) WHERE state IN ('pending','processing');
CREATE INDEX deliveries_key   ON deliveries(consumer, key, id) WHERE state IN ('pending','processing');
CREATE INDEX deliveries_dead  ON deliveries(consumer, id) WHERE state = 'dead';

-- Bandeja de entrada: un consumidor procesa cada mensaje UNA vez (efecto exactly-once sobre entrega at-least-once).
CREATE TABLE processed_messages (
  consumer     text NOT NULL,
  message_id   uuid NOT NULL,
  processed_at timestamptz NOT NULL,
  PRIMARY KEY (consumer, message_id)
);

-- ===== Servicios =====
CREATE TABLE stock (
  sku       text PRIMARY KEY,
  available int NOT NULL CHECK (available >= 0),   -- el CHECK impide sobreventa aunque falle la logica
  reserved  int NOT NULL DEFAULT 0 CHECK (reserved >= 0)
);
CREATE TABLE reservations (
  order_id uuid PRIMARY KEY,
  items    jsonb NOT NULL,
  status   text NOT NULL CHECK (status IN ('reserved','released'))
);
CREATE TABLE payments (
  order_id     uuid PRIMARY KEY,
  amount_cents bigint NOT NULL,
  status       text NOT NULL CHECK (status IN ('succeeded','failed')),
  gateway_ref  text,
  error        text,
  created_at   timestamptz NOT NULL
);
CREATE TABLE shipments (
  order_id   uuid PRIMARY KEY,
  tracking   text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE TABLE notifications (
  id         bigserial PRIMARY KEY,
  order_id   uuid NOT NULL,
  kind       text NOT NULL,
  recipient  text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (order_id, kind)
);

-- ===== Modelo de lectura (CQRS): eventualmente consistente con el de escritura =====
CREATE TABLE order_events (
  id          bigserial PRIMARY KEY,
  order_id    uuid NOT NULL,
  message_id  uuid NOT NULL,
  type        text NOT NULL,
  payload     jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  UNIQUE (order_id, message_id)
);
CREATE INDEX order_events_order ON order_events(order_id, id);
CREATE TABLE order_view (
  order_id    uuid PRIMARY KEY,
  customer_id text,
  total_cents bigint,
  status      text NOT NULL,
  last_event  text NOT NULL,
  updated_at  timestamptz NOT NULL
);
`;

export async function migrate(db: Db): Promise<boolean> {
  return db.tx(async (q) => {
    await q.query(`CREATE TABLE IF NOT EXISTS _migrations (id text PRIMARY KEY)`);
    await q.query(`SELECT pg_advisory_xact_lock(727275)`);
    const done = await q.query(`SELECT 1 FROM _migrations WHERE id='001_init'`);
    if (done.length) return false;
    await q.query(SCHEMA);
    await q.query(`INSERT INTO _migrations(id) VALUES ('001_init')`);
    return true;
  });
}
