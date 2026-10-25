// ManyClaws's service worker: it shows the notifications the server sends this device
// (a session needs you, Claude has finished), and opens the session when one is tapped.
// It keeps no copy of the page: the page is no use without the server.

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (ev) => ev.waitUntil(self.clients.claim()))

self.addEventListener('push', (ev) => {
  let note = {}
  try {
    note = ev.data.json()
  } catch {
    note = { body: ev.data ? ev.data.text() : '' }
  }
  ev.waitUntil(show(note))
})

async function show(note) {
  // What a session says comes sealed: opened with the account's key this device keeps,
  // where it has it; where it hasn't, the note's own plain title and body are shown,
  // which are the server's and say nothing of the session
  let opened = null
  if (note.sealed) {
    const got = await openSealed(note.sealed).catch(() => null)
    // (a session says all of it in one sealed thing, `n`: the server passes it on and cannot say what it is about.
    // A reminder's words are two, `title` and `body`.)
    opened = got?.n && typeof got.n === 'object' ? got.n : got
    if (opened) {
      note.title = String(opened.title || 'ManyClaws') + (opened.where ? ' · ' + opened.where : '')
      note.body = (String(opened.prefix || '') + String(opened.body ?? '')).replace(/\s+/g, ' ').trim().slice(0, 240)
    }
  }
  let error = ''
  try {
    await self.registration.showNotification(note.title || 'ManyClaws', {
      body: note.body || '',
      // One notification to a session: a newer one takes the older one's place, and says so again
      tag: note.tag || undefined,
      renotify: !!note.tag,
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      data: { url: note.url || '/' },
    })
  } catch (err) {
    error = String(err?.name ?? err) + (err?.message ? ': ' + err.message : '')
  }
  await tellShown(note, !!opened, error)
}

// (for now: the server is told what came of each notification, for its log. Which device this is, by its push
// address; whether the key here opened it; whether it was shown, and how many of its tag this device holds now; and
// whether notifications are allowed here. Nothing of what it says. deon, 2026-10-25, of notifications his iPhone and
// Mac were sent and did not show.)
async function tellShown(note, opened, error) {
  try {
    const sub = await self.registration.pushManager.getSubscription()
    const count = note.tag ? (await self.registration.getNotifications({ tag: note.tag }).catch(() => [])).length : 0
    await fetch('/api/push/seen', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: sub?.endpoint ?? '', tag: note.tag ?? '', opened, permission: self.Notification?.permission ?? '', count, error }) })
  } catch {}
}

// ---- Opening what's sealed (the same sealing as seal.js, done here with WebCrypto)

const SEALED = '\uE000v1.'
const enc = new TextEncoder()

// The keys this device keeps (keys.js keeps them in this site's own database): each is
// what an account's sessions are sealed with, given to this device by another of the
// account's or drawn from the account's root here, and kept so that it opens and seals
// here and can be read back by nothing
function storedKeys() {
  return new Promise((resolve) => {
    const req = indexedDB.open('manyclaws', 1)
    req.onupgradeneeded = () => req.result.createObjectStore('keys')
    req.onerror = () => resolve([])
    req.onsuccess = () => {
      const db = req.result
      const all = db.transaction('keys', 'readonly').objectStore('keys').getAll()
      // (each is what a device holds of an account's: of that, the key is what opens)
      all.onsuccess = () => (db.close(), resolve((all.result || []).map((held) => held && held.key).filter((k) => k instanceof CryptoKey)))
      all.onerror = () => (db.close(), resolve([]))
    }
  })
}

async function openOne(sealed, key) {
  const bytes = Uint8Array.from(atob(sealed.slice(SEALED.length).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData: enc.encode('manyclaws sealed v2') }, key, bytes.subarray(12))
  return JSON.parse(new TextDecoder().decode(plain))
}

// Every sealed value of an object opened with the first kept key that opens them all, or null
async function openSealed(values) {
  for (const key of await storedKeys()) {
    try {
      const out = {}
      for (const [k, v] of Object.entries(values)) out[k] = typeof v === 'string' && v.startsWith(SEALED) ? await openOne(v, key) : v
      return out
    } catch {
      // not this key
    }
  }
  return null
}

// Tapped: the page that's open is brought forward and shown the session, or one is opened
self.addEventListener('notificationclick', (ev) => {
  ev.notification.close()
  const url = (ev.notification.data && ev.notification.data.url) || '/'
  ev.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((pages) => {
      const page = pages.find((p) => 'focus' in p)
      if (!page) return self.clients.openWindow(url)
      page.postMessage({ open: url })
      return page.focus()
    }),
  )
})
