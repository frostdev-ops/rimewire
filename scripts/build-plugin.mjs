import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const root = fileURLToPath(new URL('../', import.meta.url));
const plugin = `${root}plugins/rimewire/`;
mkdirSync(`${plugin}dist`, { recursive: true });
await build({ entryPoints: [`${root}src/cli.ts`], outfile: `${plugin}dist/cli.js`, bundle: true, mainFields: ['module', 'main'], platform: 'node', format: 'esm', target: 'node24', sourcemap: false, banner: { js: "import { createRequire as rimewireCreateRequire } from 'node:module'; const require = rimewireCreateRequire(import.meta.url);" } });
for (const [source, target] of [['static', 'static'], ['skills', 'skills'], ['adapters', 'adapters']]) {
  rmSync(`${plugin}${target}`, {recursive:true,force:true});
  cpSync(`${root}${source}`, `${plugin}${target}`, {recursive:true});
}
