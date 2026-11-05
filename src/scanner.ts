import * as vscode from 'vscode';
import * as path from 'path';
import { globToRegExp } from './format';
import { gitExecutable, gitRepoRoots, runGit } from './git';
export { gitChangedFiles } from './git';

export interface FileEntry {
  uri: string;   // uri.toString()
  rel: string;   // chemin relatif affiché (avec le nom du dossier racine si multi-root)
  size: number;
  proj: string;  // projet : nom du dépôt git qui contient le fichier, sinon du dossier ouvert
}

const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'tiff', 'psd', 'pdf', 'zip', 'gz', 'tgz', '7z', 'rar', 'jar',
  'war', 'ear', 'class', 'exe', 'dll', 'so', 'dylib', 'bin', 'o', 'a', 'lib', 'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp3', 'mp4', 'avi', 'mov', 'wav', 'ogg', 'webm', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'db', 'sqlite',
  'iso', 'dmg', 'pyc', 'keystore', 'jks', 'p12', 'pfx'
]);

export function isBinaryName(rel: string): boolean {
  const ext = rel.includes('.') ? rel.split('.').pop()!.toLowerCase() : '';
  return BINARY_EXT.has(ext);
}

function excludeMatchers(): RegExp[] {
  const globs = vscode.workspace.getConfiguration('contextSender').get<string[]>('exclude') ?? [];
  return globs.map(globToRegExp);
}

/** Vrai si le chemin relatif est exclu par les réglages (motifs) ou a une extension binaire. */
export function isExcludedPath(rel: string): boolean {
  if (isBinaryName(rel)) { return true; }
  const rs = excludeMatchers();
  // teste le chemin complet et chaque sous-chemin (multi-root : « dossier/… »)
  const parts = rel.split('/');
  for (let i = 0; i < parts.length; i++) {
    const sub = parts.slice(i).join('/');
    if (rs.some(re => re.test(sub))) { return true; }
  }
  return false;
}

/** Contenu binaire ? (octet nul dans les 8 premiers Ko) */
export function looksBinary(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) { if (buf[i] === 0) { return true; } }
  return false;
}

// ---------- détection des projets ----------

/** Fichiers qui marquent la racine d'un projet. */
const PROJECT_MARKERS = new Set([
  'go.mod', 'package.json', 'angular.json', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle',
  'settings.gradle.kts', 'cargo.toml', 'pyproject.toml', 'setup.py', 'composer.json', 'gemfile', 'pubspec.yaml',
  'deno.json', 'mix.exs', 'cmakelists.txt'
]);
const PROJECT_MARKER_EXT = /\.(sln|csproj|fsproj|vbproj)$/i;
const IGNORED_DIRS = /(^|\/)(node_modules|vendor|dist|out|build|target|\.git|\.angular|coverage|e2e|test-fixtures|fixtures|examples?)(\/|$)/i;
const MAX_MARKER_DEPTH = 6;

interface ProjectRoot { rel: string; label: string }       // rel : chemin relatif au dossier ouvert ('' = le dossier lui-même)
interface FolderProjects { abs: string; name: string; roots: ProjectRoot[]; byTopDir: boolean }
let projectCache: FolderProjects[] = [];

/** Calcule les racines de projets d'un dossier ouvert à partir des dépôts git et des fichiers marqueurs. */
function detectProjects(folderAbs: string, folderName: string, rels: string[], repoAbs: string[]): FolderProjects {
  const roots = new Set<string>();
  for (const r of repoAbs) {
    const rr = path.relative(folderAbs, r);
    if (!rr) { roots.add(''); }
    else if (rr.startsWith('..')) { roots.add(''); }                   // dépôt parent du dossier ouvert
    else if (!path.isAbsolute(rr)) { roots.add(rr.split(path.sep).join('/')); }
  }
  for (const r of rels) {
    const base = r.split('/').pop()!.toLowerCase();
    if (!PROJECT_MARKERS.has(base) && !PROJECT_MARKER_EXT.test(base)) { continue; }
    const dir = r.includes('/') ? r.slice(0, r.lastIndexOf('/')) : '';
    if (IGNORED_DIRS.test(dir) || dir.split('/').length > MAX_MARKER_DEPTH) { continue; }
    roots.add(dir);
  }
  // le dossier ouvert n'est pas lui-même un projet : on regroupe le reste par dossier de 1er niveau
  const byTopDir = !roots.has('');
  const list = [...roots].filter(r => r !== '');
  const baseCount = new Map<string, number>();
  for (const r of list) { const b = r.split('/').pop()!; baseCount.set(b, (baseCount.get(b) ?? 0) + 1); }
  const out: ProjectRoot[] = list.map(r => {
    const b = r.split('/').pop()!;
    return { rel: r, label: (baseCount.get(b) ?? 0) > 1 ? r : b };   // nom court, chemin si homonymes
  });
  if (!byTopDir) { out.push({ rel: '', label: folderName }); }
  out.sort((x, y) => y.rel.length - x.rel.length);                   // le plus profond d'abord
  return { abs: folderAbs, name: folderName, roots: out, byTopDir };
}

function projectFor(fp: FolderProjects, rel: string): string {
  for (const r of fp.roots) {
    if (r.rel === '' || rel === r.rel || rel.startsWith(r.rel + '/')) { return r.label; }
  }
  if (fp.byTopDir && rel.includes('/')) { return rel.split('/')[0]; }  // ex. docs/, scripts/
  return fp.name;                                                     // fichiers à la racine du dossier ouvert
}

