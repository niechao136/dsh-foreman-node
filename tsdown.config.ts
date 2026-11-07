import { defineConfig } from 'tsdown'
export default defineConfig([
  { entry: { protocol: 'src/protocol.ts', index: 'src/index.ts' }, outDir: 'lib', format: 'esm', fixedExtension: false,
    platform: 'node', target: 'es2024', dts: true, clean: true, deps: { neverBundle: [/^@deepseek-ai\//] } },
  // The page the Plugin Manager mounts. It is a CommonJS bundle with the same wrapper the hub's client uses, because
  // that is how DSH's browser module loader hands a plugin its exports.
  { entry: { client: 'src/client/index.tsx' }, outDir: 'lib', format: 'cjs', platform: 'browser', dts: false, clean: false,
    deps: { neverBundle: ['react', 'react/jsx-runtime', 'react-dom'] },
    outputOptions: { entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "dsh-foreman-node", factory: (require) => {',
      footer: 'return module.exports; } });', intro: 'var module = { exports: {} }; var exports = module.exports;' } },
])
