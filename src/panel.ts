import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { FileEntry, scanWorkspace, gitChangedFiles, isExcludedPath, looksBinary, projectOf } from './scanner';
import { Doc, formatAll, splitParts, maskSecrets, flatName, estimateTokens, prettyDiff } from './format';
import { diffFiles, diffKey } from './git';
import { parseResponse, applyDiff, matchStyle, lineStats, ANSWER_FORMAT, ResponseBlock } from './response';
import { copyFilesToClipboard } from './clipboard';
import { getHtml } from './webview';

const K_SELECTED = 'cs.selected';
const K_BASKETS = 'cs.baskets';
const K_INSTRUCTION = 'cs.instruction';
const K_MODE = 'cs.mode';
const K_CONTEXT = 'cs.context';
const K_EXCLUDED = 'cs.excluded';
const K_ANSWER_FORMAT = 'cs.answerFormat';
const PROPOSED_SCHEME = 'context-sender-proposed';

/** Un fichier proposé par la réponse de l'IA, en attente de revue. */
interface Pending {
  id: number;
  rel: string;
  uri?: string;               // cible (absente si aucun chemin n'a pu être déterminé)
  exists: boolean;
  kind: 'full' | 'diff';
  status: 'ready' | 'partial' | 'failed' | 'nopath' | 'same';
  blocks: ResponseBlock[];    // blocs de la réponse pour ce fichier (plusieurs diffs possibles)
  proposed?: string;
  added: number;
  removed: number;
  applied: boolean;
  revert?: string | null;     // contenu avant application (null = fichier créé)
  note?: string;
}

type Mode = 'full' | 'diff';
interface Filters { exts?: string[]; projects?: string[] }

function cfg() { return vscode.workspace.getConfiguration('contextSender'); }
/** Nom affiché du chat (réglage), « le chat » par défaut. */
function chatName(): string { return (cfg().get<string>('chatName') || '').trim() || 'Chat IA'; }

