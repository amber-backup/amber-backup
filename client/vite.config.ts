import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

// The SPA is served by the NestJS server in production; in dev it proxies /api.
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
