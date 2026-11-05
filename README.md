# Context Sender

> Extension VSCode qui transforme n'importe quel chat IA web en assistant de code : elle prépare le contexte à envoyer, puis réapplique la réponse dans tes fichiers.

![VSCode](https://img.shields.io/badge/VSCode-%5E1.103-007ACC?logo=visualstudiocode&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![Dépendances](https://img.shields.io/badge/d%C3%A9pendances%20runtime-0-brightgreen)
![Licence](https://img.shields.io/badge/licence-MIT-blue)

Quand la seule IA disponible est un chat dans le navigateur, on passe son temps à copier des fichiers un par un, à dépasser la limite de taille des messages, puis à recopier la réponse à la main. Context Sender fait tout ça depuis un panneau latéral :

```
  1. Choisir           2. Envoyer           3. Chat IA          4. Appliquer
  ┌──────────────┐     ┌──────────────┐     ┌────────────┐     ┌───────────────┐
  │ arbre, git,  │ ──▶ │ texte, pièce │ ──▶ │ navigateur │ ──▶ │ revue diff,   │
  │ onglets      │     │ jointe, N msg│     │            │     │ appliquer / ↶ │
  └──────────────┘     └──────────────┘     └────────────┘     └───────────────┘
       VSCode               VSCode                                  VSCode
```

Elle fonctionne avec **n'importe quel chat** : son nom et son URL sont de simples réglages, aucun service n'est configuré par défaut.

## Fonctionnalités

**Sélection du contexte**
- Arborescence à cases à cocher, triée comme l'Explorateur, qui respecte le `.gitignore` de chaque dépôt (y compris les dépôts imbriqués).
- Détection automatique des projets d'un monorepo (dépôts git, `package.json`, `go.mod`, `pom.xml`, `*.csproj`, `pyproject.toml`…) et filtres multi-sélection par projet et par type de fichier.
- Ajout en un clic des fichiers modifiés selon git, des onglets ouverts ou du fichier actif ; clic droit dans l'Explorateur.
- Exclusions globales (motifs glob) et par projet, sélections enregistrées rechargeables.

**Économie de tokens**
- Mode **Modifs seules** : n'envoie que les zones modifiées depuis le dernier commit, avec ± N lignes de contexte, dans un format de diff lisible par l'IA.
- Compteur de tokens calculé sur ce qui sera réellement envoyé, avec l'économie réalisée (ex. `~829 tokens · au lieu de ~4,0 k (−79 %)`).

**Envoi adapté au chat**
- Si ça tient dans un message : copié, il n'y a plus qu'à coller.
- Sinon : un fichier à joindre (copié *en tant que fichier* sous Windows, Ctrl+V dans le chat), un découpage en plusieurs messages numérotés, ou un `.txt` par fichier source.
- Masquage automatique des mots de passe, tokens, JWT et identifiants dans les URL.

**Application de la réponse**
- Lit la réponse copiée, retrouve chaque fichier (chemin exact, partiel ou nom unique) et propose une revue : *modifié*, *nouveau*, *partiel*, *échec*, avec le nombre de lignes +/−.
- Diff avant / après dans VSCode, application fichier par fichier ou en bloc, **annulation complète** (les fichiers créés partent à la corbeille).
- Applicateur de diff tolérant : numéros de ligne approximatifs, espaces / tabulations, espace de contexte oublié, fins de ligne Windows conservées.

## Points techniques

- **Zéro dépendance à l'exécution** : uniquement l'API VSCode, Node.js et `git` en ligne de commande.
- **Aucun appel réseau** : le code ne quitte le poste que lorsque l'utilisateur le colle lui-même dans le chat. Aucun module `http`, `https`, `net` ou `fetch` n'est importé.
- **Logique pure découplée de VSCode** : `format.ts` (mise en forme, découpage, masquage) et `response.ts` (parsing markdown, application de diff) sont testables directement avec Node.js.
- **Combinaison de deux sources git** : l'API de l'extension Git intégrée (état à jour) et des appels `git` directs pour les dépôts profonds qu'elle ne voit pas, avec des appels groupés pour rester sous la limite de ligne de commande Windows.
- **Webview sécurisée** : Content Security Policy stricte avec nonce, interface responsive pour une barre latérale étroite, couleurs du thème VSCode.
- **Nettoyage automatique** des exports après 24 h, limité aux fichiers reconnus comme créés par l'extension.

## Installation

Depuis un `.vsix` : dans VSCode, *Extensions* → menu `…` → *Install from VSIX…*, ou :

```bash
code --install-extension context-sender-1.2.0.vsix
```

Puis dans les réglages (`Ctrl+,`, recherche **Context Sender**) :

```jsonc
{
  "contextSender.chatName": "Mon chat IA",             // nom affiché dans le panneau
  "contextSender.chatUrl": "https://exemple.com/chat", // ouvert par « Ouvrir le chat »
  "contextSender.pasteLimit": 30000                    // taille max d'un message dans ce chat
}
```

## Utilisation

Ouvre le panneau avec l'icône de la barre d'activité ou **Ctrl+Alt+L**.

1. **Choisir les fichiers** : coche des fichiers ou des dossiers, ou utilise **± Modifiés**, **▭ Onglets**, **◉ Actif**.
2. **Fichiers complets / Modifs seules** : choisis ce qui est envoyé et le contexte ± autour des modifications.
3. **Consigne** (facultatif) : l'option *Demander une réponse applicable* précise à l'IA le format attendu (`### Fichier : chemin` + fichier complet ou zones ```` ```diff ````).
4. **Envoyer** (**Ctrl+Alt+Entrée**) : la forme est choisie selon la taille.
5. **Appliquer la réponse** (**Ctrl+Alt+V**) : copie la réponse de l'IA, vérifie avec 👁, applique avec ✓, annule avec ↶.

| Raccourci | Action |
|---|---|
| `Ctrl+Alt+L` | Ouvrir le panneau |
| `Ctrl+Alt+Entrée` | Envoyer la sélection |
| `Ctrl+Alt+V` | Appliquer la réponse de l'IA |

## Réglages (`contextSender.*`)

| Réglage | Défaut | Rôle |
|---|---|---|
| `chatName` | Chat IA | Nom affiché du chat |
| `chatUrl` | (vide) | URL ouverte par « Ouvrir le chat » |
| `pasteLimit` | 30000 | Taille max d'un message collé (caractères) |
| `largeSelection` | `ask` | `ask` / `file` / `parts` quand c'est trop gros |
| `diffContextLines` | 8 | Contexte par défaut du mode « Modifs seules » |
| `exclude` | node_modules, dist, .env*… | Motifs exclus partout, en plus du `.gitignore` |
| `exportFormat` | `txt` | `txt` ou `md` pour le fichier à joindre |
| `separateFilesAsTxt` | true | Ajoute `.txt` aux fichiers séparés |
| `exportFolder` | (temp) | Dossier des fichiers générés |
| `exportRetentionHours` | 24 | Suppression automatique des exports (0 = jamais) |
| `maskSecrets` | true | Masquage des secrets |
| `maxFileKB` | 1024 | Taille max d'un fichier |
| `maxFiles` | 20000 | Nombre max de fichiers scannés par dossier racine |
| `openChatAfterSend` | false | Ouvre le chat après chaque envoi |
| `askApplicableAnswer` | true | Option « Demander une réponse applicable » cochée par défaut |
| `saveAfterApply` | true | Enregistre les fichiers après application |
| `openAfterApply` | true | Ouvre le fichier après une application unitaire |

## Développement

```bash
npm install
npm run watch                 # puis F5 dans VSCode : fenêtre de test avec l'extension chargée
npm run lint
npx @vscode/vsce package      # produit context-sender-<version>.vsix
```

### Architecture

```
src/
├── extension.ts   Point d'entrée : commandes, panneau, surveillance des fichiers, nettoyage périodique
├── panel.ts       Logique du panneau : sélection, filtres, envoi, exports, revue et application
├── scanner.ts     Liste des fichiers (git ou recherche VSCode), exclusions, détection des projets
├── git.ts         Dépôts, fichiers modifiés, diffs par fichier
├── format.ts      Mise en forme, légende, découpage en parties, masquage des secrets   (sans VSCode)
├── response.ts    Lecture des réponses de l'IA, application tolérante des diffs         (sans VSCode)
├── clipboard.ts   Copie d'un fichier dans le presse-papiers (PowerShell, osascript)
└── webview.ts     Squelette HTML et CSP du panneau
media/
├── panel.js       Interface : arborescence, listes déroulantes, sélection, revue
└── panel.css      Styles, thème VSCode, adaptation à la largeur
```

Voir le [CHANGELOG](CHANGELOG.md) pour l'historique des versions.

## Licence

[MIT](LICENSE.txt)
