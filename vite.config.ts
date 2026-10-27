import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, '.'),
      },
    },
    build: {
      chunkSizeWarningLimit: 1000,
    },
    define: {
      'process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY': JSON.stringify(
        process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY ||
          process.env.STRIPE_PUBLISHABLE_KEY ||
          'pk_test_pk_live_51UUrCf4zcRf8LhgQF5LsWrrFd2wpw51X54trXw0FoEa9rwiMrNMGMQeSWmCUxLPIWnniB3IxssWICWg8Xr9Cptbg00XBXxtTdo'
      ),
      'process.env.AWIN_PUBLISHER_ID': JSON.stringify(
        process.env.AWIN_PUBLISHER_ID || process.env.EXPO_PUBLIC_AWIN_PUBLISHER_ID || ''
      ),
      'process.env.TESCO_PARTNER_TAG': JSON.stringify(
        process.env.TESCO_PARTNER_TAG || ''
      ),
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
