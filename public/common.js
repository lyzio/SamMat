// Shared helpers for all SamMat pages

// ---------- Storage ----------
const store = {
  get: (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } }
};

// ---------- Language: Swedish (default) or English ----------
// Chosen with the SV/EN toggle; first visit follows the browser (sv* → Swedish, anything else → English).
const LANG = (() => {
  const s = store.get('sammat_lang');
  if (s === 'sv' || s === 'en') return s;
  return /^sv|^nb|^nn|^da/i.test(navigator.language || 'sv') ? 'sv' : 'en';
})();
const L = (sv, en) => (LANG === 'en' ? en : sv);
const LOCALE = L('sv-SE', 'en-GB');
document.documentElement.lang = LANG;

function setLang(l) { store.set('sammat_lang', l); location.reload(); }

// Adds the SV | EN toggle to the page's top bar
document.addEventListener('DOMContentLoaded', () => {
  const bar = document.querySelector('.topbar');
  if (!bar || bar.querySelector('.lang')) return;
  const el = document.createElement('div');
  el.className = 'lang';
  el.innerHTML = `<button type="button" data-l="sv" class="${LANG === 'sv' ? 'on' : ''}" aria-label="Svenska">SV</button><button type="button" data-l="en" class="${LANG === 'en' ? 'on' : ''}" aria-label="English">EN</button>`;
  el.querySelectorAll('button').forEach((b) => { b.onclick = () => b.dataset.l !== LANG && setLang(b.dataset.l); });
  // Keep the right-hand side together: [whatever was last] [SV|EN]
  const last = bar.lastElementChild;
  if (last && last !== bar.firstElementChild) {
    const grp = document.createElement('div');
    grp.className = 'topbar-right';
    bar.insertBefore(grp, last);
    grp.appendChild(last);
    grp.appendChild(el);
  } else {
    bar.appendChild(el);
  }
  // Static texts marked in the HTML: <span data-sv="…" data-en="…">
  document.querySelectorAll('[data-en]').forEach((n) => { if (LANG === 'en') n.textContent = n.dataset.en; });
});

// ---------- Basics ----------
// Footer on every page: about/docs + where to report bugs
const PROJECT_DOCS = 'https://lyzio.github.io/SamMat/';
const PROJECT_ISSUES = 'https://github.com/lyzio/SamMat/issues';
document.addEventListener('DOMContentLoaded', () => {
  const host = document.querySelector('.wrap') || document.body;
  const info = document.createElement('div');
  info.className = 'foot foot-project';
  info.innerHTML = `<a href="${PROJECT_DOCS}" target="_blank" rel="noopener">${L('Om SamMat', 'About SamMat')}</a> · ` +
    `${L('Hittar du en bugg? <a href="' + PROJECT_ISSUES + '" target="_blank" rel="noopener">Rapportera den på GitHub</a>', 'Found a bug? <a href="' + PROJECT_ISSUES + '" target="_blank" rel="noopener">Report it on GitHub</a>')}`;
  const existing = host.querySelector(':scope > .foot');
  if (existing) existing.after(info); else host.appendChild(info);
});

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function api(url, method = 'GET', body) {
  const headers = { 'X-Lang': LANG };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(out.error || L('Något gick fel.', 'Something went wrong.'), res.status);
  return out;
}

// Wrap an async handler: errors become an alert instead of an unhandled rejection
const act = (fn) => async (...a) => { try { await fn(...a); } catch (e) { if (e.status !== 401) alert(e.message); } };

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
  }
  if (btn) { const old = btn.textContent; btn.textContent = L('Kopierat ✓', 'Copied ✓'); setTimeout(() => (btn.textContent = old), 1500); }
}

// Pin login card; calls onOk() after a successful login
function pinLogin(container, { title, hint, url, onOk }) {
  container.innerHTML = `
    <div class="card pin-card">
      <h1>${esc(title)}</h1>
      ${hint ? `<p class="muted">${hint}</p>` : ''}
      <form id="pinForm">
        <label for="pin">${L('PIN-kod', 'PIN code')}</label>
        <input id="pin" type="password" inputmode="numeric" autocomplete="off" required maxlength="20" class="pin-input" />
        <div id="pinErr"></div>
        <button type="submit" class="primary">${L('Logga in', 'Log in')}</button>
      </form>
    </div>`;
  const input = container.querySelector('#pin');
  input.focus();
  container.querySelector('#pinForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api(url, 'POST', { pin: input.value });
      onOk();
    } catch (ex) {
      container.querySelector('#pinErr').innerHTML = `<div class="error">${esc(ex.message)}</div>`;
      input.select();
    }
  };
}

// ---------- Dates and times (browser local time, language-aware) ----------
const hm = (iso) => new Date(iso).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });

// "om 23 min" / "in 1 h 5 min"
function until(iso) {
  const min = Math.round((Date.parse(iso) - Date.now()) / 60000);
  if (min <= 0) return L('nu', 'now');
  const t = min < 60 ? `${min} min` : `${Math.floor(min / 60)} h${min % 60 ? ' ' + (min % 60) + ' min' : ''}`;
  return L(`om ${t}`, `in ${t}`);
}

