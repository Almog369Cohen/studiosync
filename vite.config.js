import { defineConfig } from 'vite'

export default defineConfig({
  // Point to the shared web UI
  root: '..',

  build: {
    outDir:        'desktop/dist',
    emptyOutDir:   true,
    target:        ['chrome110', 'safari16'],
    rollupOptions: {
      input: { main: '../index.html' }
    }
  },

  server: {
    port:        5173,
    strictPort:  true,
    // Allow Tauri to connect
    host:        '127.0.0.1',
  },

  clearScreen: false,

  // Tauri needs these for hot-reload in dev
  envPrefix: ['VITE_', 'TAURI_'],
})
