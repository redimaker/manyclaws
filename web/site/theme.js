// The page's colors, light or dark: as this device has them in its settings (mc.theme, kept in its browser), or, where
// it has not said, as its system has them, and as the system changes them. Run from the page's head, before anything is
// drawn, so that it is never drawn in the other one first: the style sheet keys its colors on <html data-theme>.
// (A classic script: app.js, which has the setting, calls applyTheme when it is changed.)
function applyTheme() {
  let chosen = null
  try {
    chosen = localStorage.getItem('mc.theme')
  } catch {}
  const theme = chosen === 'light' || chosen === 'dark' ? chosen : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  document.documentElement.dataset.theme = theme
  // (what the browser draws of its own, its scroll bars and controls, in the same; and the bar a phone draws over the page)
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme)
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.setAttribute('content', theme === 'dark' ? '#181818' : '#f8f8f8')
}
applyTheme()
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme)
// (and as another of this browser's tabs of the page changes it)
addEventListener('storage', (ev) => ev.key === 'mc.theme' && applyTheme())
