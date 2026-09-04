import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig } from 'vitest/config';

// HTTPS=1 npm run dev serves a self-signed cert so phone GPS works
// (geolocation needs a secure context on non-localhost origins).
export default defineConfig({
  base: './',
  plugins: process.env.HTTPS ? [basicSsl()] : [],
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