/** Projet d'un fichier quelconque (utilise la dernière détection). */
export function projectOf(fsPath: string): string {
  let best: FolderProjects | undefined;
  for (const fp of projectCache) {
    const r = path.relative(fp.abs, fsPath);
    if (r && !r.startsWith('..') && !path.isAbsolute(r) && (!best || fp.abs.length > best.abs.length)) { best = fp; }
  }
  if (!best) { return vscode.workspace.getWorkspaceFolder(vscode.Uri.file(fsPath))?.name ?? ''; }
  return projectFor(best, path.relative(best.abs, fsPath).split(path.sep).join('/'));
}

function rel(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join('/');
}

function isInside(child: string, parent: string): boolean {
  const r = path.relative(parent, child);
  return !!r && !r.startsWith('..') && !path.isAbsolute(r);
}

async function lsFiles(git: string, cwd: string): Promise<string[] | null> {
  const r = await runGit(git, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd);
  return r.ok ? r.out.split('\0').filter(Boolean) : null;   // chemins relatifs à cwd
}

/**
 * Liste des fichiers d'un dossier ouvert, en respectant les .gitignore :
 * - dossier dans un dépôt git -> git ls-files
 * - sinon findFiles, puis pour chaque dépôt git trouvé dans un sous-dossier, on applique son .gitignore
 */
async function listFolder(folder: vscode.WorkspaceFolder, max: number, excludeGlobs: string[]): Promise<string[]> {
  const isFile = folder.uri.scheme === 'file';
  const git = isFile ? await gitExecutable() : 'git';
  const nested = isFile
    ? (await gitRepoRoots()).filter(r => r.scheme === 'file' && isInside(r.fsPath, folder.uri.fsPath))
    : [];

  const direct = isFile ? await lsFiles(git, folder.uri.fsPath) : null;
  if (direct) {
    // le dossier est dans un dépôt : on ajoute les fichiers des dépôts imbriqués (que git ls-files du parent ne liste pas)
    const set = new Set(direct);
    for (const repo of nested) {
      const prefix = rel(folder.uri.fsPath, repo.fsPath);
      if (set.has(prefix)) { set.delete(prefix); }               // entrée « gitlink » du sous-dépôt
      for (const t of (await lsFiles(git, repo.fsPath)) ?? []) { set.add(prefix + '/' + t); }
    }
    return [...set].slice(0, max);
  }

  // pas de dépôt à la racine : on liste tout (en n'excluant ici que les dossiers lourds, pour garder go.mod, package.json… visibles
  // par la détection des projets), puis on applique le .gitignore de chaque dépôt trouvé dans les sous-dossiers
  const dirGlobs = excludeGlobs.filter(g => g.endsWith('/**'));
  const exclude = dirGlobs.length ? `{${dirGlobs.join(',')}}` : undefined;
  const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*'), exclude, max);
  let rels = uris.map(u => path.posix.relative(folder.uri.path, u.path));
  // du plus profond au moins profond : un dépôt imbriqué gère ses propres fichiers
  const sorted = [...nested].sort((x, y) => y.fsPath.length - x.fsPath.length);
  const handled: string[] = [];
  for (const repo of sorted) {
    const tracked = await lsFiles(git, repo.fsPath);
    if (!tracked) { continue; }
    const prefix = rel(folder.uri.fsPath, repo.fsPath) + '/';
    const keep = new Set(tracked.map(t => prefix + t));
    rels = rels.filter(r => !r.startsWith(prefix) || keep.has(r) || handled.some(h => r.startsWith(h)));
    handled.push(prefix);
  }
  return rels;
}

export async function scanWorkspace(): Promise<FileEntry[]> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const multi = folders.length > 1;
  const max = vscode.workspace.getConfiguration('contextSender').get<number>('maxFiles') ?? 20000;
  const excludeGlobs = vscode.workspace.getConfiguration('contextSender').get<string[]>('exclude') ?? [];
  const excludes = excludeMatchers();
  const result: FileEntry[] = [];
  const repoAbs = (await gitRepoRoots()).filter(u => u.scheme === 'file').map(u => u.fsPath);
  const cache: FolderProjects[] = [];

  for (const folder of folders) {
    const raw = await listFolder(folder, max, excludeGlobs);
    // détection sur la liste brute : go.mod, package.json… comptent même s'ils sont exclus de l'envoi
    const fp = detectProjects(folder.uri.fsPath, folder.name, raw, repoAbs);
    cache.push(fp);
    const rels = raw
      .filter(r => !isBinaryName(r))
      .filter(r => !excludes.some(re => re.test(r)));

    // tailles (par lots, et on élimine les fichiers supprimés mais encore indexés par git)
    const BATCH = 200;
    for (let i = 0; i < rels.length; i += BATCH) {
      const slice = rels.slice(i, i + BATCH);
      const stats = await Promise.all(slice.map(async r => {
        const uri = vscode.Uri.joinPath(folder.uri, r);
        try {
          const st = await vscode.workspace.fs.stat(uri);
          if (st.type & vscode.FileType.Directory) { return null; }
          return { uri: uri.toString(), rel: multi ? `${folder.name}/${r}` : r, size: st.size, proj: projectFor(fp, r) } as FileEntry;
        } catch { return null; }
      }));
      for (const s of stats) { if (s) { result.push(s); } }
    }
  }
  projectCache = cache;
  result.sort((a, b) => a.rel.localeCompare(b.rel));
  return result;
}

