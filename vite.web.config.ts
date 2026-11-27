import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The sync server serves the web app from flat /assets/<name>.(js|css) paths,
// with web-app.js and web-app.css as the uncached entry files.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/assets/',
  publicDir: false,
  build: {
    outDir: 'dist-web',
    emptyOutDir: true,
    assetsDir: '',
    cssCodeSplit: false,
    rollupOptions: {
      input: 'src/web-app.tsx',
      output: {
        entryFileNames: 'web-app.js',
        chunkFileNames: '[name]-[hash].js',
        assetFileNames: info => (info.names.some(name => name.endsWith('.css')) ? 'web-app.css' : '[name]-[hash][extname]'),
      },
    },
  },
});
