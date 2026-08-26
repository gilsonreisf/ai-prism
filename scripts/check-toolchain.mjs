// Guard rodado como `prebundle` (antes de `npm run bundle`). Converte o críptico
// "vite: not found" numa instrução acionável quando o toolchain de build não foi
// instalado — o caso comum é rodar `npm install` puro, que NÃO instala nada porque
// o .npmrc do repo tem omit=dev e todas as deps de build vivem em devDependencies.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const required = ['vite', 'esbuild'];
const missing = required.filter((pkg) => !existsSync(join(root, 'node_modules', pkg)));

if (missing.length > 0) {
  process.stderr.write(
    `\n✗ Toolchain de build ausente: ${missing.join(', ')}.\n\n` +
      '  As dependências de build ficam em devDependencies e o .npmrc tem omit=dev,\n' +
      '  então "npm install" puro não as instala. Rode o setup do projeto primeiro:\n\n' +
      '      npm run setup\n\n' +
      '  (equivale a: npm install --include=dev --ignore-scripts)\n\n' +
      '  Atrás de um registry/proxy corporativo? Configure o npm (npm config set\n' +
      '  registry <url> e as vars de proxy) antes de rodar o setup.\n\n',
  );
  process.exit(1);
}
