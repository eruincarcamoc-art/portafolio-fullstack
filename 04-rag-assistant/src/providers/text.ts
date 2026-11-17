const STOPWORDS = new Set(
  `a an and are as at be been but by can could did do does for from had has have how i if in into is it its me my no not of on or our so than that the their them then there these they this to up us was we were what when where which who whom why will with would you your
   el la los las un una unos unas de del al y o u en es son ser que se por para con sin sobre como cual cuales cuando donde quien mi tu su nos mas pero si no lo le les`
    .split(/\s+/)
    .filter(Boolean),
);

export const isStopword = (w: string): boolean => STOPWORDS.has(w);

/** Minúsculas, sin acentos, solo alfanuméricos. */
export function tokenize(s: string): string[] {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Stemmer ligero (sufijos frecuentes) para que "reimbursed/reimbursement/reimburse" compartan raíz. */
export function stem(w: string): string {
  if (w.length <= 4 || /^\d+$/.test(w)) return w;
  return w
    .replace(/(ies)$/, 'y')
    .replace(/(ization|isation|ations|ation|ements|ement|ments|ment|ingly|ings|ing|edly|ed|ly|es|s)$/, '')
    .replace(/(.)\1$/, '$1');
}

/** Términos con contenido (sin stopwords, con stem). Lo usan el embedder local, el LLM local y la consulta léxica. */
export function contentTerms(s: string): string[] {
  return tokenize(s).filter((t) => !isStopword(t) && t.length > 1).map(stem);
}

/** Divide en frases respetando abreviaturas simples y saltos de línea. */
export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(\[])/)
    .map((s) => s.trim())
    .filter(Boolean);
}
