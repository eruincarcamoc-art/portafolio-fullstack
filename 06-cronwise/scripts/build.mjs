// Build sin dependencias de empaquetado más allá de esbuild y tsc.
//   dist/index.js    ESM        dist/index.cjs   CommonJS        dist/cli.js  binario (con shebang)
//   dist/*.d.ts      tipos ESM  dist/*.d.cts     tipos CommonJS
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { chmodSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

rmSync('dist', { recursive: true, force: true });

const common = { bundle: true, target: 'es2020', sourcemap: true, logLevel: 'info' };
await build({ ...common, entryPoints: ['src/index.ts'], format: 'esm', outfile: 'dist/index.js', platform: 'neutral', mainFields: ['module', 'main'] });
await build({ ...common, entryPoints: ['src/index.ts'], format: 'cjs', outfile: 'dist/index.cjs', platform: 'neutral', mainFields: ['module', 'main'] });
await build({ ...common, entryPoints: ['src/cli.ts'], format: 'esm', outfile: 'dist/cli.js', platform: 'node', target: 'node18' });
chmodSync('dist/cli.js', 0o755);

// Declaraciones de tipos con tsc y copia .d.cts con las rutas reescritas.
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'], { stdio: 'inherit' });
for (const f of readdirSync('dist').filter((f) => f.endsWith('.d.ts'))) {
  const text = readFileSync(join('dist', f), 'utf8');
  writeFileSync(join('dist', f.replace(/\.d\.ts$/, '.d.cts')), text.replace(/(from\s+['"]\.\/[^'"]+)\.js(['"])/g, '$1.cjs$2'));
}
console.log('build ok');
