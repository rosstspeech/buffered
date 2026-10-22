import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/speechmatics-jwt': 'http://localhost:3000',
    }
  },
  build: {
    target: 'esnext'
  }
});
