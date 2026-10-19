'use strict';
/*
 * Vinayaka Car Rentals - website + API
 *
 * Local:   node server.js            -> http://localhost:3000  (data saved in data/db.json)
 * Vercel:  api/index.js uses handle() below; data is saved in Upstash Redis.
 *
 * Optional env vars: PORT, ADMIN_KEY (enables /admin.html), DB_FILE,
 *   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN  (or KV_REST_API_URL + KV_REST_API_TOKEN)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PUBLIC_DIR = path.join(__dirname, 'public');
const config = require('./data/config.json');
const PRICE = config.pricing;
const places = require('./data/places.json').map((p) => ({
  ...p,
  id: p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
}));
const placeById = new Map(places.map((p) => [p.id, p]));

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'db.json');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/* ---------- storage: a tiny key-value layer with two back-ends ---------- */
function fileStore(file) {
  let d = { kv: {}, sets: {} };
  try { d = { ...d, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch (_) { /* first run */ }
  const save = () => {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
    fs.renameSync(tmp, file);
  };
  const live = (k) => {
    const e = d.kv[k];
    if (!e) return undefined;
    if (e.exp && e.exp < Date.now()) { delete d.kv[k]; return undefined; }
    return e;
  };
  return {
    async get(k) { const e = live(k); return e ? e.v : null; },
    async set(k, v, ttlSec) { d.kv[k] = { v, exp: ttlSec ? Date.now() + ttlSec * 1000 : 0 }; save(); },
    async setnx(k, v) { if (live(k)) return false; d.kv[k] = { v, exp: 0 }; save(); return true; },
    async del(k) { delete d.kv[k]; save(); },
    async sadd(s, m) { const a = (d.sets[s] = d.sets[s] || []); if (!a.includes(m)) { a.push(m); save(); } },
    async smembers(s) { return [...(d.sets[s] || [])]; },
    async mget(keys) { return keys.map((k) => { const e = live(k); return e ? e.v : null; }); },
  };
}

function upstashStore(url, token) {
  async function cmd(args) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error('Database error: ' + (j.error || r.status));
    return j.result;
  }
  const parse = (s) => (s == null ? null : JSON.parse(s));
  return {
    async get(k) { return parse(await cmd(['GET', k])); },
    async set(k, v, ttlSec) { const a = ['SET', k, JSON.stringify(v)]; if (ttlSec) a.push('EX', String(ttlSec)); await cmd(a); },
    async setnx(k, v) { return (await cmd(['SET', k, JSON.stringify(v), 'NX'])) === 'OK'; },
    async del(k) { await cmd(['DEL', k]); },
    async sadd(s, m) { await cmd(['SADD', s, m]); },
    async smembers(s) { return (await cmd(['SMEMBERS', s])) || []; },
    async mget(keys) { return keys.length ? (await cmd(['MGET', ...keys])).map(parse) : []; },
  };
}

let store;
function getStore() {
  if (store) return store;
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (url && token) store = upstashStore(url, token);
  else if (process.env.VERCEL) throw new HttpError(503, 'The database is not connected yet. In Vercel open Storage and connect Upstash Redis to this project, then redeploy.');
  else store = fileStore(DB_FILE);
  return store;
}
const kv = new Proxy({}, { get: (_, m) => (...a) => getStore()[m](...a) });

async function loadBookings(ids) {
  const rows = await kv.mget(ids.map((i) => 'booking:' + i));
  return rows.filter(Boolean);
}
const allBookings = async () => loadBookings(await kv.smembers('bookings'));
const byNewest = (a, b) => (a.createdAt < b.createdAt ? 1 : -1);

/* ---------- helpers ---------- */
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function checkPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const a = Buffer.from(hash, 'hex');
  const b = crypto.scryptSync(pw, salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const normPhone = (p) => String(p || '').replace(/[\s\-()]/g, '').replace(/^(\+91|91|0)(?=\d{10}$)/, '');
const validPhone = (p) => /^[6-9]\d{9}$/.test(p);
const todayIST = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
const validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const clean = (s, max) => String(s || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);

const attempts = new Map();
function rateLimit(key, max = 10, windowMs = 15 * 60 * 1000) {
  const now = Date.now();
  const rec = attempts.get(key);
  if (!rec || rec.reset < now) { attempts.set(key, { count: 1, reset: now + windowMs }); return; }
  rec.count += 1;
  if (rec.count > max) throw new HttpError(429, 'Too many attempts. Please try again after some time.');
}

/* ---------- fare calculation ---------- */
function computeFare(place, days, tripType, mode) {
  const oneWay = place.km;
  const totalKm = tripType === 'oneway' ? oneWay : oneWay * 2;
  const isTransfer = oneWay <= PRICE.transferMaxKm && days === 1;
  const out = { days, tripType, mode, distanceKm: oneWay, totalKm, lines: [], total: 0, deposit: 0 };

  if (mode === 'self') {
    const limit = days * PRICE.selfKmLimitPerDay;
    const extraKm = Math.max(0, totalKm - limit);
    out.lines.push({ label: `Self drive rent (${days} day${days > 1 ? 's' : ''} × ₹${PRICE.selfDrivePerDay})`, amount: days * PRICE.selfDrivePerDay });
    if (extraKm > 0) out.lines.push({ label: `Extra ${extraKm} km beyond ${limit} km limit (× ₹${PRICE.selfExtraPerKm})`, amount: extraKm * PRICE.selfExtraPerKm });
    out.includedKm = limit;
    out.billableKm = totalKm;
    out.deposit = PRICE.selfDeposit;
  } else if (isTransfer) {
    const raw = totalKm * PRICE.transferRatePerKm;
    out.billableKm = totalKm;
    out.lines.push({ label: `${totalKm} km × ₹${PRICE.transferRatePerKm}`, amount: raw });
    if (raw < PRICE.minTransferFare) out.lines.push({ label: 'Minimum fare adjustment', amount: PRICE.minTransferFare - raw });
  } else {
    const billable = Math.max(totalKm, days * PRICE.minKmPerDay);
    out.billableKm = billable;
    out.lines.push({
      label: billable > totalKm
        ? `${billable} km (minimum ${PRICE.minKmPerDay} km/day) × ₹${PRICE.ratePerKm}`
        : `${billable} km × ₹${PRICE.ratePerKm}`,
      amount: billable * PRICE.ratePerKm,
    });
    out.lines.push({ label: `Driver bata (${days} day${days > 1 ? 's' : ''} × ₹${PRICE.driverBataPerDay})`, amount: days * PRICE.driverBataPerDay });
  }
  out.total = Math.round(out.lines.reduce((s, l) => s + l.amount, 0));
  return out;
}

function parseTrip(b) {
  const place = placeById.get(String(b.placeId || ''));
  if (!place) throw new HttpError(400, 'Please choose a valid destination.');
  const days = Number(b.days);
  if (!Number.isInteger(days) || days < 1 || days > config.maxDays) throw new HttpError(400, `Days must be between 1 and ${config.maxDays}.`);
  const tripType = b.tripType === 'oneway' ? 'oneway' : 'round';
  const mode = b.mode === 'self' ? 'self' : 'driver';
  return { place, days, tripType, mode };
}

/* ---------- auth ---------- */
const bearer = (req) => (/^Bearer (.+)$/.exec(req.headers.authorization || '') || [])[1];
async function currentUser(req) {
  const t = bearer(req);
  if (!t) return null;
  const s = await kv.get('sess:' + sha(t));
  return s ? kv.get('user:' + s.userId) : null;
}
async function requireUser(req) {
  const u = await currentUser(req);
  if (!u) throw new HttpError(401, 'Please log in to continue.');
  return u;
}
function requireAdmin(req) {
  const key = String(req.headers['x-admin-key'] || '');
  const ok = ADMIN_KEY && key.length === ADMIN_KEY.length && crypto.timingSafeEqual(Buffer.from(key), Buffer.from(ADMIN_KEY));
  if (!ok) throw new HttpError(403, ADMIN_KEY ? 'Wrong admin key.' : 'Admin is disabled. Set the ADMIN_KEY environment variable.');
}
async function newSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await kv.set('sess:' + sha(token), { userId }, 30 * 24 * 3600);
  return token;
}
const publicUser = (u) => ({ id: u.id, name: u.name, phone: u.phone, email: u.email || '' });

/* ---------- email to the owner when a booking is made ---------- */
// Needs env vars: RESEND_API_KEY and OWNER_EMAIL (optional: MAIL_FROM). If missing, booking still works.
async function emailOwner(b) {
  const key = process.env.RESEND_API_KEY;
  const to = process.env.OWNER_EMAIL;
  if (!key || !to) { console.warn('Owner email skipped: set RESEND_API_KEY and OWNER_EMAIL'); return; }
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const rows = [
    ['Booking ID', b.id],
    ['Customer name', b.name],
    ['Mobile', b.phone],
    ['Destination', 'Jadcherla → ' + b.placeName + ' (' + b.state + ')'],
    ['Trip type', b.tripType === 'oneway' ? 'One-way drop' : 'Round trip'],
    ['Driver', b.mode === 'self' ? 'Self drive' : 'With driver'],
    ['Dates', b.startDate + ' to ' + b.endDate + ' (' + b.days + ' day' + (b.days > 1 ? 's' : '') + ')'],
    ['Passengers', b.passengers],
    ['Pickup place', b.pickupPoint],
    ['Estimated fare', '₹' + b.fare],
    ['Deposit (self drive)', b.deposit ? '₹' + b.deposit : '-'],
    ['Notes', b.notes || '-'],
  ];
  const html = '<h2>New booking request - ' + esc(b.id) + '</h2><table cellpadding="6" style="border-collapse:collapse">' +
    rows.map((r) => '<tr><td style="border:1px solid #ddd"><b>' + esc(r[0]) + '</b></td><td style="border:1px solid #ddd">' + esc(r[1]) + '</td></tr>').join('') +
    '</table><p>Open /admin.html to confirm or reject this booking.</p>';
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.MAIL_FROM || 'Vinayaka Car Rentals <onboarding@resend.dev>',
        to: [to],
        subject: 'New booking ' + b.id + ' - ' + b.placeName + ' - ₹' + b.fare,
        html,
      }),
      signal: ctl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) console.error('Owner email failed:', r.status, await r.text());
  } catch (e) {
    console.error('Owner email error:', e.message);
  }
}

