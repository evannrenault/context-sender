import * as vscode from 'vscode';
import { LiPanel } from './panel';

function targets(uri?: vscode.Uri, uris?: vscode.Uri[]): vscode.Uri[] {
  if (uris && uris.length) { return uris; }
  if (uri instanceof vscode.Uri) { return [uri]; }
  const ed = vscode.window.activeTextEditor;
  return ed ? [ed.document.uri] : [];
}

export function activate(context: vscode.ExtensionContext) {
  const panel = new LiPanel(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(LiPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.workspace.registerTextDocumentContentProvider('context-sender-proposed', panel.proposedProvider),
    vscode.window.onDidChangeActiveTextEditor(ed => panel.setActive(ed?.document.uri)),
    vscode.commands.registerCommand('contextSender.applyResponse', () => panel.reviewResponse()),
    vscode.commands.registerCommand('contextSender.addActive', () => panel.addActive()),
    vscode.commands.registerCommand('contextSender.cleanExports', () => panel.cleanExportsNow()),

    vscode.commands.registerCommand('contextSender.focus', () =>
      vscode.commands.executeCommand(`${LiPanel.viewId}.focus`)),

    vscode.commands.registerCommand('contextSender.addToSelection', (uri?: vscode.Uri, uris?: vscode.Uri[]) =>
      panel.addUris(targets(uri, uris))),
    vscode.commands.registerCommand('contextSender.excludeAlways', (uri?: vscode.Uri, uris?: vscode.Uri[]) =>
      panel.excludeUris(targets(uri, uris))),
    vscode.commands.registerCommand('contextSender.removeFromSelection', (uri?: vscode.Uri, uris?: vscode.Uri[]) =>
      panel.removeUris(targets(uri, uris))),

    // Copie immédiate de fichiers précis (sans toucher à la sélection du panneau)
    vscode.commands.registerCommand('contextSender.sendNow', async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
      const t = targets(uri, uris);
      if (t.length) { await panel.sendUris(t); }
    }),

    vscode.commands.registerCommand('contextSender.sendSelection', () => panel.send()),
    vscode.commands.registerCommand('contextSender.clearSelection', () => panel.clear()),
    vscode.commands.registerCommand('contextSender.addOpenTabs', () => panel.addOpenTabs()),
    vscode.commands.registerCommand('contextSender.addGitChanged', () => panel.addGitChanged()),
    vscode.commands.registerCommand('contextSender.exportFile', () => panel.exportFile()),
    vscode.commands.registerCommand('contextSender.refresh', () => panel.refresh()),

    vscode.commands.registerCommand('contextSender.openChat', () => openChat(false)),

    // Variante : le chat dans un onglet VSCode (beaucoup de sites l'interdisent, d'où le navigateur par défaut)
    vscode.commands.registerCommand('contextSender.openChatInEditor', () => openChat(true))
  );

  // Rescan automatique quand des fichiers sont créés / supprimés
  let timer: NodeJS.Timeout | undefined;
  const rescan = (u?: vscode.Uri) => {
    if (u && /\/(\.git|node_modules|\.angular|out|dist|target)\//.test(u.path)) { return; }
    clearTimeout(timer); timer = setTimeout(() => panel.refresh(), 1500);
  };
  const watcher = vscode.workspace.createFileSystemWatcher('**/*', false, true, false);
  watcher.onDidCreate(rescan);
  watcher.onDidDelete(rescan);
  context.subscriptions.push(watcher, vscode.workspace.onDidChangeWorkspaceFolders(() => rescan()),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('contextSender')) { rescan(); } }));

  panel.setActive(vscode.window.activeTextEditor?.document.uri);

  // Nettoyage des anciens exports : au démarrage puis toutes les heures
  panel.cleanExports().catch(() => undefined);
  const cleaner = setInterval(() => panel.cleanExports().catch(() => undefined), 3600 * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(cleaner) });

  // Premier scan en arrière-plan (pour la barre d'état), sans attendre l'ouverture du panneau
  panel.refresh();
}

async function openChat(inEditor: boolean) {
  const cfg = vscode.workspace.getConfiguration('contextSender');
  const url = (cfg.get<string>('chatUrl') || '').trim();
  const name = (cfg.get<string>('chatName') || '').trim() || 'Chat IA';
  if (!url) {
    const c = await vscode.window.showInformationMessage(
      'Aucune URL de chat configurée : renseigne le réglage « Context Sender : Chat Url ».', 'Configurer');
    if (c) { vscode.commands.executeCommand('workbench.action.openSettings', 'contextSender.chat'); }
    return;
  }
  if (!inEditor) { vscode.env.openExternal(vscode.Uri.parse(url)); return; }
  const p = vscode.window.createWebviewPanel('contextSenderChat', name, vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true });
  p.webview.html = `<!DOCTYPE html><html><head><style>body,iframe{margin:0;padding:0;width:100%;height:100vh;border:none}</style></head>
    <body><iframe src="${url.replace(/"/g, '&quot;')}"></iframe></body></html>`;
}

export function deactivate() {}
