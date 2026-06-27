'use strict';

const { Client } = require('basic-ftp');
const { Writable } = require('stream');
const config = require('./config');

/** Crée et connecte un client FTP. À fermer avec client.close(). */
async function connect() {
  const client = new Client(30000);
  client.ftp.verbose = false;
  await client.access({
    host: config.ftp.host,
    port: config.ftp.port,
    user: config.ftp.user,
    password: config.ftp.password,
    secure: config.ftp.secure,
    secureOptions: { rejectUnauthorized: false },
  });
  return client;
}

/** Liste les fichiers du dossier source qui correspondent au pattern. */
async function listFiles(client) {
  const pattern = new RegExp(config.ftp.filePattern, 'i');
  const list = await client.list(config.ftp.dir);
  return list
    .filter((f) => f.isFile && pattern.test(f.name))
    .map((f) => ({ name: f.name, size: f.size }));
}

/** Télécharge un fichier distant et renvoie son contenu en texte. */
async function downloadText(client, filename) {
  const chunks = [];
  const sink = new Writable({
    write(chunk, _enc, cb) { chunks.push(chunk); cb(); },
  });
  const remotePath = joinRemote(config.ftp.dir, filename);
  await client.downloadTo(sink, remotePath);
  return Buffer.concat(chunks).toString('utf8');
}

/** Liste les petits fichiers du dossier /global (candidats validations de paiement). */
async function listGlobal(client) {
  const list = await client.list(config.ftp.globalDir);
  return list
    .filter((f) => f.isFile && f.size <= config.ftp.globalMaxSize)
    .map((f) => ({ name: f.name, size: f.size }));
}

/** Télécharge un fichier d'un dossier arbitraire et renvoie son contenu texte. */
async function downloadTextFrom(client, dir, filename) {
  const chunks = [];
  const sink = new Writable({ write(chunk, _enc, cb) { chunks.push(chunk); cb(); } });
  await client.downloadTo(sink, joinRemote(dir, filename));
  return Buffer.concat(chunks).toString('utf8');
}

/** Déplace un fichier traité vers le dossier d'archive (le crée si besoin). */
async function archiveFile(client, filename) {
  await ensureDir(client, config.ftp.archiveDir);
  const from = joinRemote(config.ftp.dir, filename);
  const to = joinRemote(config.ftp.archiveDir, filename);
  await client.rename(from, to);
}

/** Supprime un fichier traité. */
async function deleteFile(client, filename) {
  await client.remove(joinRemote(config.ftp.dir, filename));
}

async function ensureDir(client, dir) {
  // ensureDir change le répertoire courant ; on le restaure ensuite.
  await client.ensureDir(dir);
  await client.cd('/');
}

function joinRemote(a, b) {
  return (a.replace(/\/+$/, '') + '/' + b.replace(/^\/+/, '')).replace(/\/{2,}/g, '/');
}

/** Test de connexion simple (pour l'interface). */
async function testConnection() {
  let client;
  try {
    client = await connect();
    const files = await listFiles(client);
    return { ok: true, count: files.length, files: files.map((f) => f.name).slice(0, 20) };
  } finally {
    if (client) client.close();
  }
}

module.exports = { connect, listFiles, downloadText, listGlobal, downloadTextFrom, archiveFile, deleteFile, testConnection };