function sameUri(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function extOf(rel: string): string {
  const base = rel.split('/').pop() || '';
  return base.includes('.') ? base.split('.').pop()!.toLowerCase() : '';
}

export class LiPanel implements vscode.WebviewViewProvider {
  public static readonly viewId = 'contextSender.panel';
  private view?: vscode.WebviewView;
  private files: FileEntry[] = [];
  private filesVersion = 0;
  private sentFilesVersion = -1;
  private scanning = false;
  private parts: string[] = [];
  private partsCopied: boolean[] = [];
  private previewTimer?: NodeJS.Timeout;
  private previewSeq = 0;
  private readonly status: vscode.StatusBarItem;
  private lastPreviewChars = 0;
  private pending: Pending[] = [];
  private pendingSeq = 0;
  private proposedDocs = new Map<string, string>();
  private activeUri?: string;
  public readonly proposedProvider: vscode.TextDocumentContentProvider = {
    provideTextDocumentContent: (u: vscode.Uri) => this.proposedDocs.get(u.path) ?? ''
  };

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.status.command = 'contextSender.focus';
    ctx.subscriptions.push(this.status);
    this.updateStatus();
    this.status.show();
  }

  // ---------- état persistant ----------

  get selected(): string[] { return this.ctx.workspaceState.get<string[]>(K_SELECTED, []); }
  private async setSelected(list: string[]) {
    const uniq: string[] = [];
    for (const u of list) { if (!uniq.some(x => sameUri(x, u))) { uniq.push(u); } }
    await this.ctx.workspaceState.update(K_SELECTED, uniq);
    this.changed();
  }
  private get baskets(): Record<string, string[]> { return this.ctx.workspaceState.get(K_BASKETS, {}); }
  private get instruction(): string { return this.ctx.workspaceState.get(K_INSTRUCTION, ''); }
  private get answerFormat(): boolean { return this.ctx.workspaceState.get<boolean>(K_ANSWER_FORMAT, cfg().get<boolean>('askApplicableAnswer') ?? true); }
  /** Consigne réellement envoyée : celle de l'utilisateur + le format de réponse applicable si activé. */
  private get effectiveInstruction(): string {
    const parts = [this.instruction.trim()];
    if (this.answerFormat) { parts.push(ANSWER_FORMAT); }
    return parts.filter(Boolean).join('\n\n');
  }
  private get mode(): Mode { return this.ctx.workspaceState.get<Mode>(K_MODE, 'full'); }
  private get context(): number { return this.ctx.workspaceState.get<number>(K_CONTEXT, cfg().get<number>('diffContextLines') ?? 8); }
  private get userExcluded(): string[] { return this.ctx.workspaceState.get<string[]>(K_EXCLUDED, []); }

  private isUserExcluded(rel: string): boolean {
    return this.userExcluded.some(x => rel === x || rel.startsWith(x + '/'));
  }
  private isExcluded(rel: string): boolean { return isExcludedPath(rel) || this.isUserExcluded(rel); }

  /** Fichiers visibles = scannés moins les exclusions du projet. */
  private visible(): FileEntry[] { return this.files.filter(f => !this.isUserExcluded(f.rel)); }

  private selectedEntries(): FileEntry[] {
    const sel = this.selected;
    return this.visible().filter(f => sel.some(s => sameUri(s, f.uri)));
  }

  private changed() {
    this.parts = []; this.partsCopied = [];
    this.updateStatus();
    this.post();
    this.schedulePreview();
  }

  private updateStatus() {
    const n = this.selectedEntries().length;
    const chars = this.lastPreviewChars || this.selectedEntries().reduce((a, f) => a + f.size, 0);
    this.status.text = n ? `$(cloud-upload) ${n} fichier${n > 1 ? 's' : ''} · ~${fmtTokens(estimateTokens(chars))}` : '$(cloud-upload)';
    this.status.tooltip = `Context Sender — fichiers à envoyer vers ${chatName()}`;
  }

  // ---------- webview ----------

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'media')] };
    view.webview.html = getHtml(view.webview, this.ctx.extensionUri);
    this.sentFilesVersion = -1;
    view.webview.onDidReceiveMessage(m => this.onMessage(m).catch(e =>
      vscode.window.showErrorMessage(`Context Sender : ${e?.message ?? e}`)));
    view.onDidChangeVisibility(() => { if (view.visible) { this.sentFilesVersion = -1; this.post(); this.schedulePreview(); } });
    if (!this.files.length) { this.refresh(); }
  }

  private post() {
    if (!this.view) { return; }
    const msg: Record<string, unknown> = {
      type: 'state',
      selected: this.selected,
      baskets: Object.keys(this.baskets).sort(),
      instruction: this.instruction,
      answerFormat: this.answerFormat,
      active: this.activeUri,
      review: this.reviewState(),
      mode: this.mode,
      context: this.context,
      excluded: this.userExcluded,
      parts: { count: this.parts.length, copied: this.partsCopied },
      pasteLimit: cfg().get<number>('pasteLimit') ?? 30000,
      chatName: chatName(),
      scanning: this.scanning,
      hasWorkspace: !!vscode.workspace.workspaceFolders?.length
    };
    if (this.sentFilesVersion !== this.filesVersion) {
      msg.files = this.visible().map(f => [f.uri, f.rel, f.size, f.proj]);
      this.sentFilesVersion = this.filesVersion;
    }
    this.view.webview.postMessage(msg);
  }

  /** Calcule (en arrière-plan) la taille réelle de ce qui sera envoyé, fichier par fichier. */
  private schedulePreview() {
    clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => this.computePreview().catch(() => undefined), 250);
  }

  private async computePreview() {
    const seq = ++this.previewSeq;
    const entries = this.selectedEntries();
    const { docs, byUri } = await this.buildDocs(entries, false);
    if (seq !== this.previewSeq) { return; }
    const total = docs.length ? formatAll(docs, this.effectiveInstruction).length : 0;
    this.lastPreviewChars = total;
    this.updateStatus();
    const perFile: Record<string, [number, string, string]> = {};
    for (const [uri, d] of byUri) { perFile[uri] = [d.content.length, d.kind ?? 'full', d.meta ?? '']; }
    const fullChars = entries.reduce((a, f) => a + f.size, 0);
    this.view?.webview.postMessage({ type: 'preview', total, fullChars, perFile });
  }

  async refresh() {
    this.scanning = true;
    this.post();
    try {
      this.files = await scanWorkspace();
      this.filesVersion++;
      const sel = this.selected.filter(s => this.files.some(f => sameUri(f.uri, s)));
      if (sel.length !== this.selected.length) { await this.ctx.workspaceState.update(K_SELECTED, sel); }
    } finally {
      this.scanning = false;
      this.changed();
    }
  }

  // ---------- ajout / retrait ----------

  /** Résout fichiers / dossiers en entrées (récursif), en écartant les exclusions. */
  private async resolveEntries(uris: vscode.Uri[]): Promise<{ entries: FileEntry[]; excluded: number }> {
    if (!this.files.length) { await this.refresh(); }
    const out: FileEntry[] = [];
    let excluded = 0;
    const vis = this.visible();
    for (const u of uris) {
      const s = u.toString();
      const exact = vis.find(f => sameUri(f.uri, s));
      if (exact) { out.push(exact); continue; }
      const prefix = (s.endsWith('/') ? s : s + '/');
      const inside = vis.filter(f => (process.platform === 'win32'
        ? f.uri.toLowerCase().startsWith(prefix.toLowerCase()) : f.uri.startsWith(prefix)));
      if (inside.length) { out.push(...inside); continue; }
      // hors de la liste : exclu, ignoré par git, ou binaire ?
      try {
        const st = await vscode.workspace.fs.stat(u);
        if (st.type & vscode.FileType.Directory) { continue; }
        const rel = vscode.workspace.asRelativePath(u);
        if (this.isExcluded(rel)) { excluded++; continue; }
        const head = (await vscode.workspace.fs.readFile(u)).subarray(0, 8000);
        if (looksBinary(head)) { excluded++; continue; }
        const e: FileEntry = { uri: s, rel, size: st.size, proj: projectOf(u.fsPath) };
        this.files.push(e);
        this.files.sort((a, b) => a.rel.localeCompare(b.rel));
        this.filesVersion++;
        out.push(e);
      } catch { /* introuvable */ }
    }
    return { entries: out, excluded };
  }

  private applyFilters(entries: FileEntry[], f?: Filters): FileEntry[] {
    const exts = (f?.exts ?? []).map(e => (e === '(sans)' ? '' : e.toLowerCase()));
    const projects = f?.projects ?? [];
    return entries.filter(e => (!exts.length || exts.includes(extOf(e.rel))) && (!projects.length || projects.includes(e.proj)));
  }

  private filterLabel(f?: Filters): string {
    const bits = [...(f?.projects ?? []), ...(f?.exts ?? []).map(e => (e === '(sans)' ? 'sans extension' : '.' + e))];
    return bits.length ? ` (${bits.join(', ')})` : '';
  }

  async addUris(uris: vscode.Uri[], filters?: Filters, origin = '') {
    const { entries, excluded } = await this.resolveEntries(uris);
    const kept = this.applyFilters(entries, filters);
    const before = this.selectedEntries().length;
    await this.setSelected([...this.selected, ...kept.map(e => e.uri)]);
    const added = this.selectedEntries().length - before;
    const extra = [
      excluded ? `${excluded} exclu(s)` : '',
      entries.length - kept.length ? `${entries.length - kept.length} hors filtre` : ''
    ].filter(Boolean).join(', ');
    vscode.window.setStatusBarMessage(
      `$(check) ${added} fichier(s)${origin}${this.filterLabel(filters)} ajouté(s)${extra ? ` — ${extra}` : ''}`, 5000);
    return { added, excluded, filtered: entries.length - kept.length };
  }

  async removeUris(uris: vscode.Uri[]) {
    const rm = uris.map(u => u.toString());
    await this.setSelected(this.selected.filter(s =>
      !rm.some(r => sameUri(r, s) || s.toLowerCase().startsWith((r.endsWith('/') ? r : r + '/').toLowerCase()))));
  }

  async clear() { await this.setSelected([]); }

  async addOpenTabs(filters?: Filters) {
    const uris: vscode.Uri[] = [];
    for (const g of vscode.window.tabGroups.all) {
      for (const t of g.tabs) {
        const input = t.input as { uri?: vscode.Uri } | undefined;
        if (input?.uri && input.uri.scheme === 'file') { uris.push(input.uri); }
      }
    }
    if (!uris.length) { vscode.window.showInformationMessage('Aucun onglet de fichier ouvert.'); return; }
    await this.addUris(uris, filters, ' ouvert(s)');
  }

  async addGitChanged(filters?: Filters) {
    const r = await gitChangedFiles();
    if (r.uris.length) {
      const res = await this.addUris(r.uris, filters, ' modifié(s)');
      if (!res.added && (res.filtered || res.excluded)) {
        vscode.window.showInformationMessage(`Aucun fichier modifié ne correspond${this.filterLabel(filters)} : ${r.uris.length} modifié(s) au total, ${res.filtered} hors filtre, ${res.excluded} exclu(s).`);
      }
      return;
    }
    if (r.reason === 'noGit') {
      const c = await vscode.window.showWarningMessage(
        `Git est introuvable depuis VSCode (« ${r.detail} »). GitHub Desktop utilise son propre git, qui n'est pas visible par les autres logiciels : installe Git for Windows, ou indique le chemin de git.exe dans le réglage « git.path ».`,
        'Ouvrir le réglage git.path');
      if (c) { vscode.commands.executeCommand('workbench.action.openSettings', 'git.path'); }
    } else if (r.reason === 'noRepo') {
      vscode.window.showWarningMessage(
        'Aucun dépôt git trouvé dans le dossier ouvert. Ouvre dans VSCode le dossier du dépôt (celui que GitHub Desktop affiche), ou vérifie que l\'onglet « Contrôle de code source » le détecte.'
        + (r.detail ? ` (git : ${r.detail.split('\n')[0]})` : ''));
    } else {
      vscode.window.showInformationMessage(`Aucun fichier modifié dans ${r.repos} dépôt(s) git détecté(s).`);
    }
  }

  // ---------- exclusions du projet ----------

  async exclude(rel: string) {
    rel = rel.replace(/\/+$/, '');
    if (!rel || this.isUserExcluded(rel)) { return; }
    // un dossier exclu remplace les exclusions plus fines qu'il contient
    const list = this.userExcluded.filter(x => !x.startsWith(rel + '/'));
    await this.ctx.workspaceState.update(K_EXCLUDED, [...list, rel].sort());
    this.filesVersion++;
    await this.setSelected(this.selected.filter(s => {
      const f = this.files.find(x => sameUri(x.uri, s));
      return !f || !this.isUserExcluded(f.rel);
    }));
  }

  async unexclude(rel: string) {
    await this.ctx.workspaceState.update(K_EXCLUDED, this.userExcluded.filter(x => x !== rel));
    this.filesVersion++;
    this.changed();
  }

  async excludeUris(uris: vscode.Uri[]) {
    for (const u of uris) { await this.exclude(vscode.workspace.asRelativePath(u)); }
  }

  // ---------- lecture ----------

  /** Construit les documents à envoyer, selon le mode (complet ou modifications seulement). */
  private async buildDocs(entries: FileEntry[], warn = true): Promise<{ docs: Doc[]; byUri: Map<string, Doc> }> {
    const maxBytes = (cfg().get<number>('maxFileKB') ?? 1024) * 1024;
    const mask = cfg().get<boolean>('maskSecrets') ?? true;
    const mode = this.mode;
    const diffs = mode === 'diff' && entries.length
      ? await diffFiles(entries.map(e => vscode.Uri.parse(e.uri).fsPath), this.context)
      : undefined;
    const docs: Doc[] = [];
    const byUri = new Map<string, Doc>();
    const skipped: string[] = [];

    for (const f of entries) {
      const uri = vscode.Uri.parse(f.uri);
      const fd = diffs?.get(diffKey(uri.fsPath));
      let doc: Doc | undefined;

      if (fd?.kind === 'diff' && fd.diff) {
        const p = prettyDiff(fd.diff);
        doc = { rel: f.rel, content: p.text, kind: 'diff', meta: `${p.hunks} zone${p.hunks > 1 ? 's' : ''}, +${p.added} / −${p.removed}` };
      } else {
        const open = vscode.workspace.textDocuments.find(d => sameUri(d.uri.toString(), f.uri));
        let content: string | undefined;
        if (open) {
          content = open.getText();                     // inclut les modifications non enregistrées
        } else {
          const st = await vscode.workspace.fs.stat(uri).then(s => s, () => null);
          if (!st) { skipped.push(`${f.rel} (introuvable)`); continue; }
          if (st.size > maxBytes) { skipped.push(`${f.rel} (${Math.round(st.size / 1024)} Ko > limite)`); continue; }
          const buf = await vscode.workspace.fs.readFile(uri);
          if (looksBinary(buf)) { skipped.push(`${f.rel} (binaire)`); continue; }
          content = Buffer.from(buf).toString('utf8').replace(/^﻿/, '');
        }
        doc = { rel: f.rel, content, kind: fd?.kind === 'new' ? 'new' : 'full' };
      }
      if (mask) { doc.content = maskSecrets(doc.content); }
      docs.push(doc);
      byUri.set(f.uri, doc);
    }
    if (warn && skipped.length) {
      vscode.window.showWarningMessage(`Context Sender : ${skipped.length} fichier(s) ignoré(s) : ${skipped.join(', ')}`);
    }
    return { docs, byUri };
  }

  private async docsFor(only?: FileEntry[]): Promise<Doc[] | undefined> {
    const entries = only ?? this.selectedEntries();
    if (!entries.length) {
      vscode.window.showWarningMessage('Aucun fichier sélectionné : coche des fichiers dans le panneau Context Sender.');
      return;
    }
    const { docs } = await this.buildDocs(entries);
    return docs.length ? docs : undefined;
  }

  // ---------- actions d'envoi ----------

  /** Bouton principal : colle si ça tient, sinon propose fichier ou parties. */
  async send(only?: FileEntry[]) {
    const docs = await this.docsFor(only);
    if (!docs) { return; }
    const text = formatAll(docs, this.effectiveInstruction);
    const limit = cfg().get<number>('pasteLimit') ?? 30000;
    if (text.length <= limit) { return this.copyText(docs, text); }

    const nParts = splitParts(docs, this.effectiveInstruction, limit).length;
    let choice = cfg().get<string>('largeSelection') ?? 'ask';
    if (choice === 'ask') {
      const pick = await vscode.window.showQuickPick([
        { label: '$(file) Créer un fichier à joindre', description: 'recommandé', detail: `Un seul fichier (~${fmtTokens(estimateTokens(text.length))}), mis dans le presse-papiers : Ctrl+V dans le chat ou glisser-déposer`, id: 'file' },
        { label: `$(list-ordered) Découper en ${nParts} messages`, detail: 'À coller l\'un après l\'autre, la consigne est dans le dernier', id: 'parts' },
        { label: '$(files) Un fichier par fichier source', detail: 'Pour joindre plusieurs pièces jointes (renommées en .txt)', id: 'separate' },
        { label: '$(clippy) Copier quand même en un seul message', id: 'copy' }
      ], { placeHolder: `La sélection fait ${text.length.toLocaleString('fr-FR')} caractères (limite de collage : ${limit.toLocaleString('fr-FR')})` });
      if (!pick) { return; }
      choice = pick.id;
    }
    if (choice === 'parts') { return this.makeParts(docs); }
    if (choice === 'separate') { return this.exportSeparate(docs); }
    if (choice === 'copy') { return this.copyText(docs, text); }
    return this.exportFile(docs);
  }

  async copyText(docs?: Doc[], text?: string) {
    docs ??= await this.docsFor();
    if (!docs) { return; }
    text ??= formatAll(docs, this.effectiveInstruction);
    await vscode.env.clipboard.writeText(text);
    this.notifyDone(`✅ ${docs.length} fichier(s) copié(s) (~${fmtTokens(estimateTokens(text.length))}) — colle-les dans le chat.`);
  }

  private exportDir(): string {
    const custom = cfg().get<string>('exportFolder');
    return custom && custom.trim() ? custom : path.join(os.tmpdir(), 'context-sender');
  }

  /**
   * Supprime les exports créés par l'extension (reconnus à leur nom horodaté « …-AAAAMMJJ-HHMMSS[.txt|.md] »).
   * all = true : tous ; sinon ceux plus vieux que le réglage exportRetentionHours (0 = jamais).
   */
  async cleanExports(all = false): Promise<number> {
    const hours = cfg().get<number>('exportRetentionHours') ?? 24;
    if (!all && hours <= 0) { return 0; }
    const dir = vscode.Uri.file(this.exportDir());
    let entries: [string, vscode.FileType][];
    try { entries = await vscode.workspace.fs.readDirectory(dir); } catch { return 0; }
    const ours = /-\d{8}-\d{6}(\.(txt|md))?$/;
    const limit = Date.now() - hours * 3600 * 1000;
    let n = 0;
    for (const [name, type] of entries) {
      if (!ours.test(name)) { continue; }                         // jamais un fichier qui n'est pas un export de l'extension
      const isDir = (type & vscode.FileType.Directory) !== 0;
      if (!isDir && !(type & vscode.FileType.File)) { continue; }
      const uri = vscode.Uri.joinPath(dir, name);
      try {
        if (!all) {
          const st = await vscode.workspace.fs.stat(uri);
          if (st.mtime > limit) { continue; }
        }
        await vscode.workspace.fs.delete(uri, { recursive: isDir, useTrash: false });
        n++;
      } catch { /* fichier encore ouvert ou déjà supprimé */ }
    }
    return n;
  }

  async cleanExportsNow() {
    const n = await this.cleanExports(true);
    vscode.window.showInformationMessage(n ? `🧹 ${n} export(s) supprimé(s) de ${this.exportDir()}.` : 'Aucun export à supprimer.');
  }

  private stamp(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  private projectName(): string {
    return (vscode.workspace.name || 'projet').replace(/\s*\(Workspace\)$/i, '').replace(/[^\w.-]+/g, '_');
  }

  async exportFile(docs?: Doc[]) {
    docs ??= await this.docsFor();
    if (!docs) { return; }
    const ext = cfg().get<string>('exportFormat') === 'md' ? 'md' : 'txt';
    await this.cleanExports();
    const dir = vscode.Uri.file(this.exportDir());
    await vscode.workspace.fs.createDirectory(dir);
    const suffix = this.mode === 'diff' ? '-modifs' : '';
    const file = vscode.Uri.joinPath(dir, `${this.projectName()}-${docs.length}fichiers${suffix}-${this.stamp()}.${ext}`);
    await vscode.workspace.fs.writeFile(file, Buffer.from(formatAll(docs, ''), 'utf8'));

    const inClipboard = await copyFilesToClipboard([file.fsPath]);
    const instr = this.effectiveInstruction;
    this.notifyDone(inClipboard
      ? `📎 Fichier prêt et copié : Ctrl+V dans le chat pour le joindre${instr ? ', puis colle ta consigne (bouton ci-dessous)' : ''}.`
      : '📎 Fichier prêt : glisse-le dans le chat.', file, instr);
  }

  async exportSeparate(docs?: Doc[]) {
    docs ??= await this.docsFor();
    if (!docs) { return; }
    const addTxt = cfg().get<boolean>('separateFilesAsTxt') ?? true;
    await this.cleanExports();
    const dir = vscode.Uri.joinPath(vscode.Uri.file(this.exportDir()), `${this.projectName()}-${this.stamp()}`);
    await vscode.workspace.fs.createDirectory(dir);
    const paths: string[] = [];
    for (const d of docs) {
      const name = d.kind === 'diff' ? flatName(d.rel + '.diff', addTxt) : flatName(d.rel, addTxt);
      const f = vscode.Uri.joinPath(dir, name);
      const head = d.kind === 'diff' ? `// Fichier : ${d.rel} — modifications seulement (${d.meta})\n` : `// Fichier : ${d.rel}\n`;
      await vscode.workspace.fs.writeFile(f, Buffer.from(head + d.content, 'utf8'));
      paths.push(f.fsPath);
    }
    const inClipboard = await copyFilesToClipboard(paths);
    this.notifyDone(inClipboard
      ? `📎 ${paths.length} fichiers prêts et copiés : Ctrl+V dans le chat pour les joindre.`
      : `📎 ${paths.length} fichiers prêts : sélectionne-les dans le dossier et glisse-les dans le chat.`,
      dir, this.effectiveInstruction);
  }

  async makeParts(docs?: Doc[]) {
    docs ??= await this.docsFor();
    if (!docs) { return; }
    this.parts = splitParts(docs, this.effectiveInstruction, cfg().get<number>('pasteLimit') ?? 30000);
    this.partsCopied = this.parts.map(() => false);
    await vscode.commands.executeCommand(`${LiPanel.viewId}.focus`);
    this.post();
    await this.copyPart(0);
  }

  async copyPart(i: number) {
    const p = this.parts[i];
    if (p === undefined) { return; }
    await vscode.env.clipboard.writeText(p);
    this.partsCopied[i] = true;
    this.post();
    vscode.window.setStatusBarMessage(`$(clippy) Partie ${i + 1}/${this.parts.length} copiée — colle-la, puis clique sur la suivante`, 6000);
  }

  async sendUris(uris: vscode.Uri[]) {
    const { entries } = await this.resolveEntries(uris);
    if (entries.length) { await this.send(entries); }
  }

  private notifyDone(message: string, revealUri?: vscode.Uri, instruction?: string) {
    const buttons: string[] = [];
    if (revealUri) { buttons.push('Afficher le fichier'); }
    if (instruction) { buttons.push('Copier la consigne'); }
    const openLabel = `Ouvrir ${chatName()}`;
    buttons.push(openLabel);
    vscode.window.showInformationMessage(message, ...buttons).then(async c => {
      if (c === 'Afficher le fichier' && revealUri) { vscode.commands.executeCommand('revealFileInOS', revealUri); }
      if (c === 'Copier la consigne' && instruction) { await vscode.env.clipboard.writeText(instruction); }
      if (c === openLabel) { vscode.commands.executeCommand('contextSender.openChat'); }
    });
    if (cfg().get<boolean>('openChatAfterSend')) { vscode.commands.executeCommand('contextSender.openChat'); }
  }

  // ---------- fichier actif ----------

  setActive(uri?: vscode.Uri) {
    this.activeUri = uri && uri.scheme === 'file' ? uri.toString() : undefined;
    this.view?.webview.postMessage({ type: 'active', uri: this.activeUri });
  }

  async addActive() {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.document.uri.scheme !== 'file') { vscode.window.showInformationMessage('Aucun fichier ouvert dans l\'éditeur.'); return; }
    await this.addUris([ed.document.uri], undefined, ' actif');
  }

  // ---------- réponse de l'IA : revue et application ----------

  private reviewState() {
    if (!this.pending.length) { return null; }
    return this.pending.map(p => ({
      id: p.id, rel: p.rel, kind: p.kind, status: p.status, exists: p.exists,
      added: p.added, removed: p.removed, applied: p.applied, note: p.note, hasTarget: !!p.uri
    }));
  }

  /** Trouve le fichier visé par un chemin donné par l'IA (exact, suffixe, nom de fichier unique, sinon nouveau fichier). */
  private async resolveTarget(p: string): Promise<{ uri: vscode.Uri; rel: string; exists: boolean } | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!folders.length) { return undefined; }
    const norm = p.replace(/\\/g, '/').replace(/^\/+/, '');
    const eq = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
    const ends = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase().endsWith(b.toLowerCase()) : a.endsWith(b);
    if (!this.files.length) { await this.refresh(); }

    const hit = (f: FileEntry) => ({ uri: vscode.Uri.parse(f.uri), rel: f.rel, exists: true });
    const exact = this.files.find(f => eq(f.rel, norm));
    if (exact) { return hit(exact); }
    for (const folder of folders) {                                    // fichier existant hors de la liste (exclu, ignoré…)
      const u = vscode.Uri.joinPath(folder.uri, norm);
      try { const st = await vscode.workspace.fs.stat(u); if (!(st.type & vscode.FileType.Directory)) { return { uri: u, rel: vscode.workspace.asRelativePath(u), exists: true }; } } catch { /* absent */ }
    }
    const suffix = this.files.filter(f => ends(f.rel, '/' + norm) || ends(norm, '/' + f.rel));
    if (suffix.length === 1) { return hit(suffix[0]); }
    if (!norm.includes('/')) {
      const base = this.files.filter(f => eq(f.rel.split('/').pop()!, norm));
      if (base.length === 1) { return hit(base[0]); }
    }
    // nouveau fichier : dans le dossier racine nommé en tête du chemin (multi-root), sinon le premier
    const first = norm.split('/')[0];
    const folder = folders.find(f => eq(f.name, first) && folders.length > 1);
    const relInFolder = folder ? norm.slice(first.length + 1) : norm;
    const uri = vscode.Uri.joinPath((folder ?? folders[0]).uri, relInFolder);
    return { uri, rel: vscode.workspace.asRelativePath(uri), exists: false };
  }

  private async currentText(uri: vscode.Uri): Promise<string | undefined> {
    const open = vscode.workspace.textDocuments.find(d => sameUri(d.uri.toString(), uri.toString()));
    if (open) { return open.getText(); }
    try { return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'); } catch { return undefined; }
  }

  /** Calcule le contenu proposé pour un fichier à partir de ses blocs (fichier complet et/ou diffs). */
  private async computeProposed(p: Pending) {
    if (!p.uri) { p.status = 'nopath'; return; }
    const uri = vscode.Uri.parse(p.uri);
    const original = await this.currentText(uri);
    p.exists = original !== undefined;
    let content = original;
    let failed = 0, total = 0;
    const lastFull = [...p.blocks].reverse().find(b => b.kind === 'full');
    if (lastFull) { content = matchStyle(original, lastFull.code); }
    for (const b of p.blocks.filter(x => x.kind === 'diff' && (!lastFull || p.blocks.indexOf(x) > p.blocks.indexOf(lastFull)))) {
      const r = applyDiff(content ?? '', b.code);
      content = r.content; failed += r.failed; total += r.total;
    }
    p.kind = lastFull ? 'full' : 'diff';
    p.proposed = content;
    const st = lineStats(original ?? '', content ?? '');
    p.added = st.added; p.removed = st.removed;
    if (total && failed === total) { p.status = 'failed'; p.note = 'aucune zone du diff n\'a été retrouvée dans le fichier'; }
    else if (failed) { p.status = 'partial'; p.note = `${failed} zone(s) sur ${total} non retrouvée(s)`; }
    else if (original !== undefined && content === original) { p.status = 'same'; p.note = 'identique au fichier actuel'; }
    else { p.status = 'ready'; p.note = undefined; }
    if (!p.exists && p.kind === 'diff') { p.status = 'failed'; p.note = 'diff pour un fichier introuvable'; }
  }

  /** Lit la réponse de l'IA (presse-papiers par défaut) et prépare la revue fichier par fichier. */
  async reviewResponse(text?: string) {
    text ??= await vscode.env.clipboard.readText();
    if (!text || !text.trim()) { vscode.window.showWarningMessage('Le presse-papiers est vide : copie d\'abord la réponse de l\'IA.'); return; }
    const blocks = parseResponse(text);
    if (!blocks.length) { vscode.window.showWarningMessage('Aucun bloc de code trouvé dans la réponse copiée.'); return; }

    const byKey = new Map<string, Pending>();
    const order: Pending[] = [];
    const lone = blocks.filter(b => !b.path);
    const activeEd = vscode.window.activeTextEditor;
    for (const b of blocks) {
      let target: { uri: vscode.Uri; rel: string; exists: boolean } | undefined;
      let note: string | undefined;
      if (b.path) { target = await this.resolveTarget(b.path); }
      else if (blocks.length === 1 && activeEd && activeEd.document.uri.scheme === 'file') {
        target = { uri: activeEd.document.uri, rel: vscode.workspace.asRelativePath(activeEd.document.uri), exists: true };
        note = 'aucun chemin dans la réponse : appliqué au fichier ouvert';
      }
      const k = target ? target.uri.toString().toLowerCase() : `nopath-${order.length}`;
      let p = byKey.get(k);
      if (!p) {
        p = { id: ++this.pendingSeq, rel: target?.rel ?? `Bloc ${lone.indexOf(b) + 1} sans chemin`, uri: target?.uri.toString(), exists: !!target?.exists,
          kind: b.kind, status: 'ready', blocks: [], added: 0, removed: 0, applied: false };
        byKey.set(k, p); order.push(p);
      }
      p.blocks.push(b);
      await this.computeProposed(p);
      if (note && !p.note) { p.note = note; }
    }
    this.pending = order;
    await vscode.commands.executeCommand(`${LiPanel.viewId}.focus`);
    this.post();
    const ready = order.filter(p => p.status === 'ready' || p.status === 'partial').length;
    vscode.window.setStatusBarMessage(`$(checklist) Réponse lue : ${order.length} fichier(s), ${ready} prêt(s) à appliquer`, 6000);
  }

  private find(id: number) { return this.pending.find(p => p.id === id); }

  async previewPending(id: number) {
    const p = this.find(id);
    if (!p || !p.uri || p.proposed === undefined) { return; }
    const uri = vscode.Uri.parse(p.uri);
    const name = p.rel.split('/').pop();
    const key = `/${p.id}-${Date.now()}/${name}`;
    this.proposedDocs.set(key, p.proposed);
    const right = vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: key });
    let left = uri;
    if (!p.exists) {
      const emptyKey = `/${p.id}-vide/${name}`;
      this.proposedDocs.set(emptyKey, '');
      left = vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: emptyKey });
    }
    await vscode.commands.executeCommand('vscode.diff', left, right, `${name} : actuel ↔ proposition de l'IA${p.applied ? ' (appliquée)' : ''}`, { preview: true });
  }

  async applyPending(id: number, quiet = false): Promise<boolean> {
    const p = this.find(id);
    if (!p || !p.uri || p.applied || p.status === 'failed' || p.status === 'nopath' || p.status === 'same') { return false; }
    await this.computeProposed(p);                       // repart du contenu actuel (le fichier a pu changer depuis)
    if (p.proposed === undefined || (p.status as string) === 'failed') { this.post(); return false; }
    const uri = vscode.Uri.parse(p.uri);
    const before = await this.currentText(uri);
    if (before !== undefined) {
      const doc = await vscode.workspace.openTextDocument(uri);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), p.proposed);
      if (!await vscode.workspace.applyEdit(edit)) { if (!quiet) { vscode.window.showErrorMessage(`Impossible de modifier ${p.rel}.`); } return false; }
      if (cfg().get<boolean>('saveAfterApply') ?? true) { await doc.save(); }
      p.revert = before;
    } else {
      const parent = vscode.Uri.joinPath(uri, '..');
      await vscode.workspace.fs.createDirectory(parent);
      await vscode.workspace.fs.writeFile(uri, Buffer.from(p.proposed, 'utf8'));
      p.revert = null;
    }
    p.applied = true;
    this.post();
    if (!quiet && (cfg().get<boolean>('openAfterApply') ?? true)) {
      await vscode.window.showTextDocument(uri, { preview: true, preserveFocus: true });
    }
    return true;
  }

  async applyAll() {
    const todo = this.pending.filter(p => !p.applied && (p.status === 'ready' || p.status === 'partial'));
    if (!todo.length) { vscode.window.showInformationMessage('Rien à appliquer.'); return; }
    const partial = todo.filter(p => p.status === 'partial');
    if (partial.length) {
      const ok = await vscode.window.showWarningMessage(
        `${partial.length} fichier(s) ne seront modifiés que partiellement (zones du diff non retrouvées). Appliquer quand même ?`,
        { modal: true }, 'Appliquer tout', 'Seulement les complets');
      if (!ok) { return; }
      if (ok === 'Seulement les complets') { todo.splice(0, todo.length, ...todo.filter(p => p.status === 'ready')); }
    }
    let n = 0;
    for (const p of todo) { if (await this.applyPending(p.id, true)) { n++; } }
    const c = await vscode.window.showInformationMessage(`✅ ${n} fichier(s) modifié(s) par la réponse de l'IA.`, 'Annuler', 'Voir les fichiers modifiés');
    if (c === 'Annuler') { await this.revertAll(); }
    if (c === 'Voir les fichiers modifiés') { vscode.commands.executeCommand('workbench.view.scm'); }
  }

  async revertPending(id: number) {
    const p = this.find(id);
    if (!p || !p.applied || !p.uri) { return; }
    const uri = vscode.Uri.parse(p.uri);
    if (p.revert === null) {
      try { await vscode.workspace.fs.delete(uri, { useTrash: true }); } catch { /* déjà supprimé */ }
    } else if (p.revert !== undefined) {
      const doc = await vscode.workspace.openTextDocument(uri);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), p.revert);
      await vscode.workspace.applyEdit(edit);
      if (cfg().get<boolean>('saveAfterApply') ?? true) { await doc.save(); }
    }
    p.applied = false; p.revert = undefined;
    await this.computeProposed(p);
    this.post();
  }

  async revertAll() {
    for (const p of [...this.pending].reverse()) { if (p.applied) { await this.revertPending(p.id); } }
    vscode.window.setStatusBarMessage('$(discard) Modifications de l\'IA annulées', 4000);
  }

  skipPending(id: number) { this.pending = this.pending.filter(p => p.id !== id); this.post(); }
  closeReview() { this.pending = []; this.proposedDocs.clear(); this.post(); }

  /** Choisir manuellement le fichier cible (bloc sans chemin ou mauvaise correspondance). */
  async retargetPending(id: number) {
    const p = this.find(id);
    if (!p) { return; }
    const items = this.visible().map(f => ({ label: f.rel.split('/').pop()!, description: f.rel, f }));
    const pick = await vscode.window.showQuickPick(items, { placeHolder: `Fichier cible pour « ${p.rel} »`, matchOnDescription: true });
    if (!pick) { return; }
    p.uri = pick.f.uri; p.rel = pick.f.rel; p.exists = true; p.applied = false;
    await this.computeProposed(p);
    this.post();
  }

  // ---------- sélections enregistrées ----------

  async saveBasket() {
    if (!this.selected.length) { return; }
    const name = await vscode.window.showInputBox({ prompt: 'Nom de la sélection (ex. « module facturation »)', ignoreFocusOut: true });
    if (!name) { return; }
    await this.ctx.workspaceState.update(K_BASKETS, { ...this.baskets, [name]: this.selected });
    this.post();
  }

  async loadBasket(name: string, mode: 'replace' | 'add') {
    const b = this.baskets[name];
    if (b) { await this.setSelected(mode === 'add' ? [...this.selected, ...b] : b); }
  }

  async deleteBasket(name: string) {
    const ok = await vscode.window.showWarningMessage(`Supprimer la sélection « ${name} » ?`, { modal: true }, 'Supprimer');
    if (ok !== 'Supprimer') { return; }
    const b = { ...this.baskets };
    delete b[name];
    await this.ctx.workspaceState.update(K_BASKETS, b);
    this.post();
  }

  // ---------- messages du webview ----------

  private async onMessage(m: { type: string; [k: string]: any }) {
    switch (m.type) {
      case 'ready': this.sentFilesVersion = -1; this.post(); this.schedulePreview(); break;
      case 'refresh': await this.refresh(); break;
      case 'toggle': {
        const uris: string[] = m.uris;
        await this.setSelected(m.on ? [...this.selected, ...uris] : this.selected.filter(s => !uris.some(u => sameUri(u, s))));
        break;
      }
      case 'clear': await this.clear(); break;
      case 'openTabs': await this.addOpenTabs(m.filters); break;
      case 'gitChanged': await this.addGitChanged(m.filters); break;
      case 'open': vscode.window.showTextDocument(vscode.Uri.parse(m.uri), { preview: true }); break;
      case 'instruction':
        await this.ctx.workspaceState.update(K_INSTRUCTION, String(m.value ?? ''));
        this.parts = []; this.partsCopied = []; this.schedulePreview();
        break;
      case 'mode': await this.ctx.workspaceState.update(K_MODE, m.value === 'diff' ? 'diff' : 'full'); this.changed(); break;
      case 'context': await this.ctx.workspaceState.update(K_CONTEXT, Math.max(0, Math.min(200, Number(m.value) || 0))); this.changed(); break;
      case 'exclude': await this.exclude(String(m.rel)); break;
      case 'unexclude': await this.unexclude(String(m.rel)); break;
      case 'send': await this.send(); break;
      case 'copy': await this.copyText(); break;
      case 'file': await this.exportFile(); break;
      case 'separate': await this.exportSeparate(); break;
      case 'parts': await this.makeParts(); break;
      case 'copyPart': await this.copyPart(Number(m.index)); break;
      case 'saveBasket': await this.saveBasket(); break;
      case 'loadBasket': await this.loadBasket(m.name, m.mode === 'add' ? 'add' : 'replace'); break;
      case 'deleteBasket': await this.deleteBasket(m.name); break;
      case 'openChat': vscode.commands.executeCommand('contextSender.openChat'); break;
      case 'settings': vscode.commands.executeCommand('workbench.action.openSettings', 'contextSender'); break;
      case 'cleanExports': await this.cleanExportsNow(); break;
      case 'addActive': await this.addActive(); break;
      case 'answerFormat': await this.ctx.workspaceState.update(K_ANSWER_FORMAT, !!m.value); this.changed(); break;
      case 'review': await this.reviewResponse(); break;
      case 'rvDiff': await this.previewPending(Number(m.id)); break;
      case 'rvApply': await this.applyPending(Number(m.id)); break;
      case 'rvRevert': await this.revertPending(Number(m.id)); break;
      case 'rvSkip': this.skipPending(Number(m.id)); break;
      case 'rvTarget': await this.retargetPending(Number(m.id)); break;
      case 'rvAll': await this.applyAll(); break;
      case 'rvUndoAll': await this.revertAll(); break;
      case 'rvClose': this.closeReview(); break;
    }
  }
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace('.', ',')} k tokens` : `${n} tokens`;
}
