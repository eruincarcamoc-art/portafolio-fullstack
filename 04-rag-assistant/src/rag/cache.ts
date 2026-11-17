import { corpusVersion, toVector, type Db } from '../db.js';

export interface CachedAnswer {
  answer: string;
  sources: unknown;
  similarity: number;
}

/**
 * Caché semántica: si una pregunta es prácticamente la misma que otra ya respondida (coseno >= umbral),
 * se reutiliza la respuesta: 0 tokens y latencia de milisegundos.
 * Seguridad de la caché:
 *  - solo se guardan respuestas FUNDAMENTADAS (con citas),
 *  - se invalida sola al cambiar el corpus (`corpus_version`),
 *  - caduca por TTL.
 */
export async function cacheLookup(db: Db, embedding: number[], threshold: number, ttlHours: number): Promise<CachedAnswer | null> {
  return db.tx(async (q) => {
    const version = await corpusVersion(q);
    const row = (await q.query<any>(
      `SELECT id, answer, sources, 1 - (embedding <=> $1::vector) AS similarity
         FROM answer_cache
        WHERE corpus_version = $2 AND created_at > now() - ($3 || ' hours')::interval
        ORDER BY embedding <=> $1::vector LIMIT 1`,
      [toVector(embedding), version, String(ttlHours)],
    ))[0];
    if (!row || Number(row.similarity) < threshold) return null;
    await q.query(`UPDATE answer_cache SET hits = hits + 1 WHERE id=$1`, [row.id]);
    return { answer: row.answer, sources: row.sources, similarity: Number(row.similarity) };
  });
}

export async function cacheStore(db: Db, question: string, embedding: number[], answer: string, sources: unknown): Promise<void> {
  await db.tx(async (q) => {
    const version = await corpusVersion(q);
    await q.query(
      `INSERT INTO answer_cache(question, embedding, answer, sources, corpus_version) VALUES ($1,$2::vector,$3,$4,$5)`,
      [question, toVector(embedding), answer, JSON.stringify(sources), version],
    );
    // límite de tamaño: se conservan las 500 entradas más recientes
    await q.query(`DELETE FROM answer_cache WHERE id NOT IN (SELECT id FROM answer_cache ORDER BY id DESC LIMIT 500)`);
  });
}
