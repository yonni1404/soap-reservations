'use strict';

const config = require('./config');
const ftp = require('./ftp');
const db = require('./db');
const { parseSoapFile } = require('./parser');

let scanning = false;
let lastScan = null;

function isScanning() { return scanning; }
function getLastScan() { return lastScan; }

/**
 * Scanne le FTP, traite chaque fichier non déjà traité, consolide en base
 * et archive/supprime selon la configuration.
 * @returns {Promise<object>} résumé du scan
 */
async function runScan({ trigger = 'manuel' } = {}) {
  if (scanning) {
    return { ok: false, error: 'Un scan est déjà en cours.' };
  }
  if (!config.ftpConfigured) {
    return { ok: false, error: 'FTP non configuré. Renseigne FTP_HOST / FTP_USER dans le fichier .env.' };
  }

  scanning = true;
  const summary = {
    ok: true, trigger, startedAt: new Date().toISOString(),
    found: 0, processed: 0, skipped: 0, parseErrors: 0,
    newReservations: 0, updated: 0, statusUpgrades: 0, divergences: 0,
    archived: 0, deleted: 0, errors: [],
  };

  let client;
  try {
    client = await ftp.connect();
    const files = await ftp.listFiles(client);
    summary.found = files.length;

    for (const f of files) {
      if (db.alreadyProcessed(f.name)) { summary.skipped++; continue; }

      let content;
      try {
        content = await ftp.downloadText(client, f.name);
      } catch (e) {
        summary.errors.push(`${f.name}: téléchargement échoué (${e.message})`);
        continue;
      }

      const { data } = parseSoapFile(content);

      if (!data.bscrc) {
        summary.parseErrors++;
        db.recordFile(f.name, {
          bscrc: null, status: 'parse_error', action: 'none',
          message: 'BScrc introuvable — format non reconnu', raw: content,
        });
        continue; // on ne touche pas au fichier source en cas d'échec de parsing
      }

      const res = db.upsertFromParse(f.name, data, content);
      summary.processed++;
      if (res.isNew) summary.newReservations++; else summary.updated++;
      if (res.statusChanged) summary.statusUpgrades++;
      if (res.divergence) summary.divergences++;

      // Action sur le fichier source
      let action = 'kept';
      let fileStatus = 'kept';
      try {
        if (config.afterProcess === 'archive') {
          await ftp.archiveFile(client, f.name);
          action = 'archive'; fileStatus = 'archived'; summary.archived++;
        } else if (config.afterProcess === 'delete') {
          await ftp.deleteFile(client, f.name);
          action = 'delete'; fileStatus = 'deleted'; summary.deleted++;
        } else {
          action = 'keep'; fileStatus = 'kept';
        }
      } catch (e) {
        summary.errors.push(`${f.name}: action "${config.afterProcess}" échouée (${e.message})`);
      }

      db.recordFile(f.name, {
        bscrc: data.bscrc, status: fileStatus, action,
        message: `${data.status}${res.statusChanged ? ' (statut mis à jour)' : ''}`,
        raw: content,
      });
    }
  } catch (e) {
    summary.ok = false;
    summary.error = e.message;
    summary.errors.push(e.message);
  } finally {
    if (client) client.close();
    scanning = false;
    summary.finishedAt = new Date().toISOString();
    lastScan = summary;
  }

  return summary;
}

module.exports = { runScan, isScanning, getLastScan };