/* ---------- WhatsApp alert to the owner ---------- */
// Free option (CallMeBot). Needs env vars: CALLMEBOT_PHONE (owner number with country code, e.g. 919876543210)
// and CALLMEBOT_APIKEY. If missing, it is skipped and the booking still works.
function bookingText(b) {
  return [
    'NEW BOOKING ' + b.id,
    'Name: ' + b.name,
    'Mobile: ' + b.phone,
    'Trip: Jadcherla -> ' + b.placeName + ' (' + (b.tripType === 'oneway' ? 'one-way' : 'round trip') + ')',
    'Driver: ' + (b.mode === 'self' ? 'Self drive' : 'With driver'),
    'Dates: ' + b.startDate + ' to ' + b.endDate + ' (' + b.days + ' day' + (b.days > 1 ? 's' : '') + ')',
    'Passengers: ' + b.passengers,
    'Pickup: ' + b.pickupPoint,
    'Fare: Rs.' + b.fare + (b.deposit ? ' + deposit Rs.' + b.deposit : ''),
    b.notes ? 'Notes: ' + b.notes : '',
  ].filter(Boolean).join('\n');
}

async function whatsappOwner(b) {
  const phone = String(process.env.CALLMEBOT_PHONE || '').replace(/\D/g, '');
  const apikey = process.env.CALLMEBOT_APIKEY;
  if (!phone || !apikey) { console.warn('WhatsApp alert skipped: set CALLMEBOT_PHONE and CALLMEBOT_APIKEY'); return; }
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    const u = 'https://api.callmebot.com/whatsapp.php?phone=' + encodeURIComponent('+' + phone) +
      '&text=' + encodeURIComponent(bookingText(b)) + '&apikey=' + encodeURIComponent(apikey);
    const r = await fetch(u, { signal: ctl.signal });
    clearTimeout(timer);
    if (!r.ok) console.error('WhatsApp alert failed:', r.status, await r.text());
  } catch (e) {
    console.error('WhatsApp alert error:', e.message);
  }
}

