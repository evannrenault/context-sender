// Lecture d'une réponse d'IA (markdown) et application de ses modifications.
// Logique pure, sans dépendance à VSCode : testable avec node.

export interface ResponseBlock {
  path?: string;          // chemin annoncé par l'IA (normalisé avec des /)
  lang: string;
  code: string;
  kind: 'full' | 'diff';  // fichier complet, ou zones modifiées au format diff
}

/** Consigne ajoutée au prompt pour obtenir une réponse que l'extension sait appliquer. */
export const ANSWER_FORMAT =
  'Format de réponse attendu (pour que je puisse appliquer tes modifications automatiquement) : pour chaque fichier à créer ou modifier, ' +
  'écris une ligne « ### Fichier : <chemin exact tel que fourni> » suivie d\'un seul bloc de code contenant le fichier COMPLET modifié. ' +
  'Pour un gros fichier, tu peux à la place donner seulement les zones modifiées dans un bloc ```diff ' +
  '(lignes « - » retirées, « + » ajoutées, au moins 3 lignes de contexte inchangées autour de chaque zone, chaque zone précédée d\'une ligne « @@ »). ' +
  'N\'omets jamais de code avec des commentaires du type « reste inchangé ».';

const PATH_RE = /[\w@.$~\-]+(?:[\\/][\w@.$~\-]+)*\.[\w]+|(?:[\w@.$~\-]+[\\/])+(?:Dockerfile|Makefile|Jenkinsfile)|Dockerfile|Makefile/;

