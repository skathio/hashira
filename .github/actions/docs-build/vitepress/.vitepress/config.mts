import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { transformWithEsbuild } from 'vite'
import { defineConfig } from 'vitepress'

// The helpers in lib/ are CommonJS, shared with prepare.js and its tests, so they are loaded
// at run time rather than bundled into the config.
const load = createRequire(import.meta.url)
const { escapeHtml, githubSlug, rewriteLink } = load('../../lib/links.js')
const { configureMarkdown } = load('../../lib/markdown.js')
const { siteConfig } = load('../../lib/site-config.js')
const { dropCheckDarkMode, themeFromLanding } = load('../../lib/theme-bridge.js')
const { checkBuiltPage, descriptionTag, escapeInlineMetadata } = load('../../lib/html-safety.js')

// The docs-build action copies this folder into a work folder under RUNNER_TEMP, stages the
// caller's docs/ in src/, and writes build.json (lib/prepare.js): the checked pages.json, the
// repo's GitHub URL and the work paths. Nothing here reads or writes the caller's docs/.
const build = JSON.parse(readFileSync(fileURLToPath(new URL('./build.json', import.meta.url)), 'utf8'))
const { config, stage: srcDir } = build

// Checks that need the stage as pre_build_command left it fail with an annotation, like
// prepare.js's, before VitePress does anything. The annotation is one line, as prepare.js
// writes it: a file name with a newline must not start an annotation of its own, in this
// line or in the error VitePress prints after it.
function failBuild(text: string): never {
  const message = text.replace(/\r?\n/g, ' ')
  console.error(`::error::${message}`)
  throw new Error(message)
}

let site
try {
  site = siteConfig(build)
} catch (err) {
  failBuild((err as Error).message)
}
const { rewrites, isFolder, isRepoDir } = site
const unpublished: string[] = config.unpublished
const logo = build.logo ? `/${build.logo}` : undefined
const logoType = build.logo?.endsWith('.svg') ? 'image/svg+xml' : 'image/png'

// VitePress minifies each head script with Vite's esbuild transform before writing it. The
// built-page check allows these scripts as VitePress writes them, so it minifies them the same way.
const headScripts = [themeFromLanding]
const builtHeadScripts = await Promise.all(
  headScripts.map(async (code) => (await transformWithEsbuild(code, 'inline-script.js', { minify: true })).code.trim()),
)

function refuseFrontMatter(lang: string) {
  return () => failBuild(`docs-build: front matter in ${lang} is not supported; only YAML front matter is read.`)
}
const refusedFrontMatterEngines = Object.fromEntries(
  ['js', 'javascript', 'json', 'coffee', 'coffeescript', 'cson', 'toml'].map((lang) => [lang, { parse: refuseFrontMatter(lang), stringify: refuseFrontMatter(lang) }]),
)

export default defineConfig({
  srcDir,
  srcExclude: unpublished.map((u) => (u.endsWith('.md') ? u : `${u.replace(/\/$/, '')}/**`)),
  outDir: build.dist,
  cacheDir: build.cache,
  base: config.base,
  rewrites,
  title: config.name,
  description: config.description,
  head: [
    ...(logo ? [['link', { rel: 'icon', href: `${config.base}${build.logo}`, type: logoType }] as [string, Record<string, string>]] : []),
    // theme_css, served as it is from public/ (lib/prepare.js), after VitePress's stylesheet.
    ...(build.themeCss ? [['link', { rel: 'stylesheet', href: `${config.base}${build.themeCss}` }] as [string, Record<string, string>]] : []),
    ...headScripts.map((code) => ['script', {}, code] as [string, Record<string, string>, string]),
  ],
  // pages.json values reach the HTML escaped: the description through an escaped head tag,
  // and the inline site data with no `</script>` that could end its script (lib/html-safety.js).
  transformHead: ({ description }) => [descriptionTag(description)],
  // Each built page then holds only what VitePress and this config write (lib/html-safety.js).
  transformHtml: (html, _id, { page }) => {
    const out = escapeInlineMetadata(dropCheckDarkMode(html))
    const problems = checkBuiltPage(out, { base: config.base, inlineScripts: builtHeadScripts })
    if (problems.length > 0) failBuild(`docs-build: ${page}: ${problems.slice(0, 3).join('; ')}`)
    return out
  },
  // The docs read as GitHub renders them, which gives front matter no meaning. VitePress
  // would otherwise add `head:` tags and render `hero`, `features`, `prev` and `next` as raw
  // HTML, so none of it reaches the page. The title comes from the page's first heading.
  transformPageData: (pageData) => {
    const fromFrontmatter = 'title' in pageData.frontmatter || 'titleTemplate' in pageData.frontmatter
    pageData.frontmatter = {}
    if (fromFrontmatter) pageData.title = ''
  },
  themeConfig: {
    logo,
    // VitePress renders the site title as HTML.
    siteTitle: escapeHtml(config.name),
    // The landing sits above the docs base, outside VitePress's router.
    logoLink: { link: site.landing, target: '_self' },
    nav: site.nav,
    search: { provider: 'local' },
    sidebar: site.sidebar,
    outline: [2, 3],
    socialLinks: [{ icon: 'github', link: build.repo }],
  },
  vite: {
    resolve: {
      // VitePress prefixes the docs base to every absolute nav link, which would turn a
      // landing link such as /site/blog/ into /site/docs/site/blog/. RawLink is VitePress's
      // VPLink, except that it keeps the href of a target="_self" link as built.
      // ThemeSwitch is the landing pages' three-state theme control (auto, light, dark) in
      // place of VitePress's two-state switch, on the shared `theme` key.
      alias: [
        { find: /^.*\/VPLink\.vue$/, replacement: fileURLToPath(new URL('./theme/RawLink.vue', import.meta.url)) },
        { find: /^.*\/VPSwitchAppearance\.vue$/, replacement: fileURLToPath(new URL('./theme/ThemeSwitch.vue', import.meta.url)) },
      ],
    },
  },
  markdown: {
    // gray-matter would run `---js` front matter as code. Only YAML is read; any other
    // engine fails the build (lib/site-config.js refuses such a page before this).
    frontmatter: { grayMatterOptions: { engines: refusedFrontMatterEngines } },
    // HTML in the Markdown renders as text instead of becoming a Vue tag or a script.
    html: false,
    // markdown-it-attrs would turn `{onclick="..."}` after an element into an attribute,
    // around html: false. GitHub has no such syntax either.
    attrs: { disable: true },
    // Heading ids follow GitHub's rule, so a link's #anchor lands here as it does there.
    anchor: { slugify: githubSlug },
    config: (md) => configureMarkdown(md, { srcDir, rewrite: (page, href) => rewriteLink(page, href, { repo: build.repo, unpublished, rewrites, isFolder, isRepoDir }) }),
  },
})
