import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { sceneHash } from './tools/scene-hash.mjs';
export default defineConfig({
  define: { __SCENE_HASH__: JSON.stringify(sceneHash(import.meta.dirname)) },
  plugins: [
    {
      name: 'dashboard-entry',
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          if (req.url && /^\/dashboard\/?(?:\?|$)/.test(req.url)) req.url = req.url.replace(/^\/dashboard\/?/, '/dashboard.html');
          next();
        });
      },
    },
  ],
  root: resolve(import.meta.dirname, 'src/client'),
  publicDir: resolve(import.meta.dirname, 'src/client/public'),
  build: {
    outDir: resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'src/client/index.html'),
        dashboard: resolve(import.meta.dirname, 'src/client/dashboard.html'),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      // Not the string shorthand: that sets changeOrigin, so /api would see Host :4600 while /ws sees
      // Vite's port, and the office's Origin check would turn the socket away.
      '/api': { target: 'http://localhost:4600', changeOrigin: false },
      '/ws': { target: 'ws://localhost:4600', ws: true },
      // With the slash: a bare prefix would also send the client's own whiteboard-*.ts modules to the office.
      '/whiteboard/': { target: 'http://localhost:4600', changeOrigin: false },
    },
  },
});
