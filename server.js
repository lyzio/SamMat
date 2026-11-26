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
const FAVORITE_DAYS = Number(process.env.FAVORITE_DAYS || 180);
const CREATE_PIN = String(process.env.CREATE_PIN || '').trim();          // optional: PIN needed to start a round
const BACKUP_DAYS = Number(process.env.BACKUP_DAYS ?? 7);                 // daily backup kept this many days; 0 = off // "same as last time" is kept this long after the last order
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
// v2.6: drinks (own category, with quantity), add-ons per dish, editable orders
addCols('menu_items', [['category', "TEXT NOT NULL DEFAULT 'main'"]]);   // 'main' | 'drink'
addCols('place_options', [['applies_to', 'TEXT']]);                      // JSON array of menu item ids; NULL = all dishes
addCols('orders', [
  ['extras_text', "TEXT NOT NULL DEFAULT ''"],   // "2× Coca-Cola, 1× Loka"
  ['extras', "TEXT NOT NULL DEFAULT '[]'"],      // JSON [{name, qty, price}]
  ['selection', 'TEXT'],                          // JSON of what was picked (ids), to prefill the edit form
  ['lang', "TEXT NOT NULL DEFAULT 'sv'"],
  ['updated_at', 'TEXT']
]);
addCols('favorites', [['extras', "TEXT NOT NULL DEFAULT '[]'"]]);
addCols('rounds', [['lang', "TEXT NOT NULL DEFAULT 'sv'"]]); // language of the creator (their mails)
// v2.6: contact info per place (shown to everyone in a round: phone, address, menu link, note)
addCols('places', [['phone', "TEXT NOT NULL DEFAULT ''"], ['address', "TEXT NOT NULL DEFAULT ''"], ['url', "TEXT NOT NULL DEFAULT ''"], ['note', "TEXT NOT NULL DEFAULT ''"]]);

const listCompanies = () => db.prepare('SELECT id, name FROM companies ORDER BY name COLLATE NOCASE').all();
const companyIdOr = (v) => { const id = v ? toInt(v) : null; return id && db.prepare('SELECT 1 FROM companies WHERE id = ?').get(id) ? id : null; };

const getSetting = (k, d = null) => { const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k); return r ? r.value : d; };
const setSetting = (k, v) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);
if (!getSetting('hash_salt')) setSetting('hash_salt', crypto.randomBytes(32).toString('hex'));
const emailHash = (email) => crypto.createHmac('sha256', getSetting('hash_salt')).update(String(email).trim().toLowerCase()).digest('hex');
db.exec("UPDATE rounds SET event_date = substr(created_at, 1, 10) WHERE event_date IS NULL");

