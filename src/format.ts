// Mise en forme du texte envoyé au chat IA (sans dépendance à VSCode : testable avec node).

export interface Doc {
  rel: string;      // chemin relatif affiché
  content: string;
  kind?: 'full' | 'diff' | 'new';
  meta?: string;    // ex. « 2 zones, +12 / −3 »
}

export const DIFF_LEGEND =
  'Légende : pour les fichiers marqués « modifications seulement », seuls les changements par rapport au dernier commit git sont fournis ' +
  '(lignes « + » ajoutées, « - » supprimées, les autres lignes sont du contexte ; « @@ lignes X–Y » = position dans le fichier actuel).';

/**
 * Rend un diff unifié git lisible : retire les en-têtes techniques, remplace « @@ -a,b +c,d @@ » par
 * « @@ lignes c–… @@ <fonction> ». Retourne aussi le nombre de zones et de lignes ajoutées / supprimées.
 */
export function prettyDiff(raw: string): { text: string; hunks: number; added: number; removed: number } {
  const out: string[] = [];
  let hunks = 0, added = 0, removed = 0, started = false;
  for (const line of raw.replace(/\r\n/g, '\n').split('\n')) {
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(line);
    if (h) {
      started = true; hunks++;
      const start = Number(h[3]);
      const count = h[4] === undefined ? 1 : Number(h[4]);
      const where = count === 0 ? `après la ligne ${start}` : count === 1 ? `ligne ${start}` : `lignes ${start}–${start + count - 1}`;
      if (hunks > 1) { out.push(''); }
      out.push(`@@ ${where}${h[5] ? ` · ${h[5].trim()}` : ''} @@`);
      continue;
    }
    if (!started || line.startsWith('\\ ')) { continue; }   // en-têtes diff --git / index / --- / +++, « \ No newline »
    if (line.startsWith('+')) { added++; } else if (line.startsWith('-')) { removed++; }
    out.push(line);
  }
  while (out.length && out[out.length - 1] === '') { out.pop(); }
  return { text: out.join('\n'), hunks, added, removed };
}

const FENCES: Record<string, string> = {
  go: 'go', mod: 'go', java: 'java', kt: 'kotlin', ts: 'typescript', tsx: 'tsx', js: 'javascript',
  mjs: 'javascript', cjs: 'javascript', jsx: 'jsx', html: 'html', htm: 'html', css: 'css', scss: 'scss',
  less: 'less', json: 'json', yaml: 'yaml', yml: 'yaml', xml: 'xml', sql: 'sql', sh: 'bash', bash: 'bash',
  ps1: 'powershell', py: 'python', md: 'markdown', properties: 'properties', toml: 'toml', ini: 'ini',
  gradle: 'groovy', dockerfile: 'dockerfile', tf: 'hcl', proto: 'protobuf', graphql: 'graphql', vue: 'vue'
};

export function fenceFor(rel: string): string {
  const base = rel.split('/').pop() || rel;
  if (/^dockerfile/i.test(base)) { return 'dockerfile'; }
  if (/^makefile$/i.test(base)) { return 'makefile'; }
  const ext = base.includes('.') ? base.split('.').pop()!.toLowerCase() : '';
  return FENCES[ext] ?? ext;
}

function fence(content: string): string {
  let ticks = '```';
  while (content.includes(ticks)) { ticks += '`'; }
  return ticks;
}

export function formatDoc(d: Doc, label?: string): string {
  const t = fence(d.content);
  const what = d.kind === 'diff' ? ` — modifications seulement${d.meta ? ` (${d.meta})` : ''}`
    : d.kind === 'new' ? ' — nouveau fichier' : '';
  const lang = d.kind === 'diff' ? 'diff' : fenceFor(d.rel);
  return `### Fichier : ${d.rel}${what}${label ? ` ${label}` : ''}\n${t}${lang}\n${d.content.replace(/\s+$/, '')}\n${t}`;
}

/** Arborescence texte des fichiers fournis. */
export function buildTree(rels: string[]): string {
  interface Node { [k: string]: Node }
  const root: Node = {};
  for (const r of [...rels].sort()) {
    let n = root;
    for (const part of r.split('/')) { n = n[part] ??= {}; }
  }
  const lines: string[] = [];
  const walk = (n: Node, depth: number) => {
    const keys = Object.keys(n).sort((a, b) => {
      const da = Object.keys(n[a]).length > 0 ? 0 : 1;
      const db = Object.keys(n[b]).length > 0 ? 0 : 1;
      return da - db || a.localeCompare(b);
    });
    for (const k of keys) {
      const isDir = Object.keys(n[k]).length > 0;
      lines.push(`${'  '.repeat(depth)}${k}${isDir ? '/' : ''}`);
      if (isDir) { walk(n[k], depth + 1); }
    }
  };
  walk(root, 0);
  return lines.join('\n');
}

export function maskSecrets(text: string): string {
  return text
    .replace(/((?:pass(?:word|wd)?|secret|token|api[_-]?key|client[_-]?secret)["']?\s*[:=]\s*["']?)[^"'\s,;}]+/gi, '$1<MASQUÉ>')
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1<MASQUÉ>')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g, '<JWT_MASQUÉ>')
    .replace(/(:\/\/[^:/@\s]+:)[^@\s]+@/g, '$1<MASQUÉ>@');
}

