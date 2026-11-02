import { defineConfig } from 'vite';

export default defineConfig({
  // The server's MCP framework has React 19 peers; keep this workspace and its UI libraries on one React.
  resolve: { dedupe: ['react', 'react-dom'] },
});
