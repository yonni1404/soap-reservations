'use strict';

const STATUS_LABEL = {
  success: 'Réussie',
  error_pms: 'Erreur PMS',
  error_other: 'Autre erreur',
  pending: 'En attente',
};

let currentStatus = 'all';
let currentSearch = '';

const $ = (s) => document.querySelector(s);

function euro(v) {
  if (v == null) return '—';
  return Number(v).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
}
function dt(s) {
  if (!s) return '—';
  return new Date(s).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
}

// ─── Logos des moyens de paiement (SVG inline, aucun appel réseau) ───────
const PAY_SVG = {
  mastercard: '<svg viewBox="0 0 32 22" class="pl"><rect width="32" height="22" rx="3" fill="#fff"/><circle cx="13" cy="11" r="6" fill="#EB001B"/><circle cx="19" cy="11" r="6" fill="#F79E1B"/><path d="M16 6.2a6 6 0 000 9.6 6 6 0 000-9.6z" fill="#FF5F00"/></svg>',
  visa: '<svg viewBox="0 0 32 22" class="pl"><rect width="32" height="22" rx="3" fill="#fff"/><text x="16" y="15.5" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="10" font-weight="700" font-style="italic" fill="#1A1F71">VISA</text></svg>',
  ideal: '<svg viewBox="0 0 32 22" class="pl"><rect width="32" height="22" rx="3" fill="#fff"/><text x="16" y="15" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="9" font-weight="700" fill="#CC0066">iDEAL</text></svg>',
  bank: '<svg viewBox="0 0 32 22" class="pl"><rect width="32" height="22" rx="3" fill="#0b3d91"/><g fill="#fff"><path d="M16 4l8 4.2H8z"/><rect x="9.2" y="9.4" width="2.4" height="6.4"/><rect x="14.8" y="9.4" width="2.4" height="6.4"/><rect x="20.4" y="9.4" width="2.4" height="6.4"/><rect x="8" y="16.6" width="16" height="2.2" rx="1"/></g></svg>',
};

function paymentLogo(method) {
  const m = (method || '').toLowerCase();
  const wrap = (inner, label) => `<span class="pl-wrap" title="${escapeHtml(label)}">${inner}</span>`;
  const textChip = (bg, fg, txt) => `<span class="pl-text" style="background:${bg};color:${fg}">${escapeHtml(txt)}</span>`;
  if (!method) return '—';
  if (m.includes('mastercard')) return wrap(PAY_SVG.mastercard, 'Mastercard');
  if (m.includes('visa')) return wrap(PAY_SVG.visa, 'Visa');
  if (m.includes('ideal')) return wrap(PAY_SVG.ideal, 'iDEAL');
  if (m.includes('bancontact')) return wrap(textChip('#1e3a8a', '#ffd800', 'Bancontact'), 'Bancontact');
  if (m.includes('ancv')) return wrap(textChip('#e30613', '#fff', 'ANCV'), 'ANCV (Chèques-Vacances)');
  if (m.includes('transfer') || m.includes('virement')) return wrap(PAY_SVG.bank, 'Virement bancaire');
  return wrap(textChip('#475569', '#e2e8f0', method), method);
}

async function loadStats() {
  const s = await fetch('/api/stats').then((r) => r.json());
  $('#stats').innerHTML = `
    <div class="card"><div class="num">${s.total}</div><div class="lbl">Réservations</div></div>
    <div class="card green"><div class="num">${s.success}</div><div class="lbl">Réussies</div></div>
    <div class="card orange"><div class="num">${s.error_pms}</div><div class="lbl">Erreur PMS</div></div>
    <div class="card red"><div class="num">${s.error_other}</div><div class="lbl">Autres erreurs</div></div>
    <div class="card"><div class="num">${s.pending}</div><div class="lbl">En attente</div></div>
    <div class="card"><div class="num">${s.filesProcessed}</div><div class="lbl">Fichiers traités</div></div>
  `;
}

