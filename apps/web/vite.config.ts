import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The build lands in `dist/`, which `apps/server` serves when it exists. One origin for the page
 * and the socket means a single tunnel or a single deploy covers both, and the client can derive
 * its WebSocket URL from `location` instead of being told where the server is.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
