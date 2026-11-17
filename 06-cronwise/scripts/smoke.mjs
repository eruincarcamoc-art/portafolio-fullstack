// Prueba de humo del paquete CONSTRUIDO, sin vitest: se ejecuta en CI sobre Node 18, 20 y 22.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const esm = await import('../dist/index.js');
const cjs = createRequire(import.meta.url)('../dist/index.cjs');
for (const m of [esm, cjs]) {
  const next = m.parse('30 2 * * *', { tz: 'America/New_York' }).next(new Date('2026-03-07T12:00:00Z'));
  assert.equal(next.toISOString(), '2026-03-08T07:00:00.000Z'); // hueco de DST: se desplaza a las 03:00 EDT
  assert.equal(m.explain('*/15 9-17 * * 1-5'), 'Every 15 minutes, between 09:00 and 17:59, on Monday through Friday');
  assert.equal(m.validate('61 * * * *').valid, false);
}
const out = execFileSync(process.execPath, ['dist/cli.js', 'explain', '0 9 * * 1-5', '--locale', 'es'], { encoding: 'utf8' });
assert.equal(out.trim(), 'A las 09:00, de lunes a viernes');
console.log(`smoke ok on node ${process.version}`);