function cleanPath(p: string): string | undefined {
  let s = p.trim().replace(/^[`*"'«\s]+|[`*"'»:\s]+$/g, '');
  s = s.replace(/\s+[—–-]\s+.*$/, '').replace(/\s*\(.*\)\s*$/, '').replace(/^\.\//, '').replace(/\\/g, '/');
  const m = PATH_RE.exec(s);
  if (!m) { return undefined; }
  return m[0].replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Ligne qui annonce un fichier : « ### Fichier : x », « **x** », « `x` : », « File: x »… */
function headerPath(line: string): string | undefined {
  const t = line.trim();
  if (!t || t.length > 300) { return undefined; }
  let m = /^#{1,6}\s*(?:\d+[.)]\s*)?(?:(?:nouveau\s+)?fichier(?:\s+(?:modifié|complet|créé))?|file|new file|modified file)\s*[:：]\s*(.+)$/i.exec(t);
  if (m) { return cleanPath(m[1]); }
  m = /^(?:[-*]\s*)?(?:\*\*)?(?:(?:nouveau\s+)?fichier|file)\s*[:：]\s*(?:\*\*)?\s*(.+)$/i.exec(t);
  if (m) { return cleanPath(m[1]); }
  m = /^#{1,6}\s*(.+)$/.exec(t);                                   // « ### src/app/x.ts »
  if (m && /^[`*]*[\w@.$~\-/\\]+\.[\w]+[`*]*\s*(?:[—–(-].*)?$/.test(m[1].trim())) { return cleanPath(m[1]); }
  m = /^(?:[-*]\s*)?(?:\*\*|__)?`?([\w@.$~\-/\\]+\.[\w]+)`?(?:\*\*|__)?\s*[:：]?\s*(?:[—–(-].*)?$/.exec(t);  // « **x.go** » ou « `x.go` : »
  if (m && /[\\/]|\.(go|ts|tsx|js|java|html|scss|css|json|ya?ml|sql|md|xml|py|sh|kt|vue|properties|gradle|toml|mod)$/i.test(m[1])) {
    return cleanPath(m[1]);
  }
  return undefined;
}

/** Commentaire « // Fichier : x » en 1re ligne d'un bloc. */
function inlinePath(firstLine: string): string | undefined {
  const m = /^\s*(?:\/\/|#|--|<!--|\/\*|;)\s*(?:fichier|file|path|chemin)\s*[:：]\s*(.+?)\s*(?:-->|\*\/)?\s*$/i.exec(firstLine);
  return m ? cleanPath(m[1]) : undefined;
}

function looksLikeDiff(lang: string, code: string): boolean {
  if (/^(diff|patch)$/i.test(lang)) { return true; }
  const lines = code.split('\n').filter(l => l.length);
  if (!lines.some(l => l.startsWith('@@'))) { return false; }
  const marked = lines.filter(l => /^[ +\-@]/.test(l) || l.startsWith('\\')).length;
  return marked / lines.length > 0.9;
}

export function parseResponse(text: string): ResponseBlock[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: ResponseBlock[] = [];
  let pendingPath: string | undefined;
  let linesSinceHeader = 99;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const open = /^\s*(`{3,}|~{3,})\s*([^\s`]*)\s*(.*)$/.exec(line);
    if (!open) {
      const hp = headerPath(line);
      if (hp) { pendingPath = hp; linesSinceHeader = 0; }
      else if (line.trim()) { linesSinceHeader++; }
      continue;
    }
    // bloc de code : on cherche la clôture de même type et au moins aussi longue
    const fenceChar = open[1][0];
    const fenceLen = open[1].length;
    let info = open[2] || '';
    const rest = open[3] || '';
    let j = i + 1;
    const body: string[] = [];
    for (; j < lines.length; j++) {
      const close = new RegExp(`^\\s*\\${fenceChar}{${fenceLen},}\\s*$`).exec(lines[j]);
      if (close) { break; }
      body.push(lines[j]);
    }
    i = j;

    // chemin dans l'info du bloc : ```go:src/x.go, ```go src/x.go, ```go title="src/x.go"
    let path: string | undefined;
    const colon = /^([\w+#-]*):(.+)$/.exec(info);
    if (colon) { info = colon[1]; path = cleanPath(colon[2]); }
    if (!path && rest) {
      const t = /(?:title|file|filename|path)\s*=\s*["']?([^"'\s]+)/i.exec(rest);
      path = cleanPath(t ? t[1] : rest);
    }
    if (!path && /[./\\]/.test(info) && !/^[\w+#-]+$/.test(info)) { path = cleanPath(info); info = ''; }
    if (!path && body.length) {
      const ip = inlinePath(body[0]);
      if (ip) { path = ip; body.shift(); }
    }
    if (!path && pendingPath && linesSinceHeader <= 3) { path = pendingPath; }
    pendingPath = undefined;
    linesSinceHeader = 99;

    const code = body.join('\n');
    if (!code.trim()) { continue; }
    blocks.push({ path, lang: info.toLowerCase(), code, kind: looksLikeDiff(info, code) ? 'diff' : 'full' });
  }
  return blocks;
}

// ---------- application d'un diff ----------

interface Hunk { hint?: number; old: string[]; neu: string[] }

function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let cur: Hunk | undefined;
  for (const raw of diff.replace(/\r\n/g, '\n').split('\n')) {
    if (raw.startsWith('@@')) {
      // « @@ -10,7 +10,9 @@ » (git) ou « @@ lignes 34–52 @@ » / « @@ ligne 12 @@ » (format de l'extension)
      const g = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(raw);
      const f = /lignes?\s+(\d+)/i.exec(raw) || /après la ligne\s+(\d+)/i.exec(raw);
      cur = { hint: g ? Number(g[1]) : f ? Number(f[1]) : undefined, old: [], neu: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur) { continue; }                                  // en-têtes --- / +++ / diff --git
    if (raw.startsWith('\\')) { continue; }                  // « \ No newline at end of file »
    if (raw.startsWith('+')) { cur.neu.push(raw.slice(1)); }
    else if (raw.startsWith('-')) { cur.old.push(raw.slice(1)); }
    else {
      const ctx = raw.startsWith(' ') ? raw.slice(1) : raw;  // l'IA oublie souvent l'espace des lignes de contexte
      cur.old.push(ctx); cur.neu.push(ctx);
    }
  }
  // retire les lignes vides de contexte en fin de zone (fréquentes et ambiguës)
  for (const h of hunks) {
    while (h.old.length && h.neu.length && h.old[h.old.length - 1] === '' && h.neu[h.neu.length - 1] === '') { h.old.pop(); h.neu.pop(); }
  }
  return hunks.filter(h => h.old.length || h.neu.length);
}

const norms: ((s: string) => string)[] = [
  s => s,
  s => s.replace(/\s+$/, ''),
  s => s.trim(),
  s => s.replace(/\s+/g, ''),
];

/** Toutes les positions où `needle` apparaît dans `hay` (à partir de `from`), selon une normalisation. */
function findAll(hay: string[], needle: string[], norm: (s: string) => string, from: number): number[] {
  const out: number[] = [];
  if (!needle.length) { return out; }
  const n0 = needle.map(norm);
  const h0 = hay.map(norm);
  for (let i = from; i + n0.length <= h0.length; i++) {
    let ok = true;
    for (let k = 0; k < n0.length; k++) { if (h0[i + k] !== n0[k]) { ok = false; break; } }
    if (ok) { out.push(i); }
  }
  return out;
}

export interface PatchResult {
  ok: boolean;          // toutes les zones appliquées
  content: string;
  applied: number;
  failed: number;
  total: number;
}

/** Applique les zones d'un diff (éventuellement approximatif) au contenu actuel d'un fichier. */
export function applyDiff(original: string, diff: string): PatchResult {
  const crlf = /\r\n/.test(original);
  const hadFinalNl = /\n$/.test(original);
  const lines = original.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  const hunks = parseHunks(diff);
  const edits: { at: number; len: number; neu: string[] }[] = [];
  let failed = 0;
  let cursor = 0;

  for (const h of hunks) {
    let at = -1;
    if (!h.old.length) {
      // pure insertion : on se fie à la ligne indiquée
      if (h.hint !== undefined) { at = Math.min(lines.length, Math.max(0, h.hint)); }
    } else {
      for (const norm of norms) {
        let cands = findAll(lines, h.old, norm, cursor);
        if (!cands.length) { cands = findAll(lines, h.old, norm, 0); }
        if (cands.length) {
          const target = h.hint !== undefined ? h.hint - 1 : cursor;
          at = cands.reduce((best, c) => (Math.abs(c - target) < Math.abs(best - target) ? c : best), cands[0]);
          break;
        }
      }
    }
    if (at < 0 || edits.some(e => at < e.at + e.len && at + h.old.length > e.at)) { failed++; continue; }
    edits.push({ at, len: h.old.length, neu: h.neu });
    cursor = at + h.old.length;
  }

  edits.sort((a, b) => b.at - a.at);                       // de bas en haut : les positions restent valides
  for (const e of edits) { lines.splice(e.at, e.len, ...e.neu); }
  let content = lines.join('\n') + (hadFinalNl ? '\n' : '');
  if (crlf) { content = content.replace(/\n/g, '\r\n'); }
  return { ok: failed === 0 && hunks.length > 0, content, applied: edits.length, failed, total: hunks.length };
}

/** Garde le style de fin de ligne et de fin de fichier de l'original pour un fichier complet proposé. */
export function matchStyle(original: string | undefined, proposed: string): string {
  let out = proposed.replace(/\r\n/g, '\n');
  if (original === undefined) { return out.endsWith('\n') ? out : out + '\n'; }
  out = out.replace(/\n*$/, '') + (/\n$/.test(original) ? '\n' : '');
  if (/\r\n/.test(original)) { out = out.replace(/\n/g, '\r\n'); }
  return out;
}

/** Nombre de lignes ajoutées / supprimées entre deux textes (diff LCS approximatif par lignes). */
export function lineStats(a: string, b: string): { added: number; removed: number } {
  const x = a.replace(/\r\n/g, '\n').split('\n');
  const y = b.replace(/\r\n/g, '\n').split('\n');
  // retire préfixe et suffixe communs puis compare les multiensembles (rapide et suffisant pour un compteur)
  let s = 0;
  while (s < x.length && s < y.length && x[s] === y[s]) { s++; }
  let e = 0;
  while (e < x.length - s && e < y.length - s && x[x.length - 1 - e] === y[y.length - 1 - e]) { e++; }
  const xm = x.slice(s, x.length - e), ym = y.slice(s, y.length - e);
  const count = new Map<string, number>();
  for (const l of xm) { count.set(l, (count.get(l) ?? 0) + 1); }
  let common = 0;
  for (const l of ym) { const c = count.get(l) ?? 0; if (c > 0) { common++; count.set(l, c - 1); } }
  return { added: ym.length - common, removed: xm.length - common };
}