// Click-to-chat link: opens WhatsApp to the owner with the booking details already typed.
function ownerWhatsAppLink(b) {
  let num = String(config.whatsapp || config.phone || '').replace(/\D/g, '');
  if (num.length === 10) num = '91' + num;
  return 'https://wa.me/' + num + '?text=' + encodeURIComponent(bookingText(b));
}

async function notifyOwner(b) {
  await Promise.allSettled([whatsappOwner(b), emailOwner(b)]);
}

/* ---------- API routes ---------- */
const routes = [];
const route = (method, pattern, handler) => routes.push({ method, re: new RegExp('^' + pattern + '$'), handler });

route('GET', '/api/config', () => ({
  brand: config.brand, tagline: config.tagline, phone: config.phone, whatsapp: config.whatsapp,
  carName: config.carName, baseCity: config.baseCity, maxPassengers: config.maxPassengers,
  daysOptions: config.daysOptions, maxDays: config.maxDays, priceNotes: config.priceNotes,
  pricing: PRICE,
}));

route('GET', '/api/places', () => places.map(({ id, name, state, km, popular }) => ({ id, name, state, km, popular: !!popular })));

route('POST', '/api/quote', (req, body) => {
  const { place, days, tripType, mode } = parseTrip(body);
  const quote = computeFare(place, days, tripType, mode);
  const timeline = config.daysOptions.map((d) => {
    const q = computeFare(place, d, tripType, mode);
    return { days: d, total: q.total, billableKm: q.billableKm };
  });
  return { place: { id: place.id, name: place.name, state: place.state, km: place.km }, quote, timeline };
});

