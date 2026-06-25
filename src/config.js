require('dotenv').config();
const path = require('path');

function bool(v, def = false) {
  if (v === undefined || v === null || v === '') return def;
  return ['1', 'true', 'yes', 'oui', 'on'].includes(String(v).toLowerCase());
}

const config = {
  ftp: {
    host: process.env.FTP_HOST || '',
    port: parseInt(process.env.FTP_PORT || '21', 10),
    user: process.env.FTP_USER || '',
    password: process.env.FTP_PASSWORD || '',
    secure: bool(process.env.FTP_SECURE, false),
    dir: process.env.FTP_DIR || '/',
    archiveDir: process.env.FTP_ARCHIVE_DIR || '/traites',
    filePattern: process.env.FTP_FILE_PATTERN || '\\.txt$',
  },
  afterProcess: (process.env.AFTER_PROCESS || 'archive').toLowerCase(), // archive | delete | keep
  schedule: {
    enabled: bool(process.env.SCHEDULE_ENABLED, true),
    cron: process.env.SCHEDULE_CRON || '*/15 * * * *',
  },
  port: parseInt(process.env.PORT || '3010', 10),
  dbPath: path.resolve(process.env.DB_PATH || './data/soap.db'),
};

config.ftpConfigured = Boolean(config.ftp.host && config.ftp.user);

module.exports = config;
