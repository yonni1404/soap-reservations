'use strict';

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { parseSoapFile, maskPII } = require('./parser');

const dir = path.dirname(config.dbPath);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS reservations (
    bscrc            TEXT PRIMARY KEY,
    booking_id       TEXT,
    dossier_id       TEXT,
    id_establishment TEXT,
    id_engine        TEXT,
    user             TEXT,
    email            TEXT,
    tel              TEXT,
    tx_time          TEXT,
    payment_id       TEXT,
    payment_method   TEXT,
    payment_type     TEXT,
    payment_provider TEXT,
    amount           REAL,
    will_pay_offsite INTEGER DEFAULT 0,
    final_status     TEXT,            -- success | error_pms | error_other | pending
    error_code       TEXT,
    error_message    TEXT,
    attempts         INTEGER DEFAULT 0,
    has_divergence   INTEGER DEFAULT 0,
    first_seen       TEXT,
    last_update      TEXT
  );

  CREATE TABLE IF NOT EXISTS attempts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    bscrc        TEXT,
    filename     TEXT,
    status       TEXT,
    error_code   TEXT,
    error_message TEXT,
    amount       REAL,
    booking_id   TEXT,
    recorded     TEXT,
    seen_at      TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS files (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    filename     TEXT UNIQUE,
    bscrc        TEXT,
    status       TEXT,            -- processed | parse_error | archived | deleted | kept
    action       TEXT,            -- archive | delete | keep | none
    message      TEXT,
    raw          TEXT,
    processed_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS payment_validations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    id_booking TEXT,
    method     TEXT,
    provider   TEXT,
    validated  INTEGER,
    tx_time    TEXT,
    filename   TEXT UNIQUE,
    raw        TEXT,
    seen_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS global_seen (
    filename TEXT PRIMARY KEY,
    seen_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_attempts_bscrc ON attempts(bscrc);
  CREATE INDEX IF NOT EXISTS idx_attempts_booking ON attempts(booking_id);
  CREATE INDEX IF NOT EXISTS idx_resa_status ON reservations(final_status);
  CREATE INDEX IF NOT EXISTS idx_pv_booking ON payment_validations(id_booking);
`);

// Migration : colonnes paiement + horodatage par tentative (ajoutées si absentes)
for (const col of ['payment_method TEXT', 'payment_type TEXT', 'will_pay_offsite INTEGER', 'tx_time TEXT', 'payment_provider TEXT']) {
  try { db.exec(`ALTER TABLE attempts ADD COLUMN ${col}`); } catch (_) { /* déjà présente */ }
}
// Marqueur d'anonymisation RGPD sur les réservations
try { db.exec('ALTER TABLE reservations ADD COLUMN anonymized INTEGER DEFAULT 0'); } catch (_) { /* déjà présente */ }

// Backfill : renseigne moyen de paiement + fournisseur + horodatage des tentatives existantes
(function backfillAttempts() {
  const rows = db.prepare(`
    SELECT a.id, f.raw FROM attempts a
    JOIN files f ON f.filename = a.filename
    WHERE a.payment_provider IS NULL
  `).all();
  const upd = db.prepare('UPDATE attempts SET payment_method = ?, payment_type = ?, will_pay_offsite = ?, tx_time = ?, payment_provider = ? WHERE id = ?');
  for (const r of rows) {
    try {
      const { data } = parseSoapFile(r.raw);
      upd.run(data.paymentMethod, data.paymentType, data.willPayOffsite, data.txTime, data.paymentProvider, r.id);
    } catch (_) { /* fichier illisible */ }
  }
})();

// Statut "gagnant" : un succès l'emporte toujours sur une erreur.
const STATUS_RANK = { pending: 0, error_other: 1, error_pms: 1, success: 3 };

function alreadyProcessed(filename) {
  const row = db.prepare('SELECT 1 FROM files WHERE filename = ?').get(filename);
  return Boolean(row);
}

/**
 * Enregistre une tentative et consolide la réservation (dédoublonnage par BScrc).
 * @returns {{isNew: boolean, statusChanged: boolean, divergence: boolean}}
 */
function upsertFromParse(filename, data, raw) {
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO attempts (bscrc, filename, status, error_code, error_message, amount, booking_id, recorded, payment_method, payment_type, will_pay_offsite, tx_time, payment_provider, seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.bscrc, filename, data.status, data.errorCode, data.errorMessage,
    data.amount, data.bookingId, data.recorded,
    data.paymentMethod, data.paymentType, data.willPayOffsite, data.txTime, data.paymentProvider, now
  );

  const existing = db.prepare('SELECT * FROM reservations WHERE bscrc = ?').get(data.bscrc);

  if (!existing) {
    db.prepare(`
      INSERT INTO reservations (
        bscrc, booking_id, dossier_id, id_establishment, id_engine, user,
        email, tel, tx_time, payment_id, payment_method, payment_type, payment_provider,
        amount, will_pay_offsite,
        final_status, error_code, error_message, attempts, has_divergence,
        first_seen, last_update
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)
    `).run(
      data.bscrc, data.bookingId, data.dossierId, data.idEstablishment, data.idEngine, data.user,
      data.email, data.tel, data.txTime, data.paymentId, data.paymentMethod, data.paymentType, data.paymentProvider,
      data.amount, data.willPayOffsite,
      data.status, data.errorCode, data.errorMessage, now, now
    );
    return { isNew: true, statusChanged: false, divergence: false };
  }

  // Consolidation
  const prevRank = STATUS_RANK[existing.final_status] ?? 0;
  const newRank = STATUS_RANK[data.status] ?? 0;
  const upgrade = newRank > prevRank;

  const divergence =
    existing.amount != null && data.amount != null &&
    Math.abs(existing.amount - data.amount) > 0.001;

  const finalStatus = upgrade ? data.status : existing.final_status;
  const errorCode = upgrade ? data.errorCode : existing.error_code;
  const errorMessage = upgrade ? data.errorMessage : existing.error_message;
  const bookingId = data.bookingId || existing.booking_id;
  const dossierId = data.dossierId || existing.dossier_id;

  db.prepare(`
    UPDATE reservations SET
      booking_id = ?, dossier_id = ?, amount = ?,
      email = COALESCE(NULLIF(?, ''), email),
      tel = COALESCE(NULLIF(?, ''), tel),
      tx_time = COALESCE(NULLIF(?, ''), tx_time),
      payment_provider = COALESCE(NULLIF(?, ''), payment_provider),
      final_status = ?, error_code = ?, error_message = ?,
      attempts = attempts + 1,
      has_divergence = CASE WHEN ? = 1 THEN 1 ELSE has_divergence END,
      last_update = ?
    WHERE bscrc = ?
  `).run(
    bookingId, dossierId, data.amount ?? existing.amount,
    data.email, data.tel, data.txTime, data.paymentProvider,
    finalStatus, errorCode, errorMessage,
    divergence ? 1 : 0, now, data.bscrc
  );

  return { isNew: false, statusChanged: upgrade, divergence };
}

// ─── Validations de paiement (/global) ──────────────────────────────────
function globalSeen(filename) {
  return Boolean(db.prepare('SELECT 1 FROM global_seen WHERE filename = ?').get(filename));
}

function markGlobalSeen(filename) {
  db.prepare('INSERT OR IGNORE INTO global_seen (filename, seen_at) VALUES (?, ?)')
    .run(filename, new Date().toISOString());
}

function recordValidation(filename, v, rawMasked) {
  db.prepare(`
    INSERT OR IGNORE INTO payment_validations (id_booking, method, provider, validated, tx_time, filename, raw, seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(v.idBooking, v.method, v.provider, v.validated ? 1 : 0, v.time, filename, rawMasked, new Date().toISOString());
}

// État d'encaissement d'une réservation
function computePayState({ paid, has_virement, providers }) {
  if (paid) return 'paid';                                  // paiement en ligne validé
  if (has_virement) return 'deferred';                      // virement ferme, attente d'encaissement
  const p = (providers || '').toLowerCase();
  if (p.includes('payline')) return 'unpaid';               // Payline attendu mais pas de validation → abandon probable
  if (p.includes('stripe')) return 'stripe_unknown';        // Stripe : validation non disponible sur le FTP
  return 'unknown';
}

function recordFile(filename, { bscrc, status, action, message, raw }) {
  db.prepare(`
    INSERT INTO files (filename, bscrc, status, action, message, raw, processed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(filename) DO UPDATE SET
      bscrc = excluded.bscrc, status = excluded.status, action = excluded.action,
      message = excluded.message, raw = excluded.raw, processed_at = excluded.processed_at
  `).run(filename, bscrc || null, status, action || 'none', message || null, raw || null, new Date().toISOString());
}

// ─── Requêtes pour l'API ────────────────────────────────────────────────
function listReservations({ status, search } = {}) {
  let sql = `SELECT *,
    (SELECT GROUP_CONCAT(DISTINCT payment_method) FROM attempts WHERE attempts.bscrc = reservations.bscrc) AS methods,
    (SELECT COUNT(DISTINCT booking_id) FROM attempts WHERE attempts.bscrc = reservations.bscrc AND booking_id <> '') AS booking_count,
    (SELECT GROUP_CONCAT(DISTINCT payment_provider) FROM attempts WHERE attempts.bscrc = reservations.bscrc) AS providers,
    (SELECT MAX(CASE WHEN will_pay_offsite = 0 THEN 1 ELSE 0 END) FROM attempts WHERE attempts.bscrc = reservations.bscrc) AS has_virement,
    (SELECT MAX(pv.validated) FROM payment_validations pv JOIN attempts a ON a.booking_id = pv.id_booking WHERE a.bscrc = reservations.bscrc) AS paid,
    (SELECT pv.tx_time FROM payment_validations pv JOIN attempts a ON a.booking_id = pv.id_booking WHERE a.bscrc = reservations.bscrc AND pv.validated = 1 LIMIT 1) AS paid_at
    FROM reservations`;
  const where = [];
  const params = [];
  if (status && status !== 'all') { where.push('final_status = ?'); params.push(status); }
  if (search) {
    where.push('(bscrc LIKE ? OR booking_id LIKE ? OR email LIKE ? OR tel LIKE ? OR payment_id LIKE ?)');
    const s = `%${search}%`;
    params.push(s, s, s, s, s);
  }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY last_update DESC LIMIT 1000';
  const rows = db.prepare(sql).all(...params);
  for (const r of rows) r.pay_state = computePayState(r);
  return rows;
}

function getReservation(bscrc) {
  const resa = db.prepare('SELECT * FROM reservations WHERE bscrc = ?').get(bscrc);
  if (!resa) return null;
  // Ordre chronologique réel (horodatage de la transaction), du plus ancien au plus récent
  const att = db.prepare('SELECT * FROM attempts WHERE bscrc = ? ORDER BY tx_time ASC, seen_at ASC').all(bscrc);

  // Regroupe les tentatives par numéro de réservation (bookingId) → 1 ligne par n°
  const byBooking = new Map();
  for (const a of att) {
    const key = a.booking_id || '∅';
    if (!byBooking.has(key)) {
      byBooking.set(key, {
        booking_id: a.booking_id || '',
        payment_method: a.payment_method,
        payment_type: a.payment_type,
        will_pay_offsite: a.will_pay_offsite,
        status: a.status,
        amount: a.amount,
        files: [],
        tx_time: a.tx_time,
        seen_at: a.seen_at,
      });
    }
    byBooking.get(key).files.push(a.filename);
  }
  const bookings = [...byBooking.values()]
    .sort((a, b) => String(a.tx_time || a.seen_at || '').localeCompare(String(b.tx_time || b.seen_at || '')));
  if (bookings.length) bookings[bookings.length - 1].is_last = true; // dernière tentative

  // Validations de paiement liées aux n° de réservation de ce client
  const bookingIds = [...new Set(att.map((a) => a.booking_id).filter(Boolean))];
  let validations = [];
  if (bookingIds.length) {
    const ph = bookingIds.map(() => '?').join(',');
    validations = db.prepare(`SELECT * FROM payment_validations WHERE id_booking IN (${ph})`).all(...bookingIds);
  }
  const vByBooking = new Map(validations.map((v) => [v.id_booking, v]));
  for (const b of bookings) b.validation = vByBooking.get(b.booking_id) || null;

  const paid = validations.some((v) => v.validated);
  const providers = [...new Set(att.map((a) => a.payment_provider).filter(Boolean))].join(',');
  const has_virement = att.some((a) => a.will_pay_offsite === 0) ? 1 : 0;
  const pay_state = computePayState({ paid, has_virement, providers });
  const paid_at = (validations.find((v) => v.validated) || {}).tx_time || null;

  return { ...resa, attempts_list: att, bookings, validations, pay_state, paid_at, providers };
}

function stats() {
  const total = db.prepare('SELECT COUNT(*) c FROM reservations').get().c;
  const byStatus = db.prepare('SELECT final_status, COUNT(*) c FROM reservations GROUP BY final_status').all();
  const filesProcessed = db.prepare('SELECT COUNT(*) c FROM files').get().c;
  const divergences = db.prepare('SELECT COUNT(*) c FROM reservations WHERE has_divergence = 1').get().c;
  const map = { success: 0, error_pms: 0, error_other: 0, pending: 0 };
  for (const r of byStatus) map[r.final_status] = r.c;
  return { total, filesProcessed, divergences, ...map };
}

function listFiles(limit = 200) {
  return db.prepare('SELECT id, filename, bscrc, status, action, message, processed_at FROM files ORDER BY processed_at DESC LIMIT ?').all(limit);
}

function getFileRaw(filename) {
  return db.prepare('SELECT filename, bscrc, status, message, processed_at, raw FROM files WHERE filename = ?').get(filename);
}

// ─── Réglages (auth, etc.) ──────────────────────────────────────────────
function getSetting(key) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : null;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

// ─── Purge RGPD ──────────────────────────────────────────────────────────
// Réservations en erreur (PMS/autre) trop anciennes → ANONYMISÉES (logs gardés, PII retirée).
// Toutes les autres réservations trop anciennes → SUPPRIMÉES totalement.
function purgeOlderThan(days) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const ERR = ['error_pms', 'error_other'];
  let anonymized = 0;
  let deleted = 0;

  const old = db.prepare('SELECT bscrc, final_status, anonymized FROM reservations WHERE last_update < ?').all(cutoff);
  const maskRaw = db.prepare('UPDATE files SET raw = ? WHERE filename = ?');
  for (const r of old) {
    if (ERR.includes(r.final_status)) {
      if (r.anonymized) continue; // déjà anonymisée
      db.prepare("UPDATE reservations SET email = '', tel = '', anonymized = 1 WHERE bscrc = ?").run(r.bscrc);
      const fs = db.prepare('SELECT filename, raw FROM files WHERE bscrc = ?').all(r.bscrc);
      for (const f of fs) if (f.raw) maskRaw.run(maskPII(f.raw), f.filename);
      anonymized++;
    } else {
      eraseClient(r.bscrc); // suppression totale (résa + attempts + files + validations)
      deleted++;
    }
  }

  // Annexes : fichiers /global déjà disparus du FTP, validations et tentatives orphelines
  const globalSeen = db.prepare('DELETE FROM global_seen WHERE seen_at < ?').run(cutoff).changes;
  db.prepare('DELETE FROM attempts WHERE bscrc NOT IN (SELECT bscrc FROM reservations)').run();
  const validations = db.prepare(
    "DELETE FROM payment_validations WHERE seen_at < ? AND id_booking NOT IN (SELECT booking_id FROM attempts WHERE booking_id <> '')"
  ).run(cutoff).changes;

  return { cutoff, anonymized, deleted, globalSeen, validations };
}

// ─── Effacement RGPD : supprime toutes les données d'un client (par bscrc) ─
function eraseClient(bscrc) {
  const resa = db.prepare('SELECT email FROM reservations WHERE bscrc = ?').get(bscrc);
  const bookingIds = db.prepare("SELECT DISTINCT booking_id FROM attempts WHERE bscrc = ? AND booking_id <> ''").all(bscrc).map((x) => x.booking_id);
  for (const id of bookingIds) db.prepare('DELETE FROM payment_validations WHERE id_booking = ?').run(id);
  db.prepare('DELETE FROM files WHERE bscrc = ?').run(bscrc);
  db.prepare('DELETE FROM attempts WHERE bscrc = ?').run(bscrc);
  const del = db.prepare('DELETE FROM reservations WHERE bscrc = ?').run(bscrc).changes;
  return { deleted: del > 0, bscrc, email: resa ? resa.email : null, bookingIds };
}

module.exports = {
  db, alreadyProcessed, upsertFromParse, recordFile,
  listReservations, getReservation, stats, listFiles, getFileRaw,
  globalSeen, markGlobalSeen, recordValidation,
  getSetting, setSetting, purgeOlderThan, eraseClient,
};