function treeBlock(docs: Doc[]): string {
  return `Arborescence des fichiers fournis (${docs.length}) :\n\`\`\`\n${buildTree(docs.map(d => d.rel))}\n\`\`\``;
}

/** Texte complet en un seul bloc (à coller ou à mettre dans un fichier). */
export function formatAll(docs: Doc[], instruction: string): string {
  const parts: string[] = [];
  if (instruction.trim()) { parts.push(instruction.trim()); }
  if (docs.some(d => d.kind === 'diff')) { parts.push(DIFF_LEGEND); }
  if (docs.length > 1) { parts.push(treeBlock(docs)); }
  parts.push(...docs.map(d => formatDoc(d)));
  return parts.join('\n\n') + '\n';
}

/** Coupe un texte par lignes en morceaux de taille ≤ size (le premier ≤ firstSize). */
function chunkLines(content: string, firstSize: number, size: number): string[] {
  const chunks: string[] = [];
  let limit = firstSize;
  let cur = '';
  const flush = () => { chunks.push(cur); cur = ''; limit = size; };
  for (const line of content.split('\n')) {
    if (cur && cur.length + line.length + 1 > limit) { flush(); }
    if (line.length + 1 > limit) {                  // ligne gigantesque (fichier minifié…)
      let i = 0;
      while (i < line.length) { cur = line.slice(i, i + limit); i += limit; flush(); }
      continue;
    }
    cur += (cur ? '\n' : '') + line;
  }
  if (cur) { chunks.push(cur); }
  return chunks;
}

/**
 * Découpe en plusieurs messages à coller l'un après l'autre.
 * Les gros fichiers sont coupés par lignes et remplissent l'espace restant de chaque message.
 * La consigne est placée dans le dernier message, pour que l'IA ne réponde qu'à la fin.
 */
export function splitParts(docs: Doc[], instruction: string, maxChars: number): string[] {
  const HEADER = 700;                                   // réserve pour l'en-tête / pied de chaque partie
  const budget = Math.max(1000, maxChars - HEADER - instruction.length);
  const OVERHEAD = 80;                                  // titre « ### Fichier : … » + clôtures
  const packs: string[][] = [];
  let cur: string[] = [];
  let len = 0;
  const push = (b: string) => { cur.push(b); len += b.length + 2; };
  const newPack = () => { if (cur.length) { packs.push(cur); } cur = []; len = 0; };

  if (docs.some(d => d.kind === 'diff')) { push(DIFF_LEGEND); }
  if (docs.length > 1) { push(treeBlock(docs)); }
  for (const d of docs) {
    const whole = formatDoc(d);
    if (len + whole.length + 2 <= budget) { push(whole); continue; }
    if (whole.length + 2 <= budget) { newPack(); push(whole); continue; }
    // trop gros pour un message : on le coupe, en commençant dans l'espace restant
    const room = budget - len - OVERHEAD - d.rel.length;
    const full = budget - OVERHEAD - d.rel.length;
    if (room < 1500) { newPack(); }
    const chunks = chunkLines(d.content, room < 1500 ? full : room, full);
    chunks.forEach((c, i) => {
      if (i > 0) { newPack(); }
      push(formatDoc({ ...d, content: c }, `(morceau ${i + 1}/${chunks.length})`));
    });
  }
  newPack();

  const n = packs.length;
  if (n <= 1) { return [formatAll(docs, instruction)]; }
  return packs.map((p, i) => {
    const num = `${i + 1}/${n}`;
    const head = i === 0
      ? `Je vais t'envoyer du code en ${n} messages. Avant le dernier message, réponds seulement « OK, partie X/${n} reçue », sans rien analyser. La consigne arrivera dans le dernier message.\n\n--- Partie ${num} ---`
      : `--- Partie ${num} ---`;
    const tail = i === n - 1
      ? `--- Fin (partie ${num}) : tu as maintenant tous les fichiers. ---\n\n${instruction.trim() || 'Analyse l\'ensemble de ces fichiers.'}`
      : `--- Fin de la partie ${num} : réponds juste « OK ${num} reçue ». ---`;
    return `${head}\n\n${p.join('\n\n')}\n\n${tail}\n`;
  });
}

export function estimateTokens(chars: number): number {
  return Math.round(chars / 3.5);
}

/** Nom de fichier « à plat » pour un upload : src/app/x.go -> src__app__x.go(.txt) */
export function flatName(rel: string, addTxt: boolean): string {
  const flat = rel.replace(/[\\/]/g, '__').replace(/[<>:"|?*]/g, '_');
  return addTxt && !/\.(txt|md)$/i.test(flat) ? `${flat}.txt` : flat;
}

/** Convertit un glob simple (**, *, ?, {a,b}) en RegExp, pour filtrer les chemins relatifs. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  let inGroup = false;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else { re += '.*'; }
      } else { re += '[^/]*'; }
    } else if (c === '?') { re += '[^/]'; }
    else if (c === '{') { inGroup = true; re += '(?:'; }
    else if (c === '}' && inGroup) { inGroup = false; re += ')'; }
    else if (c === ',' && inGroup) { re += '|'; }
    else if ('.+^$()|[]\\'.includes(c)) { re += '\\' + c; }
    else { re += c; }
  }
  return new RegExp(`^${re}$`, 'i');
}