async function loadTable() {
  const params = new URLSearchParams();
  if (currentStatus !== 'all') params.set('status', currentStatus);
  if (currentSearch) params.set('search', currentSearch);
  const rows = await fetch('/api/reservations?' + params).then((r) => r.json());

  const tbody = $('#tbody');
  tbody.innerHTML = '';
  $('#empty').classList.toggle('hidden', rows.length > 0);

  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.onclick = () => openDetail(r.bscrc);
    const client = r.email
      ? `${escapeHtml(r.email)}${r.tel ? `<br><span class="muted">${escapeHtml(r.tel)}</span>` : ''}`
      : '—';
    const methods = [...new Set((r.methods || r.payment_method || '').split(',').map((s) => s.trim()).filter(Boolean))];
    const payCell = methods.length ? `<span class="pay-list">${methods.map(paymentLogo).join('')}</span>` : '—';
    const numCell = `${r.booking_id || '—'}${r.booking_count > 1 ? `<div class="muted">${r.booking_count} n° résa</div>` : ''}`;
    tr.innerHTML = `
      <td><span class="badge ${r.final_status}">${STATUS_LABEL[r.final_status] || r.final_status}</span></td>
      <td>${dt(r.tx_time || r.last_update)}</td>
      <td>${client}</td>
      <td>${numCell}</td>
      <td>${euro(r.amount)}${r.has_divergence ? '<span class="diverge" title="Montant divergent entre tentatives">⚠</span>' : ''}</td>
      <td>${payCell}</td>
      <td>${r.attempts}</td>
    `;
    tbody.appendChild(tr);
  }
}

async function openDetail(bscrc) {
  let r;
  try {
    r = await fetch('/api/reservations/' + encodeURIComponent(bscrc)).then((x) => x.json());
  } catch (e) {
    banner('err', 'Impossible de charger le détail : ' + e.message);
    return;
  }
  if (!r || !r.bscrc) {
    banner('err', 'Détail introuvable pour cette réservation.');
    return;
  }
  const bookings = r.bookings || [];
  const bookingRows = bookings.map((b) => {
    const kind = b.will_pay_offsite === 0
      ? '<span class="kind firm">Ferme · virement</span>'
      : (b.will_pay_offsite === 1 ? '<span class="kind online">Redirection · paiement en ligne</span>' : '');
    const fileBtns = b.files.map((fn, i) =>
      `<button type="button" class="file-btn-sm" data-file="${escapeHtml(fn)}">voir fichier${b.files.length > 1 ? ' ' + (i + 1) : ''}</button>`
    ).join(' ');
    return `
      <div class="bk-row">
        <div class="bk-main">
          ${paymentLogo(b.payment_method)}
          <span class="bk-num mono">N° ${b.booking_id || '—'}</span>
          <span class="badge ${b.status}">${STATUS_LABEL[b.status] || b.status}</span>
          ${kind}
          <span class="muted">${dt(b.last_seen)} · ${euro(b.amount)}</span>
        </div>
        <div class="bk-files">${fileBtns}</div>
      </div>`;
  }).join('');

  $('#modalContent').innerHTML = `
    <h2>Réservation <span class="mono">${r.bscrc}</span></h2>
    <span class="badge ${r.final_status}">${STATUS_LABEL[r.final_status] || r.final_status}</span>
    <dl class="kv">
      <dt>Date transaction</dt><dd>${dt(r.tx_time) || '—'}</dd>
      <dt>Email client</dt><dd>${r.email ? `<a href="mailto:${escapeHtml(r.email)}">${escapeHtml(r.email)}</a>` : '—'}</dd>
      <dt>Téléphone</dt><dd>${r.tel ? `<a href="tel:${escapeHtml(r.tel)}">${escapeHtml(r.tel)}</a>` : '—'}</dd>
      <dt>N° réservation</dt><dd>${r.booking_id || '—'}</dd>
      <dt>N° dossier</dt><dd>${r.dossier_id || '—'}</dd>
      <dt>Montant</dt><dd>${euro(r.amount)}${r.has_divergence ? ' ⚠ divergence détectée' : ''}</dd>
      <dt>Paiement</dt><dd>${paymentLogo(r.payment_method)} ${escapeHtml(r.payment_method || '—')}${r.payment_type ? ` · ${escapeHtml(r.payment_type)}` : ''} · ID ${r.payment_id || '—'}</dd>
      <dt>Fournisseur paiement</dt><dd>${r.payment_provider || '—'}</dd>
      <dt>Paiement hors site</dt><dd>${r.will_pay_offsite ? 'Oui' : 'Non'}</dd>
      <dt>Code erreur</dt><dd>${r.error_code || '—'}</dd>
      <dt>Message</dt><dd>${r.error_message ? escapeHtml(r.error_message) : '—'}</dd>
      <dt>Tentatives</dt><dd>${r.attempts}</dd>
      <dt>Première vue</dt><dd>${dt(r.first_seen)}</dd>
      <dt>Dernière MAJ</dt><dd>${dt(r.last_update)}</dd>
    </dl>
    <div class="attempts">
      <h3>${bookings.length > 1 ? `${bookings.length} numéros de réservation générés` : 'Réservation'} — 1 ligne par n°, avec le moyen de paiement</h3>
      <div class="bk-list">${bookingRows || '<p class="err-msg">Aucune tentative.</p>'}</div>
      <div id="fileViewer"></div>
    </div>
  `;

  // Branche l'affichage du contenu sur chaque bouton "voir fichier"
  $('#modalContent').querySelectorAll('.file-btn-sm').forEach((b) => {
    b.onclick = () => {
      $('#modalContent').querySelectorAll('.file-btn-sm').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      loadFile(b.dataset.file);
    };
  });

  $('#modal').classList.remove('hidden');
}

