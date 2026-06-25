'use strict';

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const config = require('./config');

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

  CREATE INDEX IF NOT EXISTS idx_attempts_bscrc ON attempts(bscrc);
  CREATE INDEX IF NOT EXISTS idx_resa_status ON reservations(final_status);
`);

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
    INSERT INTO attempts (bscrc, filename, status, error_code, error_message, amount, booking_id, recorded, seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.bscrc, filename, data.status, data.errorCode, data.errorMessage,
    data.amount, data.bookingId, data.recorded, now
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
  let sql = 'SELECT * FROM reservations';
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
  return db.prepare(sql).all(...params);
}

function getReservation(bscrc) {
  const resa = db.prepare('SELECT * FROM reservations WHERE bscrc = ?').get(bscrc);
  if (!resa) return null;
  const att = db.prepare('SELECT * FROM attempts WHERE bscrc = ? ORDER BY seen_at ASC').all(bscrc);
  return { ...resa, attempts_list: att };
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

module.exports = {
  db, alreadyProcessed, upsertFromParse, recordFile,
  listReservations, getReservation, stats, listFiles,
};
