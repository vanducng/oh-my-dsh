import { defineConfig } from 'astro/config'
import sitemap from '@astrojs/sitemap'
import rehypeSlug from 'rehype-slug'
import rehypeDocLinks from './plugins/rehype-doc-links.mjs'

export default defineConfig({
  site: 'https://vanducng.github.io',
  base: '/oh-my-dsh/',
  trailingSlash: 'always',
  build: {
    inlineStylesheets: 'always',
  },
  integrations: [
    sitemap({
      i18n: {
        defaultLocale: 'en',
        locales: { en: 'en-US', zh: 'zh-CN' },
      },
    }),
  ],
  markdown: {
    rehypePlugins: [rehypeSlug, rehypeDocLinks],
    shikiConfig: {
      themes: { light: 'github-light-default', dark: 'github-dark-default' },
    },
  },
})
