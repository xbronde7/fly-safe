import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: {
      __FLY_SAFE_ENTITLEMENT_API_URL__: JSON.stringify(
        process.env.FLY_SAFE_ENTITLEMENT_API_URL ?? ''
      ),
      __FLY_SAFE_COMBAT_RELAY_URL__: JSON.stringify(
        process.env.FLY_SAFE_COMBAT_RELAY_URL ?? ''
      )
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react()]
  }
})
