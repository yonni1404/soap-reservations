'use strict';

const express = require('express');
const db = require('../db');
const ftp = require('../ftp');
const config = require('../config');
const { runScan, isScanning, getLastScan } = require('../processor');

const router = express.Router();

router.get('/stats', (req, res) => {
  res.json({ ...db.stats(), scanning: isScanning(), lastScan: getLastScan() });
});

router.get('/reservations', (req, res) => {
  const { status, search } = req.query;
  res.json(db.listReservations({ status, search }));
});

router.get('/reservations/:bscrc', (req, res) => {
  const r = db.getReservation(req.params.bscrc);
  if (!r) return res.status(404).json({ error: 'Réservation introuvable' });
  res.json(r);
});

router.get('/files', (req, res) => {
  res.json(db.listFiles());
});

// Contenu brut d'un fichier traité (pour l'affichage dans le détail)
router.get('/files/raw', (req, res) => {
  const f = db.getFileRaw(req.query.name);
  if (!f) return res.status(404).json({ error: 'Fichier introuvable' });
  res.json(f);
});

router.post('/scan', async (req, res) => {
  const result = await runScan({ trigger: 'manuel' });
  res.json(result);
});

router.get('/ftp/test', async (req, res) => {
  if (!config.ftpConfigured) {
    return res.status(400).json({ ok: false, error: 'FTP non configuré (.env).' });
  }
  try {
    res.json(await ftp.testConnection());
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/config', (req, res) => {
  res.json({
    ftpConfigured: config.ftpConfigured,
    afterProcess: config.afterProcess,
    schedule: config.schedule,
    ftpDir: config.ftp.dir,
    archiveDir: config.ftp.archiveDir,
  });
});

// Export CSV des réservations
router.get('/export.csv', (req, res) => {
  const rows = db.listReservations(req.query);
  const cols = [
    'bscrc', 'booking_id', 'dossier_id', 'tx_time', 'email', 'tel',
    'payment_method', 'payment_type', 'payment_provider', 'payment_id', 'amount', 'will_pay_offsite',
    'final_status', 'error_code', 'error_message', 'attempts', 'has_divergence',
    'first_seen', 'last_update',
  ];
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [cols.join(';')];
  for (const r of rows) lines.push(cols.map((c) => esc(r[c])).join(';'));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="reservations-soap.csv"');
  res.send('﻿' + lines.join('\r\n')); // BOM pour Excel
});

module.exports = router;
