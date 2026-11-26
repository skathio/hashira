// The landing pages use the system font stack, so the docs skip VitePress's bundled Inter.
// The order is the cascade: the shared theme, then the site's accent. prepare.js writes
// accent.css for each build. theme_css is not imported here: config.mts links it after these,
// so the site's own rules win, and Vite never resolves the paths in it.
import DefaultTheme from 'vitepress/theme-without-fonts'
import './custom.css'
import './accent.css'

export default DefaultTheme