// ---------- Language (sv default, en) ----------
const langOf = (req) => (String(req.get('x-lang') || '').toLowerCase() === 'en' ? 'en' : 'sv');
const T = (req, sv, en) => (langOf(req) === 'en' ? en : sv);

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
// For the restaurant: dish, add-ons, removals. Drinks are listed separately at the bottom of the order list.
const orderText = (o) => [o.item_name, o.addons_text, o.removals_text].filter(Boolean).join(' - ');
// For the person: everything, drinks included
const orderTextFull = (o) => orderText(o) + (o.extras_text ? ` + ${o.extras_text}` : '');
// "3× Coca-Cola (#1, #4×2)" – drinks summed over orders
function drinkLines(orders) {
  const m = new Map();
  for (const o of orders) {
    for (const x of JSON.parse(o.extras || '[]')) {
      const g = m.get(x.name) || { n: 0, who: [] };
      g.n += x.qty; g.who.push(`#${o.nr}${x.qty > 1 ? '×' + x.qty : ''}`);
      m.set(x.name, g);
    }
  }
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], 'sv')).map(([name, g]) => `${g.n}× ${name} (${g.who.join(', ')})`);
}
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
const locOf = (lang) => (lang === 'en' ? 'en-GB' : 'sv-SE');
const dateL = (ymd, lang = 'sv') => new Date(ymd + 'T12:00:00Z').toLocaleDateString(locOf(lang), { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const dayTimeL = (iso, lang = 'sv') => new Date(iso).toLocaleString(locOf(lang), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: TZ });
const dateSv = (ymd) => dateL(ymd, 'sv');
const dayTimeSv = (iso) => dayTimeL(iso, 'sv');

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

const ROUND_SELECT = `SELECT r.*, p.name AS place_name, p.location_id, l.name AS location_name, co.name AS company_name,
  p.phone AS place_phone, p.address AS place_address, p.url AS place_url, p.note AS place_note
  FROM rounds r JOIN places p ON p.id = r.place_id LEFT JOIN locations l ON l.id = p.location_id
  LEFT JOIN companies co ON co.id = r.company_id`;
const getRoundBySlug = (slug) => db.prepare(`${ROUND_SELECT} WHERE r.slug = ?`).get(clean(slug, 12).toLowerCase());
const getRoundById = (id) => db.prepare(`${ROUND_SELECT} WHERE r.id = ?`).get(id);
const ordersOf = (roundId) => db.prepare('SELECT * FROM orders WHERE round_id = ? AND cancelled_at IS NULL ORDER BY nr').all(roundId);
const allOrdersOf = (roundId) => db.prepare('SELECT * FROM orders WHERE round_id = ? ORDER BY nr').all(roundId);

function menuFor(placeId) {
  const options = db.prepare('SELECT id, kind, name, price, applies_to FROM place_options WHERE place_id = ? ORDER BY id').all(placeId)
    .map((o) => ({ id: o.id, kind: o.kind, name: o.name, price: o.price, appliesTo: o.applies_to ? JSON.parse(o.applies_to) : null }));
  const items = db.prepare('SELECT id, name, price, category FROM menu_items WHERE place_id = ? ORDER BY name COLLATE NOCASE').all(placeId);
  return {
    menu: items.filter((m) => m.category !== 'drink').map(({ id, name, price }) => ({ id, name, price })),
    drinks: items.filter((m) => m.category === 'drink').map(({ id, name, price }) => ({ id, name, price })),
    addons: options.filter((o) => o.kind === 'addon'),
    removals: options.filter((o) => o.kind === 'removal')
  };
}
const optionFits = (o, itemId) => !o.appliesTo || o.appliesTo.includes(itemId);

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
    place: { phone: r.place_phone || '', address: r.place_address || '', url: r.place_url || '', note: r.place_note || '' },
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

// Error messages are written in Swedish; English clients (X-Lang: en) get them translated here
const ERR_EN = {
  'Sambeställningen finns inte (längre).': 'This group order no longer exists.',
  'Det namnet finns redan.': 'That name already exists.',
  'Ogiltig e-postadress.': 'Invalid e-mail address.',
  'Namn och pris krävs.': 'Name and price are required.',
  'Beställningen hittades inte. Rundan kan vara avslutad.': 'Order not found. The round may have ended.',
  'Ange ställets namn.': "Enter the place's name.",
  'Ange ortens namn.': "Enter the location's name.",
  'Ange företagets namn.': "Enter the company's name.",
  'Välj ett ställe.': 'Choose a place.',
  'Stället finns redan.': 'The place already exists.',
  'Stället används i en aktiv runda.': 'The place is used in an active round.',
  'Orten finns redan.': 'The location already exists.',
  'Orten finns inte.': 'The location does not exist.',
  'Okänt svar.': 'Unknown answer.',
  'Okänd adress.': 'Unknown address.',
  'Ogiltigt pris.': 'Invalid price.',
  'Ogiltigt datum.': 'Invalid date.',
  'Mejl är inte konfigurerat.': 'Mail is not configured.',
  'Mejl är inte konfigurerat – påminnelser går inte att skicka.': 'Mail is not configured – reminders cannot be sent.',
  'Mejl är inte konfigurerat på servern.': 'Mail is not configured on the server.',
  'Logga in med admin-PIN.': 'Log in with the admin PIN.',
  'Ingen e-post angiven för rundan. Lägg till den under Inställningar.': 'No e-mail set for the round. Add it under Settings.',
  'Företaget finns redan.': 'The company already exists.',
  'För många felaktiga försök. Vänta 15 minuter.': 'Too many wrong attempts. Wait 15 minutes.',
  'För många aktiva rundor just nu.': 'Too many active rounds right now.',
  'Finns inte.': 'Not found.',
  'Fel PIN-kod.': 'Wrong PIN code.',
  'Ett utskick pågår redan.': 'A mail-out is already running.',
  'Du har startat många rundor den senaste timmen. Vänta lite.': 'You have started many rounds in the last hour. Please wait a bit.',
  'Datumet har redan passerat.': 'The date has already passed.',
  'Betalningen hittades inte. Rundan kan vara avslutad.': 'Payment not found. The round may have ended.',
  'Beställningen finns inte.': 'The order does not exist.',
  'Ange rundans PIN-kod.': "Enter the round's PIN code.",
  'Ange namn.': 'Enter a name.',
  'Ange ett giltigt Swish-nummer.': 'Enter a valid Swish number.',
  'Ange en giltig e-postadress.': 'Enter a valid e-mail address.',
  'Ange en giltig adress.': 'Enter a valid address.',
  'Ange e-post för att få orderlistan mejlad.': 'Enter an e-mail to get the order list.',
  'Ange ditt namn.': 'Enter your name.',
  'Ange ditt Swish-nummer.': 'Enter your Swish number.',
  'Ange din e-post för att få orderlistan mejlad.': 'Enter your e-mail to get the order list.',
  'Stopptid har redan passerat.': 'The closing time has already passed.',
  'Stopptid ligger för långt fram.': 'The closing time is too far ahead.',
  'Ogiltig stopptid.': 'Invalid closing time.',
  'Påminnelsetid har redan passerat.': 'The reminder time has already passed.',
  'Påminnelsetid ligger för långt fram.': 'The reminder time is too far ahead.',
  'Ogiltig påminnelsetid.': 'Invalid reminder time.',
  'Beställningen är stängd.': 'Ordering is closed.'
};
function errorToEn(msg) {
  if (ERR_EN[msg]) return ERR_EN[msg];
  let m;
  if ((m = msg.match(/^Max (\d+) dagar fram\.$/))) return `At most ${m[1]} days ahead.`;
  if ((m = msg.match(/^Beställningen är redan stängd – kontakta (.+)\.$/))) return `Ordering is already closed – contact ${m[1]}.`;
  if ((m = msg.match(/^Ogiltig adress \(måste börja med http:\/\/ eller https:\/\/\): (.*)$/))) return `Invalid address (must start with http:// or https://): ${m[1]}`;
  if ((m = msg.match(/^Kunde inte skicka: (.*)$/))) return `Could not send: ${m[1]}`;
  if ((m = msg.match(/^Misslyckades: (.*)$/))) return `Failed: ${m[1]}`;
  return msg;
}
app.use((req, res, next) => {
  if (langOf(req) === 'en') {
    const json = res.json.bind(res);
    res.json = (b) => json(b && typeof b.error === 'string' ? { ...b, error: errorToEn(b.error) } : b);
  }
  next();
});

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
app.get('/r/:slug/andra/:token', page('round.html'));
app.get('/pay/:token', page('pay.html'));
app.get('/svar/:token', page('svar.html'));
app.get('/integritet', page('integritet.html'));
app.use('/fonts', express.static(path.join(__dirname, 'node_modules', '@fontsource'), { maxAge: '30d', immutable: true }));
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

// ---------- Public API ----------
app.get('/api/places', (req, res) => {
  res.json(db.prepare(`
    SELECT p.id, p.name, p.location_id AS locationId, l.name AS locationName, p.phone, p.address, p.url, p.note,
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

  // Optional install-wide PIN for starting rounds (CREATE_PIN), with the same lockout as other PINs
  if (CREATE_PIN) {
    if (locked(ipFails, req.ip)) return res.status(429).json({ error: T(req, 'För många felaktiga försök. Vänta 15 minuter.', 'Too many wrong attempts. Wait 15 minutes.') });
    if (!safeEqual(clean(req.body.createPin, 20), CREATE_PIN)) {
      fail(ipFails, req.ip, 10);
      return res.status(401).json({ error: T(req, 'Fel PIN för att starta en runda.', 'Wrong PIN for starting a round.'), needPin: true });
    }
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
                        event_date, reminder_at, confirm, pay_mode, shared_cost, shared_label, pay_remind_hours, company_id, lang, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(slug, pin, name, placeId, swishNumber, creatorName, creatorEmail, foodEta, close.value, mailOrders ? 1 : 0,
    eventDate.value, reminder.value, confirm ? 1 : 0, payMode, sharedCost, sharedLabel, payRemindHours, companyId, langOf(req), new Date().toISOString());
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

// Per-IP limit on new orders (spam protection): ORDER_LIMIT per 10 minutes, default 20
const ORDER_LIMIT = Number(process.env.ORDER_LIMIT || 20);
const orderLog = new Map();
function orderRateOk(req) {
  const now = Date.now();
  const list = (orderLog.get(req.ip) || []).filter((t) => t > now - 600000);
  if (list.length >= ORDER_LIMIT) return false;
  list.push(now);
  orderLog.set(req.ip, list);
  return true;
}

// Validates an order body against the round's menu. Returns { error } or the order fields.
function buildOrder(req, r) {
  const { menu, drinks, addons: allAddons, removals: allRemovals } = menuFor(r.place_id);
  const b = req.body;
  const customerName = clean(b.customerName, 40);
  const email = clean(b.email, 120).toLowerCase();
  const menuItemId = toInt(b.menuItemId);
  const addonIds = Array.isArray(b.addonIds) ? b.addonIds.map(toInt) : [];
  const removalIds = Array.isArray(b.removalIds) ? b.removalIds.map(toInt) : [];
  const customRemoval = clean(b.customRemoval, 120);
  if (!customerName) return { error: T(req, 'Ange ditt namn.', 'Enter your name.') };
  if (!isEmail(email)) return { error: T(req, 'Ange en giltig e-postadress.', 'Enter a valid e-mail address.') };
  const item = menu.find((m) => m.id === menuItemId);
  if (!item) return { error: T(req, 'Välj en rätt.', 'Choose a dish.') };

  const addons = allAddons.filter((a) => addonIds.includes(a.id) && optionFits(a, item.id));
  const removals = allRemovals.filter((x) => removalIds.includes(x.id) && optionFits(x, item.id));
  // Drinks: [{ id, qty }], 1–10 each
  const extras = [];
  for (const e of Array.isArray(b.extras) ? b.extras : []) {
    const d = drinks.find((x) => x.id === toInt(e.id));
    const qty = Math.max(0, Math.min(10, toInt(e.qty) || 0));
    if (d && qty) extras.push({ id: d.id, name: d.name, qty, price: d.price });
  }
  const totalPrice = item.price + addons.reduce((s2, a) => s2 + a.price, 0) + extras.reduce((s2, x) => s2 + x.price * x.qty, 0);
  return {
    customerName, email, item, addons, removals, customRemoval, extras, totalPrice,
    addonsText: addons.map((a) => a.name).join(', '),
    removalsText: [...removals.map((x) => x.name), ...(customRemoval ? [customRemoval] : [])].join(', '),
    extrasText: extras.map((x) => `${x.qty}× ${x.name}`).join(', '),
    extrasJson: JSON.stringify(extras.map(({ name, qty, price }) => ({ name, qty, price }))),
    selection: JSON.stringify({ menuItemId: item.id, addonIds: addons.map((a) => a.id), removalIds: removals.map((x) => x.id),
      extras: extras.map(({ id, qty }) => ({ id, qty })), customRemoval })
  };
}

// "Same as last time": opt-in, keyed on e-mail (hashed) + place, needs the name too when read back
function saveFavorite(r, o, remember) {
  const ek = emailHash(o.email);
  if (remember) {
    db.prepare(`
      INSERT INTO favorites (email_hash, place_id, name_lc, item_name, addons, removals, custom, extras, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(email_hash, place_id) DO UPDATE SET name_lc = excluded.name_lc, item_name = excluded.item_name,
        addons = excluded.addons, removals = excluded.removals, custom = excluded.custom, extras = excluded.extras, updated_at = excluded.updated_at
    `).run(ek, r.place_id, o.customerName.toLowerCase(), o.item.name, JSON.stringify(o.addons.map((a) => a.name)),
      JSON.stringify(o.removals.map((x) => x.name)), o.customRemoval, JSON.stringify(o.extras.map(({ name, qty }) => ({ name, qty }))), new Date().toISOString());
  } else {
    db.prepare('DELETE FROM favorites WHERE email_hash = ? AND place_id = ?').run(ek, r.place_id);
  }
}

app.post('/api/rounds/:slug/orders', (req, res) => {
  const r = getRoundBySlug(req.params.slug);
  if (!r) return res.status(404).json({ error: T(req, 'Sambeställningen finns inte (längre).', 'This group order no longer exists.') });
  if (!r.is_open) return res.status(400).json({ error: T(req, 'Beställningen är stängd.', 'Ordering is closed.') });
  if (!orderRateOk(req)) return res.status(429).json({ error: T(req, 'För många beställningar på kort tid. Vänta en stund.', 'Too many orders in a short time. Please wait a moment.') });
  const o = buildOrder(req, r);
  if (o.error) return res.status(400).json({ error: o.error });

  // Number per round, never reused (a deleted #3 stays a gap)
  const payToken = newToken();
  let nr;
  db.transaction(() => {
    nr = db.prepare('SELECT next_nr FROM rounds WHERE id = ?').get(r.id).next_nr;
    db.prepare('UPDATE rounds SET next_nr = next_nr + 1 WHERE id = ?').run(r.id);
    db.prepare(`
      INSERT INTO orders (round_id, nr, customer_name, email, item_name, base_price, addons_text, removals_text, extras_text, extras,
                          selection, lang, total_price, pay_token, confirmed_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(r.id, nr, o.customerName, o.email, o.item.name, o.item.price, o.addonsText, o.removalsText, o.extrasText, o.extrasJson,
      o.selection, langOf(req), o.totalPrice, payToken, r.reminder_sent_at ? new Date().toISOString() : null, new Date().toISOString());
  })();
  saveFavorite(r, o, req.body.remember);

  // Pay before: the order page shows Swish right away, and the same payment info is mailed
  if (r.pay_mode === 'before' && mailConfigured) {
    const row = db.prepare('SELECT * FROM orders WHERE pay_token = ?').get(payToken);
    payMail(row, r, '')
      .then((m) => sendMail({ to: row.email, subject: m.subject, text: m.text, html: m.html, attachments: m.attachments }))
      .then(() => db.prepare('UPDATE orders SET pay_mail_at = ? WHERE id = ?').run(new Date().toISOString(), row.id))
      .catch((e) => console.error(`Betalmejl #${row.nr}:`, e.message));
  }

  res.status(201).json({
    nr, editToken: payToken, closeAt: r.close_at,
    payMode: r.pay_mode, payToken: r.pay_mode === 'before' ? payToken : undefined, mailConfigured,
    customerName: o.customerName, email: o.email, title: roundTitle(r), foodEta: r.food_eta, eventDate: r.event_date,
    isToday: r.event_date === todayStr(), reminderAt: r.reminder_sent_at ? null : r.reminder_at, confirm: Boolean(r.confirm),
    itemName: o.item.name, addonsText: o.addonsText, removalsText: o.removalsText, extrasText: o.extrasText, totalPrice: o.totalPrice
  });
});

// ---------- Edit / cancel own order (link shown after ordering; works while the round is open) ----------
const orderByToken = (t) => db.prepare('SELECT * FROM orders WHERE pay_token = ?').get(clean(t, 64));
function ownOrderView(o, r) {
  return {
    nr: o.nr, cancelled: Boolean(o.cancelled_at), canEdit: Boolean(r.is_open), closeAt: r.close_at, slug: r.slug,
    customerName: o.customer_name, email: o.email, text: orderTextFull(o), totalPrice: o.total_price,
    selection: o.selection ? JSON.parse(o.selection) : null, creatorName: r.creator_name
  };
}
app.get('/api/order/:token', (req, res) => {
  const o = orderByToken(req.params.token);
  const r = o && getRoundById(o.round_id);
  if (!o || !r) return res.status(404).json({ error: T(req, 'Beställningen hittades inte. Rundan kan vara avslutad.', 'Order not found. The round may have ended.') });
  res.json(ownOrderView(o, r));
});
app.put('/api/order/:token', (req, res) => {
  const old = orderByToken(req.params.token);
  const r = old && getRoundById(old.round_id);
  if (!old || !r) return res.status(404).json({ error: T(req, 'Beställningen hittades inte.', 'Order not found.') });
  if (!r.is_open) return res.status(400).json({ error: T(req, `Beställningen är stängd – kontakta ${r.creator_name}.`, `Ordering is closed – contact ${r.creator_name}.`) });
  const o = buildOrder(req, r);
  if (o.error) return res.status(400).json({ error: o.error });
  db.prepare(`
    UPDATE orders SET customer_name = ?, email = ?, item_name = ?, base_price = ?, addons_text = ?, removals_text = ?, extras_text = ?,
      extras = ?, selection = ?, total_price = ?, final_price = NULL, cancelled_at = NULL, lang = ?, updated_at = ? WHERE id = ?
  `).run(o.customerName, o.email, o.item.name, o.item.price, o.addonsText, o.removalsText, o.extrasText, o.extrasJson, o.selection,
    o.totalPrice, langOf(req), new Date().toISOString(), old.id);
  saveFavorite(r, o, req.body.remember);
  res.json(ownOrderView(orderByToken(req.params.token), r));
});
app.post('/api/order/:token/cancel', (req, res) => {
  const o = orderByToken(req.params.token);
  const r = o && getRoundById(o.round_id);
  if (!o || !r) return res.status(404).json({ error: T(req, 'Beställningen hittades inte.', 'Order not found.') });
  if (!r.is_open) return res.status(400).json({ error: T(req, `Beställningen är stängd – kontakta ${r.creator_name}.`, `Ordering is closed – contact ${r.creator_name}.`) });
  db.prepare('UPDATE orders SET cancelled_at = ?, confirmed_at = NULL WHERE id = ?').run(new Date().toISOString(), o.id);
  res.json(ownOrderView(orderByToken(req.params.token), r));
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
  const { menu, drinks, addons, removals } = menuFor(r.place_id);
  const item = menu.find((m) => m.name === f.item_name);
  if (!item) return res.json({ found: false });
  const pick = (list, names) => list.filter((x) => JSON.parse(names).includes(x.name) && optionFits(x, item.id)).map((x) => x.id);
  const favExtras = JSON.parse(f.extras || '[]').map((e) => ({ d: drinks.find((x) => x.name === e.name), qty: e.qty })).filter((e) => e.d);
  res.json({
    found: true, itemName: f.item_name, menuItemId: item.id,
    addonIds: pick(addons, f.addons), removalIds: pick(removals, f.removals), custom: f.custom, updatedAt: f.updated_at,
    extras: favExtras.map((e) => ({ id: e.d.id, qty: e.qty })),
    label: [f.item_name, JSON.parse(f.addons).join(', '), [...JSON.parse(f.removals), ...(f.custom ? [f.custom] : [])].join(', ')].filter(Boolean).join(' - ') +
      (favExtras.length ? ` + ${favExtras.map((e) => `${e.qty}× ${e.d.name}`).join(', ')}` : '')
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

app.get('/api/info', (req, res) => res.json({ favoriteDays: FAVORITE_DAYS, purgeDays: PURGE_DAYS, backupDays: BACKUP_DAYS, mailConfigured, createPin: Boolean(CREATE_PIN) }));

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
    orderText: orderTextFull(o), amount: sw.amount, estimated: o.total_price, paid: mo.isPaid || o.cancelled_at != null,
    food: mo.food, share: mo.share, sharedLabel: r.shared_label, alreadyPaid: mo.paid, owed: mo.owed,
    swishNumber: r.swish_number, swishMessage: sw.message, swishAppUrl: sw.appUrl, qrSvg
  });
});

// Confirm / cancel page (link in the reminder). GET only reads; the change needs a POST from the page,
// so mail scanners that open links can't confirm or cancel anyone.
function answerView(o, r) {
  return {
    orderNumber: o.nr, customerName: o.customer_name, title: roundTitle(r), placeName: r.place_name,
    eventDate: r.event_date, foodEta: r.food_eta, orderText: orderTextFull(o), editLink: `/r/${r.slug}/andra/${o.pay_token}`,
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
      addons_text: o.addons_text, removals_text: o.removals_text, extras_text: o.extras_text, extras: JSON.parse(o.extras || '[]'),
      updated_at: o.updated_at, total_price: o.total_price,
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

// ---------- Mail templates: plain white, logo image, just the facts. Swedish or English per recipient. ----------
const FONT = "'Nunito Sans',Helvetica,Arial,sans-serif";
const SLAB = "Bitter,Rockwell,Georgia,'Times New Roman',serif";
const M = (lang, sv, en) => (lang === 'en' ? en : sv);

function mailLayout(bodyHtml, lang = 'sv') {
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="color-scheme" content="light"></head>
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
const orderBox = (o) => box(`<strong>#${o.nr}</strong> ${escHtml(orderTextFull(o))}`);
const extraHtml = (extra) => (extra ? `<p style="margin:14px 0">${escHtml(extra).replace(/\n/g, '<br>')}</p>` : '');
const link = (href, text) => `<a href="${escHtml(href)}" style="color:#f53b57;font-weight:700">${escHtml(text)}</a>`;
const btn = (href, text, bg) => `<a href="${escHtml(href)}" style="display:inline-block;background:${bg};color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:700;margin:0 8px 8px 0">${escHtml(text)}</a>`;
const editLink = (o, r) => `${PUBLIC_URL}/r/${r.slug}/andra/${o.pay_token}`;

function createdMail(r) {
  const L = r.lang || 'sv';
  const m = manageRound(r);
  const subject = M(L, `Din sambeställning: ${roundTitle(r)} (PIN ${r.pin})`, `Your group order: ${roundTitle(r)} (PIN ${r.pin})`);
  const text = [
    M(L, `Hej ${r.creator_name}!`, `Hi ${r.creator_name}!`), '',
    M(L, `Din sambeställning "${roundTitle(r)}" (${r.place_name}) är igång.`, `Your group order "${roundTitle(r)}" (${r.place_name}) is up.`), '',
    M(L, `Dela länken: ${m.link}`, `Share the link: ${m.link}`),
    M(L, `Hantera: ${m.manageLink}`, `Manage: ${m.manageLink}`),
    `PIN: ${r.pin}`,
    ...(r.event_date !== todayStr() ? ['', `${M(L, 'Datum', 'Date')}: ${dateL(r.event_date, L)}`] : []),
    ...(r.close_at ? ['', M(L, `Beställningen stängs automatiskt ${dayTimeL(r.close_at, L)}.`, `Ordering closes automatically ${dayTimeL(r.close_at, L)}.`)] : []),
    ...(r.reminder_at ? [M(L, `Påminnelse${r.confirm ? ' (med bekräfta/avboka)' : ''} skickas ${dayTimeL(r.reminder_at, L)}.`,
      `Reminder${r.confirm ? ' (with confirm/cancel)' : ''} is sent ${dayTimeL(r.reminder_at, L)}.`)] : []),
    ...(r.mail_orders ? [M(L, 'Du får orderlistan mejlad när den stängs.', 'You get the order list by mail when it closes.')] : [])
  ].join('\n');
  const html = mailLayout(`
    <p style="margin:0 0 6px">${M(L, 'Hej', 'Hi')} ${escHtml(r.creator_name)}!</p>
    <p style="margin:0">${M(L, 'Din sambeställning', 'Your group order')} <strong>${escHtml(roundTitle(r))}</strong> (${escHtml(r.place_name)}) ${M(L, 'är igång.', 'is up.')}</p>
    ${box(`${M(L, 'Dela länken', 'Share the link')}:<br>${link(m.link, m.link)}`)}
    <p style="margin:6px 0">${M(L, 'Hantera rundan', 'Manage the round')}: ${link(m.manageLink, M(L, 'öppna admin', 'open admin'))}<br>
      PIN: <strong style="font-family:${SLAB};font-size:20px;letter-spacing:2px">${escHtml(r.pin)}</strong></p>
    ${r.event_date !== todayStr() ? `<p style="margin:10px 0 0">${M(L, 'Datum', 'Date')}: <strong>${escHtml(dateL(r.event_date, L))}</strong></p>` : ''}
    ${r.close_at ? `<p style="margin:10px 0 0">${M(L, 'Beställningen stängs automatiskt', 'Ordering closes automatically')} <strong>${escHtml(dayTimeL(r.close_at, L))}</strong>.</p>` : ''}
    ${r.reminder_at ? `<p style="margin:4px 0 0">${M(L, `Påminnelse${r.confirm ? ' (med bekräfta/avboka)' : ''} skickas`, `Reminder${r.confirm ? ' (with confirm/cancel)' : ''} is sent`)} ${escHtml(dayTimeL(r.reminder_at, L))}.</p>` : ''}
    ${r.mail_orders ? `<p style="margin:4px 0 0">${M(L, 'Du får orderlistan mejlad när den stängs.', 'You get the order list by mail when it closes.')}</p>` : ''}`, L);
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

// To the creator. The lines are what the restaurant gets, so they stay as typed in the menu.
function orderListMail(r, orders) {
  const L = r.lang || 'sv';
  const m = manageRound(r);
  const subject = M(L, `Orderlista: ${roundTitle(r)} (${orders.length} st)`, `Order list: ${roundTitle(r)} (${orders.length})`);
  const lines = orders.map(orderLine);
  const groups = groupLines(orders);
  const drinks = drinkLines(orders);
  const drinkHead = M(L, 'Dricka (hämtas själv)', 'Drinks (pick up yourself)');
  const text = [
    `${M(L, 'Orderlista', 'Order list')} – ${roundTitle(r)} (${r.place_name})`, '',
    ...(lines.length ? lines : [M(L, 'Inga beställningar.', 'No orders.')]),
    ...(drinks.length ? ['', `${drinkHead}:`, ...drinks] : []),
    ...(groups.length ? ['', `${M(L, 'Sammanställt', 'Summary')}:`, ...groups] : []),
    '', `${M(L, 'Hantera', 'Manage')}: ${m.manageLink}  (PIN ${r.pin})`
  ].join('\n');
  const html = mailLayout(`
    <p style="margin:0">${M(L, 'Beställningen', 'The order')} <strong>${escHtml(roundTitle(r))}</strong> (${escHtml(r.place_name)}) ${M(L, 'är stängd', 'is closed')} – ${orders.length} ${M(L, 'st', 'orders')}.</p>
    ${box(lines.length ? lines.map(escHtml).join('<br>') : M(L, 'Inga beställningar.', 'No orders.'))}
    ${drinks.length ? `<p style="margin:14px 0 4px;color:#5b6570">${drinkHead}</p>${box(drinks.map(escHtml).join('<br>'))}` : ''}
    ${groups.length ? `<p style="margin:14px 0 4px;color:#5b6570">${M(L, 'Sammanställt', 'Summary')}</p>${box(groups.map(escHtml).join('<br>'))}` : ''}
    <p style="margin:14px 0 0">${link(m.manageLink, M(L, 'Hantera rundan', 'Manage the round'))} · PIN ${escHtml(r.pin)}</p>`, L);
  return { subject, text, html };
}

function reminderMail(o, r) {
  const L = o.lang || 'sv';
  const answer = `${PUBLIC_URL}/svar/${o.pay_token}`;
  const when = r.event_date === todayStr() ? M(L, 'idag', 'today') : dateL(r.event_date, L);
  const subject = `${r.confirm ? M(L, 'Bekräfta: ', 'Confirm: ') : M(L, 'Påminnelse: ', 'Reminder: ')}${roundTitle(r)} ${when}`;
  const text = [
    M(L, `Hej ${o.customer_name}!`, `Hi ${o.customer_name}!`), '',
    M(L, `Påminnelse: du har beställt mat från ${r.place_name} ${when}`, `Reminder: you have ordered food from ${r.place_name} ${when}`) + (r.food_eta ? ` (${M(L, 'ca', 'approx.')} ${r.food_eta}).` : '.'),
    `#${o.nr} ${orderTextFull(o)}`, '',
    ...(r.confirm
      ? [M(L, `Bekräfta eller avboka här: ${answer}`, `Confirm or cancel here: ${answer}`),
        ...(r.close_at ? [M(L, `Svara senast ${dayTimeL(r.close_at, L)}.`, `Answer by ${dayTimeL(r.close_at, L)}.`)] : [])]
      : [M(L, `Kan du inte? Avboka här: ${answer}`, `Can't make it? Cancel here: ${answer}`)]),
    `${M(L, 'Ändra beställningen', 'Change your order')}: ${editLink(o, r)}`,
    '', `/${r.creator_name}`
  ].join('\n');
  const html = mailLayout(`
    <p style="margin:0 0 6px">${M(L, 'Hej', 'Hi')} ${escHtml(o.customer_name)}!</p>
    <p style="margin:0">${M(L, 'Påminnelse: du har beställt mat från', 'Reminder: you have ordered food from')} <strong>${escHtml(r.place_name)}</strong> <strong>${escHtml(when)}</strong>${r.food_eta ? ` (${M(L, 'ca', 'approx.')} ${escHtml(r.food_eta)})` : ''}.</p>
    ${orderBox(o)}
    ${r.confirm
      ? `<p style="margin:14px 0 10px">${M(L, 'Står du fast vid beställningen?', 'Still want it?')}${r.close_at ? ` ${M(L, 'Svara senast', 'Answer by')} <strong>${escHtml(dayTimeL(r.close_at, L))}</strong>.` : ''}</p>
         <div>${btn(answer + '?a=ja', M(L, 'Bekräfta', 'Confirm'), '#05c46b')}${btn(answer + '?a=nej', M(L, 'Avboka', 'Cancel'), '#f53b57')}</div>`
      : `<p style="margin:14px 0 0;color:#5b6570">${M(L, 'Kan du inte?', "Can't make it?")} ${link(answer + '?a=nej', M(L, 'Avboka här', 'Cancel here'))}.</p>`}
    <p style="margin:10px 0 0;color:#5b6570">${link(editLink(o, r), M(L, 'Ändra beställningen', 'Change your order'))}</p>
    <p style="margin:14px 0 0">/${escHtml(r.creator_name)}</p>`, L);
  return { subject, text, html };
}

function foodMail(o, r, extra) {
  const L = o.lang || 'sv';
  const subject = `${M(L, 'Maten är här!', 'The food is here!')} – ${roundTitle(r)}`;
  const text = [
    M(L, `Hej ${o.customer_name}!`, `Hi ${o.customer_name}!`), '',
    M(L, `Maten från ${r.place_name} har kommit.`, `The food from ${r.place_name} has arrived.`), `#${o.nr} ${orderTextFull(o)}`,
    ...(extra ? ['', extra] : []), '', M(L, 'Smaklig måltid!', 'Enjoy your meal!')
  ].join('\n');
  const html = mailLayout(`
    <p style="margin:0 0 6px">${M(L, 'Hej', 'Hi')} ${escHtml(o.customer_name)}!</p>
    <p style="margin:0">${M(L, 'Maten från', 'The food from')} <strong>${escHtml(r.place_name)}</strong> ${M(L, 'har kommit.', 'has arrived.')}</p>
    ${orderBox(o)}
    ${extraHtml(extra)}
    <p style="margin:14px 0 0">${M(L, 'Smaklig måltid!', 'Enjoy your meal!')}</p>`, L);
  return { subject, text, html };
}

async function payMail(o, r, extra, isReminder = false) {
  const L = o.lang || 'sv';
  const mo = money(o, sharesFor(r.id));
  const sw = swishFor(o, r, mo.outstanding);
  const payLink = `${PUBLIC_URL}/pay/${o.pay_token}`;
  const changed = o.final_price != null && o.final_price !== o.total_price;
  const subject = `${isReminder ? M(L, 'Påminnelse – ', 'Reminder – ') : ''}${M(L, 'Att betala', 'To pay')}: ${sw.amount} kr – ${roundTitle(r)}`;
  const label = r.shared_label || M(L, 'Gemensam kostnad', 'Shared cost');
  const parts = [
    ...(mo.share || mo.paid ? [[`${M(L, 'Mat', 'Food')}${changed ? M(L, ' (enligt kvittot)', ' (per receipt)') : ''}`, `${mo.food} kr`]] : []),
    ...(mo.share ? [[`${label} (${M(L, 'din del', 'your share')})`, `${mo.share} kr`]] : []),
    ...(mo.paid ? [[M(L, 'Redan betalt', 'Already paid'), `−${mo.paid} kr`]] : [])
  ];
  const changedTxt = M(L, `Justerat efter kvittot – menypriset var ${o.total_price} kr.`, `Adjusted to the receipt – the menu price was ${o.total_price} kr.`);
  const qrPng = await QRCode.toBuffer(sw.qrText, { type: 'png', width: 360, margin: 2, errorCorrectionLevel: 'M' });
  const text = [
    M(L, `Hej ${o.customer_name}!`, `Hi ${o.customer_name}!`), '',
    ...(isReminder ? [M(L, 'Påminnelse: vi har inte fått din betalning än.', "Reminder: we haven't received your payment yet."), ''] : []),
    M(L, `Att betala för maten från ${r.place_name}: ${sw.amount} kr`, `To pay for the food from ${r.place_name}: ${sw.amount} kr`),
    `#${o.nr} ${orderTextFull(o)}`,
    ...parts.map(([a, b]) => `  ${a}: ${b}`),
    ...(changed ? [`(${changedTxt})`] : []),
    '', `${M(L, 'Swisha till', 'Swish to')}: ${r.swish_number}`, `${M(L, 'Meddelande', 'Message')}: ${sw.message}`, '',
    `${M(L, 'QR-kod och Swish-knapp', 'QR code and Swish button')}: ${payLink}`,
    ...(extra ? ['', extra] : []), '', M(L, 'Tack!', 'Thanks!')
  ].join('\n');
  const html = mailLayout(`
    <p style="margin:0 0 6px">${M(L, 'Hej', 'Hi')} ${escHtml(o.customer_name)}!</p>
    <p style="margin:0">${isReminder ? M(L, 'Påminnelse – vi har inte fått din betalning än. ', "Reminder – we haven't received your payment yet. ") : ''}${M(L, 'Här är vad du ska betala för maten från', 'Here is what you owe for the food from')} <strong>${escHtml(r.place_name)}</strong>.</p>
    ${orderBox(o)}
    ${parts.length ? `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 6px;font-size:14px;color:#5b6570">
      ${parts.map(([a, b]) => `<tr><td style="padding:2px 16px 2px 0">${escHtml(a)}</td><td style="padding:2px 0;text-align:right">${escHtml(b)}</td></tr>`).join('')}</table>` : ''}
    <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:6px 0 4px;font-size:15px">
      <tr><td style="padding:3px 16px 3px 0;color:#5b6570">${M(L, 'Belopp', 'Amount')}</td>
          <td style="padding:3px 0;font-family:${SLAB};font-weight:700;font-size:22px">${sw.amount} kr</td></tr>
      <tr><td style="padding:3px 16px 3px 0;color:#5b6570">${M(L, 'Swish till', 'Swish to')}</td><td style="padding:3px 0"><strong>${escHtml(r.swish_number)}</strong></td></tr>
      <tr><td style="padding:3px 16px 3px 0;color:#5b6570">${M(L, 'Meddelande', 'Message')}</td><td style="padding:3px 0">${escHtml(sw.message)}</td></tr>
    </table>
    ${changed ? `<p style="margin:2px 0 0;color:#5b6570;font-size:13px">${changedTxt}</p>` : ''}
    <div style="margin:22px 0 6px">
      <img src="cid:swishqr" width="180" height="180" alt="Swish QR" style="display:block;border:0;width:180px;height:180px">
      <div style="color:#5b6570;font-size:13px;margin-top:4px">${M(L, 'Skanna med Swish-appen', 'Scan with the Swish app')}</div>
    </div>
    <p style="margin:16px 0">${M(L, 'På mobilen', 'On your phone')}: ${link(payLink, M(L, 'öppna betalningssidan', 'open the payment page'))} ${M(L, 'och tryck på "Öppna Swish".', 'and tap "Open Swish".')}</p>
    ${extraHtml(extra)}
    <p style="margin:14px 0 0">${M(L, 'Tack!', 'Thanks!')}</p>`, L);
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
// Webhook texts, per hook language (L = 'sv' | 'en')
const EVENT_TEXT = {
  'round.created': (r, x, L = 'sv') => `🍕 ${r.creator_name} ${M(L, 'startar en sambeställning', 'is starting a group order')}: ${roundTitle(r)}` +
    `${r.name ? ` (${[r.place_name, r.location_name].filter(Boolean).join(', ')})` : r.location_name ? ` (${r.location_name})` : ''}` +
    `${r.company_name ? ` ${M(L, 'för', 'for')} ${r.company_name}` : ''}` +
    `${r.event_date !== todayStr() ? ` ${M(L, 'för', 'for')} ${dateL(r.event_date, L)}` : ''}${r.close_at ? ` – ${M(L, 'beställ senast', 'order by')} ${dayTimeL(r.close_at, L)}` : ''}`,
  'round.closed': (r, x, L = 'sv') => {
    const n = db.prepare('SELECT COUNT(*) AS n FROM orders WHERE round_id = ? AND cancelled_at IS NULL').get(r.id).n;
    return `🔒 ${roundTitle(r)} ${M(L, `är stängd – ${n} beställningar.`, `is closed – ${n} orders.`)}`;
  },
  'food.arrived': (r, x, L = 'sv') => `🍽️ ${M(L, `Maten från ${r.place_name} är här!`, `The food from ${r.place_name} is here!`)} (${roundTitle(r)})${x && x.extra ? ` ${x.extra}` : ''}`
};
const getHooks = () => { try { return JSON.parse(getSetting('webhooks', '[]')); } catch { return []; } };

function hookPayload(format, event, r, text, lang = 'sv') {
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
          actions: event === 'food.arrived' ? [] : [{ type: 'Action.OpenUrl', title: M(lang, 'Öppna sambeställningen', 'Open the group order'), url: link }]
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
  const text = EVENT_TEXT[event](r, extra, h.lang === 'en' ? 'en' : 'sv');
  const res = await fetch(h.url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(hookPayload(h.format, event, r, text, h.lang)), signal: AbortSignal.timeout(8000)
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
    places: db.prepare('SELECT id, name, location_id, phone, address, url, note FROM places ORDER BY name COLLATE NOCASE').all(),
    menuItems: db.prepare('SELECT id, place_id, name, price, category FROM menu_items ORDER BY name COLLATE NOCASE').all(),
    options: db.prepare('SELECT id, place_id, kind, name, price, applies_to FROM place_options ORDER BY kind, id').all()
      .map((o) => ({ ...o, applies_to: o.applies_to ? JSON.parse(o.applies_to) : null })),
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
    const cleanUrl = (u) => { const v = clean(u, 300); return !v || /^https?:\/\//i.test(v) ? v : 'https://' + v; };
    for (const [k, max] of [['phone', 40], ['address', 120], ['note', 200]]) {
      if (k in req.body) db.prepare(`UPDATE places SET ${k} = ? WHERE id = ?`).run(clean(req.body[k], max), id);
    }
    if ('url' in req.body) db.prepare('UPDATE places SET url = ? WHERE id = ?').run(cleanUrl(req.body.url), id);
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

// ---------- Paste a menu ----------
// Sections: [Rätter] [Dricka] [Tillval] [Bortval] (or English). Lines: "Vesuvio 115", "Coca-Cola 33 cl – 25 kr".
// Without a section: "+Extra ost 15" = add-on, "-Utan lök" = removal, otherwise a dish. The price is the last number.
const SECTIONS = {
  main: /^(rätter|rätt|mat|meny|huvudrätter|dishes|food|mains?)$/i,
  drink: /^(dricka|drycker|dryck|drinks?|beverages?)$/i,
  addon: /^(tillval|extra|add-?ons?|extras)$/i,
  removal: /^(bortval|utan|remove|removals|leave out)$/i
};
function parseMenu(text) {
  let section = 'main';
  const out = { main: [], drink: [], addon: [], removal: [], skipped: [] };
  for (const raw of String(text || '').split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    const head = line.match(/^\[?\s*([^\]]+?)\s*\]?\s*:?$/);
    if (/^\[.*\]$/.test(line) || (head && Object.values(SECTIONS).some((re) => re.test(head[1])) && !/\d/.test(line))) {
      const name = head ? head[1] : line;
      const hit = Object.entries(SECTIONS).find(([, re]) => re.test(name));
      if (hit) { section = hit[0]; continue; }
    }
    let kind = section;
    if (section === 'main' && /^\+/.test(line)) { kind = 'addon'; line = line.slice(1).trim(); }
    else if (section === 'main' && /^[-–]\s*\D/.test(line)) { kind = 'removal'; line = line.replace(/^[-–]\s*/, ''); }
    // last number (115 / 115 kr / 115:- / 115,00)
    const m = line.match(/^(.*?)[\s.;:,–\-|]*?(\d+)(?:[.,]\d{1,2})?\s*(?:kr|sek|:-|-)?\s*$/i);
    let name = line, price = null;
    if (m && m[1].trim()) { name = m[1].replace(/[\s.;:,–\-|]+$/, '').trim(); price = Number(m[2]); }
    name = name.slice(0, 80);
    if (!name) { out.skipped.push(raw.trim()); continue; }
    if ((kind === 'main' || kind === 'drink') && price === null) { out.skipped.push(raw.trim()); continue; }
    out[kind].push({ name, price: kind === 'removal' ? 0 : (price ?? 0) });
  }
  return out;
}
app.post('/api/admin/places/:id/import', requireAdmin, (req, res) => {
  const id = toInt(req.params.id);
  if (!db.prepare('SELECT 1 FROM places WHERE id = ?').get(id)) return res.status(404).json({ error: T(req, 'Stället finns inte.', 'Place not found.') });
  const parsed = parseMenu(req.body.text);
  if (req.body.dryRun) return res.json(parsed);
  db.transaction(() => {
    if (req.body.replace) {
      db.prepare('DELETE FROM menu_items WHERE place_id = ?').run(id);
      db.prepare('DELETE FROM place_options WHERE place_id = ?').run(id);
    }
    for (const k of ['main', 'drink']) for (const x of parsed[k]) db.prepare('INSERT INTO menu_items (place_id, name, price, category) VALUES (?, ?, ?, ?)').run(id, x.name, x.price, k);
    for (const k of ['addon', 'removal']) for (const x of parsed[k]) db.prepare('INSERT INTO place_options (place_id, kind, name, price) VALUES (?, ?, ?, ?)').run(id, k, x.name, x.price);
  })();
  res.json({ ok: true, ...parsed });
});

app.post('/api/admin/menu', requireAdmin, (req, res) => {
  const placeId = toInt(req.body.placeId);
  const name = clean(req.body.name, 80);
  const price = toInt(req.body.price);
  if (!placeId || !name || Number.isNaN(price) || price < 0) return res.status(400).json({ error: 'Namn och pris krävs.' });
  const category = req.body.category === 'drink' ? 'drink' : 'main';
  const info = db.prepare('INSERT INTO menu_items (place_id, name, price, category) VALUES (?, ?, ?, ?)').run(placeId, name, price, category);
  res.status(201).json({ id: Number(info.lastInsertRowid) });
});

app.patch('/api/admin/menu/:id', requireAdmin, (req, res) => {
  const name = clean(req.body.name, 80);
  const price = toInt(req.body.price);
  if (!name || Number.isNaN(price) || price < 0) return res.status(400).json({ error: 'Namn och pris krävs.' });
  db.prepare('UPDATE menu_items SET name = ?, price = ? WHERE id = ?').run(name, price, toInt(req.params.id));
  if ('category' in req.body) db.prepare('UPDATE menu_items SET category = ? WHERE id = ?').run(req.body.category === 'drink' ? 'drink' : 'main', toInt(req.params.id));
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

// Which dishes an add-on/removal applies to: list of menu item ids, or null/[] = all dishes
app.patch('/api/admin/options/:id', requireAdmin, (req, res) => {
  const id = toInt(req.params.id);
  const opt = db.prepare('SELECT place_id FROM place_options WHERE id = ?').get(id);
  if (!opt) return res.status(404).json({ error: 'Finns inte.' });
  const ids = Array.isArray(req.body.appliesTo) ? req.body.appliesTo.map(toInt)
    .filter((x) => db.prepare("SELECT 1 FROM menu_items WHERE id = ? AND place_id = ? AND category = 'main'").get(x, opt.place_id)) : [];
  db.prepare('UPDATE place_options SET applies_to = ? WHERE id = ?').run(ids.length ? JSON.stringify(ids) : null, id);
  res.json({ ok: true });
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
      url, format: HOOK_FORMATS.includes(h.format) ? h.format : 'json', lang: h.lang === 'en' ? 'en' : 'sv',
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
    await postHook({ url, format: HOOK_FORMATS.includes(req.body.format) ? req.body.format : 'json', lang: req.body.lang === 'en' ? 'en' : 'sv' }, 'round.created', fake);
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

// ---------- Daily backup into <data>/backups, kept BACKUP_DAYS days ----------
const BACKUP_DIR = path.join(path.dirname(DB_PATH), 'backups');
async function autoBackup() {
  if (!BACKUP_DAYS) return;
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const file = path.join(BACKUP_DIR, `sammat-${todayStr()}.db`);
  if (!fs.existsSync(file)) {
    await db.backup(file);
    fs.chmodSync(file, 0o600);
    console.log(`Backup: ${file}`);
  }
  const cutoff = addDays(todayStr(), -BACKUP_DAYS);
  for (const f of fs.readdirSync(BACKUP_DIR)) {
    const m = f.match(/^sammat-(\d{4}-\d{2}-\d{2})\.db$/);
    if (m && m[1] <= cutoff) fs.unlinkSync(path.join(BACKUP_DIR, f));
  }
}

autoClose();
autoPurge();
autoBackup().catch((e) => console.error('Backup:', e.message));
setInterval(() => autoBackup().catch((e) => console.error('Backup:', e.message)), 3600 * 1000).unref();
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
