import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Served from /app by `accounts serve --web packages/web/dist` (ADR 0020).
// In dev, /api proxies to a running `accounts serve` so the app is always
// origin-relative and CORS never enters the picture.
export default defineConfig({
  plugins: [react()],
  base: '/app/',
  server: {
    proxy: { '/api': 'http://127.0.0.1:3000' },
  },
  test: {
    environment: 'jsdom',
  },
});
