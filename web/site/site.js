// The front door's script (home.html, setup.html, legal.html): links meant for the page
// itself are passed on to it, what a subscription costs is asked of the server, and the
// spoken version plays.

// A link that is the page's own (a one-time sign-in, an invite, the way back from
// paying) came to the front door because nobody is signed in yet: it goes on to the page
if (/^#(login=|invite=|signup$|\/)/.test(location.hash) || new URLSearchParams(location.search).has('paid')) location.replace('/app' + location.search + location.hash)

// What it costs is Stripe's to say: the figures in the page are put right from the server's
const money = (p, digits = 2) => new Intl.NumberFormat('en-US', { style: 'currency', currency: p.currency, minimumFractionDigits: digits }).format(p.amount / 100)
fetch('/api/plans')
  .then((r) => r.json())
  .then(({ prices = [] }) => {
    const month = prices.find((p) => p.plan === 'monthly')
    const year = prices.find((p) => p.plan === 'yearly')
    const put = (name, text) => {
      for (const el of document.querySelectorAll(`[data-price="${name}"]`)) el.textContent = text
    }
    if (month) {
      put('monthly', `${money(month)} a month`)
      put('monthly-short', money(month))
      put('monthly-sum', money(month))
    }
    if (year) put('yearly-sum', money(year))
    if (month && year) {
      const saved = month.amount * 12 - year.amount
      const months = saved / month.amount
      document.documentElement.dataset.priced = '1'
      if (saved > 0) put('saving', months >= 1.9 && months <= 2.1 ? 'Two months free, near enough' : `${money({ ...year, amount: saved })} less than twelve months`)
    }
  })
  .catch(() => {})

// The spoken version: one button, which fills as it plays
const listen = document.getElementById('listen')
const pitch = document.getElementById('pitch')
if (listen && pitch) {
  const text = listen.querySelector('.listen-text')
  const idle = text.textContent
  listen.addEventListener('click', () => (pitch.paused ? pitch.play() : pitch.pause()))
  pitch.addEventListener('play', () => listen.setAttribute('aria-pressed', 'true'))
  pitch.addEventListener('pause', () => listen.setAttribute('aria-pressed', 'false'))
  pitch.addEventListener('timeupdate', () => {
    listen.style.setProperty('--played', pitch.duration ? pitch.currentTime / pitch.duration : 0)
    text.textContent = pitch.paused && !pitch.currentTime ? idle : `${Math.max(0, Math.ceil(pitch.duration - pitch.currentTime))} seconds to go`
  })
  pitch.addEventListener('ended', () => {
    listen.style.setProperty('--played', 0)
    text.textContent = 'Hear it again'
  })
}

// In the guide, a command (or what to say to Claude Code) is taken with one press
for (const block of document.querySelectorAll('.guide pre.term, .guide-intro blockquote')) {
  const text = (block.querySelector('code') ?? block).textContent.trim()
  const copy = document.createElement('button')
  copy.type = 'button'
  copy.className = 'copy'
  copy.textContent = 'Copy'
  copy.addEventListener('click', async () => {
    await navigator.clipboard.writeText(text).catch(() => {})
    copy.textContent = 'Copied'
    setTimeout(() => (copy.textContent = 'Copy'), 1500)
  })
  block.append(copy)
}

// Things come up as they're scrolled to
const rising = document.querySelectorAll('.premise > *, .beat > *, .bench h2, .box-head, .manifest li, .sealed > *, .setup > *, .price-head, .ticket, .way li, .asked details, .last h2')
if ('IntersectionObserver' in window && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
  const seen = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue
        e.target.classList.add('risen')
        seen.unobserve(e.target)
      }
    },
    { rootMargin: '0px 0px -8% 0px' },
  )
  for (const el of rising) {
    el.classList.add('rise')
    seen.observe(el)
  }
}
