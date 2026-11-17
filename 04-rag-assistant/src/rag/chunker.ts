import { splitSentences } from '../providers/text.js';

export interface Chunk {
  ord: number;
  /** Ruta de encabezados ("Security > Passwords"): contexto que se antepone al texto al indexar. */
  heading: string;
  content: string;
}

export interface ChunkOptions {
  targetChars?: number;
  maxChars?: number;
  overlapChars?: number;
}

interface Section {
  heading: string;
  body: string;
}

/** Divide Markdown en secciones por encabezados, conservando la jerarquía como ruta. */
function sections(text: string): Section[] {
  const out: Section[] = [];
  const stack: string[] = [];
  let buf: string[] = [];
  let inFence = false;
  const flush = () => {
    const body = buf.join('\n').trim();
    if (body) out.push({ heading: stack.filter(Boolean).join(' > '), body });
    buf = [];
  };
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (/^```/.test(line)) inFence = !inFence;
    const m = !inFence && /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) {
      flush();
      const level = m[1]!.length;
      stack.length = level - 1;
      stack[level - 1] = m[2]!.trim();
    } else buf.push(line);
  }
  flush();
  return out;
}

/** Trocea un párrafo demasiado largo por frases y, en último caso, por longitud. */
function splitLong(par: string, max: number): string[] {
  if (par.length <= max) return [par];
  const out: string[] = [];
  let cur = '';
  for (const s of splitSentences(par)) {
    if (s.length > max) {
      if (cur) out.push(cur), (cur = '');
      for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max));
      continue;
    }
    if ((cur + ' ' + s).trim().length > max) out.push(cur), (cur = s);
    else cur = (cur + ' ' + s).trim();
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Chunking consciente de la estructura:
 *  1. respeta los encabezados (un chunk no mezcla secciones) y los guarda como contexto,
 *  2. empaqueta párrafos hasta ~targetChars, sin partir frases,
 *  3. añade un solapamiento de frases entre chunks vecinos para no cortar una idea por la mitad.
 */
export function chunkText(text: string, opts: ChunkOptions = {}): Chunk[] {
  const target = opts.targetChars ?? 800;
  const max = opts.maxChars ?? 1200;
  const overlap = opts.overlapChars ?? 150;
  const chunks: Chunk[] = [];

  for (const sec of sections(text)) {
    const paragraphs = sec.body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).flatMap((p) => splitLong(p, max));
    let cur = '';
    const pieces: string[] = [];
    for (const p of paragraphs) {
      if (cur && cur.length + p.length + 2 > target) {
        pieces.push(cur);
        cur = '';
      }
      cur = cur ? `${cur}\n\n${p}` : p;
    }
    if (cur) pieces.push(cur);

    pieces.forEach((piece, i) => {
      let content = piece;
      if (i > 0 && overlap > 0) {
        const tail = splitSentences(pieces[i - 1]!).reverse();
        let carry = '';
        for (const s of tail) {
          if ((s + ' ' + carry).length > overlap) break;
          carry = `${s} ${carry}`.trim();
        }
        if (carry) content = `${carry}\n\n${piece}`;
      }
      chunks.push({ ord: 0, heading: sec.heading, content });
    });
  }
  return chunks.map((c, i) => ({ ...c, ord: i }));
}
