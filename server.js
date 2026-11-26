// SamMat – sambeställning av mat med Swish
// Copyright (C) 2026 Oliver Sundström
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/lyzio/SamMat
'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const QRCode = require('qrcode');
const nodemailer = require('nodemailer');

// ---------- Config ----------
const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'sammat.db');
const ADMIN_PIN = String(process.env.ADMIN_PIN || process.env.ADMIN_PASSWORD || '').trim();
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, ''); // set this in production (links in mails)
const PURGE_DAYS = Number(process.env.PURGE_DAYS || 7); // rounds older than this are ended and deleted
const MAX_ACTIVE_ROUNDS = Number(process.env.MAX_ACTIVE_ROUNDS || 30);
const FAVORITE_DAYS = Number(process.env.FAVORITE_DAYS || 180); // "same as last time" is kept this long after the last order
const SESSION_HOURS = 24;

if (ADMIN_PIN.length < 4 || ADMIN_PIN === 'CHANGE_ME') {
  console.error('ADMIN_PIN saknas eller är kortare än 4 tecken. Sätt ADMIN_PIN=0042 (eller annat) i sammat.env.');
  process.exit(1);
}

// ---------- Mail ----------
const SMTP = {
  host: process.env.SMTP_HOST || '',
  port: Number(process.env.SMTP_PORT || 587),
  user: process.env.SMTP_USER || '',
  pass: process.env.SMTP_PASS || '',
  from: process.env.MAIL_FROM || ''
};
const mailConfigured = Boolean(SMTP.host && SMTP.user && SMTP.pass && SMTP.from && !SMTP.pass.startsWith('PASTE_'));
const transporter = mailConfigured
  ? nodemailer.createTransport({
      host: SMTP.host, port: SMTP.port, secure: SMTP.port === 465,
      auth: { user: SMTP.user, pass: SMTP.pass }, pool: true, maxConnections: 2, rateLimit: 10
    })
  : null;
console.log(mailConfigured ? `Mejl: ${SMTP.host}:${SMTP.port} som ${SMTP.from}` : 'Mejl: ej konfigurerat (SMTP_* / MAIL_FROM saknas)');

// Every mail gets the logo as an inline image (web fonts don't work reliably in mail clients)
const LOGO = { filename: 'sammat.png', path: path.join(__dirname, 'public', 'img', 'logo-mail.png'), cid: 'sammatlogo', contentDisposition: 'inline' };
function sendMail(opts) {
  return transporter.sendMail({ from: SMTP.from, ...opts, attachments: [LOGO, ...(opts.attachments || [])] });
}

// ---------- Database ----------
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');
db.pragma('secure_delete = ON'); // deleted orders/e-mails are overwritten in the file

// v1.x had one global round (active_session) and orders without round_id – drop those (ephemeral data).
const oldOrders = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='orders'").get();
if (oldOrders && !db.prepare('PRAGMA table_info(orders)').all().some((c) => c.name === 'round_id')) {
  db.exec('DROP TABLE orders; DROP TABLE IF EXISTS active_session;');
  console.log('Migrering: gamla beställningar (v1) raderade.');
}

db.exec(`
  CREATE TABLE IF NOT EXISTS places (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
  );
  CREATE TABLE IF NOT EXISTS menu_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    place_id INTEGER NOT NULL REFERENCES places(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    price INTEGER NOT NULL CHECK (price >= 0)
  );
  CREATE TABLE IF NOT EXISTS place_options (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    place_id INTEGER NOT NULL REFERENCES places(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('addon', 'removal')),
    name TEXT NOT NULL,
    price INTEGER NOT NULL DEFAULT 0 CHECK (price >= 0)
  );
  CREATE TABLE IF NOT EXISTS rounds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    pin TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    place_id INTEGER NOT NULL REFERENCES places(id),
    swish_number TEXT NOT NULL,
    creator_name TEXT NOT NULL DEFAULT '',
    creator_email TEXT NOT NULL DEFAULT '',
    food_eta TEXT NOT NULL DEFAULT '',      -- "HH:MM", shown only
    close_at TEXT,                          -- ISO, orders close automatically
    is_open INTEGER NOT NULL DEFAULT 1,
    mail_orders INTEGER NOT NULL DEFAULT 0, -- mail the order list to the creator when closed
    orders_mailed_at TEXT,
    next_nr INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    round_id INTEGER NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
    nr INTEGER NOT NULL,
    customer_name TEXT NOT NULL,
    email TEXT NOT NULL DEFAULT '',
    item_name TEXT NOT NULL,
    base_price INTEGER NOT NULL,
    addons_text TEXT NOT NULL DEFAULT '',
    removals_text TEXT NOT NULL DEFAULT '',
    total_price INTEGER NOT NULL,
    final_price INTEGER,
    paid INTEGER NOT NULL DEFAULT 0,
    pay_token TEXT NOT NULL UNIQUE,
    food_mail_at TEXT,
    pay_mail_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (round_id, nr)
  );
`);

// Columns added in v2.1 (dated rounds, reminders, confirm/cancel)
function addCols(table, cols) {
  const have = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  for (const [col, def] of cols) if (!have.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addCols('rounds', [
  ['event_date', 'TEXT'],          // YYYY-MM-DD the food is for
  ['reminder_at', 'TEXT'],         // ISO, reminder mail to everyone who ordered
  ['reminder_sent_at', 'TEXT'],
  ['confirm', 'INTEGER NOT NULL DEFAULT 0'], // reminder asks people to confirm or cancel
  ['pay_mode', "TEXT NOT NULL DEFAULT 'after'"] // 'after' = payment mail after the food, 'before' = Swish right after ordering
]);
addCols('orders', [['confirmed_at', 'TEXT'], ['cancelled_at', 'TEXT'], ['reminder_mail_at', 'TEXT']]);

// v2.2: shared cost, paid amounts, automatic payment reminder
addCols('rounds', [
  ['shared_cost', 'INTEGER NOT NULL DEFAULT 0'],       // e.g. delivery fee, split equally over active orders
  ['shared_label', "TEXT NOT NULL DEFAULT ''"],
  ['pay_remind_hours', 'INTEGER NOT NULL DEFAULT 0']   // 0 = off; else one reminder this many hours after the payment mail
]);
addCols('orders', [['paid_amount', 'INTEGER NOT NULL DEFAULT 0'], ['pay_remind_at', 'TEXT']]);
db.exec('UPDATE orders SET paid_amount = COALESCE(final_price, total_price) WHERE paid = 1 AND paid_amount = 0');

// v2.2: "same as last time" (opt-in) and settings (webhooks, hash salt)
db.exec(`
  CREATE TABLE IF NOT EXISTS favorites (
    email_hash TEXT NOT NULL,          -- HMAC of the e-mail, the address itself is not stored
    place_id INTEGER NOT NULL REFERENCES places(id) ON DELETE CASCADE,
    name_lc TEXT NOT NULL,             -- lookup needs name + e-mail
    item_name TEXT NOT NULL,
    addons TEXT NOT NULL DEFAULT '[]', -- JSON array of names
    removals TEXT NOT NULL DEFAULT '[]',
    custom TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (email_hash, place_id)
  );
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);
// v2.4: locations (offices/cities). A place belongs to one location, or none = shown everywhere.
db.exec('CREATE TABLE IF NOT EXISTS locations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE)');
addCols('places', [['location_id', 'INTEGER REFERENCES locations(id) ON DELETE SET NULL']]);
const listLocations = () => db.prepare('SELECT id, name FROM locations ORDER BY name COLLATE NOCASE').all();

// v2.5: companies (e.g. an office hotel). A round is for one company, or none = everyone in the building.
db.exec('CREATE TABLE IF NOT EXISTS companies (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE)');
addCols('rounds', [['company_id', 'INTEGER REFERENCES companies(id) ON DELETE SET NULL']]);
const listCompanies = () => db.prepare('SELECT id, name FROM companies ORDER BY name COLLATE NOCASE').all();
const companyIdOr = (v) => { const id = v ? toInt(v) : null; return id && db.prepare('SELECT 1 FROM companies WHERE id = ?').get(id) ? id : null; };

const getSetting = (k, d = null) => { const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k); return r ? r.value : d; };
const setSetting = (k, v) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);
if (!getSetting('hash_salt')) setSetting('hash_salt', crypto.randomBytes(32).toString('hex'));
const emailHash = (email) => crypto.createHmac('sha256', getSetting('hash_salt')).update(String(email).trim().toLowerCase()).digest('hex');
db.exec("UPDATE rounds SET event_date = substr(created_at, 1, 10) WHERE event_date IS NULL");

// ---------- Helpers ----------
const clean = (v, max = 80) => String(v ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);
const toInt = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : NaN; };
const isEmail = (s) => /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(s);
const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// ---------- Money ----------
// Shared cost (e.g. delivery) split equally over active orders in whole kronor; the first orders take the remainder.
function sharesFor(roundId) {
  const r = db.prepare('SELECT shared_cost FROM rounds WHERE id = ?').get(roundId);
  const active = db.prepare('SELECT id FROM orders WHERE round_id = ? AND cancelled_at IS NULL ORDER BY nr').all(roundId);
  const m = new Map();
  const cost = r ? r.shared_cost : 0;
  if (!cost || !active.length) return m;
  const base = Math.floor(cost / active.length);
  let rest = cost - base * active.length;
  for (const { id } of active) { m.set(id, base + (rest > 0 ? 1 : 0)); if (rest > 0) rest -= 1; }
  return m;
}
// food = menu or receipt price; owed = food + share; outstanding = owed - already paid
function money(o, shares) {
  const food = o.final_price ?? o.total_price;
  const share = o.cancelled_at ? 0 : (shares.get(o.id) || 0);
  const owed = o.cancelled_at ? 0 : food + share;
  const paid = o.paid_amount || 0;
  return { food, share, owed, paid, outstanding: Math.max(0, owed - paid), isPaid: owed > 0 && paid >= owed };
}
const orderText = (o) => [o.item_name, o.addons_text, o.removals_text].filter(Boolean).join(' - ');
const orderLine = (o) => `#${o.nr} (${o.customer_name}) ${orderText(o)}`;
const swishDigits = (n) => String(n).replace(/\D/g, '');
const cleanSwish = (v) => clean(v, 20).replace(/[^\d+ ]/g, '').trim();
const cleanEta = (v) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || '')) ? String(v) : '');
const newToken = (bytes = 16) => crypto.randomBytes(bytes).toString('hex');
const newPin = () => String(crypto.randomInt(0, 10000)).padStart(4, '0');
const SLUG_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
const newSlug = () => Array.from({ length: 6 }, () => SLUG_CHARS[crypto.randomInt(0, SLUG_CHARS.length)]).join('');
const roundTitle = (r) => r.name || r.place_name;
const timeSv = (iso) => new Date(iso).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Stockholm' });

