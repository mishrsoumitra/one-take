import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { noiseSuppressionAudioWorkletVitePlugin } from '@workadventure/noise-suppression/vite';
import { defineConfig, type Plugin } from 'vite';

const API_PORT = Number(process.env.ONE_TAKE_PORT ?? 4317);

const require = createRequire(import.meta.url);
/** MediaPipe's package root (its `exports` map hides the wasm files from `require.resolve`). */
const mediapipe = path.dirname(require.resolve('@mediapipe/tasks-vision'));

/**
 * Files out of node_modules that a library fetches by URL at run time, served at a fixed path in
 * dev and copied there in the build. MediaPipe's loader is given a directory and fetches the wasm
 * runtime from it by name, so it cannot be given a hashed asset URL.
 */
function vendorFiles(files: Record<string, string>): Plugin {
  const type = (url: string) => (url.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
  return {
    name: 'one-take-vendor-files',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = (request.url ?? '').split('?')[0] ?? '';
        const file = files[url];
        if (!file) {
          next();
          return;
        }
        response.setHeader('Content-Type', type(url));
        fs.createReadStream(file).pipe(response);
      });
    },
    generateBundle() {
      for (const [url, file] of Object.entries(files)) {
        this.emitFile({ type: 'asset', fileName: url.replace(/^\//, ''), source: fs.readFileSync(file) });
      }
    },
  };
}

export default defineConfig({
  plugins: [
    noiseSuppressionAudioWorkletVitePlugin(),
    // the ES-module build of the runtime, the one a module worker can load (SIMD, which every browser
    // that runs the lip check has)
    vendorFiles({
      '/vendor/mediapipe/vision_wasm_module_internal.js': path.join(
        mediapipe,
        'wasm/vision_wasm_module_internal.js',
      ),
      '/vendor/mediapipe/vision_wasm_module_internal.wasm': path.join(
        mediapipe,
        'wasm/vision_wasm_module_internal.wasm',
      ),
    }),
  ],
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': { target: `http://127.0.0.1:${API_PORT}`, changeOrigin: false },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('/pdfjs-dist/')) return 'pdfjs';
          if (id.includes('/mediabunny/')) return 'mediabunny';
          if (id.includes('/@mediapipe/')) return 'mediapipe';
          return undefined;
        },
      },
    },
  },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@one-take/shared'] },
});
