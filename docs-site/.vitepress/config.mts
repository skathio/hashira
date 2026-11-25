import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { posix, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitepress'
import { h1Label } from '../h1-label.mjs'
import { escapeBraces, githubSlug, rewriteLink } from '../links.mjs'

// The docs are read from the repo's docs/ as they are on GitHub: no front matter and no
// link edits. build.sh stages them (with the logo) under artifacts/, because VitePress
// reads one source folder and resolves node modules from the sources.
const repoPath = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url))
const stage = repoPath('artifacts/docs-site')
const srcDir = `${stage}/src`

const REPO = 'https://github.com/skathio/hashira'
// The maintainer checklist stays on GitHub only.
const unpublished = ['contributing.md']

// Short sidebar labels, in reading order. A published page missing here is still listed,
// under its H1, so a new doc never drops out of the sidebar.
const guides: [string, string][] = [
  ['getting-started.md', 'Getting started'],
  ['usage.md', 'Usage and pin policy'],
  ['flows/npm.md', 'npm flow'],
  ['flows/nuget.md', 'NuGet flow'],
  ['flows/static-webapp.md', 'Static site flow'],
  ['catalog.md', 'Catalog'],
  ['migration-v2-to-v3.md', 'Migrating from v2 to v3'],
]
// A listed guide that is gone would leave /hashira/docs/ or a sidebar entry pointing at no page,
// and VitePress checks links in pages, not in the sidebar: fail the build instead.
const missing = guides.map(([g]) => g).filter((g) => !existsSync(repoPath(`docs/${g}`)))
if (missing.length) {
  throw new Error(`docs-site: listed guides missing from docs/: ${missing.join(', ')}`)
}
// The published pages: docs/*.md and docs/flows/*.md, as paths relative to docs/.
const docsIn = (sub: string) =>
  readdirSync(repoPath(posix.join('docs', sub))).filter((f) => f.endsWith('.md')).map((f) => posix.join(sub, f))
const unlisted = [...docsIn('.'), ...docsIn('flows')]
  .filter((f) => !unpublished.includes(f) && !guides.some(([g]) => g === f))
  .sort()
  .map((f): [string, string] => [f, h1Label(readFileSync(repoPath(`docs/${f}`), 'utf8'), f)])
// /hashira/docs/ opens Getting started.
const rewrites: Record<string, string> = { 'getting-started.md': 'index.md' }
const pageLink = (md: string) => `/${(Object.hasOwn(rewrites, md) ? rewrites[md] : md).replace(/(index)?\.md$/, '')}`

// A folder of docs/ with no index page of its own, which a link opens on GitHub.
const isFolder = (path: string) =>
  existsSync(repoPath(path)) && statSync(repoPath(path)).isDirectory() && !existsSync(`${srcDir}/${path.slice('docs/'.length)}index.md`)

// The landing page keeps its theme under `theme` (auto, light or dark). Before VitePress's
// own dark-mode check runs, map it onto VitePress's key, so a stored light or dark opens
// the docs in that theme with no flash. Anything else means auto.
const themeFromLanding = `try{var t=localStorage.getItem('theme');localStorage.setItem('vitepress-theme-appearance',t==='light'||t==='dark'?t:'auto')}catch(e){}`
// When the visitor flips the docs toggle, store light or dark under the landing key. The
// observer starts after load, so the initial class does not count as a choice.
const themeToLanding = `document.addEventListener('DOMContentLoaded',function(){var r=document.documentElement,d=r.classList.contains('dark');new MutationObserver(function(){var n=r.classList.contains('dark');if(n===d){return}d=n;try{localStorage.setItem('theme',n?'dark':'light')}catch(e){}}).observe(r,{attributes:true,attributeFilter:['class']})})`

export default defineConfig({
  srcDir,
  srcExclude: unpublished,
  outDir: `${stage}/dist`,
  cacheDir: `${stage}/cache`,
  base: '/hashira/docs/',
  rewrites,
  title: 'hashira',
  description: 'Guides for hashira: reusable GitHub Actions workflows and composite actions for npm, NuGet and static-site CI/CD.',
  head: [
    ['link', { rel: 'icon', href: '/hashira/docs/mark.svg', type: 'image/svg+xml' }],
    ['script', {}, themeFromLanding],
    ['script', {}, themeToLanding],
  ],
  themeConfig: {
    logo: '/mark.svg',
    siteTitle: 'hashira',
    // The landing page sits one level above the docs base, outside VitePress's router.
    logoLink: { link: '/hashira/', target: '_self' },
    nav: [{ text: '← hashira', link: '/../', target: '_self' }],
    search: { provider: 'local' },
    sidebar: [{ text: 'Guides', items: [...guides, ...unlisted].map(([md, text]) => ({ text, link: pageLink(md) })) }],
    outline: [2, 3],
    socialLinks: [{ icon: 'github', link: REPO }],
  },
  markdown: {
    // The docs show placeholders such as '<name>\t<status>' in plain text and use no raw HTML
    // of their own, so HTML in the Markdown renders as text instead of becoming a Vue tag.
    html: false,
    // Heading ids follow GitHub's rule, so a link's #anchor lands here as it does there.
    anchor: { slugify: githubSlug },
    config: (md) => {
      // The docs are plain Markdown, not Vue templates: see escapeBraces.
      for (const rule of ['text', 'code_inline'] as const) {
        const render = md.renderer.rules[rule]!
        md.renderer.rules[rule] = (...args) => escapeBraces(render(...args))
      }
      md.core.ruler.push('outbound-and-rewritten-links', (state) => {
        // The source page's path relative to docs/, before any rewrite moved it.
        const page = relative(srcDir, state.env.realPath ?? state.env.path).split('\\').join('/')
        for (const block of state.tokens) {
          for (const token of block.children ?? []) {
            const href = token.type === 'link_open' ? token.attrGet('href') ?? '' : ''
            const url = href && rewriteLink(page, href, { unpublished, rewrites, isFolder })
            if (url) {
              token.attrSet('href', url)
            }
          }
        }
      })
      // VitePress labels a heading's permalink with the heading's Markdown source, backslash
      // escapes and code marks included. A screen reader should hear the heading as it reads.
      md.core.ruler.push('permalink-labels', (state) => {
        for (const block of state.tokens) {
          const permalink = block.children?.find((t) => t.type === 'link_open' && t.attrGet('class') === 'header-anchor')
          if (permalink) {
            const heading = block.children!.filter((t) => t.type === 'text' || t.type === 'code_inline').map((t) => t.content).join('').trim()
            permalink.attrSet('aria-label', `Permalink to "${heading}"`)
          }
        }
      })
    },
  },
})
