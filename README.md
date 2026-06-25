# SOAP-Réservations — Camping du Lac de Carouge

Application autonome qui **récupère les fichiers de réservation SOAP** déposés sur un serveur FTP, **extrait les données** (BScrc, paiement, établissement, statut, erreur PMS…), les **consolide** (dédoublonnage par `BScrc`, mise à jour de statut, détection de divergences) dans une base SQLite, et les présente dans une **interface web**.

Après extraction réussie, chaque fichier est **archivé** sur le FTP (ou supprimé / laissé, selon la configuration).

## Stack

- **Node.js ≥ 22** (utilise `node:sqlite`, intégré — aucune dépendance native à compiler)
- **Express** (API + interface)
- **basic-ftp** (FTP / FTPS)
- **node-cron** (scan automatique)
- Interface : HTML/CSS/JS pur, sans framework

## Installation

```bash
cd soap-reservations
npm install
cp .env.example .env   # puis remplir les identifiants FTP
```

## Configuration (`.env`)

| Variable | Rôle |
|---|---|
| `FTP_HOST`, `FTP_PORT`, `FTP_USER`, `FTP_PASSWORD` | Connexion FTP |
| `FTP_SECURE` | `true` pour FTPS explicite, `false` pour FTP simple |
| `FTP_DIR` | Dossier distant des fichiers à traiter |
| `FTP_ARCHIVE_DIR` | Dossier d'archive (créé automatiquement) |
| `FTP_FILE_PATTERN` | Filtre regex sur les noms (défaut `\.txt$`) |
| `AFTER_PROCESS` | `archive` (défaut) · `delete` · `keep` |
| `SCHEDULE_ENABLED` | `true`/`false` — scan automatique |
| `SCHEDULE_CRON` | Fréquence (défaut `*/15 * * * *`, toutes les 15 min) |
| `PORT` | Port de l'interface web (défaut `3010`) |
| `DB_PATH` | Emplacement de la base SQLite |

## Démarrage

```bash
npm start          # serveur web + planificateur → http://localhost:3010
npm run dev        # avec rechargement auto (node --watch)
```

### Commandes utiles

```bash
npm run scan                          # un scan FTP unique en ligne de commande
npm run parse -- samples/exemple-erreur-pms.txt   # teste le parser sur un fichier local
```

## Interface web

- **Cartes statistiques** : total, réussies, erreur PMS, autres erreurs, en attente, fichiers traités
- **Bouton « Scanner maintenant »** : déclenche un scan FTP à la demande
- **Filtres** par statut + **recherche** (BScrc, n° résa, établissement, n° paiement)
- **Détail d'une réservation** (clic sur une ligne) : toutes les données + **historique des tentatives**
- **Export CSV** (compatible Excel, séparateur `;`, BOM UTF-8)

## Logique de consolidation

La clé d'unicité est le **`BScrc`** (identifiant unique de transaction).

- Chaque fichier = une **tentative** (table `attempts`, historisée).
- Les tentatives d'un même `BScrc` sont fusionnées en **une réservation** (table `reservations`).
- **Un succès l'emporte sur une erreur** : si une 1ʳᵉ tentative est en erreur PMS et une 2ᵉ réussit, le statut final passe à *réussie*.
- **Divergence de montant** entre tentatives → signalée (⚠) dans l'interface.
- Le `bookingId` / `dossierId` est complété dès qu'une tentative le fournit.

### Statuts

| Statut | Signification |
|---|---|
| `success` | Réservation enregistrée (`recorded` ou `bookingId` présent) |
| `error_pms` | Code `PMS` — le logiciel de gestion de l'hébergement n'a pas répondu |
| `error_other` | Autre erreur retournée par le service SOAP |
| `pending` | Ni succès ni erreur identifiable |

## Sécurité des fichiers

- Un fichier dont le **parsing échoue** (BScrc introuvable) n'est **jamais** déplacé ni supprimé : il reste sur le FTP et est marqué `parse_error` en base, pour inspection manuelle.
- Les fichiers déjà traités (présents dans la table `files`) sont **ignorés** aux scans suivants — pas de double comptage.
- Le contenu brut de chaque fichier est conservé en base (`files.raw`).

## Déploiement Synology (Docker + Git)

Le planificateur interne (`node-cron`) gère le scan automatique : pas besoin du cron Synology.

### 1. Récupérer le code sur le NAS

Via **Git** (Container Manager → onglet *Projet*, ou en SSH) :

```bash
git clone <URL_DU_DEPOT> soap-reservations
cd soap-reservations
```

### 2. Créer le fichier `.env` sur le NAS

Le `.env` **n'est pas** dans le dépôt git (il contient les identifiants FTP). Il faut le créer à partir du modèle :

```bash
cp .env.example .env
# puis éditer .env avec les identifiants FTP (FTP_HOST, FTP_USER, FTP_PASSWORD…)
```

> Valeurs déjà connues pour ce projet : `FTP_DIR=/`, `FTP_FILE_PATTERN=\.log$`, `FTP_ARCHIVE_DIR=/traites`.

### 3. Lancer le conteneur

**Container Manager** : créer un *Projet*, pointer sur le dossier, il détecte `docker-compose.yml`.

Ou en ligne de commande :

```bash
docker compose up -d --build
```

### 4. Accéder à l'interface

```
http://IP_DU_NAS:3010
```

La base SQLite est persistée dans le dossier `./data` (volume Docker), elle survit aux redémarrages et reconstructions du conteneur.

### Mises à jour

```bash
git pull
docker compose up -d --build
```

## Structure

```
soap-reservations/
├── src/
│   ├── index.js        Serveur Express + planificateur cron
│   ├── config.js       Chargement .env
│   ├── parser.js       Extraction des fichiers SOAP (format print_r PHP)
│   ├── db.js           Schéma SQLite + consolidation/dédoublonnage
│   ├── ftp.js          Connexion, listing, téléchargement, archivage FTP
│   ├── processor.js    Orchestration du scan
│   ├── scan-cli.js     Scan unique en ligne de commande
│   ├── parse-cli.js    Test du parser sur un fichier local
│   └── routes/api.js   Endpoints REST
├── public/             Interface web (index.html, app.js, styles.css)
├── samples/            Fichiers SOAP d'exemple
└── data/               Base SQLite (gitignored)
```
