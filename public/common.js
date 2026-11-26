// Shared helpers for all Sammat pages
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function api(url, method = 'GET', body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(out.error || 'Något gick fel.', res.status);
  return out;
}

// Wrap an async handler: errors become an alert instead of an unhandled rejection
const act = (fn) => async (...a) => { try { await fn(...a); } catch (e) { if (e.status !== 401) alert(e.message); } };

const hm = (iso) => new Date(iso).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });

// "om 23 min" / "om 1 h 5 min"
function until(iso) {
  const min = Math.round((Date.parse(iso) - Date.now()) / 60000);
  if (min <= 0) return 'nu';
  if (min < 60) return `om ${min} min`;
  return `om ${Math.floor(min / 60)} h${min % 60 ? ' ' + (min % 60) + ' min' : ''}`;
}

// "HH:MM" from a <input type=time> -> ISO for today (local time); '' -> null
function timeToIso(hhmm) {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}
const isoToTime = (iso) => (iso ? hm(iso) : '');

const store = {
  get: (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } }
};

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
  }
  if (btn) { const old = btn.textContent; btn.textContent = 'Kopierat ✓'; setTimeout(() => (btn.textContent = old), 1500); }
}

// Pin login card; calls onOk() after a successful login
function pinLogin(container, { title, hint, url, onOk }) {
  container.innerHTML = `
    <div class="card pin-card">
      <h1>${esc(title)}</h1>
      ${hint ? `<p class="muted">${hint}</p>` : ''}
      <form id="pinForm">
        <label for="pin">PIN-kod</label>
        <input id="pin" type="password" inputmode="numeric" autocomplete="off" required maxlength="20" class="pin-input" />
        <div id="pinErr"></div>
        <button type="submit" class="primary">Logga in</button>
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

// ---------- Dates (v2.1) ----------
const ymdLocal = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDaysYmd = (ymd, n) => { const d = new Date(ymd + 'T12:00:00'); d.setDate(d.getDate() + n); return ymdLocal(d); };
// "2026-12-03" + "11:30" -> ISO (browser local time); missing time -> null
function dateTimeToIso(ymd, hhmm) {
  if (!ymd || !hhmm) return null;
  return new Date(`${ymd}T${hhmm}:00`).toISOString();
}
const isoToYmd = (iso) => (iso ? ymdLocal(new Date(iso)) : '');
// "torsdag 3 december"
const dateLong = (ymd) => new Date(ymd + 'T12:00:00').toLocaleDateString('sv-SE', { weekday: 'long', day: 'numeric', month: 'long' });
// "idag" / "imorgon" / "torsdag 3 december"
function dayWord(ymd) {
  const t = ymdLocal();
  if (ymd === t) return 'idag';
  if (ymd === addDaysYmd(t, 1)) return 'imorgon';
  return dateLong(ymd);
}
// "idag 11:30" / "ons 2 dec 16:00"
function whenShort(iso) {
  const d = new Date(iso);
  const ymd = ymdLocal(d);
  if (ymd === ymdLocal()) return `idag ${hm(iso)}`;
  if (ymd === addDaysYmd(ymdLocal(), 1)) return `imorgon ${hm(iso)}`;
  return d.toLocaleString('sv-SE', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
// Reminder presets relative to the round's date
function reminderPreset(kind, eventYmd, closeIso) {
  if (kind === 'daybefore') return dateTimeToIso(addDaysYmd(eventYmd, -1), '16:00');
  if (kind === 'morning') return dateTimeToIso(eventYmd, '08:00');
  if (kind === 'beforeclose' && closeIso) return new Date(Date.parse(closeIso) - 2 * 3600000).toISOString();
  return null;
}
// ISO -> value for <input type=datetime-local> in local time
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
  if (ios) return 'Tryck på <strong>Dela</strong> <span aria-hidden="true">⎙</span> och välj <strong>Lägg till på hemskärmen</strong>.';
  if (macSafari) return 'Välj <strong>Arkiv → Lägg till i Dock</strong> i menyn.';
  return '';
}

// Renders an "install as app" card into el, if the browser supports it and it isn't installed or dismissed
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
        <div class="install-text"><strong>Spara SamMat som app</strong>
          <span>${deferredInstall ? 'Hamnar bland dina appar – snabbt att hitta nästa gång.' : hint}</span></div>
        ${deferredInstall ? '<button type="button" class="small" data-install>Installera</button>' : ''}
        <button type="button" class="install-x" data-install-hide title="Visa inte igen" aria-label="Stäng">✕</button>
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
