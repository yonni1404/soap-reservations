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

module.exports = { parseSoapFile, parseJsonLog, parsePrintR, findFirst, determineStatus };
