'use strict';

const crypto = require('crypto');
const db = require('./db');
const config = require('./config');

// Sessions en mémoire (perdues au redémarrage → reconnexion). Suffit pour un usage mono-utilisateur.
const SESSIONS = new Map(); // token -> expiresAt
const SESSION_MS = 12 * 60 * 60 * 1000; // 12 h

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(String(password), salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(test, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Initialise le mot de passe au premier démarrage (depuis .env), puis modifiable dans l'interface
function init() {
  if (!db.getSetting('auth_user')) db.setSetting('auth_user', config.auth.user);
  if (!db.getSetting('auth_password')) db.setSetting('auth_password', hashPassword(config.auth.initialPassword));
}

function login(user, password) {
  const okUser = (user || '') === db.getSetting('auth_user');
  const okPass = verifyPassword(password, db.getSetting('auth_password'));
  if (!okUser || !okPass) return null;
  const token = crypto.randomBytes(24).toString('hex');
  SESSIONS.set(token, Date.now() + SESSION_MS);
  return token;
}

function validate(token) {
  const exp = token && SESSIONS.get(token);
  if (!exp) return false;
  if (Date.now() > exp) { SESSIONS.delete(token); return false; }
  return true;
}

function logout(token) { SESSIONS.delete(token); }

function changePassword(current, next) {
  if (!verifyPassword(current, db.getSetting('auth_password'))) return false;
  if (!next || String(next).length < 6) return false;
  db.setSetting('auth_password', hashPassword(next));
  SESSIONS.clear(); // invalide toutes les sessions → reconnexion avec le nouveau mot de passe
  return true;
}

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((c) => {
    const i = c.indexOf('=');
    if (i > -1) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}

function tokenFromReq(req) {
  return parseCookies(req.headers.cookie).sid;
}

// Middleware Express : exige une session valide
function requireAuth(req, res, next) {
  if (validate(tokenFromReq(req))) return next();
  res.status(401).json({ error: 'Non authentifié' });
}

function cookieHeader(token) {
  return `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(SESSION_MS / 1000)}`;
}
const CLEAR_COOKIE = 'sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0';

module.exports = {
  init, login, logout, validate, changePassword, requireAuth,
  tokenFromReq, cookieHeader, CLEAR_COOKIE,
};