async function loadFile(name) {
  const viewer = document.getElementById('fileViewer');
  viewer.innerHTML = '<p class="muted">Chargement…</p>';
  try {
    const f = await fetch('/api/files/raw?name=' + encodeURIComponent(name)).then((r) => r.json());
    if (!f || f.error) {
      viewer.innerHTML = `<p class="err-msg">${f && f.error ? escapeHtml(f.error) : 'Fichier introuvable'}</p>`;
      return;
    }
    let body = f.raw || '';
    try { body = JSON.stringify(JSON.parse(body), null, 2); } catch (_) { /* pas du JSON : contenu brut */ }
    viewer.innerHTML = `<div class="file-head mono">${escapeHtml(name)}</div><pre class="file-raw">${escapeHtml(body)}</pre>`;
  } catch (e) {
    viewer.innerHTML = `<p class="err-msg">Erreur : ${escapeHtml(e.message)}</p>`;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function banner(type, msg) {
  const b = $('#banner');
  b.className = 'banner ' + type;
  b.textContent = msg;
  b.classList.remove('hidden');
}

async function checkConfig() {
  try {
    const c = await fetch('/api/config').then((r) => r.json());
    if (!c.ftpConfigured) {
      banner('info', 'FTP non configuré : renseigne FTP_HOST / FTP_USER dans le fichier .env, puis relance le serveur.');
    }
  } catch (_) { /* ignore */ }
}

async function scan() {
  const btn = $('#scanBtn');
  btn.disabled = true;
  btn.textContent = '⟳ Scan en cours…';
  try {
    const s = await fetch('/api/scan', { method: 'POST' }).then((r) => r.json());
    if (!s.ok) {
      banner('err', 'Scan impossible : ' + (s.error || 'erreur inconnue'));
    } else {
      banner('ok', `Scan terminé : ${s.found} fichier(s) trouvé(s), ${s.processed} traité(s), ${s.newReservations} nouvelle(s), ${s.updated} mise(s) à jour, ${s.statusUpgrades} statut(s) corrigé(s), ${s.archived} archivé(s).` + (s.errors?.length ? ' ⚠ ' + s.errors.length + ' erreur(s).' : ''));
    }
    await refresh();
  } catch (e) {
    banner('err', 'Erreur réseau : ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '⟳ Scanner maintenant';
  }
}

async function refresh() {
  await Promise.all([loadStats(), loadTable()]);
}

// ─── Événements ──────────────────────────────────────────────────────────
function closeModal() { $('#modal').classList.add('hidden'); }
$('#scanBtn').onclick = scan;
$('#modalClose').onclick = closeModal;
// Clic n'importe où sur le fond (hors de la boîte) ferme la fenêtre
$('#modal').onclick = (e) => { if (!e.target.closest('.modal-box')) closeModal(); };
// La touche Échap ferme toujours la fenêtre
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

$('#filters').onclick = (e) => {
  const btn = e.target.closest('.chip');
  if (!btn) return;
  document.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
  btn.classList.add('active');
  currentStatus = btn.dataset.status;
  loadTable();
};

let searchTimer;
$('#search').oninput = (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { currentSearch = e.target.value.trim(); loadTable(); }, 250);
};

// ─── Démarrage ──────────────────────────────────────────────────────────
checkConfig();
refresh();
setInterval(loadStats, 30000); // rafraîchit les stats toutes les 30 s
