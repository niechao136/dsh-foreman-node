import { defineConfig } from 'tsdown'
export default defineConfig({
  entry: { protocol: 'src/protocol.ts' },
  outDir: 'lib', format: 'esm', fixedExtension: false, platform: 'node', target: 'es2024',
  dts: true, clean: true, deps: { neverBundle: [/^@deepseek-ai\//] },
})