const MAX_DAYS_AHEAD = 60;
const TZ = 'Europe/Stockholm';
const todayStr = () => new Date().toLocaleDateString('sv-SE', { timeZone: TZ }); // YYYY-MM-DD
const addDays = (ymd, n) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dateSv = (ymd) => new Date(ymd + 'T12:00:00Z').toLocaleDateString('sv-SE', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const dayTimeSv = (iso) => new Date(iso).toLocaleString('sv-SE', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: TZ });

// A future point in time (ISO from the browser), at most MAX_DAYS_AHEAD (+1) away
function parseFuture(v, label) {
  if (v === null || v === undefined || v === '') return { value: null };
  const t = Date.parse(v);
  if (Number.isNaN(t)) return { error: `Ogiltig ${label}.` };
  if (t < Date.now() - 60000) return { error: `${label[0].toUpperCase() + label.slice(1)} har redan passerat.` };
  if (t > Date.now() + (MAX_DAYS_AHEAD + 1) * 86400000) return { error: `${label[0].toUpperCase() + label.slice(1)} ligger för långt fram.` };
  return { value: new Date(t).toISOString() };
}
const parseCloseAt = (v) => parseFuture(v, 'stopptid');

function parseEventDate(v) {
  if (!v) return { value: todayStr() };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) return { error: 'Ogiltigt datum.' };
  if (v < todayStr()) return { error: 'Datumet har redan passerat.' };
  if (v > addDays(todayStr(), MAX_DAYS_AHEAD)) return { error: `Max ${MAX_DAYS_AHEAD} dagar fram.` };
  return { value: String(v) };
}

// Swish messages allow a limited character set (max 50). ';' would also break the QR string.
function swishMessage(text) {
  return String(text).replace(/[^0-9A-Za-zÅÄÖåäöÉéÜü .,:!?()\-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 50);
}

function swishFor(order, round, amount) {
  const message = swishMessage(`${round.place_name} - ${order.customer_name}`);
  const payee = swishDigits(round.swish_number);
  return {
    message, amount,
    qrText: `C${payee};${amount};${message};0`, // 0 = nothing editable
    appUrl: 'swish://payment?data=' + encodeURIComponent(JSON.stringify({
      version: 1, payee: { value: payee }, amount: { value: amount }, message: { value: message, editable: false }
    }))
  };
}

const ROUND_SELECT = `SELECT r.*, p.name AS place_name, p.location_id, l.name AS location_name, co.name AS company_name
  FROM rounds r JOIN places p ON p.id = r.place_id LEFT JOIN locations l ON l.id = p.location_id
  LEFT JOIN companies co ON co.id = r.company_id`;
const getRoundBySlug = (slug) => db.prepare(`${ROUND_SELECT} WHERE r.slug = ?`).get(clean(slug, 12).toLowerCase());
const getRoundById = (id) => db.prepare(`${ROUND_SELECT} WHERE r.id = ?`).get(id);
const ordersOf = (roundId) => db.prepare('SELECT * FROM orders WHERE round_id = ? AND cancelled_at IS NULL ORDER BY nr').all(roundId);
const allOrdersOf = (roundId) => db.prepare('SELECT * FROM orders WHERE round_id = ? ORDER BY nr').all(roundId);

function menuFor(placeId) {
  const options = db.prepare('SELECT id, kind, name, price FROM place_options WHERE place_id = ? ORDER BY id').all(placeId);
  return {
    menu: db.prepare('SELECT id, name, price FROM menu_items WHERE place_id = ? ORDER BY name COLLATE NOCASE').all(placeId),
    addons: options.filter((o) => o.kind === 'addon'),
    removals: options.filter((o) => o.kind === 'removal')
  };
}

// Public view of a round (no PIN, no Swish number)
function publicRound(r) {
  return {
    slug: r.slug,
    title: roundTitle(r),
    name: r.name,
    placeName: r.place_name,
    locationId: r.location_id ?? null,
    locationName: r.location_name || '',
    companyId: r.company_id ?? null,
    companyName: r.company_name || '',
    creatorName: r.creator_name,
    eventDate: r.event_date,
    isToday: r.event_date === todayStr(),
    foodEta: r.food_eta,
    closeAt: r.close_at,
    isOpen: Boolean(r.is_open),
    reminderAt: r.reminder_at,
    reminderSentAt: r.reminder_sent_at,
    confirm: Boolean(r.confirm),
    payMode: r.pay_mode === 'before' ? 'before' : 'after',
    sharedCost: r.shared_cost,
    sharedLabel: r.shared_label,
    orderCount: db.prepare('SELECT COUNT(*) AS n FROM orders WHERE round_id = ? AND cancelled_at IS NULL').get(r.id).n,
    createdAt: r.created_at
  };
}

// Full view for whoever manages the round
function manageRound(r) {
  return {
    ...publicRound(r),
    id: r.id,
    pin: r.pin,
    placeId: r.place_id,
    swishNumber: r.swish_number,
    creatorEmail: r.creator_email,
    mailOrders: Boolean(r.mail_orders),
    payRemindHours: r.pay_remind_hours,
    ordersMailedAt: r.orders_mailed_at,
    link: `${PUBLIC_URL}/r/${r.slug}`,
    manageLink: `${PUBLIC_URL}/r/${r.slug}/admin`
  };
}

// Delete a round and all its orders (names, e-mails, prices)
function endRound(id) {
  db.transaction(() => {
    db.prepare('DELETE FROM orders WHERE round_id = ?').run(id);
    db.prepare('DELETE FROM rounds WHERE id = ?').run(id);
  })();
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (e) { console.error('checkpoint:', e.message); }
}

// ---------- App ----------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback'); // Caddy on the host
app.use(express.json({ limit: '20kb' }));

// ---------- Auth: one cookie, server-side scopes ('admin' and/or 'round:<id>') ----------
const sessions = new Map(); // token -> { exp, scopes:Set }
const ipFails = new Map(); // ip -> { count, until }
const roundFails = new Map(); // roundId -> { count, until }
const COOKIE = 'sammat_auth';

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > -1) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore */ } }
  }
  return out;
}

function getSession(req) {
  const t = parseCookies(req)[COOKIE];
  const s = t && sessions.get(t);
  if (!s) return null;
  if (s.exp < Date.now()) { sessions.delete(t); return null; }
  return s;
}

function grant(req, res, scope) {
  let token = parseCookies(req)[COOKIE];
  let s = token && sessions.get(token);
  if (!s || s.exp < Date.now()) {
    token = newToken(32);
    s = { exp: 0, scopes: new Set() };
    sessions.set(token, s);
  }
  s.scopes.add(scope);
  s.exp = Date.now() + SESSION_HOURS * 3600 * 1000;
  res.cookie(COOKIE, token, {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_HOURS * 3600 * 1000, path: '/'
  });
}

const isAdmin = (req) => Boolean(getSession(req)?.scopes.has('admin'));
const canManage = (req, r) => { const s = getSession(req); return Boolean(s && (s.scopes.has('admin') || s.scopes.has(`round:${r.id}`))); };

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Logga in med admin-PIN.' });
  next();
}

// Loads req.round from :slug and checks access
function requireRound(req, res, next) {
  const r = getRoundBySlug(req.params.slug);
  if (!r) return res.status(404).json({ error: 'Sambeställningen finns inte (längre).' });
  if (!canManage(req, r)) return res.status(401).json({ error: 'Ange rundans PIN-kod.' });
  req.round = r;
  next();
}

const safeEqual = (a, b) => crypto.timingSafeEqual(
  crypto.createHash('sha256').update(String(a)).digest(),
  crypto.createHash('sha256').update(String(b)).digest()
);
const locked = (map, key) => { const f = map.get(key); return f && f.until > Date.now() && f.count >= f.max; };
function fail(map, key, max) {
  const f = map.get(key);
  const cur = f && f.until > Date.now() ? f : { count: 0, until: Date.now() + 15 * 60 * 1000, max };
  cur.count += 1;
  map.set(key, cur);
}

