import * as vscode from 'vscode';
import * as path from 'path';
import { execFile } from 'child_process';
import * as fs from 'fs';

// Sous-ensemble de l'API de l'extension Git intégrée à VSCode (vscode.git, API v1).
interface GitChange { uri: vscode.Uri }
interface GitRepository {
  rootUri: vscode.Uri;
  state: { workingTreeChanges: GitChange[]; indexChanges: GitChange[]; untrackedChanges?: GitChange[]; mergeChanges?: GitChange[] };
  status?(): Promise<void>;
}
interface GitAPI {
  state: 'uninitialized' | 'initialized';
  onDidChangeState?: vscode.Event<string>;
  repositories: GitRepository[];
  git: { path: string };
}

let cachedApi: GitAPI | null | undefined;

async function getApi(): Promise<GitAPI | null> {
  if (cachedApi !== undefined) { return cachedApi; }
  try {
    const ext = vscode.extensions.getExtension<{ getAPI(v: 1): GitAPI }>('vscode.git');
    if (!ext) { return (cachedApi = null); }
    const exports = ext.isActive ? ext.exports : await ext.activate();
    const api = exports.getAPI(1);
    if (api.state !== 'initialized' && api.onDidChangeState) {
      // attend l'initialisation (au plus 5 s)
      await new Promise<void>(resolve => {
        const t = setTimeout(resolve, 5000);
        api.onDidChangeState!(s => { if (s === 'initialized') { clearTimeout(t); resolve(); } });
      });
    }
    return (cachedApi = api);
  } catch {
    return (cachedApi = null);
  }
}

/** Exécutable git : celui configuré dans VSCode (git.path), sinon "git". */
export async function gitExecutable(): Promise<string> {
  const api = await getApi();
  if (api?.git?.path) { return api.git.path; }
  const setting = vscode.workspace.getConfiguration('git').get<string | string[]>('path');
  if (typeof setting === 'string' && setting) { return setting; }
  if (Array.isArray(setting) && setting.length) { return setting[0]; }
  return 'git';
}

export function runGit(git: string, args: string[], cwd: string): Promise<{ ok: boolean; out: string; err: string; notFound: boolean }> {
  return new Promise(resolve => {
    execFile(git, args, { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      const notFound = !!error && (error as NodeJS.ErrnoException).code === 'ENOENT';
      resolve({ ok: !error, out: stdout ?? '', err: String(stderr || error?.message || ''), notFound });
    });
  });
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'target', 'build', 'vendor', '.angular', '.idea', '.vscode']);

const REPO_SCAN_DEPTH = 4;
const normPath = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p).replace(/[\\/]+$/, '');

/** Dépôts trouvés sur le disque, sans s'arrêter au premier : continue sous un dépôt pour trouver les dépôts imbriqués. */
function findAllReposOnDisk(dir: string, depth: number, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  if (entries.some(e => e.name === '.git')) { out.push(dir); }
  if (depth <= 0) { return out; }
  for (const e of entries) {
    if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) {
      findAllReposOnDisk(path.join(dir, e.name), depth - 1, out);
    }
  }
  return out;
}

/**
 * Racines de tous les dépôts git de l'espace de travail : union de ceux vus par l'extension Git de VSCode
 * (qui ne descend que d'un niveau par défaut) et de ceux trouvés sur le disque jusqu'à 4 niveaux,
 * plus le dépôt parent si le dossier ouvert est un sous-dossier d'un dépôt.
 */
export async function gitRepoRoots(): Promise<vscode.Uri[]> {
  const seen = new Map<string, vscode.Uri>();
  const add = (u: vscode.Uri) => { if (!seen.has(normPath(u.fsPath))) { seen.set(normPath(u.fsPath), u); } };
  const api = await getApi();
  for (const r of api?.repositories ?? []) { add(r.rootUri); }
  const git = await gitExecutable();
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    if (f.uri.scheme !== 'file') { continue; }
    for (const p of findAllReposOnDisk(f.uri.fsPath, REPO_SCAN_DEPTH)) { add(vscode.Uri.file(p)); }
    const up = await runGit(git, ['rev-parse', '--show-toplevel'], f.uri.fsPath);   // dossier ouvert dans un dépôt parent
    if (up.ok && up.out.trim()) { add(vscode.Uri.file(up.out.trim())); }
  }
  return [...seen.values()];
}

export interface ChangedResult {
  uris: vscode.Uri[];
  repos: number;
  reason?: 'noGit' | 'noRepo' | 'none';
  detail?: string;
}

