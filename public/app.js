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
    tr.innerHTML = `
      <td><span class="badge ${r.final_status}">${STATUS_LABEL[r.final_status] || r.final_status}</span></td>
      <td>${dt(r.tx_time || r.last_update)}</td>
      <td>${client}</td>
      <td>${r.booking_id || '—'}</td>
      <td>${euro(r.amount)}${r.has_divergence ? '<span class="diverge" title="Montant divergent entre tentatives">⚠</span>' : ''}</td>
      <td>${r.payment_method || '—'}${r.payment_type ? ` <span class="muted">(${escapeHtml(r.payment_type)})</span>` : ''}</td>
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
  const attempts = (r.attempts_list || []).map((a) => `
    <div class="attempt">
      <span class="badge ${a.status}">${STATUS_LABEL[a.status] || a.status}</span>
      ${euro(a.amount)} · ${dt(a.seen_at)} · <span class="mono">${a.filename}</span>
      ${a.error_message ? `<div class="err-msg">${escapeHtml(a.error_message)}</div>` : ''}
    </div>
  `).join('');

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
      <dt>Paiement</dt><dd>${r.payment_method || '—'} (${r.payment_type || '—'}) · ID ${r.payment_id || '—'}</dd>
      <dt>Fournisseur paiement</dt><dd>${r.payment_provider || '—'}</dd>
      <dt>Paiement hors site</dt><dd>${r.will_pay_offsite ? 'Oui' : 'Non'}</dd>
      <dt>Code erreur</dt><dd>${r.error_code || '—'}</dd>
      <dt>Message</dt><dd>${r.error_message ? escapeHtml(r.error_message) : '—'}</dd>
      <dt>Tentatives</dt><dd>${r.attempts}</dd>
      <dt>Première vue</dt><dd>${dt(r.first_seen)}</dd>
      <dt>Dernière MAJ</dt><dd>${dt(r.last_update)}</dd>
    </dl>
    <div class="attempts">
      <h3>Historique des tentatives (${r.attempts_list?.length || 0})</h3>
      ${attempts || '<p class="err-msg">Aucune tentative enregistrée.</p>'}
    </div>
  `;
  $('#modal').classList.remove('hidden');
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
