import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';
import react from '@astrojs/react';

export default defineConfig({
  output: 'static',
  site: 'https://nimiq.subimpact.net',
  integrations: [sitemap(), react()],
  vite: {
    plugins: [tailwindcss()],
  },
});