/** Fichiers modifiés, indexés ou nouveaux (hors supprimés), dans tous les dépôts de l'espace de travail. */
export async function gitChangedFiles(): Promise<ChangedResult> {
  const seen = new Map<string, vscode.Uri>();
  const add = (u: vscode.Uri) => seen.set(u.toString(), u);

  // Dépôts : ceux de l'extension Git de VSCode (état à jour, comme l'onglet Contrôle de code source)
  // + ceux qu'elle ne voit pas (sous-dossiers profonds), interrogés en ligne de commande.
  const api = await getApi();
  const apiRepos = api?.repositories ?? [];
  const apiRoots = new Set(apiRepos.map(r => normPath(r.rootUri.fsPath)));
  for (const repo of apiRepos) {
    try { await repo.status?.(); } catch { /* état déjà à jour */ }
    const st = repo.state;
    for (const c of [...st.workingTreeChanges, ...st.indexChanges, ...(st.untrackedChanges ?? []), ...(st.mergeChanges ?? [])]) { add(c.uri); }
  }

  const git = await gitExecutable();
  const others = (await gitRepoRoots()).filter(u => u.scheme === 'file' && !apiRoots.has(normPath(u.fsPath)));
  let repos = apiRepos.length;
  let lastErr = '';
  for (const rootUri of others) {
    const dir = rootUri.fsPath;
    const status = await runGit(git, ['status', '--porcelain', '-z', '--untracked-files=all'], dir);
    if (status.notFound) {
      if (!repos) { return { uris: [], repos: 0, reason: 'noGit', detail: git }; }
      break;
    }
    if (!status.ok) { lastErr = status.err; continue; }
    repos++;
    const tokens = status.out.split('\0');
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.length < 4) { continue; }
      if (t[0] === 'R' || t[0] === 'C') { i++; }   // le token suivant est l'ancien chemin
      add(vscode.Uri.file(path.join(dir, t.slice(3))));
    }
  }
  if (!repos) {
    // aucun dépôt : git est-il seulement disponible ?
    const probe = await runGit(git, ['--version'], (vscode.workspace.workspaceFolders ?? [])[0]?.uri.fsPath ?? process.cwd());
    if (probe.notFound) { return { uris: [], repos: 0, reason: 'noGit', detail: git }; }
    return { uris: [], repos: 0, reason: 'noRepo', detail: lastErr.trim() };
  }
  return { uris: await existing([...seen.values()]), repos, reason: seen.size ? undefined : 'none' };
}

/** Garde les fichiers qui existent encore (retire les supprimés) et ignore les dossiers. */
async function existing(uris: vscode.Uri[]): Promise<vscode.Uri[]> {
  const res = await Promise.all(uris.map(async u => {
    try { const st = await vscode.workspace.fs.stat(u); return st.type & vscode.FileType.Directory ? null : u; }
    catch { return null; }
  }));
  return res.filter((u): u is vscode.Uri => !!u);
}

// ---------- diffs par fichier (mode « modifications seulement ») ----------

export interface FileDiff {
  kind: 'diff' | 'new' | 'clean' | 'nogit';
  diff?: string;   // diff unifié brut (à partir du premier @@)
}

const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);

function repoFor(fsPath: string, roots: string[]): string | undefined {
  let best: string | undefined;
  for (const r of roots) {
    const rel = path.relative(r, fsPath);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel) && (!best || r.length > best.length)) { best = r; }
  }
  return best;
}

function unquote(p: string): string {
  return p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\') : p;
}

/**
 * Pour chaque fichier : diff par rapport à HEAD (indexé + non indexé), ou « new » s'il n'est pas suivi
 * par git, ou « clean » s'il n'a pas changé. Un seul appel git diff par dépôt (par lots).
 */
export async function diffFiles(fsPaths: string[], context: number): Promise<Map<string, FileDiff>> {
  const res = new Map<string, FileDiff>();
  const roots = (await gitRepoRoots()).filter(u => u.scheme === 'file').map(u => u.fsPath);
  const git = await gitExecutable();
  const byRepo = new Map<string, string[]>();
  for (const p of fsPaths) {
    const r = repoFor(p, roots);
    if (!r) { res.set(norm(p), { kind: 'nogit' }); continue; }
    byRepo.set(r, [...(byRepo.get(r) ?? []), p]);
  }

  for (const [root, files] of byRepo) {
    const relOf = new Map(files.map(f => [path.relative(root, f).split(path.sep).join('/'), f]));
    const rels = [...relOf.keys()];
    const BATCH = 60;                                   // reste sous la limite de ligne de commande Windows
    for (let i = 0; i < rels.length; i += BATCH) {
      const slice = rels.slice(i, i + BATCH);
      const base = ['-c', 'core.quotepath=off'];
      const untracked = await runGit(git, [...base, 'ls-files', '--others', '--exclude-standard', '-z', '--', ...slice], root);
      const newSet = new Set(untracked.ok ? untracked.out.split('\0').filter(Boolean) : []);
      const d = await runGit(git, [...base, 'diff', '--no-color', '--no-ext-diff', `-U${Math.max(0, context)}`, 'HEAD', '--', ...slice], root);
      const diffs = new Map<string, string>();
      if (d.ok) {
        for (const chunk of d.out.split(/^diff --git /m).slice(1)) {
          const plus = /^\+\+\+ (?:b\/)?(.+)$/m.exec(chunk);
          const minus = /^--- (?:a\/)?(.+)$/m.exec(chunk);
          const file = unquote((plus && plus[1] !== '/dev/null' ? plus[1] : minus?.[1]) ?? '').trim();
          const at = chunk.indexOf('\n@@');
          if (file && at >= 0) { diffs.set(file, chunk.slice(at + 1)); }
        }
      }
      for (const r of slice) {
        const f = relOf.get(r)!;
        if (newSet.has(r) || (!d.ok && /HEAD|unknown revision|ambiguous argument/i.test(d.err))) {
          res.set(norm(f), { kind: 'new' });
        } else if (diffs.has(r)) {
          res.set(norm(f), { kind: 'diff', diff: diffs.get(r) });
        } else {
          res.set(norm(f), { kind: 'clean' });
        }
      }
    }
  }
  return res;
}

export function diffKey(fsPath: string): string { return norm(fsPath); }
