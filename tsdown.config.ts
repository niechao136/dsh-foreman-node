import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { defineConfig } from 'tsdown'
// `?raw` imports a file as its text, as Vite and vitest do; tsdown refuses `.css` ids without @tsdown/css, so this
// loads them. The page's stylesheet arrives this way and is rendered through a <style> element, which keeps a
// settings section from needing a stylesheet URL for the host to serve.
const raw = { name: 'raw',
  resolveId: (source: string, importer?: string) => source.endsWith('?raw') && importer ? resolve(dirname(importer), source) : undefined,
  load: (id: string) => id.endsWith('?raw') ? { code: `export default ${JSON.stringify(readFileSync(id.slice(0, -4), 'utf8'))}`, moduleType: 'js' as const }
    : undefined }
export default defineConfig([
  { entry: { protocol: 'src/protocol.ts', index: 'src/index.ts' }, outDir: 'lib', format: 'esm', fixedExtension: false,
    platform: 'node', target: 'es2024', dts: true, clean: true, deps: { neverBundle: [/^@deepseek-ai\//] } },
  // The page the Plugin Manager mounts. It is a CommonJS bundle with the same wrapper the hub's client uses, because
  // that is how DSH's browser module loader hands a plugin its exports.
  { entry: { client: 'src/client/index.tsx' }, outDir: 'lib', format: 'cjs', platform: 'browser', dts: false, clean: false,
    plugins: [raw], deps: { neverBundle: ['react', 'react/jsx-runtime', 'react-dom'] },
    outputOptions: { entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "dsh-foreman-node", factory: (require) => {',
      footer: 'return module.exports; } });', intro: 'var module = { exports: {} }; var exports = module.exports;' } },
])
