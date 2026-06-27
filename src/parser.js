'use strict';

/**
 * Parser des fichiers de log de réservation.
 *
 * Deux formats sont gérés :
 *  1. JSON (format de production déposé sur le FTP) — objet { time, log: { request, steps, soap } }
 *  2. print_r() de PHP (ancien format d'exemple) — blocs "Requête SOAP" / "Réponse SOAP"
 *
 * On extrait les mêmes champs métier dans les deux cas (BScrc, paiement,
 * client, statut, erreur...), pour alimenter la consolidation par BScrc.
 */

// ─── Helpers communs ─────────────────────────────────────────────────────
function clean(v) {
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

function toNumber(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function isTruthy(v) {
  if (v === true || v === 1) return true;
  const s = clean(v).toLowerCase();
  return s === 'true' || s === '1' || s === 'oui';
}

/** Présence d'un identifiant non vide / non nul / non "0". */
function hasId(v) {
  const s = clean(v);
  return s !== '' && s !== '0' && s.toLowerCase() !== 'null';
}

/** Recherche récursive de la première valeur scalaire pour une clé donnée. */
function findFirst(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, key) && (obj[key] === null || typeof obj[key] !== 'object')) {
    return obj[key];
  }
  for (const k of Object.keys(obj)) {
    if (obj[k] && typeof obj[k] === 'object') {
      const found = findFirst(obj[k], key);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** Recherche récursive du premier sous-objet contenant la clé donnée. */
function findNodeWith(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj;
  for (const k of Object.keys(obj)) {
    if (obj[k] && typeof obj[k] === 'object') {
      const found = findNodeWith(obj[k], key);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/**
 * Détermine le statut final.
 * @returns {'success'|'error_pms'|'error_other'|'pending'}
 */
function determineStatus({ recorded, bookingId, errorCode, errorMessage, steps }) {
  if (errorCode || errorMessage) {
    return clean(errorCode).toUpperCase() === 'PMS' ? 'error_pms' : 'error_other';
  }
  if (isTruthy(recorded) || hasId(bookingId)) return 'success';
  if (Array.isArray(steps) && steps.map((s) => clean(s).toLowerCase()).includes('success')) return 'success';
  return 'pending';
}

// ─── Format JSON (production) ────────────────────────────────────────────
function parseJsonLog(obj) {
  const log = obj.log || obj;
  const req = log.request || {};
  const soap = log.soap || {};
  const steps = Array.isArray(log.steps) ? log.steps : [];

  // Bloc réponse de réservation
  const bookingResult =
    findFirst(soap, 'recorded') !== undefined
      ? findNodeWith(soap, 'recorded')
      : (soap.post_booking_response && soap.post_booking_response.postBooking_v3Result) || {};

  // Détection d'erreur (structure myErrorPB / errorDetailPB, comme en SOAP)
  const errNode = findNodeWith(soap, 'trad') || findNodeWith(soap, 'myErrorPB');
  const errorCode = errNode ? clean(findFirst(errNode, 'code')) : '';
  const errorMessage = errNode ? clean(findFirst(errNode, 'trad')) : '';
  const errorSystem = errNode ? clean(findFirst(errNode, 'system')) : '';

  const recorded = bookingResult ? findFirst(bookingResult, 'recorded') : undefined;
  const bookingId = bookingResult ? findFirst(bookingResult, 'bookingId') : undefined;

  const data = {
    bscrc: clean(req.bsCrc || findFirst(soap, 'BScrc')),
    txTime: clean(obj.time || log.time),
    idEstablishment: clean(findFirst(soap, 'idEstablishment')),
    idEngine: clean(findFirst(soap, 'idEngine')),
    user: clean(findFirst(soap, 'user')),

    paymentId: clean(req.PaymentID || findFirst(soap, 'PaymentID')),
    paymentMethod: clean(req.MyEnumPaymentKeyStr || findFirst(soap, 'MyEnumPaymentKeyStr')),
    paymentType: clean(req.MyEnumPaymentTypeStr || findFirst(soap, 'MyEnumPaymentTypeStr')),
    paymentProvider: clean(findFirst(soap, 'ProviderName')),
    amount: toNumber(findFirst(soap, 'TotalAmount') ?? req.Amount ?? findFirst(soap, 'Amount')),
    willPayOffsite: isTruthy(findFirst(soap, 'WillPayOffsite')) ? 1 : 0,

    email: clean(req.email),
    tel: clean(req.tel),

    recorded: clean(recorded),
    bookingId: clean(bookingId),
    dossierId: clean(findFirst(bookingResult, 'DossierId')),
    isFirmBooking: clean(findFirst(bookingResult, 'isFirmBooking')),
    errorCode,
    errorSystem,
    errorMessage,
    steps,
  };

  data.status = determineStatus(data);
  return { data, request: req, response: soap };
}

// ─── Format print_r (ancien, conservé en secours) ────────────────────────
function parsePrintR(lines, startIdx = 0) {
  let i = startIdx;
  while (i < lines.length && lines[i].trim() !== '(') i++;
  i++;

  function parseArray() {
    const o = {};
    while (i < lines.length) {
      const trimmed = lines[i].trim();
      if (trimmed === ')') { i++; return o; }
      const m = trimmed.match(/^\[([^\]]+)\]\s*=>\s*(.*)$/);
      if (!m) { i++; continue; }
      const key = m[1];
      const val = m[2];
      if (val === 'Array') {
        i++;
        while (i < lines.length && lines[i].trim() !== '(') i++;
        i++;
        o[key] = parseArray();
      } else {
        o[key] = val;
        i++;
      }
    }
    return o;
  }
  return { value: parseArray(), next: i };
}

function parsePrintRFile(text) {
  const lines = text.split(/\r?\n/);
  let splitIdx = lines.findIndex((l) => /R[ée]ponse\s+SOAP/i.test(l));
  if (splitIdx === -1) splitIdx = lines.length;
  let request = {};
  let response = {};
  try { request = parsePrintR(lines.slice(0, splitIdx)).value; } catch (_) {}
  try { response = parsePrintR(lines.slice(splitIdx)).value; } catch (_) {}

  const recorded = clean(findFirst(response, 'recorded'));
  const bookingId = clean(findFirst(response, 'bookingId'));
  const errorCode = clean(findFirst(response, 'code'));
  const errorMessage = clean(findFirst(response, 'trad'));

  const data = {
    bscrc: clean(findFirst(request, 'BScrc')),
    txTime: '',
    idEstablishment: clean(findFirst(request, 'idEstablishment')),
    idEngine: clean(findFirst(request, 'idEngine')),
    user: clean(findFirst(request, 'user')),
    paymentId: clean(findFirst(request, 'PaymentID')),
    paymentMethod: clean(findFirst(request, 'MyEnumPaymentKeyStr')),
    paymentType: clean(findFirst(request, 'MyEnumPaymentTypeStr')),
    paymentProvider: '',
    amount: toNumber(findFirst(request, 'TotalAmount') ?? findFirst(request, 'Amount')),
    willPayOffsite: clean(findFirst(request, 'WillPayOffsite')) === '1' ? 1 : 0,
    email: '',
    tel: '',
    recorded,
    bookingId,
    dossierId: clean(findFirst(response, 'DossierId')),
    isFirmBooking: clean(findFirst(response, 'isFirmBooking')),
    errorCode,
    errorSystem: clean(findFirst(response, 'system')),
    errorMessage,
    steps: [],
  };
  data.status = determineStatus(data);
  return { data, request, response };
}

// ─── Point d'entrée ──────────────────────────────────────────────────────
function parseSoapFile(content) {
  const text = String(content).trim();
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      return parseJsonLog(JSON.parse(text));
    } catch (_) {
      // JSON malformé → on tente quand même le print_r
    }
  }
  return parsePrintRFile(text);
}

// ─── Fichiers /global (logs de tous les appels SOAP, dont les validations de paiement) ───
// Format : { time, log: { "Soap METHOD", "Soap REQUEST" (XML string), "Soap RESPONSE" {obj} } }

// Masque le mot de passe secureholiday présent en clair dans le XML REQUEST
function maskSecret(raw) {
  return String(raw).replace(/(<[\w:]*password>)(.*?)(<\/[\w:]*password>)/gi, '$1******$3');
}

// Masque les données personnelles (email, téléphone) dans le contenu brut JSON
function maskPII(raw) {
  return String(raw)
    .replace(/("email"\s*:\s*")[^"]*(")/gi, '$1$2')
    .replace(/("tel"\s*:\s*")[^"]*(")/gi, '$1$2');
}

// Cherche un résultat booléen (clé du type ...SuccedResult / ...Success / paid / valid)
function findResultBool(obj) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of Object.keys(obj)) {
    if (typeof obj[k] === 'boolean' && /succed|success|result|paid|valid/i.test(k)) return obj[k];
  }
  for (const k of Object.keys(obj)) {
    if (obj[k] && typeof obj[k] === 'object') {
      const r = findResultBool(obj[k]);
      if (r !== undefined) return r;
    }
  }
  return undefined;
}

/**
 * Analyse un fichier /global. Renvoie le type d'appel et, si c'est une
 * validation de paiement, le n° de réservation et le résultat.
 */
function parseGlobalFile(content) {
  let d;
  try { d = JSON.parse(content); } catch (_) { return { isValidation: false }; }
  const log = d.log || {};
  const method = clean(log['Soap METHOD']);
  const requestXml = String(log['Soap REQUEST'] || '');
  const response = log['Soap RESPONSE'];

  const m = requestXml.match(/<[\w:]*idBooking>\s*(\d+)\s*<\/[\w:]*idBooking>/i);
  const idBooking = m ? m[1] : '';

  const result = findResultBool(response);
  const respKeys = response && typeof response === 'object' ? Object.keys(response).join(' ') : '';

  // Validation de paiement = référence un n° de résa + résultat booléen + contexte "paiement validé"
  const looksPayment = /verif|succed|success|paid|paiement|payment|payline|stripe/i.test(method + ' ' + respKeys);
  const isValidation = Boolean(idBooking) && typeof result === 'boolean' && looksPayment;

  const provider = /payline/i.test(method) ? 'Payline'
    : (/stripe/i.test(method) ? 'Stripe' : (method ? 'Autre' : ''));

  return {
    time: clean(d.time),
    method,
    idBooking,
    provider,
    validated: result === true,
    result,
    isValidation,
  };
}

module.exports = { parseSoapFile, parseJsonLog, parsePrintR, findFirst, determineStatus, parseGlobalFile, maskSecret, maskPII };
