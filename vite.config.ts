import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main:   './index.html',
        player: './player/player.html',
      },
    },
    outDir: 'dist',
  },
  server: {
    port: 5174, // different port from VideoSharePlugin's 5173
  },
});
