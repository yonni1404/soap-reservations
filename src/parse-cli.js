'use strict';

// Parse un fichier SOAP local et affiche les données extraites (test du parser).
// Usage : npm run parse -- chemin/vers/fichier.txt
const fs = require('fs');
const { parseSoapFile } = require('./parser');

const file = process.argv[2];
if (!file) {
  console.error('Usage : npm run parse -- <fichier.txt>');
  process.exit(1);
}

const content = fs.readFileSync(file, 'utf8');
const { data } = parseSoapFile(content);
console.log(JSON.stringify(data, null, 2));