route('GET', '/api/booked', async () => {
  const today = todayIST();
  return (await allBookings()).filter((b) => b.status === 'confirmed' && b.endDate >= today).map((b) => ({ start: b.startDate, end: b.endDate }));
});

route('POST', '/api/signup', async (req, body, ctx) => {
  rateLimit('signup:' + ctx.ip, 10);
  const name = clean(body.name, 60);
  const phone = normPhone(body.phone);
  const email = clean(body.email, 100).toLowerCase();
  const password = String(body.password || '');
  if (name.length < 2) throw new HttpError(400, 'Please enter your name.');
  if (!validPhone(phone)) throw new HttpError(400, 'Enter a valid 10-digit mobile number.');
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Enter a valid email or leave it blank.');
  if (password.length < 6 || password.length > 100) throw new HttpError(400, 'Password must be at least 6 characters.');
  const id = crypto.randomUUID();
  if (!(await kv.setnx('phone:' + phone, id))) throw new HttpError(409, 'This mobile number is already registered. Please log in.');
  const user = { id, name, phone, email, passwordHash: hashPassword(password), createdAt: new Date().toISOString() };
  await kv.set('user:' + id, user);
  return { token: await newSession(id), user: publicUser(user) };
});

route('POST', '/api/login', async (req, body, ctx) => {
  const phone = normPhone(body.phone);
  rateLimit('login:' + ctx.ip + ':' + phone, 10);
  const id = await kv.get('phone:' + phone);
  const user = id ? await kv.get('user:' + id) : null;
  if (!user || !checkPassword(String(body.password || ''), user.passwordHash)) throw new HttpError(401, 'Wrong mobile number or password.');
  return { token: await newSession(user.id), user: publicUser(user) };
});

route('POST', '/api/logout', async (req) => {
  const t = bearer(req);
  if (t) await kv.del('sess:' + sha(t));
  return { ok: true };
});

route('GET', '/api/me', async (req) => ({ user: publicUser(await requireUser(req)) }));

route('POST', '/api/bookings', async (req, body) => {
  const user = await requireUser(req);
  const { place, days, tripType, mode } = parseTrip(body);
  const startDate = String(body.startDate || '');
  if (!validDate(startDate)) throw new HttpError(400, 'Please choose the pickup date.');
  if (startDate < todayIST()) throw new HttpError(400, 'Pickup date cannot be in the past.');
  const passengers = Number(body.passengers);
  if (!Number.isInteger(passengers) || passengers < 1 || passengers > config.maxPassengers) throw new HttpError(400, `Passengers must be between 1 and ${config.maxPassengers}.`);
  const name = clean(body.name, 60);
  const phone = normPhone(body.phone);
  if (name.length < 2) throw new HttpError(400, 'Please enter the passenger name.');
  if (!validPhone(phone)) throw new HttpError(400, 'Enter a valid 10-digit mobile number.');
  const endDate = addDays(startDate, days - 1);
  const existing = await allBookings();
  if (existing.some((b) => b.status === 'confirmed' && startDate <= b.endDate && endDate >= b.startDate)) {
    throw new HttpError(409, 'Sorry, the car is already booked for some of these dates. Please choose other dates or call us.');
  }
  const q = computeFare(place, days, tripType, mode);
  const booking = {
    id: '', userId: user.id, name, phone,
    placeId: place.id, placeName: place.name, state: place.state, distanceKm: place.km,
    tripType, mode, days, startDate, endDate, passengers,
    pickupPoint: clean(body.pickupPoint, 120) || config.baseCity,
    notes: clean(body.notes, 300),
    fare: q.total, deposit: q.deposit, status: 'pending', createdAt: new Date().toISOString(),
  };
  for (let i = 0; i < 5; i++) {
    booking.id = 'VCR-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    if (await kv.setnx('booking:' + booking.id, booking)) break;
    if (i === 4) throw new Error('Could not create booking id');
  }
  await kv.sadd('bookings', booking.id);
  await kv.sadd('ubookings:' + user.id, booking.id);
  await notifyOwner(booking); // must finish before replying, otherwise Vercel may stop the function
  return { booking, whatsappLink: ownerWhatsAppLink(booking) };
});

