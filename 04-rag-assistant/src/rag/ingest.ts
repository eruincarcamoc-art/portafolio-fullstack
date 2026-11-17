import { createHash } from 'node:crypto';
import { bumpCorpusVersion, toVector, type Db } from '../db.js';
import type { Embedder } from '../providers/types.js';
import { chunkText, type ChunkOptions } from './chunker.js';

export interface IngestInput {
  title: string;
  /** Identificador estable (ruta, URL). Reingestar la misma fuente reemplaza el documento. */
  source: string;
  content: string;
}

export type IngestResult =
  | { status: 'created' | 'updated'; documentId: number; chunks: number; embeddingTokens: number }
  | { status: 'unchanged'; documentId: number; chunks: number; embeddingTokens: 0 };

const normalize = (s: string) => s.replace(/\r\n/g, '\n').trim();

/** El texto que se embebe lleva su ruta de encabezados: "Security > Passwords\n..." mejora la recuperación. */
export const embeddingText = (title: string, heading: string, content: string) =>
  [title, heading].filter(Boolean).join(' > ') + '\n' + content;

/**
 * Ingesta idempotente:
 *  - hash del contenido => si no cambió, no se re-embebe nada (los embeddings cuestan dinero),
 *  - si cambió, se reemplazan documento y chunks en UNA transacción (nunca se ve un documento a medias),
 *  - los embeddings se calculan ANTES de abrir la transacción: no se retiene una conexión durante llamadas de red.
 */
export async function ingestDocument(
  db: Db,
  embedder: Embedder,
  input: IngestInput,
  chunkOpts?: ChunkOptions,
): Promise<IngestResult> {
  const content = normalize(input.content);
  if (!content) throw new Error('Document is empty');
  const hash = createHash('sha256').update(content).digest('hex');

  const existing = await db.tx(async (q) =>
    (await q.query<{ id: string; content_hash: string; chunk_count: number }>(
      `SELECT id, content_hash, chunk_count FROM documents WHERE source=$1`, [input.source],
    ))[0],
  );
  if (existing && existing.content_hash === hash) {
    return { status: 'unchanged', documentId: Number(existing.id), chunks: existing.chunk_count, embeddingTokens: 0 };
  }

  const chunks = chunkText(content, chunkOpts);
  if (!chunks.length) throw new Error('Document produced no chunks');
  const { vectors, tokens } = await embedder.embed(chunks.map((c) => embeddingText(input.title, c.heading, c.content)), 'document');

  const documentId = await db.tx(async (q) => {
    if (existing) await q.query(`DELETE FROM documents WHERE id=$1`, [existing.id]); // cascada a chunks
    const doc = (await q.query<{ id: string }>(
      `INSERT INTO documents(title, source, content_hash, chunk_count) VALUES ($1,$2,$3,$4) RETURNING id`,
      [input.title, input.source, hash, chunks.length],
    ))[0]!;
    for (const [i, c] of chunks.entries()) {
      await q.query(
        `INSERT INTO chunks(document_id, ord, heading, content, embedding) VALUES ($1,$2,$3,$4,$5::vector)`,
        [doc.id, c.ord, c.heading, c.content, toVector(vectors[i]!)],
      );
    }
    await bumpCorpusVersion(q); // invalida la caché semántica: las respuestas viejas podrían estar desactualizadas
    return Number(doc.id);
  });
  return { status: existing ? 'updated' : 'created', documentId, chunks: chunks.length, embeddingTokens: tokens };
}

export async function deleteDocument(db: Db, id: number): Promise<boolean> {
  return db.tx(async (q) => {
    const r = await q.query(`DELETE FROM documents WHERE id=$1 RETURNING id`, [id]);
    if (r.length) await bumpCorpusVersion(q);
    return r.length > 0;
  });
}

export async function listDocuments(db: Db) {
  return db.tx((q) =>
    q.query(`SELECT id::int, title, source, chunk_count AS "chunkCount", created_at AS "createdAt" FROM documents ORDER BY title`),
  );
}
