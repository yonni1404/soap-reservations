'use strict';

const express = require('express');
const path = require('path');
const cron = require('node-cron');
const config = require('./config');
const apiRouter = require('./routes/api');
const auth = require('./auth');
const db = require('./db');
const { runScan } = require('./processor');

auth.init(); // crée le compte au premier démarrage (mot de passe modifiable ensuite)

const app = express();
app.use(express.json());
app.use('/api', apiRouter);
// no-cache : le navigateur revalide à chaque fois → les mises à jour de l'interface
// sont prises en compte par un simple F5 (plus besoin de rechargement forcé)
app.use(express.static(path.join(__dirname, '../public'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

app.listen(config.port, () => {
  console.log(`\n  SOAP-Réservations — interface sur http://localhost:${config.port}`);
  console.log(`  Base de données : ${config.dbPath}`);
  console.log(`  FTP : ${config.ftpConfigured ? config.ftp.host + config.ftp.dir : 'NON CONFIGURÉ (.env)'}`);
  console.log(`  Après traitement : ${config.afterProcess}`);

  if (config.schedule.enabled && config.ftpConfigured) {
    if (cron.validate(config.schedule.cron)) {
      cron.schedule(config.schedule.cron, () => {
        console.log(`[${new Date().toISOString()}] Scan automatique déclenché`);
        runScan({ trigger: 'auto' }).then((s) => {
          console.log(`  → ${s.processed} traité(s), ${s.skipped} ignoré(s), ${s.archived} archivé(s)`);
        });
      });
      console.log(`  Planificateur : actif (${config.schedule.cron})`);
    } else {
      console.warn(`  Planificateur : expression cron invalide (${config.schedule.cron})`);
    }
  } else {
    console.log('  Planificateur : désactivé');
  }

  // Purge automatique (RGPD)
  if (config.purge.enabled && cron.validate(config.purge.cron)) {
    cron.schedule(config.purge.cron, () => {
      const r = db.purgeOlderThan(config.purge.retentionDays);
      console.log(`[${new Date().toISOString()}] Purge RGPD (> ${config.purge.retentionDays} j) : ` +
        `${r.reservations} résa, ${r.files} fichiers, ${r.validations} validations supprimés`);
    });
    console.log(`  Purge RGPD : active (${config.purge.cron}, conservation ${config.purge.retentionDays} j)`);
  } else {
    console.log('  Purge RGPD : désactivée');
  }
  console.log('');
});
