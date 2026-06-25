'use strict';

const express = require('express');
const path = require('path');
const cron = require('node-cron');
const config = require('./config');
const apiRouter = require('./routes/api');
const { runScan } = require('./processor');

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
  console.log('');
});
