import { defineConfig } from 'vite';

const API_PORT = Number(process.env.ONE_TAKE_PORT ?? 4317);

export default defineConfig({
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
          if (id.includes('/onnxruntime-web/')) return 'ort';
          return undefined;
        },
      },
    },
  },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@one-take/shared'] },
});
