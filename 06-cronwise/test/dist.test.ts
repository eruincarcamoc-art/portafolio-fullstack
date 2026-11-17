import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

/** Prueba los artefactos CONSTRUIDOS (lo que recibirá un usuario de npm), no el código fuente. Requiere `npm run build`. */
const built = existsSync('dist/index.js') && existsSync('dist/index.cjs') && existsSync('dist/cli.js');

describe.skipIf(!built)('published artifacts (dist/)', () => {
  const abs = (p: string) => path.resolve(p);

  it('ESM entry works', async () => {
    const m = await import(pathToFileURL(abs('dist/index.js')).href);
    expect(m.parse('0 9 * * 1-5', { tz: 'Europe/Madrid' }).nextRuns(1, new Date('2026-03-01T00:00:00Z'))[0].toISOString()).toBe('2026-03-02T08:00:00.000Z');
    expect(m.explain('*/5 * * * *')).toBe('Every 5 minutes');
  });

  it('CommonJS entry works and exposes the same API as ESM', async () => {
    const cjs = createRequire(import.meta.url)(abs('dist/index.cjs'));
    const esm = await import(pathToFileURL(abs('dist/index.js')).href);
    expect(Object.keys(cjs).sort()).toEqual(Object.keys(esm).sort());
    expect(cjs.validate('61 * * * *').valid).toBe(false);
  });

  it('the CLI binary runs, has a shebang, and returns proper exit codes', () => {
    const run = (args: string[]) => {
      try {
        return { code: 0, out: execFileSync(process.execPath, ['dist/cli.js', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
      } catch (e: any) {
        return { code: e.status as number, out: String(e.stdout) + String(e.stderr) };
      }
    };
    expect(run(['--version']).out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(run(['explain', '0 9 * * 1-5', '--locale', 'es']).out.trim()).toBe('A las 09:00, de lunes a viernes');
    expect(run(['validate', '61 * * * *']).code).toBe(1);
    expect(run(['bogus']).code).toBe(2);
    expect(readFileSync('dist/cli.js', 'utf8').startsWith('#!/usr/bin/env node')).toBe(true);
  });

  it('the published type declarations compile for a consumer (and reject misuse)', () => {
    execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '--strict', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler', '--skipLibCheck', 'false', '--types', 'node', '--ignoreConfig', 'test/fixtures/consumer.ts'], { stdio: 'pipe' });
  });

  it('has zero runtime dependencies', async () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.files).toContain('dist');
  });
});
