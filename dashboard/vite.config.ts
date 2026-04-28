import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Dashboard fetches PostgREST through `/api/*` (same origin in dev via
// this proxy; same origin in prod when Caddy serves the SPA + reverse-
// proxies /api/*). Keeps the client code identical across modes.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target =
    env.VITE_API_TARGET ?? 'https://dashboard.178-104-253-30.nip.io';
  return {
    plugins: [react()],
    resolve: {
      alias: { '@': path.resolve(__dirname, 'src') },
    },
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': {
          target,
          changeOrigin: true,
          secure: true,
          rewrite: (p) => p.replace(/^\/api/, ''),
        },
      },
    },
  };
});
