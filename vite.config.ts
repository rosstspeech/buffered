import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: {
      '/speechmatics-jwt': 'http://localhost:3000',
      '/language-identification': 'http://localhost:3000'
    }
  },
  build: {
    target: 'esnext'
  }
});
