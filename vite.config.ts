import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Vite dev/build config for the SC Prism client UI.
// The Tauri shell (src-tauri) is added once the UI is proven.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: false },
})
