'use strict';

// Lance un scan FTP unique en ligne de commande puis affiche le résumé.
const { runScan } = require('./processor');

runScan({ trigger: 'cli' }).then((s) => {
  console.log(JSON.stringify(s, null, 2));
  process.exit(s.ok ? 0 : 1);
});
