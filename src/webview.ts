import * as vscode from 'vscode';

function nonce(): string {
  const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => c[Math.floor(Math.random() * c.length)]).join('');
}

export function getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const n = nonce();
  const css = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'panel.css'));
  const js = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'panel.js'));
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
</head>
<body>
  <div id="noWs" class="empty" hidden>Ouvre un dossier de projet pour sélectionner des fichiers.</div>
  <div id="main">
    <div class="filters" id="filters">
      <div class="dd" id="ddProj">
        <button class="ddbtn" id="projBtn" title="Choisir les projets à afficher"><span class="ddk">Projets</span><span class="ddv" id="projVal">Tous</span><span class="caret">▾</span></button>
      </div>
      <div class="dd" id="ddExt">
        <button class="ddbtn" id="extBtn" title="Choisir les types de fichiers à afficher"><span class="ddk">Types</span><span class="ddv" id="extVal">Tous</span><span class="caret">▾</span></button>
      </div>
      <div class="ddmenu" id="ddMenu" hidden></div>
    </div>
    <div class="bar">
      <input type="text" id="filter" placeholder="Filtrer : nom, chemin, *.go…" title="Échap pour effacer" />
      <button class="icon" id="refresh" title="Rescanner le projet">⟳</button>
    </div>
    <div class="tools four">
      <button id="gitChanged" title="Ajouter les fichiers modifiés selon git (selon les projets et types choisis)"><span class="ic">±</span><span class="lbl">Modifiés</span></button>
      <button id="openTabs" title="Ajouter les onglets ouverts (selon les projets et types choisis)"><span class="ic">▭</span><span class="lbl">Onglets</span></button>
      <button id="addActive" title="Ajouter le fichier ouvert dans l'éditeur"><span class="ic">◉</span><span class="lbl">Actif</span></button>
      <button id="checkVisible" title="Cocher tous les fichiers affichés par le filtre"><span class="ic">☑</span><span class="lbl">Visibles</span></button>
    </div>
    <div class="tree" id="tree"></div>

    <div class="sechead">
      <span id="selTitle">Sélection</span>
      <button class="link" id="clear" title="Retirer tous les fichiers">Vider</button>
    </div>
    <div class="gauge" id="gauge" title=""><div></div></div>
    <div class="stats" id="selStats"></div>
    <div class="sel" id="selList"></div>

    <div class="modes">
      <div class="seg" id="modeSeg">
        <button data-mode="full" title="Envoie le contenu complet des fichiers"><span class="lbl-long">Fichiers complets</span><span class="lbl-short">Complets</span></button>
        <button data-mode="diff" title="Pour les fichiers modifiés, n'envoie que les changements (diff git) avec un peu de contexte"><span class="lbl-long">Modifs seules</span><span class="lbl-short">Δ Modifs</span></button>
      </div>
      <label class="ctx" id="ctxRow" title="Lignes de contexte gardées autour de chaque modification">contexte ±<input type="number" id="ctx" min="0" max="200"></label>
    </div>

    <textarea id="instruction" rows="2" placeholder="Consigne (optionnel) : ex. « Relis ces modifications et signale les bugs »"></textarea>
    <label class="check" title="Ajoute à la consigne le format de réponse que l'extension sait appliquer automatiquement (bouton 📥)"><input type="checkbox" id="answerFormat"> Demander une réponse applicable</label>

    <div class="sendrow">
      <button class="primary" id="send" title="Envoyer"><span class="lbl-long" id="sendLabel">Envoyer</span><span class="lbl-short">Envoyer ▸</span></button>
      <button class="icon" id="copy" title="Copier tout le texte">📋</button>
      <button class="icon" id="file" title="Créer un fichier à joindre (copié : Ctrl+V dans le chat)">📎</button>
      <button class="icon" id="parts" title="Découper en plusieurs messages">🧩</button>
      <button class="icon" id="separate" title="Un fichier .txt par fichier source">🗂</button>
    </div>
    <div id="hint" class="hint"></div>
    <button class="wide" id="review" title="Lit la réponse copiée depuis le chat, retrouve les fichiers et te laisse vérifier avant d'appliquer (Ctrl+Alt+V)"><span class="lbl-long">📥 Appliquer la réponse de l'IA</span><span class="lbl-short">📥 Appliquer la réponse</span></button>
    <div id="reviewBox" class="review" hidden>
      <div class="rvhead"><span id="rvTitle">Réponse de l'IA</span><button class="link" id="rvClose" title="Fermer la revue">✕</button></div>
      <div id="rvList"></div>
      <div class="rvfoot">
        <button class="primary" id="rvAll">✓ Tout appliquer</button>
        <button id="rvUndoAll" title="Remettre les fichiers comme avant">↶ Annuler</button>
      </div>
    </div>
    <div id="partsBox" hidden>
      <div class="hint">Colle les parties dans l'ordre, en attendant le « OK » de l'IA entre deux :</div>
      <div class="parts" id="partsBtns"></div>
    </div>

    <details id="more">
      <summary>Sélections enregistrées · exclusions · réglages</summary>
      <div class="bar"><select id="baskets"></select></div>
      <div class="tools four">
        <button id="loadBasket" title="Remplace la sélection actuelle"><span class="ic">↺</span><span class="lbl">Charger</span></button>
        <button id="addBasket" title="Ajoute à la sélection actuelle"><span class="ic">+</span><span class="lbl">Ajouter</span></button>
        <button id="saveBasket" title="Enregistrer la sélection actuelle"><span class="ic">💾</span><span class="lbl">Enreg.</span></button>
        <button id="delBasket" title="Supprimer la sélection enregistrée"><span class="ic">🗑</span><span class="lbl">Suppr.</span></button>
      </div>
      <div class="sub">Exclus de ce projet <span class="dim">(survole un fichier ou un dossier puis ⊘ pour l'ajouter)</span></div>
      <div id="excluded" class="chips"></div>
      <div class="links">
        <button class="link" id="openChat">↗ Ouvrir le chat</button>
        <button class="link" id="cleanExports" title="Supprime maintenant tous les fichiers d'export créés par l'extension">🧹 Supprimer les exports</button>
        <button class="link" id="settings">⚙ Réglages</button>
      </div>
    </details>
  </div>
<script nonce="${n}" src="${js}"></script>
</body>
</html>`;
}