// Checks a PIN with lockout per IP (10 tries / 15 min) and per round (20 tries / 15 min)
function pinOk(req, res, expected, roundId) {
  if (locked(ipFails, req.ip) || (roundId && locked(roundFails, roundId))) {
    res.status(429).json({ error: 'För många felaktiga försök. Vänta 15 minuter.' });
    return false;
  }
  if (!safeEqual(clean(req.body.pin, 20), expected)) {
    fail(ipFails, req.ip, 10);
    if (roundId) fail(roundFails, roundId, 20);
    res.status(401).json({ error: 'Fel PIN-kod.' });
    return false;
  }
  ipFails.delete(req.ip);
  return true;
}

app.get('/healthz', (req, res) => res.type('text').send('ok'));

app.get('/api/auth', (req, res) => {
  const s = getSession(req);
  res.json({ admin: Boolean(s?.scopes.has('admin')) });
});

app.post('/api/logout', (req, res) => {
  const t = parseCookies(req)[COOKIE];
  if (t) sessions.delete(t);
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

// ---------- Pages ----------
const page = (file) => (req, res) => res.sendFile(path.join(__dirname, 'public', file));
app.get('/admin', page('admin.html'));
app.get('/ny', page('new.html'));
app.get('/r/:slug', page('round.html'));
app.get('/r/:slug/admin', page('manage.html'));
app.get('/pay/:token', page('pay.html'));
app.get('/svar/:token', page('svar.html'));
app.get('/integritet', page('integritet.html'));
app.use('/fonts', express.static(path.join(__dirname, 'node_modules', '@fontsource'), { maxAge: '30d', immutable: true }));
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

// ---------- Public API ----------
app.get('/api/places', (req, res) => {
  res.json(db.prepare(`
    SELECT p.id, p.name, p.location_id AS locationId, l.name AS locationName,
           (SELECT COUNT(*) FROM menu_items m WHERE m.place_id = p.id) AS items
    FROM places p LEFT JOIN locations l ON l.id = p.location_id ORDER BY p.name COLLATE NOCASE
  `).all().filter((p) => p.items > 0));
});

app.get('/api/rounds', (req, res) => {
  const rounds = db.prepare(`${ROUND_SELECT} ORDER BY r.event_date, r.is_open DESC, r.created_at DESC`).all();
  res.json({ mailConfigured, locations: listLocations(), companies: listCompanies(), rounds: rounds.map(publicRound) });
});

const createLog = new Map(); // ip -> [timestamps]
app.post('/api/rounds', async (req, res) => {
  const now = Date.now();
  const recent = (createLog.get(req.ip) || []).filter((t) => t > now - 3600000);
  if (recent.length >= 5) return res.status(429).json({ error: 'Du har startat många rundor den senaste timmen. Vänta lite.' });
  if (db.prepare('SELECT COUNT(*) AS n FROM rounds').get().n >= MAX_ACTIVE_ROUNDS) {
    return res.status(429).json({ error: 'För många aktiva rundor just nu.' });
  }

  const placeId = toInt(req.body.placeId);
  const place = db.prepare('SELECT id FROM places WHERE id = ?').get(placeId);
  const name = clean(req.body.name, 50);
  const creatorName = clean(req.body.creatorName, 40);
  const creatorEmail = clean(req.body.creatorEmail, 120).toLowerCase();
  const swishNumber = cleanSwish(req.body.swishNumber);
  const foodEta = cleanEta(req.body.foodEta);
  const close = parseCloseAt(req.body.closeAt);
  const mailOrders = Boolean(req.body.mailOrders);
  const eventDate = parseEventDate(req.body.eventDate);
  const reminder = parseFuture(req.body.reminderAt, 'påminnelsetid');
  const confirm = Boolean(req.body.confirm) && Boolean(reminder.value);
  const payMode = req.body.payMode === 'before' ? 'before' : 'after';
  const companyId = companyIdOr(req.body.companyId);
  const sharedCost = Math.max(0, Math.min(100000, toInt(req.body.sharedCost) || 0));
  const sharedLabel = clean(req.body.sharedLabel, 40);
  const payRemindHours = [0, 2, 4, 24, 48].includes(toInt(req.body.payRemindHours)) ? toInt(req.body.payRemindHours) : 0;

  if (!place) return res.status(400).json({ error: 'Välj ett ställe.' });
  if (!creatorName) return res.status(400).json({ error: 'Ange ditt namn.' });
  if (swishDigits(swishNumber).length < 8) return res.status(400).json({ error: 'Ange ditt Swish-nummer.' });
  if (creatorEmail && !isEmail(creatorEmail)) return res.status(400).json({ error: 'Ogiltig e-postadress.' });
  if (mailOrders && !creatorEmail) return res.status(400).json({ error: 'Ange din e-post för att få orderlistan mejlad.' });
  if (close.error) return res.status(400).json({ error: close.error });
  if (eventDate.error) return res.status(400).json({ error: eventDate.error });
  if (reminder.error) return res.status(400).json({ error: reminder.error });
  if (reminder.value && !mailConfigured) return res.status(400).json({ error: 'Mejl är inte konfigurerat – påminnelser går inte att skicka.' });

  let slug;
  do { slug = newSlug(); } while (db.prepare('SELECT 1 FROM rounds WHERE slug = ?').get(slug));
  const pin = newPin();
  const info = db.prepare(`
    INSERT INTO rounds (slug, pin, name, place_id, swish_number, creator_name, creator_email, food_eta, close_at, mail_orders,
                        event_date, reminder_at, confirm, pay_mode, shared_cost, shared_label, pay_remind_hours, company_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(slug, pin, name, placeId, swishNumber, creatorName, creatorEmail, foodEta, close.value, mailOrders ? 1 : 0,
    eventDate.value, reminder.value, confirm ? 1 : 0, payMode, sharedCost, sharedLabel, payRemindHours, companyId, new Date().toISOString());
  recent.push(now);
  createLog.set(req.ip, recent);

  const r = getRoundById(Number(info.lastInsertRowid));
  grant(req, res, `round:${r.id}`);
  emit('round.created', r);
  if (creatorEmail && mailConfigured) {
    const m = createdMail(r);
    sendMail({ to: creatorEmail, ...m }).catch((e) => console.error('Startmejl:', e.message));
  }
  res.status(201).json(manageRound(r));
});

app.get('/api/rounds/:slug', (req, res) => {
  const r = getRoundBySlug(req.params.slug);
  if (!r) return res.status(404).json({ error: 'Sambeställningen finns inte (längre).' });
  // "board": name + dish only, for the sticky notes behind the form (no e-mail, no price)
  const board = db.prepare('SELECT nr, customer_name AS name, item_name AS item FROM orders WHERE round_id = ? AND cancelled_at IS NULL ORDER BY nr').all(r.id);
  res.json({ ...publicRound(r), ...menuFor(r.place_id), board, canManage: canManage(req, r) });
});

app.post('/api/rounds/:slug/orders', (req, res) => {
  const r = getRoundBySlug(req.params.slug);
  if (!r) return res.status(404).json({ error: 'Sambeställningen finns inte (längre).' });
  if (!r.is_open) return res.status(400).json({ error: 'Beställningen är stängd.' });

  const { menu, addons: allAddons, removals: allRemovals } = menuFor(r.place_id);
  const customerName = clean(req.body.customerName, 40);
  const email = clean(req.body.email, 120).toLowerCase();
  const menuItemId = toInt(req.body.menuItemId);
  const addonIds = Array.isArray(req.body.addonIds) ? req.body.addonIds.map(toInt) : [];
  const removalIds = Array.isArray(req.body.removalIds) ? req.body.removalIds.map(toInt) : [];
  const customRemoval = clean(req.body.customRemoval, 120);

  if (!customerName) return res.status(400).json({ error: 'Ange ditt namn.' });
  if (!isEmail(email)) return res.status(400).json({ error: 'Ange en giltig e-postadress.' });
  const item = menu.find((m) => m.id === menuItemId);
  if (!item) return res.status(400).json({ error: 'Välj en produkt.' });

  const addons = allAddons.filter((a) => addonIds.includes(a.id));
  const removals = allRemovals.filter((x) => removalIds.includes(x.id));
  const totalPrice = item.price + addons.reduce((s, a) => s + a.price, 0);
  const addonsText = addons.map((a) => a.name).join(', ');
  const removalsText = [...removals.map((x) => x.name), ...(customRemoval ? [customRemoval] : [])].join(', ');

  // Number per round, never reused (a deleted #3 stays a gap)
  const payToken = newToken();
  db.transaction(() => {
    const { next_nr: nr } = db.prepare('SELECT next_nr FROM rounds WHERE id = ?').get(r.id);
    db.prepare('UPDATE rounds SET next_nr = next_nr + 1 WHERE id = ?').run(r.id);
    db.prepare(`
      INSERT INTO orders (round_id, nr, customer_name, email, item_name, base_price, addons_text, removals_text, total_price, pay_token,
                          confirmed_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(r.id, nr, customerName, email, item.name, item.price, addonsText, removalsText, totalPrice, payToken,
      r.reminder_sent_at ? new Date().toISOString() : null, new Date().toISOString());
  })();

  // "Same as last time": opt-in, keyed on e-mail (hashed) + place, needs the name too when read back
  const ek = emailHash(email);
  if (req.body.remember) {
    db.prepare(`
      INSERT INTO favorites (email_hash, place_id, name_lc, item_name, addons, removals, custom, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(email_hash, place_id) DO UPDATE SET name_lc = excluded.name_lc, item_name = excluded.item_name,
        addons = excluded.addons, removals = excluded.removals, custom = excluded.custom, updated_at = excluded.updated_at
    `).run(ek, r.place_id, customerName.toLowerCase(), item.name, JSON.stringify(addons.map((a) => a.name)),
      JSON.stringify(removals.map((x) => x.name)), customRemoval, new Date().toISOString());
  } else {
    db.prepare('DELETE FROM favorites WHERE email_hash = ? AND place_id = ?').run(ek, r.place_id);
  }

  // Pay before: the order page shows Swish right away, and the same payment info is mailed
  if (r.pay_mode === 'before' && mailConfigured) {
    const o = db.prepare('SELECT * FROM orders WHERE pay_token = ?').get(payToken);
    payMail(o, r, '')
      .then((m) => sendMail({ to: o.email, subject: m.subject, text: m.text, html: m.html, attachments: m.attachments }))
      .then(() => db.prepare('UPDATE orders SET pay_mail_at = ? WHERE id = ?').run(new Date().toISOString(), o.id))
      .catch((e) => console.error(`Betalmejl #${o.nr}:`, e.message));
  }

  res.status(201).json({
    payMode: r.pay_mode, payToken: r.pay_mode === 'before' ? payToken : undefined, mailConfigured,
    customerName, email, title: roundTitle(r), foodEta: r.food_eta, eventDate: r.event_date, isToday: r.event_date === todayStr(),
    reminderAt: r.reminder_sent_at ? null : r.reminder_at, confirm: Boolean(r.confirm), itemName: item.name, addonsText, removalsText, totalPrice
  });
});

// "Same as last time" – needs e-mail AND name, mapped onto the place's current menu
app.post('/api/rounds/:slug/last', (req, res) => {
  const r = getRoundBySlug(req.params.slug);
  if (!r) return res.status(404).json({ error: 'Sambeställningen finns inte (längre).' });
  const email = clean(req.body.email, 120).toLowerCase();
  const name = clean(req.body.name, 40).toLowerCase();
  if (!isEmail(email) || !name) return res.json({ found: false });
  const f = db.prepare('SELECT * FROM favorites WHERE email_hash = ? AND place_id = ? AND name_lc = ?').get(emailHash(email), r.place_id, name);
  if (!f) return res.json({ found: false });
  const { menu, addons, removals } = menuFor(r.place_id);
  const item = menu.find((m) => m.name === f.item_name);
  if (!item) return res.json({ found: false });
  const pick = (list, names) => list.filter((x) => JSON.parse(names).includes(x.name)).map((x) => x.id);
  res.json({
    found: true, itemName: f.item_name, menuItemId: item.id,
    addonIds: pick(addons, f.addons), removalIds: pick(removals, f.removals), custom: f.custom, updatedAt: f.updated_at,
    label: [f.item_name, JSON.parse(f.addons).join(', '), [...JSON.parse(f.removals), ...(f.custom ? [f.custom] : [])].join(', ')].filter(Boolean).join(' - ')
  });
});

// Forget everything remembered for an e-mail (all places)
app.post('/api/forget', (req, res) => {
  const email = clean(req.body.email, 120).toLowerCase();
  if (!isEmail(email)) return res.status(400).json({ error: 'Ange en giltig e-postadress.' });
  const info = db.prepare('DELETE FROM favorites WHERE email_hash = ?').run(emailHash(email));
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }
  res.json({ ok: true, removed: info.changes });
});

app.get('/api/info', (req, res) => res.json({ favoriteDays: FAVORITE_DAYS, purgeDays: PURGE_DAYS, mailConfigured }));

// Payment page data (link from the payment mail)
app.get('/api/pay/:token', async (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE pay_token = ?').get(clean(req.params.token, 64));
  const r = o && getRoundById(o.round_id);
  if (!o || !r) return res.status(404).json({ error: 'Betalningen hittades inte. Rundan kan vara avslutad.' });
  const mo = money(o, sharesFor(r.id));
  const sw = swishFor(o, r, mo.outstanding);
  let qrSvg = '';
  try { qrSvg = await QRCode.toString(sw.qrText, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }); } catch { /* ignore */ }
  res.json({
    orderNumber: o.nr, customerName: o.customer_name, placeName: r.place_name, title: roundTitle(r),
    orderText: orderText(o), amount: sw.amount, estimated: o.total_price, paid: mo.isPaid || o.cancelled_at != null,
    food: mo.food, share: mo.share, sharedLabel: r.shared_label, alreadyPaid: mo.paid, owed: mo.owed,
    swishNumber: r.swish_number, swishMessage: sw.message, swishAppUrl: sw.appUrl, qrSvg
  });
});

