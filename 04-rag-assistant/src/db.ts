import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';

export interface Queryable {
  query<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
}
export interface Db {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function createPgDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString, max: 10 });
  return {
    async tx(fn) {
      const client = await pool.connect();
      const q: Queryable = { query: async (sql, params) => (await client.query(sql, params as any[])).rows };
      try {
        await client.query('BEGIN');
        const out = await fn(q);
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/** Postgres real (WASM) con pgvector: mismo SQL (`<=>`, HNSW, tsvector) sin servicios externos. */
export function createPgliteDb(dataDir?: string): Db {
  const db = new PGlite({ dataDir, extensions: { vector } });
  const wrap = (tx: any): Queryable => ({
    query: async (sql, params) => {
      if (!params || params.length === 0) {
        const res = await tx.exec(sql);
        return res[res.length - 1]?.rows ?? [];
      }
      return (await tx.query(sql, params)).rows;
    },
  });
  return { tx: (fn) => db.transaction((tx) => fn(wrap(tx))), close: () => db.close() };
}

/** pgvector espera '[0.1,0.2,...]'. */
export const toVector = (v: number[]): string => `[${v.join(',')}]`;

export async function migrate(db: Db, dims: number): Promise<void> {
  await db.tx(async (q) => {
    await q.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await q.query(`CREATE TABLE IF NOT EXISTS _meta (key text PRIMARY KEY, value text NOT NULL)`);
    const existing = (await q.query<{ value: string }>(`SELECT value FROM _meta WHERE key='embed_dims'`))[0];
    if (existing) {
      if (Number(existing.value) !== dims) {
        throw new Error(
          `Index was built with ${existing.value}-dim embeddings but the current provider produces ${dims}. ` +
            `Changing the embedding model requires re-indexing (wipe the database and re-ingest).`,
        );
      }
      return;
    }
    await q.query(`
CREATE TABLE documents (
  id           bigserial PRIMARY KEY,
  title        text NOT NULL,
  source       text NOT NULL UNIQUE,
  content_hash text NOT NULL,
  chunk_count  int NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE chunks (
  id          bigserial PRIMARY KEY,
  document_id bigint NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ord         int NOT NULL,
  heading     text NOT NULL DEFAULT '',
  content     text NOT NULL,
  embedding   vector(${dims}) NOT NULL,
  tsv         tsvector GENERATED ALWAYS AS (to_tsvector('simple', heading || ' ' || content)) STORED
);
CREATE INDEX chunks_doc ON chunks(document_id, ord);
CREATE INDEX chunks_tsv ON chunks USING gin(tsv);
CREATE INDEX chunks_embedding ON chunks USING hnsw (embedding vector_cosine_ops);

-- Caché semántica: preguntas casi idénticas reutilizan la respuesta (y no gastan tokens).
CREATE TABLE answer_cache (
  id             bigserial PRIMARY KEY,
  question       text NOT NULL,
  embedding      vector(${dims}) NOT NULL,
  answer         text NOT NULL,
  sources        jsonb NOT NULL,
  corpus_version int NOT NULL,
  hits           int NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX answer_cache_embedding ON answer_cache USING hnsw (embedding vector_cosine_ops);

-- Cada llamada al modelo queda registrada: base del control de costes y del presupuesto diario.
CREATE TABLE usage_log (
  id            bigserial PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  client_id     text NOT NULL,
  kind          text NOT NULL,            -- chat | embed | ingest
  model         text NOT NULL,
  input_tokens  int NOT NULL DEFAULT 0,
  output_tokens int NOT NULL DEFAULT 0,
  cost_usd      numeric(12,6) NOT NULL DEFAULT 0,
  latency_ms    int NOT NULL DEFAULT 0,
  cached        boolean NOT NULL DEFAULT false,
  outcome       text NOT NULL DEFAULT 'ok' -- ok | refused | error | cache_hit
);
CREATE INDEX usage_client_time ON usage_log(client_id, at);

CREATE TABLE eval_runs (
  id         bigserial PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  label      text NOT NULL,
  summary    jsonb NOT NULL
);
`);
    await q.query(`INSERT INTO _meta(key, value) VALUES ('embed_dims', $1), ('corpus_version', '1')`, [String(dims)]);
  });
}

export async function corpusVersion(q: Queryable): Promise<number> {
  return Number((await q.query<{ value: string }>(`SELECT value FROM _meta WHERE key='corpus_version'`))[0]?.value ?? 1);
}
export async function bumpCorpusVersion(q: Queryable): Promise<void> {
  await q.query(`UPDATE _meta SET value = (value::int + 1)::text WHERE key='corpus_version'`);
}
