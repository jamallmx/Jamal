import express from 'express';
import multer from 'multer';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, transaction } from './db.js';
import { sha256, buildPayload, sealOf, appendLedger, verifyRental } from './seal.js';
import { SLOTS, LANGS, translator } from './i18n.js';
import * as views from './views.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));
const SESSION_DAYS = 30;
const IMAGE_TYPES = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/heif': '.heif',
};
const CONTENT_TYPES = Object.fromEntries(Object.entries(IMAGE_TYPES).map(([type, ext]) => [ext, type]));
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

class HttpError extends Error {
  constructor(status, key) {
    super(key);
    this.status = status;
    this.key = key;
  }
}

const token = (bytes = 24) => randomBytes(bytes).toString('base64url');
const now = () => new Date().toISOString();
const clean = (value, max) => String(value ?? '').trim().slice(0, max);

function hashPassword(password) {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(password, salt, 64).toString('hex')}`;
}

function checkPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(password, Buffer.from(salt, 'hex'), 64);
  return timingSafeEqual(expected, actual);
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function decodeSignature(dataUrl) {
  const prefix = 'data:image/png;base64,';
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(prefix)) return null;
  const buf = Buffer.from(dataUrl.slice(prefix.length), 'base64');
  if (buf.length < 100 || buf.length > 1_000_000 || !buf.subarray(0, 8).equals(PNG_MAGIC)) return null;
  return buf;
}

export function createApp({ dataDir }) {
  dataDir = path.resolve(dataDir);
  const uploadsDir = path.join(dataDir, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });
  const db = openDb(path.join(dataDir, 'mahdar.db'));

  const storeFile = (buf, ext) => {
    const hash = sha256(buf);
    const file = path.join(uploadsDir, hash + ext);
    if (!fs.existsSync(file)) fs.writeFileSync(file, buf, { flag: 'wx' });
    return hash;
  };

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024, files: 30, fieldSize: 1_500_000 },
    fileFilter: (req, file, cb) =>
      IMAGE_TYPES[file.mimetype] ? cb(null, true) : cb(new HttpError(400, 'err_file_type')),
  }).fields([...SLOTS.map((slot) => ({ name: `photo_${slot}`, maxCount: 1 })), { name: 'photo_extra', maxCount: 20 }]);

  const app = express();
  app.set('trust proxy', true);
  app.disable('x-powered-by');
  app.use('/static', express.static(PUBLIC_DIR, { maxAge: '1h' }));
  app.use(express.urlencoded({ extended: false, limit: '3mb' }));

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    req.cookies = parseCookies(req.headers.cookie);
    if (req.cookies.sid) {
      const row = db
        .prepare(
          `SELECT s.token, s.csrf, shops.id, shops.name, shops.email FROM sessions s
           JOIN shops ON shops.id = s.shop_id WHERE s.token = ? AND s.expires_at > ?`
        )
        .get(req.cookies.sid, now());
      if (row) {
        req.session = { token: row.token, csrf: row.csrf };
        req.shop = { id: row.id, name: row.name, email: row.email };
      }
    }
    next();
  });

  // Shop staff default to Arabic; customers (often tourists) default to English.
  const ctx = (req, fallbackLang = 'ar') => {
    const lang = LANGS.includes(req.cookies?.lang) ? req.cookies.lang : fallbackLang;
    return { lang, t: translator(lang), shop: req.shop, csrf: req.session?.csrf, path: req.originalUrl };
  };

  const startSession = (req, res, shopId) => {
    const sid = token(32);
    const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
    db.prepare('INSERT INTO sessions (token, shop_id, csrf, expires_at) VALUES (?, ?, ?, ?)').run(
      sid,
      shopId,
      token(),
      expires.toISOString()
    );
    res.cookie('sid', sid, { httpOnly: true, sameSite: 'lax', secure: req.secure, expires });
  };

  const requireShop = (req, res, next) => (req.shop ? next() : res.redirect('/login'));
  const requireCsrf = (req, res, next) => {
    const sent = String(req.body?._csrf ?? '');
    const ok =
      req.session && sent.length === req.session.csrf.length && timingSafeEqual(Buffer.from(sent), Buffer.from(req.session.csrf));
    return ok ? next() : next(new HttpError(403, 'forbidden'));
  };

  const ownRental = (req) => {
    const rental = db.prepare('SELECT * FROM rentals WHERE id = ? AND shop_id = ?').get(Number(req.params.id), req.shop.id);
    if (!rental) throw new HttpError(404, 'not_found');
    return rental;
  };
  const publicRental = (req) => {
    const rental = db.prepare('SELECT * FROM rentals WHERE public_token = ?').get(req.params.token);
    if (!rental) throw new HttpError(404, 'not_found');
    return rental;
  };
  const inspectionsOf = (rental) => db.prepare('SELECT * FROM inspections WHERE rental_id = ? ORDER BY id').all(rental.id);
  const publicUrl = (req, rental) => `${req.protocol}://${req.get('host')}/r/${rental.public_token}`;

  app.get('/', (req, res) => (req.shop ? res.redirect('/dashboard') : res.send(views.landing(ctx(req)))));

  app.get('/lang/:code', (req, res) => {
    const next = String(req.query.next ?? '/');
    if (LANGS.includes(req.params.code)) {
      res.cookie('lang', req.params.code, { sameSite: 'lax', maxAge: 365 * 864e5 });
    }
    res.redirect(next.startsWith('/') && !next.startsWith('//') ? next : '/');
  });

  app.get('/register', (req, res) => res.send(views.register(ctx(req))));
  app.post('/register', (req, res) => {
    const values = { shop_name: clean(req.body.shop_name, 100), email: clean(req.body.email, 200).toLowerCase() };
    const password = String(req.body.password ?? '');
    if (!values.shop_name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email) || password.length < 8) {
      return res.status(400).send(views.register(ctx(req), { error: 'err_register', values }));
    }
    if (db.prepare('SELECT 1 FROM shops WHERE email = ?').get(values.email)) {
      return res.status(400).send(views.register(ctx(req), { error: 'err_email_taken', values }));
    }
    const { lastInsertRowid } = db
      .prepare('INSERT INTO shops (name, email, password_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(values.shop_name, values.email, hashPassword(password), now());
    startSession(req, res, Number(lastInsertRowid));
    res.redirect('/dashboard');
  });

  app.get('/login', (req, res) => res.send(views.login(ctx(req))));
  app.post('/login', (req, res) => {
    const email = clean(req.body.email, 200).toLowerCase();
    const shop = db.prepare('SELECT * FROM shops WHERE email = ?').get(email);
    if (!shop || !checkPassword(String(req.body.password ?? ''), shop.password_hash)) {
      return res.status(401).send(views.login(ctx(req), { error: 'err_login', values: { email } }));
    }
    startSession(req, res, shop.id);
    res.redirect('/dashboard');
  });

  app.post('/logout', requireShop, requireCsrf, (req, res) => {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(req.session.token);
    res.clearCookie('sid');
    res.redirect('/');
  });

  const listRentals = (shopId) =>
    db.prepare('SELECT * FROM rentals WHERE shop_id = ? ORDER BY id DESC LIMIT 200').all(shopId);

  app.get('/dashboard', requireShop, (req, res) => {
    res.send(views.dashboard(ctx(req), { rentals: listRentals(req.shop.id) }));
  });

  app.post('/rentals', requireShop, requireCsrf, (req, res) => {
    const values = {
      asset: clean(req.body.asset, 120),
      customer_name: clean(req.body.customer_name, 120),
      customer_phone: clean(req.body.customer_phone, 30),
    };
    if (!values.asset || !values.customer_name) {
      return res
        .status(400)
        .send(views.dashboard(ctx(req), { rentals: listRentals(req.shop.id), error: 'err_rental', values }));
    }
    const { lastInsertRowid } = db
      .prepare(
        'INSERT INTO rentals (shop_id, public_token, asset, customer_name, customer_phone, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(req.shop.id, token(), values.asset, values.customer_name, values.customer_phone, now());
    res.redirect(`/rentals/${lastInsertRowid}`);
  });

  app.get('/rentals/:id', requireShop, (req, res) => {
    const rental = ownRental(req);
    res.send(views.rental(ctx(req), { rental, inspections: inspectionsOf(rental), publicUrl: publicUrl(req, rental) }));
  });

  const kindAllowed = (rental, kind) =>
    (kind === 'pickup' && rental.status === 'new') || (kind === 'return' && rental.status === 'out');

  app.get('/rentals/:id/inspect/:kind', requireShop, (req, res) => {
    const rental = ownRental(req);
    const { kind } = req.params;
    if (!kindAllowed(rental, kind)) throw new HttpError(400, 'err_order');
    res.send(views.inspectForm(ctx(req), { rental, kind }));
  });

  app.post(
    '/rentals/:id/inspect/:kind',
    requireShop,
    (req, res, next) => upload(req, res, (err) => next(err?.code === 'LIMIT_FILE_SIZE' ? new HttpError(413, 'err_too_large') : err)),
    requireCsrf,
    (req, res) => {
      const rental = ownRental(req);
      const { kind } = req.params;
      if (!kindAllowed(rental, kind)) throw new HttpError(400, 'err_order');
      const fail = (error) => res.status(400).send(views.inspectForm(ctx(req), { rental, kind, error }));

      const files = req.files ?? {};
      const incoming = [
        ...SLOTS.flatMap((slot) => (files[`photo_${slot}`] ?? []).map((f) => ({ slot, f }))),
        ...(files.photo_extra ?? []).map((f) => ({ slot: 'extra', f })),
      ].filter(({ f }) => f.size > 0);
      if (!incoming.length) return fail('err_photos');

      const staffSig = decodeSignature(req.body.staff_signature);
      const customerSig = decodeSignature(req.body.customer_signature);
      if (!staffSig || !customerSig) return fail('err_signatures');

      const photos = incoming.map(({ slot, f }) => {
        const ext = IMAGE_TYPES[f.mimetype];
        return { slot, ext, size: f.size, sha256: storeFile(f.buffer, ext) };
      });
      const staffSigSha = storeFile(staffSig, '.png');
      const customerSigSha = storeFile(customerSig, '.png');
      const reading = clean(req.body.reading, 100);
      const notes = clean(req.body.notes, 2000);

      transaction(db, () => {
        const prev = db
          .prepare('SELECT seal_hash FROM inspections WHERE rental_id = ? ORDER BY id DESC LIMIT 1')
          .get(rental.id);
        const sealedAt = now();
        const payload = buildPayload({
          rental,
          kind,
          reading,
          notes,
          sealedAt,
          photos,
          staffSig: staffSigSha,
          customerSig: customerSigSha,
          prevSeal: prev?.seal_hash ?? null,
        });
        const sealHash = sealOf(payload);
        const { lastInsertRowid } = db
          .prepare(
            `INSERT INTO inspections (rental_id, kind, reading, notes, staff_sig_sha, customer_sig_sha, sealed_at, payload, seal_hash)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(rental.id, kind, reading, notes, staffSigSha, customerSigSha, sealedAt, JSON.stringify(payload), sealHash);
        const insertPhoto = db.prepare('INSERT INTO photos (inspection_id, slot, sha256, ext, size) VALUES (?, ?, ?, ?, ?)');
        for (const p of photos) insertPhoto.run(lastInsertRowid, p.slot, p.sha256, p.ext, p.size);
        appendLedger(db, Number(lastInsertRowid), sealHash);
        db.prepare('UPDATE rentals SET status = ? WHERE id = ?').run(kind === 'pickup' ? 'out' : 'returned', rental.id);
      });
      res.redirect(`/rentals/${rental.id}`);
    }
  );

  // ---- Customer-facing pages: reachable by anyone holding the unguessable link ----

  app.get('/r/:token', (req, res) => {
    const rental = publicRental(req);
    const inspections = inspectionsOf(rental);
    const photosByInspection = Object.fromEntries(
      inspections.map((ins) => [ins.id, db.prepare('SELECT * FROM photos WHERE inspection_id = ? ORDER BY id').all(ins.id)])
    );
    const shopName = db.prepare('SELECT name FROM shops WHERE id = ?').get(rental.shop_id).name;
    res.send(views.report(ctx(req, 'en'), { rental, shopName, inspections, photosByInspection }));
  });

  const sendUpload = (res, name) => {
    res.set('Cache-Control', 'private, max-age=31536000, immutable');
    res.type(CONTENT_TYPES[path.extname(name)] ?? 'application/octet-stream');
    res.sendFile(path.join(uploadsDir, name));
  };

  app.get('/r/:token/photo/:photoId', (req, res) => {
    const rental = publicRental(req);
    const photo = db
      .prepare(
        `SELECT p.* FROM photos p JOIN inspections i ON i.id = p.inspection_id WHERE p.id = ? AND i.rental_id = ?`
      )
      .get(Number(req.params.photoId), rental.id);
    if (!photo) throw new HttpError(404, 'not_found');
    sendUpload(res, photo.sha256 + photo.ext);
  });

  app.get('/r/:token/sig/:inspectionId/:who', (req, res) => {
    const rental = publicRental(req);
    const ins = db
      .prepare('SELECT * FROM inspections WHERE id = ? AND rental_id = ?')
      .get(Number(req.params.inspectionId), rental.id);
    const sha = { staff: ins?.staff_sig_sha, customer: ins?.customer_sig_sha }[req.params.who];
    if (!sha) throw new HttpError(404, 'not_found');
    sendUpload(res, `${sha}.png`);
  });

  app.get('/r/:token/verify', (req, res) => {
    const rental = publicRental(req);
    res.send(views.verify(ctx(req, 'en'), { rental, result: verifyRental(db, uploadsDir, rental) }));
  });

  app.get('/r/:token/verify.json', (req, res) => {
    const rental = publicRental(req);
    const { ok, checks } = verifyRental(db, uploadsDir, rental);
    res.json({ ok, checks });
  });

  app.get('/r/:token/evidence.json', (req, res) => {
    const rental = publicRental(req);
    const inspections = inspectionsOf(rental).map((ins) => ({
      kind: ins.kind,
      payload: JSON.parse(ins.payload),
      seal_hash: ins.seal_hash,
      ledger: db.prepare('SELECT prev_hash, entry_hash, created_at FROM ledger WHERE inspection_id = ?').get(ins.id),
    }));
    res.attachment(`mahdar-${rental.public_token}.json`);
    res.json({
      about: 'seal_hash = sha256 of payload serialized as key-sorted JSON; entry_hash = sha256(prev_hash|seal_hash|created_at)',
      inspections,
    });
  });

  app.use((req, res) => {
    const c = ctx(req);
    res.status(404).send(views.message(c, c.t('not_found'), c.t('not_found')));
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const c = ctx(req, req.path.startsWith('/r/') ? 'en' : 'ar');
    if (err instanceof HttpError) return res.status(err.status).send(views.message(c, c.t(err.key), c.t(err.key)));
    console.error(err);
    res.status(500).send(views.message(c, c.t('server_error'), c.t('server_error')));
  });

  return { app, db };
}