// Confirm / cancel page (link in the reminder). GET only reads; the change needs a POST from the page,
// so mail scanners that open links can't confirm or cancel anyone.
function answerView(o, r) {
  return {
    orderNumber: o.nr, customerName: o.customer_name, title: roundTitle(r), placeName: r.place_name,
    eventDate: r.event_date, foodEta: r.food_eta, orderText: orderText(o),
    confirmed: Boolean(o.confirmed_at), cancelled: Boolean(o.cancelled_at), canChange: Boolean(r.is_open),
    creatorName: r.creator_name, roundLink: `/r/${r.slug}`, payMode: r.pay_mode, paid: (o.paid_amount || 0) > 0
  };
}
app.get('/api/answer/:token', (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE pay_token = ?').get(clean(req.params.token, 64));
  const r = o && getRoundById(o.round_id);
  if (!o || !r) return res.status(404).json({ error: 'Beställningen hittades inte. Rundan kan vara avslutad.' });
  res.json(answerView(o, r));
});
app.post('/api/answer/:token', (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE pay_token = ?').get(clean(req.params.token, 64));
  const r = o && getRoundById(o.round_id);
  if (!o || !r) return res.status(404).json({ error: 'Beställningen hittades inte. Rundan kan vara avslutad.' });
  if (!r.is_open) return res.status(400).json({ error: `Beställningen är redan stängd – kontakta ${r.creator_name}.` });
  const now = new Date().toISOString();
  if (req.body.answer === 'yes') db.prepare('UPDATE orders SET confirmed_at = ?, cancelled_at = NULL WHERE id = ?').run(now, o.id);
  else if (req.body.answer === 'no') db.prepare('UPDATE orders SET cancelled_at = ?, confirmed_at = NULL WHERE id = ?').run(now, o.id);
  else return res.status(400).json({ error: 'Okänt svar.' });
  res.json(answerView(db.prepare('SELECT * FROM orders WHERE id = ?').get(o.id), r));
});

// ---------- Round management (round PIN or site admin) ----------
app.post('/api/rounds/:slug/login', (req, res) => {
  const r = getRoundBySlug(req.params.slug);
  if (!r) return res.status(404).json({ error: 'Sambeställningen finns inte (längre).' });
  if (!pinOk(req, res, r.pin, r.id)) return;
  roundFails.delete(r.id);
  grant(req, res, `round:${r.id}`);
  res.json({ ok: true });
});

app.get('/api/rounds/:slug/manage', requireRound, (req, res) => {
  res.json({
    mailConfigured,
    round: manageRound(req.round),
    orders: (() => { const sh = sharesFor(req.round.id); return allOrdersOf(req.round.id).map((o) => ({ ...money(o, sh),
      order_number: o.nr, customer_name: o.customer_name, email: o.email, item_name: o.item_name,
      addons_text: o.addons_text, removals_text: o.removals_text, total_price: o.total_price,
      final_price: o.final_price, paid_amount: o.paid_amount, food_mail_at: o.food_mail_at, pay_mail_at: o.pay_mail_at, created_at: o.created_at,
      confirmed_at: o.confirmed_at, cancelled_at: o.cancelled_at, reminder_mail_at: o.reminder_mail_at, pay_remind_at: o.pay_remind_at
    })); })()
  });
});