function timeToIso(hhmm) {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}
const isoToTime = (iso) => (iso ? hm(iso) : '');

const ymdLocal = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDaysYmd = (ymd, n) => { const d = new Date(ymd + 'T12:00:00'); d.setDate(d.getDate() + n); return ymdLocal(d); };
function dateTimeToIso(ymd, hhmm) {
  if (!ymd || !hhmm) return null;
  return new Date(`${ymd}T${hhmm}:00`).toISOString();
}
const isoToYmd = (iso) => (iso ? ymdLocal(new Date(iso)) : '');
// "torsdag 3 december" / "Thursday 3 December"
const dateLong = (ymd) => new Date(ymd + 'T12:00:00').toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' });
function dayWord(ymd) {
  const t = ymdLocal();
  if (ymd === t) return L('idag', 'today');
  if (ymd === addDaysYmd(t, 1)) return L('imorgon', 'tomorrow');
  return dateLong(ymd);
}
// "idag 11:30" / "ons 2 dec 16:00"
function whenShort(iso) {
  const d = new Date(iso);
  const ymd = ymdLocal(d);
  if (ymd === ymdLocal()) return `${L('idag', 'today')} ${hm(iso)}`;
  if (ymd === addDaysYmd(ymdLocal(), 1)) return `${L('imorgon', 'tomorrow')} ${hm(iso)}`;
  return d.toLocaleString(LOCALE, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function reminderPreset(kind, eventYmd, closeIso) {
  if (kind === 'daybefore') return dateTimeToIso(addDaysYmd(eventYmd, -1), '16:00');
  if (kind === 'morning') return dateTimeToIso(eventYmd, '08:00');
  if (kind === 'beforeclose' && closeIso) return new Date(Date.parse(closeIso) - 2 * 3600000).toISOString();
  return null;
}
const isoToLocal = (iso) => { if (!iso) return ''; const d = new Date(iso); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };

// ---------- Install as app (PWA) ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
let deferredInstall = null;
const installListeners = [];
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); // show our own button instead of the browser's mini-infobar
  deferredInstall = e;
  installListeners.forEach((fn) => fn());
});
window.addEventListener('appinstalled', () => { store.set('sammat_install_hidden', '1'); document.querySelectorAll('.install').forEach((x) => x.remove()); });

function installHint() {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const macSafari = !ios && /Macintosh/.test(ua) && /Safari/.test(ua) && !/Chrome|Chromium|Edg|Firefox/.test(ua);
  if (ios) return L('Tryck på <strong>Dela</strong> <span aria-hidden="true">⎙</span> och välj <strong>Lägg till på hemskärmen</strong>.',
    'Tap <strong>Share</strong> <span aria-hidden="true">⎙</span> and choose <strong>Add to Home Screen</strong>.');
  if (macSafari) return L('Välj <strong>Arkiv → Lägg till i Dock</strong> i menyn.', 'Choose <strong>File → Add to Dock</strong> in the menu.');
  return '';
}

function renderInstall(el) {
  if (!el) return;
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (standalone || store.get('sammat_install_hidden') === '1') { el.innerHTML = ''; return; }
  const draw = () => {
    const hint = deferredInstall ? '' : installHint();
    if (!deferredInstall && !hint) { el.innerHTML = ''; return; }
    el.innerHTML = `
      <div class="install">
        <img src="/img/icon-192.png" alt="" width="44" height="44" />
        <div class="install-text"><strong>${L('Spara SamMat som app', 'Save SamMat as an app')}</strong>
          <span>${deferredInstall ? L('Hamnar bland dina appar – snabbt att hitta nästa gång.', 'It sits with your apps – quick to find next time.') : hint}</span></div>
        ${deferredInstall ? `<button type="button" class="small" data-install>${L('Installera', 'Install')}</button>` : ''}
        <button type="button" class="install-x" data-install-hide title="${L('Visa inte igen', "Don't show again")}" aria-label="${L('Stäng', 'Close')}">✕</button>
      </div>`;
    const b = el.querySelector('[data-install]');
    if (b) b.onclick = async () => {
      deferredInstall.prompt();
      const { outcome } = await deferredInstall.userChoice;
      deferredInstall = null;
      if (outcome === 'accepted') store.set('sammat_install_hidden', '1');
      draw();
    };
    el.querySelector('[data-install-hide]').onclick = () => { store.set('sammat_install_hidden', '1'); el.innerHTML = ''; };
  };
  installListeners.push(draw);
  draw();
}

// ---------- My orders (edit links remembered in this browser, per round) ----------
const myOrders = {
  list: (slug) => { try { return JSON.parse(store.get('sammat_my_' + slug) || '[]'); } catch { return []; } },
  save: (slug, list) => store.set('sammat_my_' + slug, JSON.stringify(list.slice(-10))),
  add(slug, o) { this.save(slug, [...this.list(slug).filter((x) => x.token !== o.token), o]); },
  remove(slug, token) { this.save(slug, this.list(slug).filter((x) => x.token !== token)); }
};
