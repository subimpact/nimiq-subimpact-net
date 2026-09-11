import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';
import react from '@astrojs/react';
// @nimiq/core ships its wasm as an ES module import, which Vite only understands
// with this plugin. It is the library's own `./vite` export, so it adds no
// dependency of its own. Only the lazily-imported StakeDialog pulls in the wasm.
import nimiq from '@nimiq/core/vite';

export default defineConfig({
  output: 'static',
  site: 'https://nimiq.subimpact.net',
  integrations: [sitemap(), react()],
  vite: {
    plugins: [tailwindcss(), nimiq()],
  },
});