app.patch('/api/rounds/:slug', requireRound, (req, res) => {
  const r = req.round;
  const b = req.body;
  const set = {};
  if ('name' in b) set.name = clean(b.name, 50);
  if ('swishNumber' in b) {
    const n = cleanSwish(b.swishNumber);
    if (swishDigits(n).length < 8) return res.status(400).json({ error: 'Ange ett giltigt Swish-nummer.' });
    set.swish_number = n;
  }
  if ('foodEta' in b) set.food_eta = cleanEta(b.foodEta);
  if ('closeAt' in b && !(b.closeAt && r.close_at && Date.parse(b.closeAt) === Date.parse(r.close_at))) {
    const c = parseCloseAt(b.closeAt);
    if (c.error) return res.status(400).json({ error: c.error });
    set.close_at = c.value;
  }
  if ('creatorEmail' in b) {
    const e = clean(b.creatorEmail, 120).toLowerCase();
    if (e && !isEmail(e)) return res.status(400).json({ error: 'Ogiltig e-postadress.' });
    set.creator_email = e;
  }
  if ('mailOrders' in b) set.mail_orders = b.mailOrders ? 1 : 0;
  if ('eventDate' in b && b.eventDate !== r.event_date) {
    const d = parseEventDate(b.eventDate);
    if (d.error) return res.status(400).json({ error: d.error });
    set.event_date = d.value;
  }
  if ('reminderAt' in b) {
    const same = b.reminderAt && r.reminder_at && Date.parse(b.reminderAt) === Date.parse(r.reminder_at);
    if (!same) {
      const m = parseFuture(b.reminderAt, 'påminnelsetid');
      if (m.error) return res.status(400).json({ error: m.error });
      set.reminder_at = m.value;
      set.reminder_sent_at = null; // a new time means it goes out again
    }
  }
  if ('confirm' in b) set.confirm = b.confirm ? 1 : 0;
  if ('payMode' in b) set.pay_mode = b.payMode === 'before' ? 'before' : 'after';
  if ('companyId' in b) set.company_id = companyIdOr(b.companyId);
  if ('sharedCost' in b) set.shared_cost = Math.max(0, Math.min(100000, toInt(b.sharedCost) || 0));
  if ('sharedLabel' in b) set.shared_label = clean(b.sharedLabel, 40);
  if ('payRemindHours' in b) set.pay_remind_hours = [0, 2, 4, 24, 48].includes(toInt(b.payRemindHours)) ? toInt(b.payRemindHours) : 0;
  if ('isOpen' in b) {
    set.is_open = b.isOpen ? 1 : 0;
    if (b.isOpen && r.close_at && Date.parse(r.close_at) <= Date.now() && !('closeAt' in b)) set.close_at = null; // reopened after auto close
  }
  const mailFlag = 'mailOrders' in b ? set.mail_orders : r.mail_orders;
  const mailTo = 'creatorEmail' in b ? set.creator_email : r.creator_email;
  if (mailFlag && !mailTo) return res.status(400).json({ error: 'Ange e-post för att få orderlistan mejlad.' });

  const keys = Object.keys(set);
  if (keys.length) {
    db.prepare(`UPDATE rounds SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => set[k]), r.id);
  }
  const updated = getRoundById(r.id);
  if (r.is_open && !updated.is_open) { onClosed(updated).catch(() => {}); emit('round.closed', updated); }
  res.json({ ok: true, round: manageRound(updated) });
});

app.post('/api/rounds/:slug/end', requireRound, (req, res) => {
  endRound(req.round.id);
  res.json({ ok: true });
});

const findOrder = (r, nr) => db.prepare('SELECT * FROM orders WHERE round_id = ? AND nr = ?').get(r.id, toInt(nr));

app.patch('/api/rounds/:slug/orders/:nr/paid', requireRound, (req, res) => {
  // Ticking "Swishat" records what they owe right now; a later shared cost or price change leaves a remainder
  const o = findOrder(req.round, req.params.nr);
  if (!o) return res.status(404).json({ error: 'Beställningen finns inte.' });
  const owed = money(o, sharesFor(req.round.id)).owed;
  db.prepare('UPDATE orders SET paid_amount = ?, paid = ? WHERE id = ?').run(req.body.paid ? owed : 0, req.body.paid ? 1 : 0, o.id);
  res.json({ ok: true });
});

// Actual price from the receipt. Empty / null = back to the menu price.
app.patch('/api/rounds/:slug/orders/:nr/price', requireRound, (req, res) => {
  const raw = req.body.price;
  const price = raw === null || raw === '' || raw === undefined ? null : toInt(raw);
  if (price !== null && (Number.isNaN(price) || price < 0 || price > 100000)) return res.status(400).json({ error: 'Ogiltigt pris.' });
  db.prepare('UPDATE orders SET final_price = ? WHERE round_id = ? AND nr = ?').run(price, req.round.id, toInt(req.params.nr));
  res.json({ ok: true });
});

app.patch('/api/rounds/:slug/orders/:nr/restore', requireRound, (req, res) => {
  db.prepare('UPDATE orders SET cancelled_at = NULL WHERE round_id = ? AND nr = ?').run(req.round.id, toInt(req.params.nr));
  res.json({ ok: true });
});

app.delete('/api/rounds/:slug/orders/:nr', requireRound, (req, res) => {
  db.prepare('DELETE FROM orders WHERE round_id = ? AND nr = ?').run(req.round.id, toInt(req.params.nr));
  res.json({ ok: true });
});

// ---------- Mail templates: plain white, logo image, just the facts ----------
const FONT = "'Nunito Sans',Helvetica,Arial,sans-serif";
const SLAB = "Bitter,Rockwell,Georgia,'Times New Roman',serif";

function mailLayout(bodyHtml) {
  return `<!doctype html><html lang="sv"><head><meta charset="utf-8"><meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:0;background:#ffffff;color:#1e272e;font-family:${FONT};font-size:15px;line-height:1.5">
  <div style="max-width:480px;margin:0 auto;padding:28px 20px">
    <div style="margin-bottom:20px"><img src="cid:sammatlogo" width="122" height="36" alt="SamMat"
      style="display:block;border:0;width:122px;height:36px;font-family:Impact,'Arial Black',sans-serif;font-size:26px;color:#f53b57"></div>
    ${bodyHtml}
    <div style="margin-top:28px;padding-top:12px;border-top:1px solid #e6e8eb;color:#8a929b;font-size:12px">
      ${escHtml(PUBLIC_URL.replace(/^https?:\/\//, ''))}
    </div>
  </div>
</body></html>`;
}

const box = (inner) => `<div style="margin:14px 0;padding:10px 14px;border-left:3px solid #f53b57;background:#f7f8f9">${inner}</div>`;
const orderBox = (o) => box(`<strong>#${o.nr}</strong> ${escHtml(orderText(o))}`);
const extraHtml = (extra) => (extra ? `<p style="margin:14px 0">${escHtml(extra).replace(/\n/g, '<br>')}</p>` : '');
const link = (href, text) => `<a href="${escHtml(href)}" style="color:#f53b57;font-weight:700">${escHtml(text)}</a>`;

function createdMail(r) {
  const m = manageRound(r);
  const subject = `Din sambeställning: ${roundTitle(r)} (PIN ${r.pin})`;
  const text = [
    `Hej ${r.creator_name}!`, '',
    `Din sambeställning "${roundTitle(r)}" (${r.place_name}) är igång.`, '',
    `Dela länken: ${m.link}`,
    `Hantera: ${m.manageLink}`,
    `PIN-kod: ${r.pin}`,
    ...(r.event_date !== todayStr() ? ['', `Datum: ${dateSv(r.event_date)}`] : []),
    ...(r.close_at ? ['', `Beställningen stängs automatiskt ${dayTimeSv(r.close_at)}.`] : []),
    ...(r.reminder_at ? [`Påminnelse${r.confirm ? ' (med bekräfta/avboka)' : ''} skickas ${dayTimeSv(r.reminder_at)}.`] : []),
    ...(r.mail_orders ? ['Du får orderlistan mejlad när den stängs.'] : [])
  ].join('\n');
  const html = mailLayout(`
    <p style="margin:0 0 6px">Hej ${escHtml(r.creator_name)}!</p>
    <p style="margin:0">Din sambeställning <strong>${escHtml(roundTitle(r))}</strong> (${escHtml(r.place_name)}) är igång.</p>
    ${box(`Dela länken:<br>${link(m.link, m.link)}`)}
    <p style="margin:6px 0">Hantera rundan: ${link(m.manageLink, 'öppna admin')}<br>
      PIN-kod: <strong style="font-family:${SLAB};font-size:20px;letter-spacing:2px">${escHtml(r.pin)}</strong></p>
    ${r.event_date !== todayStr() ? `<p style="margin:10px 0 0">Datum: <strong>${escHtml(dateSv(r.event_date))}</strong></p>` : ''}
    ${r.close_at ? `<p style="margin:10px 0 0">Beställningen stängs automatiskt <strong>${escHtml(dayTimeSv(r.close_at))}</strong>.</p>` : ''}
    ${r.reminder_at ? `<p style="margin:4px 0 0">Påminnelse${r.confirm ? ' (med bekräfta/avboka)' : ''} skickas ${escHtml(dayTimeSv(r.reminder_at))}.</p>` : ''}
    ${r.mail_orders ? '<p style="margin:4px 0 0">Du får orderlistan mejlad när den stängs.</p>' : ''}`);
  return { subject, text, html };
}

function groupLines(orders) {
  const groups = new Map();
  for (const o of orders) {
    const t = orderText(o);
    const g = groups.get(t) || { n: 0, t, nrs: [] };
    g.n += 1; g.nrs.push('#' + o.nr);
    groups.set(t, g);
  }
  return [...groups.values()].sort((a, b) => a.t.localeCompare(b.t, 'sv')).map((g) => `${g.n}× ${g.t} (${g.nrs.join(', ')})`);
}

function orderListMail(r, orders) {
  const m = manageRound(r);
  const subject = `Orderlista: ${roundTitle(r)} (${orders.length} st)`;
  const lines = orders.map(orderLine);
  const groups = groupLines(orders);
  const text = [
    `Orderlista – ${roundTitle(r)} (${r.place_name})`, '',
    ...(lines.length ? lines : ['Inga beställningar.']),
    ...(groups.length ? ['', 'Sammanställt:', ...groups] : []),
    '', `Hantera: ${m.manageLink}  (PIN ${r.pin})`
  ].join('\n');
  const html = mailLayout(`
    <p style="margin:0">Beställningen <strong>${escHtml(roundTitle(r))}</strong> (${escHtml(r.place_name)}) är stängd – ${orders.length} st.</p>
    ${box(lines.length ? lines.map(escHtml).join('<br>') : 'Inga beställningar.')}
    ${groups.length ? `<p style="margin:14px 0 4px;color:#5b6570">Sammanställt</p>${box(groups.map(escHtml).join('<br>'))}` : ''}
    <p style="margin:14px 0 0">${link(m.manageLink, 'Hantera rundan')} · PIN ${escHtml(r.pin)}</p>`);
  return { subject, text, html };
}

const btn = (href, text, bg) => `<a href="${escHtml(href)}" style="display:inline-block;background:${bg};color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:700;margin:0 8px 8px 0">${escHtml(text)}</a>`;

function reminderMail(o, r) {
  const answer = `${PUBLIC_URL}/svar/${o.pay_token}`;
  const when = r.event_date === todayStr() ? 'idag' : dateSv(r.event_date);
  const subject = `${r.confirm ? 'Bekräfta: ' : 'Påminnelse: '}${roundTitle(r)} ${when}`;
  const text = [
    `Hej ${o.customer_name}!`, '',
    `Påminnelse: du har beställt mat från ${r.place_name} ${when}${r.food_eta ? ` (ca ${r.food_eta})` : ''}.`,
    `#${o.nr} ${orderText(o)}`, '',
    ...(r.confirm
      ? [`Bekräfta eller avboka här: ${answer}`, ...(r.close_at ? [`Svara senast ${dayTimeSv(r.close_at)}.`] : [])]
      : [`Kan du inte? Avboka här: ${answer}`]),
    '', `/${r.creator_name}`
  ].join('\n');
  const html = mailLayout(`
    <p style="margin:0 0 6px">Hej ${escHtml(o.customer_name)}!</p>
    <p style="margin:0">Påminnelse: du har beställt mat från <strong>${escHtml(r.place_name)}</strong> <strong>${escHtml(when)}</strong>${r.food_eta ? ` (ca ${escHtml(r.food_eta)})` : ''}.</p>
    ${orderBox(o)}
    ${r.confirm
      ? `<p style="margin:14px 0 10px">Står du fast vid beställningen?${r.close_at ? ` Svara senast <strong>${escHtml(dayTimeSv(r.close_at))}</strong>.` : ''}</p>
         <div>${btn(answer + '?a=ja', 'Bekräfta', '#05c46b')}${btn(answer + '?a=nej', 'Avboka', '#f53b57')}</div>`
      : `<p style="margin:14px 0 0;color:#5b6570">Kan du inte? ${link(answer + '?a=nej', 'Avboka här')}.</p>`}
    <p style="margin:14px 0 0">/${escHtml(r.creator_name)}</p>`);
  return { subject, text, html };
}

function foodMail(o, r, extra) {
  const subject = `Maten är här! – ${roundTitle(r)}`;
  const text = [
    `Hej ${o.customer_name}!`, '', `Maten från ${r.place_name} har kommit.`, `#${o.nr} ${orderText(o)}`,
    ...(extra ? ['', extra] : []), '', 'Smaklig måltid!'
  ].join('\n');
  const html = mailLayout(`
    <p style="margin:0 0 6px">Hej ${escHtml(o.customer_name)}!</p>
    <p style="margin:0">Maten från <strong>${escHtml(r.place_name)}</strong> har kommit.</p>
    ${orderBox(o)}
    ${extraHtml(extra)}
    <p style="margin:14px 0 0">Smaklig måltid!</p>`);
  return { subject, text, html };
}

async function payMail(o, r, extra, isReminder = false) {
  const mo = money(o, sharesFor(r.id));
  const sw = swishFor(o, r, mo.outstanding);
  const payLink = `${PUBLIC_URL}/pay/${o.pay_token}`;
  const changed = o.final_price != null && o.final_price !== o.total_price;
  const subject = `${isReminder ? 'Påminnelse – ' : ''}Att betala: ${sw.amount} kr – ${roundTitle(r)}`;
  const label = r.shared_label || 'Gemensam kostnad';
  const parts = [
    ...(mo.share || mo.paid ? [[`Mat${changed ? ' (enligt kvittot)' : ''}`, `${mo.food} kr`]] : []),
    ...(mo.share ? [[`${label} (din del)`, `${mo.share} kr`]] : []),
    ...(mo.paid ? [['Redan betalt', `−${mo.paid} kr`]] : [])
  ];
  const qrPng = await QRCode.toBuffer(sw.qrText, { type: 'png', width: 360, margin: 2, errorCorrectionLevel: 'M' });
  const text = [
    `Hej ${o.customer_name}!`, '',
    ...(isReminder ? ['Påminnelse: vi har inte fått din betalning än.', ''] : []),
    `Att betala för maten från ${r.place_name}: ${sw.amount} kr`,
    `#${o.nr} ${orderText(o)}`,
    ...parts.map(([a, b]) => `  ${a}: ${b}`),
    ...(changed ? [`(Justerat efter kvittot – menypriset var ${o.total_price} kr.)`] : []),
    '', `Swisha till: ${r.swish_number}`, `Meddelande: ${sw.message}`, '',
    `QR-kod och Swish-knapp: ${payLink}`,
    ...(extra ? ['', extra] : []), '', 'Tack!'
  ].join('\n');
  const html = mailLayout(`
    <p style="margin:0 0 6px">Hej ${escHtml(o.customer_name)}!</p>
    <p style="margin:0">${isReminder ? 'Påminnelse – vi har inte fått din betalning än. ' : ''}Här är vad du ska betala för maten från <strong>${escHtml(r.place_name)}</strong>.</p>
    ${orderBox(o)}
    ${parts.length ? `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 6px;font-size:14px;color:#5b6570">
      ${parts.map(([a, b]) => `<tr><td style="padding:2px 16px 2px 0">${escHtml(a)}</td><td style="padding:2px 0;text-align:right">${escHtml(b)}</td></tr>`).join('')}</table>` : ''}
    <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:6px 0 4px;font-size:15px">
      <tr><td style="padding:3px 16px 3px 0;color:#5b6570">Belopp</td>
          <td style="padding:3px 0;font-family:${SLAB};font-weight:700;font-size:22px">${sw.amount} kr</td></tr>
      <tr><td style="padding:3px 16px 3px 0;color:#5b6570">Swish till</td><td style="padding:3px 0"><strong>${escHtml(r.swish_number)}</strong></td></tr>
      <tr><td style="padding:3px 16px 3px 0;color:#5b6570">Meddelande</td><td style="padding:3px 0">${escHtml(sw.message)}</td></tr>
    </table>
    ${changed ? `<p style="margin:2px 0 0;color:#5b6570;font-size:13px">Justerat efter kvittot – menypriset var ${o.total_price} kr.</p>` : ''}
    <div style="margin:22px 0 6px">
      <img src="cid:swishqr" width="180" height="180" alt="Swish QR-kod" style="display:block;border:0;width:180px;height:180px">
      <div style="color:#5b6570;font-size:13px;margin-top:4px">Skanna med Swish-appen</div>
    </div>
    <p style="margin:16px 0">På mobilen: ${link(payLink, 'öppna betalningssidan')} och tryck på "Öppna Swish".</p>
    ${extraHtml(extra)}
    <p style="margin:14px 0 0">Tack!</p>`);
  return {
    subject, text, html,
    attachments: [{ filename: 'swish-qr.png', content: qrPng, contentType: 'image/png', cid: 'swishqr', contentDisposition: 'inline' }]
  };
}

// ---------- Sending ----------
const sendingRounds = new Set();
async function sendBatch(orders, build, stampCol) {
  const result = { sent: 0, failed: [], skipped: 0 };
  for (const o of orders) {
    if (!o.email) { result.skipped += 1; continue; }
    try {
      const m = await build(o);
      await sendMail({ to: o.email, subject: m.subject, text: m.text, html: m.html, attachments: m.attachments });
      db.prepare(`UPDATE orders SET ${stampCol} = ? WHERE id = ?`).run(new Date().toISOString(), o.id);
      result.sent += 1;
    } catch (e) {
      console.error(`Mejl till #${o.nr} misslyckades:`, e.message);
      result.failed.push(`#${o.nr} ${o.customer_name}: ${e.message}`);
    }
  }
  return result;
}

function mailGuard(req, res) {
  if (!mailConfigured) { res.status(400).json({ error: 'Mejl är inte konfigurerat på servern.' }); return false; }
  if (sendingRounds.has(req.round.id)) { res.status(409).json({ error: 'Ett utskick pågår redan.' }); return false; }
  return true;
}

app.post('/api/rounds/:slug/mail/food', requireRound, async (req, res) => {
  if (!mailGuard(req, res)) return;
  const r = req.round;
  const extra = clean(req.body.extra, 500);
  sendingRounds.add(r.id);
  emit('food.arrived', r, { extra });
  try { res.json(await sendBatch(ordersOf(r.id), (o) => foodMail(o, r, extra), 'food_mail_at')); } finally { sendingRounds.delete(r.id); }
});

app.post('/api/rounds/:slug/mail/pay', requireRound, async (req, res) => {
  if (!mailGuard(req, res)) return;
  const r = req.round;
  const extra = clean(req.body.extra, 500);
  sendingRounds.add(r.id);
  try {
    const sh = sharesFor(r.id);
    res.json(await sendBatch(ordersOf(r.id).filter((o) => money(o, sh).outstanding > 0), (o) => payMail(o, r, extra), 'pay_mail_at'));
  } finally { sendingRounds.delete(r.id); }
});

async function sendReminders(r) {
  db.prepare('UPDATE rounds SET reminder_sent_at = ? WHERE id = ?').run(new Date().toISOString(), r.id);
  const fresh = getRoundById(r.id);
  return sendBatch(ordersOf(r.id), (o) => reminderMail(o, fresh), 'reminder_mail_at');
}

app.post('/api/rounds/:slug/mail/reminder', requireRound, async (req, res) => {
  if (!mailGuard(req, res)) return;
  const r = req.round;
  sendingRounds.add(r.id);
  try { res.json(await sendReminders(r)); } finally { sendingRounds.delete(r.id); }
});

// Order list to the creator, on demand
app.post('/api/rounds/:slug/mail/orders', requireRound, async (req, res) => {
  if (!mailGuard(req, res)) return;
  const r = req.round;
  if (!r.creator_email) return res.status(400).json({ error: 'Ingen e-post angiven för rundan. Lägg till den under Inställningar.' });
  try {
    await sendMail({ to: r.creator_email, ...orderListMail(r, ordersOf(r.id)) });
    db.prepare('UPDATE rounds SET orders_mailed_at = ? WHERE id = ?').run(new Date().toISOString(), r.id);
    res.json({ ok: true, to: r.creator_email });
  } catch (e) {
    res.status(502).json({ error: 'Kunde inte skicka: ' + e.message });
  }
});

// When a round closes (automatically or by hand): mail the order list once, if the creator asked for it
async function onClosed(r) {
  if (!r.mail_orders || !r.creator_email || r.orders_mailed_at || !mailConfigured) return;
  db.prepare('UPDATE rounds SET orders_mailed_at = ? WHERE id = ?').run(new Date().toISOString(), r.id);
  try {
    await sendMail({ to: r.creator_email, ...orderListMail(r, ordersOf(r.id)) });
    console.log(`Orderlista mejlad till skaparen av ${r.slug}.`);
  } catch (e) {
    db.prepare('UPDATE rounds SET orders_mailed_at = NULL WHERE id = ?').run(r.id);
    console.error(`Orderlista ${r.slug}:`, e.message);
  }
}

// ---------- Webhooks: Teams (Workflows), Slack, Discord or plain JSON ----------
const EVENT_TEXT = {
  'round.created': (r) => `🍕 ${r.creator_name} startar en sambeställning: ${roundTitle(r)}` +
    `${r.name ? ` (${[r.place_name, r.location_name].filter(Boolean).join(', ')})` : r.location_name ? ` (${r.location_name})` : ''}` +
    `${r.company_name ? ` för ${r.company_name}` : ''}` +
    `${r.event_date !== todayStr() ? ` för ${dateSv(r.event_date)}` : ''}${r.close_at ? ` – beställ senast ${dayTimeSv(r.close_at)}` : ''}`,
  'round.closed': (r) => `🔒 ${roundTitle(r)} är stängd – ${db.prepare('SELECT COUNT(*) AS n FROM orders WHERE round_id = ? AND cancelled_at IS NULL').get(r.id).n} beställningar.`,
  'food.arrived': (r, x) => `🍽️ Maten från ${r.place_name} är här! (${roundTitle(r)})${x && x.extra ? ` ${x.extra}` : ''}`
};
const getHooks = () => { try { return JSON.parse(getSetting('webhooks', '[]')); } catch { return []; } };

function hookPayload(format, event, r, text) {
  const link = `${PUBLIC_URL}/r/${r.slug}`;
  if (format === 'slack') return { text: `${text}\n${link}` };
  if (format === 'discord') return { content: `${text}\n${link}` };
  if (format === 'teams') {
    return {
      type: 'message',
      attachments: [{
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4',
          body: [{ type: 'TextBlock', text, wrap: true, weight: 'Bolder' }],
          actions: event === 'food.arrived' ? [] : [{ type: 'Action.OpenUrl', title: 'Öppna sambeställningen', url: link }]
        }
      }]
    };
  }
  return { // json
    event, text, link,
    round: { slug: r.slug, title: roundTitle(r), place: r.place_name, location: r.location_name || null, company: r.company_name || null, creator: r.creator_name, date: r.event_date,
      closeAt: r.close_at, foodEta: r.food_eta, isOpen: Boolean(r.is_open) }
  };
}

async function postHook(h, event, r, extra) {
  const text = EVENT_TEXT[event](r, extra);
  const res = await fetch(h.url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(hookPayload(h.format, event, r, text)), signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

function emit(event, r, extra) {
  for (const h of getHooks()) {
    if (h.events && !h.events.includes(event)) continue;
    // Location filter: empty = all. Places without a location go to every hook.
    if (h.locations && h.locations.length && r.location_id && !h.locations.includes(r.location_id)) continue;
    // Company filter: empty = all. Rounds for "everyone in the building" go to every hook.
    if (h.companies && h.companies.length && r.company_id && !h.companies.includes(r.company_id)) continue;
    postHook(h, event, r, extra).catch((e) => console.error(`Webhook ${event} → ${h.url.slice(0, 40)}…:`, e.message));
  }
}

// ---------- Site admin (ADMIN_PIN): places, menus, all rounds ----------
app.post('/api/admin/login', (req, res) => {
  if (!pinOk(req, res, ADMIN_PIN)) return;
  grant(req, res, 'admin');
  res.json({ ok: true });
});

app.get('/api/admin/overview', requireAdmin, (req, res) => {
  res.json({
    mailConfigured,
    locations: listLocations(),
    companies: listCompanies(),
    places: db.prepare('SELECT id, name, location_id FROM places ORDER BY name COLLATE NOCASE').all(),
    menuItems: db.prepare('SELECT id, place_id, name, price FROM menu_items ORDER BY name COLLATE NOCASE').all(),
    options: db.prepare('SELECT id, place_id, kind, name, price FROM place_options ORDER BY kind, id').all(),
    rounds: db.prepare(`${ROUND_SELECT} ORDER BY r.created_at DESC`).all().map(manageRound)
  });
});

app.post('/api/admin/places', requireAdmin, (req, res) => {
  const name = clean(req.body.name, 60);
  if (!name) return res.status(400).json({ error: 'Ange ställets namn.' });
  try {
    const loc = req.body.locationId ? toInt(req.body.locationId) : null;
    const info = db.prepare('INSERT INTO places (name, location_id) VALUES (?, ?)').run(name, loc && db.prepare('SELECT 1 FROM locations WHERE id = ?').get(loc) ? loc : null);
    res.status(201).json({ id: Number(info.lastInsertRowid) });
  } catch {
    res.status(400).json({ error: 'Stället finns redan.' });
  }
});

app.patch('/api/admin/places/:id', requireAdmin, (req, res) => {
  const id = toInt(req.params.id);
  try {
    if ('name' in req.body) {
      const name = clean(req.body.name, 60);
      if (!name) return res.status(400).json({ error: 'Ange ställets namn.' });
      db.prepare('UPDATE places SET name = ? WHERE id = ?').run(name, id);
    }
    if ('locationId' in req.body) {
      const loc = req.body.locationId ? toInt(req.body.locationId) : null;
      if (loc && !db.prepare('SELECT 1 FROM locations WHERE id = ?').get(loc)) return res.status(400).json({ error: 'Orten finns inte.' });
      db.prepare('UPDATE places SET location_id = ? WHERE id = ?').run(loc, id);
    }
    res.json({ ok: true });
  } catch {
    res.status(400).json({ error: 'Det namnet finns redan.' });
  }
});

app.delete('/api/admin/places/:id', requireAdmin, (req, res) => {
  const id = toInt(req.params.id);
  if (db.prepare('SELECT 1 FROM rounds WHERE place_id = ?').get(id)) {
    return res.status(400).json({ error: 'Stället används i en aktiv runda.' });
  }
  db.prepare('DELETE FROM places WHERE id = ?').run(id);
  res.json({ ok: true });
});

app.post('/api/admin/locations', requireAdmin, (req, res) => {
  const name = clean(req.body.name, 40);
  if (!name) return res.status(400).json({ error: 'Ange ortens namn.' });
  try {
    const info = db.prepare('INSERT INTO locations (name) VALUES (?)').run(name);
    res.status(201).json({ id: Number(info.lastInsertRowid) });
  } catch {
    res.status(400).json({ error: 'Orten finns redan.' });
  }
});
app.patch('/api/admin/locations/:id', requireAdmin, (req, res) => {
  const name = clean(req.body.name, 40);
  if (!name) return res.status(400).json({ error: 'Ange ortens namn.' });
  try {
    db.prepare('UPDATE locations SET name = ? WHERE id = ?').run(name, toInt(req.params.id));
    res.json({ ok: true });
  } catch {
    res.status(400).json({ error: 'Det namnet finns redan.' });
  }
});
// Deleting a location keeps its places; they become "all locations"
app.delete('/api/admin/locations/:id', requireAdmin, (req, res) => {
  const id = toInt(req.params.id);
  db.transaction(() => {
    db.prepare('UPDATE places SET location_id = NULL WHERE location_id = ?').run(id);
    db.prepare('DELETE FROM locations WHERE id = ?').run(id);
  })();
  const hooks = getHooks().map((h) => ({ ...h, locations: (h.locations || []).filter((l) => l !== id) }));
  setSetting('webhooks', JSON.stringify(hooks));
  res.json({ ok: true });
});

app.post('/api/admin/companies', requireAdmin, (req, res) => {
  const name = clean(req.body.name, 50);
  if (!name) return res.status(400).json({ error: 'Ange företagets namn.' });
  try {
    const info = db.prepare('INSERT INTO companies (name) VALUES (?)').run(name);
    res.status(201).json({ id: Number(info.lastInsertRowid) });
  } catch {
    res.status(400).json({ error: 'Företaget finns redan.' });
  }
});
app.patch('/api/admin/companies/:id', requireAdmin, (req, res) => {
  const name = clean(req.body.name, 50);
  if (!name) return res.status(400).json({ error: 'Ange företagets namn.' });
  try {
    db.prepare('UPDATE companies SET name = ? WHERE id = ?').run(name, toInt(req.params.id));
    res.json({ ok: true });
  } catch {
    res.status(400).json({ error: 'Det namnet finns redan.' });
  }
});
// Deleting a company keeps its rounds; they become "everyone in the building"
app.delete('/api/admin/companies/:id', requireAdmin, (req, res) => {
  const id = toInt(req.params.id);
  db.transaction(() => {
    db.prepare('UPDATE rounds SET company_id = NULL WHERE company_id = ?').run(id);
    db.prepare('DELETE FROM companies WHERE id = ?').run(id);
  })();
  setSetting('webhooks', JSON.stringify(getHooks().map((h) => ({ ...h, companies: (h.companies || []).filter((c) => c !== id) }))));
  res.json({ ok: true });
});

app.post('/api/admin/menu', requireAdmin, (req, res) => {
  const placeId = toInt(req.body.placeId);
  const name = clean(req.body.name, 80);
  const price = toInt(req.body.price);
  if (!placeId || !name || Number.isNaN(price) || price < 0) return res.status(400).json({ error: 'Namn och pris krävs.' });
  const info = db.prepare('INSERT INTO menu_items (place_id, name, price) VALUES (?, ?, ?)').run(placeId, name, price);
  res.status(201).json({ id: Number(info.lastInsertRowid) });
});

app.patch('/api/admin/menu/:id', requireAdmin, (req, res) => {
  const name = clean(req.body.name, 80);
  const price = toInt(req.body.price);
  if (!name || Number.isNaN(price) || price < 0) return res.status(400).json({ error: 'Namn och pris krävs.' });
  db.prepare('UPDATE menu_items SET name = ?, price = ? WHERE id = ?').run(name, price, toInt(req.params.id));
  res.json({ ok: true });
});

app.delete('/api/admin/menu/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM menu_items WHERE id = ?').run(toInt(req.params.id));
  res.json({ ok: true });
});

app.post('/api/admin/options', requireAdmin, (req, res) => {
  const placeId = toInt(req.body.placeId);
  const kind = req.body.kind === 'removal' ? 'removal' : 'addon';
  const name = clean(req.body.name, 60);
  const price = kind === 'removal' ? 0 : Math.max(0, toInt(req.body.price || 0) || 0);
  if (!placeId || !name) return res.status(400).json({ error: 'Ange namn.' });
  const info = db.prepare('INSERT INTO place_options (place_id, kind, name, price) VALUES (?, ?, ?, ?)').run(placeId, kind, name, price);
  res.status(201).json({ id: Number(info.lastInsertRowid) });
});

app.delete('/api/admin/options/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM place_options WHERE id = ?').run(toInt(req.params.id));
  res.json({ ok: true });
});

app.post('/api/admin/rounds/:id/end', requireAdmin, (req, res) => {
  endRound(toInt(req.params.id));
  res.json({ ok: true });
});

const HOOK_FORMATS = ['teams', 'slack', 'discord', 'json'];
const HOOK_EVENTS = Object.keys(EVENT_TEXT);
app.get('/api/admin/webhooks', requireAdmin, (req, res) => res.json({ hooks: getHooks(), formats: HOOK_FORMATS, events: HOOK_EVENTS, locations: listLocations(), companies: listCompanies() }));
app.put('/api/admin/webhooks', requireAdmin, (req, res) => {
  const list = Array.isArray(req.body.hooks) ? req.body.hooks : [];
  const hooks = [];
  for (const h of list.slice(0, 10)) {
    const url = clean(h.url, 1000);
    if (!/^https?:\/\/\S+$/.test(url)) return res.status(400).json({ error: `Ogiltig adress (måste börja med http:// eller https://): ${url.slice(0, 50)}` });
    hooks.push({
      url, format: HOOK_FORMATS.includes(h.format) ? h.format : 'json',
      events: Array.isArray(h.events) ? h.events.filter((e) => HOOK_EVENTS.includes(e)) : HOOK_EVENTS,
      locations: Array.isArray(h.locations) ? h.locations.map(toInt).filter((l) => db.prepare('SELECT 1 FROM locations WHERE id = ?').get(l)) : [],
      companies: Array.isArray(h.companies) ? h.companies.map(toInt).filter((c) => db.prepare('SELECT 1 FROM companies WHERE id = ?').get(c)) : []
    });
  }
  setSetting('webhooks', JSON.stringify(hooks));
  res.json({ ok: true, hooks });
});
app.post('/api/admin/webhooks/test', requireAdmin, async (req, res) => {
  const url = clean(req.body.url, 1000);
  if (!/^https?:\/\/\S+$/.test(url)) return res.status(400).json({ error: "Ogiltig adress." });
  const fake = { slug: 'test', name: 'Testrunda', place_name: 'Pizzeria Test', creator_name: 'SamMat', event_date: todayStr(),
    close_at: null, food_eta: '12:00', is_open: 1 };
  try {
    await postHook({ url, format: HOOK_FORMATS.includes(req.body.format) ? req.body.format : 'json' }, 'round.created', fake);
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: 'Misslyckades: ' + e.message });
  }
});

app.post('/api/admin/mail/test', requireAdmin, async (req, res) => {
  if (!mailConfigured) return res.status(400).json({ error: 'Mejl är inte konfigurerat.' });
  const to = clean(req.body.to, 120);
  if (!isEmail(to)) return res.status(400).json({ error: 'Ange en giltig adress.' });
  try {
    await sendMail({
      to, subject: 'SamMat – testmejl',
      text: 'Det här är ett testmejl från SamMat. SMTP fungerar!',
      html: mailLayout('<p style="margin:0">Det här är ett testmejl från SamMat. SMTP fungerar!</p>')
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: 'Kunde inte skicka: ' + e.message });
  }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Okänd adress.' }));

// ---------- Timers: auto close (every 20 s) and clean-up of old rounds (hourly) ----------
// Optional: one payment reminder per unpaid order, pay_remind_hours after its payment mail
async function autoPayRemind() {
  if (!mailConfigured) return;
  const rounds = db.prepare(`${ROUND_SELECT} WHERE r.pay_remind_hours > 0`).all();
  for (const r of rounds) {
    if (sendingRounds.has(r.id)) continue;
    const cutoff = new Date(Date.now() - r.pay_remind_hours * 3600000).toISOString();
    const sh = sharesFor(r.id);
    const due = ordersOf(r.id).filter((o) => o.email && o.pay_mail_at && o.pay_mail_at <= cutoff && !o.pay_remind_at && money(o, sh).outstanding > 0);
    if (!due.length) continue;
    sendingRounds.add(r.id);
    try {
      const out = await sendBatch(due, (o) => payMail(o, r, '', true), 'pay_remind_at');
      console.log(`Betalpåminnelse ${r.slug}: ${out.sent} skickade.`);
    } finally { sendingRounds.delete(r.id); }
  }
}

async function autoRemind() {
  if (!mailConfigured) return;
  const due = db.prepare('SELECT id FROM rounds WHERE reminder_at IS NOT NULL AND reminder_sent_at IS NULL AND reminder_at <= ?').all(new Date().toISOString());
  for (const { id } of due) {
    if (sendingRounds.has(id)) continue;
    const r = getRoundById(id);
    sendingRounds.add(id);
    try {
      const out = await sendReminders(r);
      console.log(`Påminnelse ${r.slug}: ${out.sent} skickade, ${out.failed.length} misslyckades.`);
    } catch (e) {
      console.error(`Påminnelse ${r.slug}:`, e.message);
    } finally { sendingRounds.delete(id); }
  }
}

function autoClose() {
  const due = db.prepare('SELECT id FROM rounds WHERE is_open = 1 AND close_at IS NOT NULL AND close_at <= ?').all(new Date().toISOString());
  for (const { id } of due) {
    db.prepare('UPDATE rounds SET is_open = 0 WHERE id = ?').run(id);
    const r = getRoundById(id);
    console.log(`Runda ${r.slug} stängd automatiskt.`);
    emit('round.closed', r);
    onClosed(r).catch(() => {});
  }
}

function autoPurge() {
  // Counted from the round's date, so a round set up weeks ahead isn't deleted early
  const cutoff = addDays(todayStr(), -PURGE_DAYS);
  for (const { id, slug } of db.prepare('SELECT id, slug FROM rounds WHERE event_date < ?').all(cutoff)) {
    endRound(id);
    console.log(`Rensning: runda ${slug} (mer än ${PURGE_DAYS} dagar efter datumet) raderad.`);
  }
  const favCut = new Date(Date.now() - FAVORITE_DAYS * 86400000).toISOString();
  const fav = db.prepare('DELETE FROM favorites WHERE updated_at < ?').run(favCut);
  if (fav.changes) console.log(`Rensning: ${fav.changes} sparade beställningar äldre än ${FAVORITE_DAYS} dagar raderade.`);
  const now = Date.now();
  for (const [t, s] of sessions) if (s.exp < now) sessions.delete(t);
}

autoClose();
autoPurge();
setInterval(autoClose, 20 * 1000).unref();
setInterval(() => autoRemind().catch(() => {}), 30 * 1000).unref();
setInterval(() => autoPayRemind().catch((e) => console.error('Betalpåminnelse:', e.message)), 60 * 1000).unref();
setInterval(autoPurge, 3600 * 1000).unref();

// ---------- Start / stop ----------
const server = app.listen(PORT, '0.0.0.0', () => console.log(`SamMat kör på port ${PORT}`));

function shutdown() {
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => { db.close(); process.exit(0); }, 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