route('GET', '/api/my-bookings', async (req) => {
  const user = await requireUser(req);
  const list = await loadBookings(await kv.smembers('ubookings:' + user.id));
  return { bookings: list.sort(byNewest) };
});

route('POST', '/api/bookings/([A-Z0-9-]+)/cancel', async (req, body, ctx) => {
  const user = await requireUser(req);
  const b = await kv.get('booking:' + ctx.params[0]);
  if (!b || b.userId !== user.id) throw new HttpError(404, 'Booking not found.');
  if (b.status !== 'pending' && b.status !== 'confirmed') throw new HttpError(400, 'This booking cannot be cancelled.');
  b.status = 'cancelled';
  await kv.set('booking:' + b.id, b);
  return { booking: b };
});

route('GET', '/api/admin/bookings', async (req) => {
  requireAdmin(req);
  return { bookings: (await allBookings()).sort(byNewest) };
});

route('POST', '/api/admin/bookings/([A-Z0-9-]+)/status', async (req, body, ctx) => {
  requireAdmin(req);
  const b = await kv.get('booking:' + ctx.params[0]);
  if (!b) throw new HttpError(404, 'Booking not found.');
  if (!['pending', 'confirmed', 'rejected', 'completed', 'cancelled'].includes(body.status)) throw new HttpError(400, 'Invalid status.');
  if (body.status === 'confirmed') {
    const others = await allBookings();
    if (others.some((o) => o.id !== b.id && o.status === 'confirmed' && b.startDate <= o.endDate && b.endDate >= o.startDate)) {
      throw new HttpError(409, 'Dates overlap with another confirmed booking.');
    }
  }
  b.status = body.status;
  await kv.set('booking:' + b.id, b);
  return { booking: b };
});

/* ---------- HTTP plumbing ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp',
};
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

function readBody(req) {
  // Vercel has usually parsed the JSON body already (req.body); locally we read the stream.
  if (req.body !== undefined && req.body !== null) {
    if (Buffer.isBuffer(req.body)) req = { ...req, body: req.body.toString('utf8') };
    if (typeof req.body === 'string') {
      if (!req.body) return Promise.resolve({});
      try { return Promise.resolve(JSON.parse(req.body)); } catch (_) { return Promise.reject(new HttpError(400, 'Invalid JSON.')); }
    }
    return Promise.resolve(req.body);
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 20000) { reject(new HttpError(413, 'Request too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (_) { reject(new HttpError(400, 'Invalid JSON.')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SEC_HEADERS });
  res.end(JSON.stringify(obj));
}

function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch (_) { res.writeHead(400); return res.end('Bad request'); }
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
      ...SEC_HEADERS,
    });
    res.end(data);
  });
}

async function handle(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    let pathname = url.pathname;
    const fwdPath = url.searchParams.get('__path');
    if (fwdPath !== null) pathname = '/api/' + fwdPath.replace(/^\/+/, '');
    if (pathname.length > 5 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);

    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
      return serveStatic(req, res, pathname);
    }
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(pathname);
      if (!m) continue;
      const body = req.method === 'POST' ? await readBody(req) : {};
      const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      const ctx = { params: m.slice(1), ip: fwd || (req.socket && req.socket.remoteAddress) || '' };
      return sendJson(res, 200, await r.handler(req, body, ctx));
    }
    sendJson(res, 404, { error: 'Not found.' });
  } catch (e) {
    if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
    console.error(e);
    sendJson(res, 500, { error: 'Something went wrong. Please try again.' });
  }
}

if (require.main === module) {
  http.createServer(handle).listen(PORT, () => {
    console.log(`Vinayaka Car Rentals running at http://localhost:${PORT}`);
    console.log(ADMIN_KEY ? 'Admin page: /admin.html' : 'Admin page disabled. Start with ADMIN_KEY=yourSecret node server.js to enable /admin.html');
  });
}
module.exports = handle;
module.exports.handle = handle;
module.exports.computeFare = computeFare;
module.exports.places = places;