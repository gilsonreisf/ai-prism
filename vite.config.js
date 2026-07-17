import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Frontend lives in /client, builds to /client/dist (served by Express in prod).
export default defineConfig({
  plugins: [react()],
  root: 'client',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8000',
    },
  },
})
