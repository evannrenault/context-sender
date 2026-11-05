// Script du panneau « Envoyer des fichiers » (webview)
(function () {
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const saved = vscode.getState() || {};
  const ui = {
    expanded: saved.expanded || {},
    filter: saved.filter || '',
    exts: saved.exts || [],          // extensions actives (multi)
    projects: saved.projects || [],  // projets actifs (multi) ; vide = tous
    moreOpen: !!saved.moreOpen
  };

  let files = [];                    // {uri, rel, size, proj, ext}
  let selected = new Set();
  let pasteLimit = 30000;
  let parts = { count: 0, copied: [] };
  let mode = 'full';
  let preview = null;                // {total, fullChars, perFile: {uri: [chars, kind, meta]}}
  let scanning = false;
  let instructionSent = '';
  let root = null;
  let dirIndex = new Map();
  let activeUri = null;
  let review = null;
  // même ordre que l'Explorateur de VSCode : dossiers d'abord, puis tri naturel insensible à la casse
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const cmpName = (a, b) => collator.compare(a, b);
  const baseOf = rel => rel.split('/').pop();
  const dirOf = rel => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');

  const win = /win/i.test(navigator.platform || navigator.userAgent);
  const key = u => (win ? u.toLowerCase() : u);
  const isSel = uri => selected.has(key(uri));

  function persist() { vscode.setState(ui); }
  function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function fmtSize(b) {
    return b < 1024 ? b + ' o' : b < 1048576 ? (b / 1024).toFixed(b < 10240 ? 1 : 0).replace('.', ',') + ' Ko' : (b / 1048576).toFixed(1).replace('.', ',') + ' Mo';
  }
  function fmtTok(chars) {
    const t = Math.round(chars / 3.5);
    return t >= 1000 ? (t / 1000).toFixed(t >= 10000 ? 0 : 1).replace('.', ',') + ' k' : String(t);
  }
  const projectsList = () => [...new Set(files.map(f => f.proj))].filter(Boolean).sort();
  const multiProject = () => projectsList().length > 1;

  // ---------- filtres ----------

  function inProjects(f) { return !ui.projects.length || ui.projects.includes(f.proj); }

  function textMatcher() {
    const q = ui.filter.trim().toLowerCase();
    if (!q) return null;
    if (q.includes('*')) {
      const src = q.replace(/[.+^$()|[\]\\{}]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*');
      const re = new RegExp('^' + src + '$');
      return f => { const r = f.rel.toLowerCase(); return re.test(r) || re.test(r.split('/').pop()); };
    }
    const terms = q.split(/\s+/);
    return f => { const r = f.rel.toLowerCase(); return terms.every(t => r.includes(t)); };
  }

  function filtered() {
    const m = textMatcher();
    return files.filter(f => inProjects(f) && (!ui.exts.length || ui.exts.includes(f.ext || '(sans)')) && (!m || m(f)));
  }
  const flatMode = () => !!ui.filter.trim() || ui.exts.length > 0;

  // ---------- arbre ----------

  function buildTree() {
    root = { name: '', path: '', dirs: new Map(), files: [], all: [] };
    for (const f of files.filter(inProjects)) {
      const p = f.rel.split('/');
      let node = root;
      for (let i = 0; i < p.length - 1; i++) {
        const path = p.slice(0, i + 1).join('/');
        if (!node.dirs.has(p[i])) node.dirs.set(p[i], { name: p[i], path, dirs: new Map(), files: [], all: [] });
        node = node.dirs.get(p[i]);
        node.all.push(f.uri);
      }
      node.files.push(f);
    }
    // compacte les dossiers à enfant unique (src/main/java/com/… sur une ligne)
    const compact = n => {
      for (const [k, d] of [...n.dirs]) {
        let cur = d;
        while (cur.files.length === 0 && cur.dirs.size === 1) {
          const only = [...cur.dirs.values()][0];
          cur = Object.assign({}, only, { name: cur.name + '/' + only.name });
        }
        n.dirs.set(k, cur);
        compact(cur);
      }
    };
    compact(root);
    // projets : on déplie le 1er niveau par défaut
    if (!Object.keys(ui.expanded).length) for (const d of root.dirs.values()) ui.expanded[d.path] = root.dirs.size <= 3;
  }

  /** Déplie les dossiers qui mènent au fichier actif puis le fait défiler à l'écran (comme l'Explorateur). */
  function revealActive() {
    if (!activeUri || !root || flatMode()) { scrollActive(); return; }
    const k = key(activeUri);
    let node = root, changed = false;
    for (;;) {
      const next = [...node.dirs.values()].find(d => d.all.some(u => key(u) === k));
      if (!next) break;
      if (!ui.expanded[next.path]) { ui.expanded[next.path] = true; changed = true; }
      node = next;
    }
    if (changed) persist();
    renderTree();
    scrollActive();
  }
  function scrollActive() {
    const row = document.getElementById('activeRow');
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
  }

  function checkState(uris) {
    let n = 0;
    for (const u of uris) if (isSel(u)) n++;
    return n === 0 ? 0 : n === uris.length ? 2 : 1;
  }

  function fileRow(f, depth, showPath) {
    const name = f.rel.split('/').pop();
    const dir = dirOf(f.rel);
    const act = activeUri && key(activeUri) === key(f.uri);
    return '<div class="item' + (act ? ' active' : '') + '"' + (act ? ' id="activeRow"' : '') + ' style="padding-left:' + (4 + depth * 11) + 'px">' +
      '<span class="twisty"></span>' +
      '<input type="checkbox" data-file="' + esc(f.uri) + '"' + (isSel(f.uri) ? ' checked' : '') + '>' +
      '<span class="name" data-open="' + esc(f.uri) + '" title="' + esc(f.rel) + '">' + esc(name) +
      (showPath && dir ? '<span class="path">' + esc(dir) + '</span>' : '') + '</span>' +
      '<span class="size">' + fmtSize(f.size) + '</span>' +
      '<span class="acts"><span class="act" data-excl="' + esc(f.rel) + '" title="Exclure ce fichier du projet">⊘</span></span></div>';
  }

  function renderTree() {
    const el = $('tree');
    $('checkVisible').disabled = !flatMode();
    if (!files.length) {
      el.innerHTML = '<div class="empty">' + (scanning ? '<span class="spin">⟳</span> Analyse du projet…' : 'Aucun fichier trouvé.') + '</div>';
      return;
    }
    if (flatMode()) {
      const list = filtered();
      const shown = list.slice(0, 400);
      el.innerHTML = shown.length
        ? shown.map(f => fileRow(f, 0, true)).join('') + (list.length > 400 ? '<div class="empty">… ' + (list.length - 400) + ' autres : affine le filtre</div>' : '')
        : '<div class="empty">Aucun fichier ne correspond.</div>';
      return;
    }
    dirIndex = new Map();
    const out = [];
    const walk = (node, depth) => {
      for (const d of [...node.dirs.values()].sort((a, b) => cmpName(a.name, b.name))) {
        dirIndex.set(d.path, d);
        const open = !!ui.expanded[d.path];
        const st = checkState(d.all);
        out.push('<div class="item dir" style="padding-left:' + (4 + depth * 11) + 'px">' +
          '<span class="twisty" data-toggle="' + esc(d.path) + '">' + (open ? '▼' : '▶') + '</span>' +
          '<input type="checkbox" data-dir="' + esc(d.path) + '"' + (st === 2 ? ' checked' : '') + (st === 1 ? ' data-indet="1"' : '') + '>' +
          '<span class="name" data-toggle="' + esc(d.path) + '">' + esc(d.name) + '</span>' +
          '<span class="size">' + d.all.length + '</span>' +
          '<span class="acts"><span class="act" data-excl="' + esc(d.path) + '" title="Exclure ce dossier du projet">⊘</span></span></div>');
        if (open) walk(d, depth + 1);
      }
      for (const f of node.files.slice().sort((a, b) => cmpName(a.rel.split('/').pop(), b.rel.split('/').pop()))) out.push(fileRow(f, depth, false));
    };
    walk(root, 0);
    el.innerHTML = out.join('');
    el.querySelectorAll('input[data-indet]').forEach(i => { i.indeterminate = true; });
  }

  // ---------- listes déroulantes Projets / Types ----------

  let openMenu = null;               // 'proj' | 'ext' | null
  let menuSearch = '';

  function projItems() {
    const counts = new Map();
    for (const f of files) counts.set(f.proj, (counts.get(f.proj) || 0) + 1);
    return [...counts].filter(([p]) => p).sort((a, b) => a[0].localeCompare(b[0])).map(([v, n]) => ({ v, label: v, n }));
  }
  function extItems() {
    const counts = new Map();
    for (const f of files.filter(inProjects)) { const e = f.ext || '(sans)'; counts.set(e, (counts.get(e) || 0) + 1); }
    for (const e of ui.exts) if (!counts.has(e)) counts.set(e, 0);
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([v, n]) => ({ v, label: v === '(sans)' ? '(sans extension)' : '.' + v, n }));
  }
  const ddState = w => w === 'proj'
    ? { items: projItems(), sel: ui.projects, set: v => { ui.projects = v; }, noun: ['projet', 'projets'] }
    : { items: extItems(), sel: ui.exts, set: v => { ui.exts = v; }, noun: ['type', 'types'] };

  function ddLabel(w) {
    const { items, sel, noun } = ddState(w);
    if (!sel.length) return 'Tous';
    if (sel.length === 1) { const it = items.find(i => i.v === sel[0]); return it ? it.label : sel[0]; }
    const labels = sel.map(v => (items.find(i => i.v === v) || { label: v }).label);
    const joined = labels.join(', ');
    return joined.length <= 18 ? joined : sel.length + ' ' + noun[1];
  }

  function renderDropdowns() {
    const multi = projItems().length > 1;
    $('ddProj').hidden = !multi;
    $('projVal').textContent = ddLabel('proj');
    $('extVal').textContent = ddLabel('ext');
    $('projBtn').classList.toggle('active', ui.projects.length > 0);
    $('extBtn').classList.toggle('active', ui.exts.length > 0);
    $('projBtn').title = ui.projects.length ? 'Projets : ' + ui.projects.join(', ') : 'Tous les projets — clic pour choisir';
    $('extBtn').title = ui.exts.length ? 'Types : ' + ui.exts.map(e => '.' + e).join(', ') : 'Tous les types — clic pour choisir';
    renderMenu();
  }

  let menuFor = null;                // menu actuellement construit (pour ne pas recréer la recherche)
  function renderMenu() {
    const menu = $('ddMenu');
    if (!openMenu) { menu.hidden = true; menuFor = null; return; }
    const { items, sel } = ddState(openMenu);
    if (menuFor !== openMenu) {
      menu.innerHTML = (items.length > 8 ? '<input type="text" id="ddSearch" placeholder="Chercher…">' : '') +
        '<div id="ddList"></div>' +
        '<div class="ddfoot"><button class="link" data-act="invert">Inverser</button><button class="link" data-act="close">Fermer</button></div>';
      menuFor = openMenu;
    }
    const q = menuSearch.trim().toLowerCase();
    const shown = q ? items.filter(i => i.label.toLowerCase().includes(q)) : items;
    const opt = (v, label, n, checked, cls) =>
      '<label class="opt' + (cls ? ' ' + cls : '') + '"><input type="checkbox" data-v="' + esc(v) + '"' + (checked ? ' checked' : '') + '>' +
      '<span class="t">' + esc(label) + '</span><span class="n">' + n + '</span></label>';
    const total = items.reduce((a, i) => a + i.n, 0);
    $('ddList').innerHTML =
      opt('*', openMenu === 'proj' ? 'Tous les projets' : 'Tous les types', total, !sel.length, 'all') +
      shown.map(i => opt(i.v, i.label, i.n, sel.includes(i.v))).join('') +
      (shown.length ? '' : '<div class="empty">Aucun résultat</div>');
    menu.hidden = false;
  }

  function applyDd(next) {
    const { items, set } = ddState(openMenu);
    // tout coché = « Tous »
    set(next.length >= items.length ? [] : next);
    persist();
    if (openMenu === 'proj') { buildTree(); }
    renderDropdowns(); renderTree(); renderSelection();
  }

  function toggleMenu(w) {
    openMenu = openMenu === w ? null : w;
    menuSearch = '';
    renderMenu();
    if (openMenu) { const sb = $('ddSearch'); if (sb) sb.focus(); }
  }
  $('projBtn').addEventListener('click', e => { e.stopPropagation(); toggleMenu('proj'); });
  $('extBtn').addEventListener('click', e => { e.stopPropagation(); toggleMenu('ext'); });
  $('ddMenu').addEventListener('click', e => e.stopPropagation());
  $('ddMenu').addEventListener('change', e => {
    const t = e.target; if (!t.dataset || t.dataset.v === undefined) return;
    const { sel } = ddState(openMenu);
    if (t.dataset.v === '*') return applyDd([]);
    applyDd(t.checked ? sel.concat(t.dataset.v) : sel.filter(x => x !== t.dataset.v));
  });
  $('ddMenu').addEventListener('input', e => { if (e.target.id === 'ddSearch') { menuSearch = e.target.value; renderMenu(); } });
  $('ddMenu').addEventListener('click', e => {
    const a = e.target.dataset && e.target.dataset.act;
    if (a === 'close') { openMenu = null; renderMenu(); }
    if (a === 'invert') {
      const { items, sel } = ddState(openMenu);
      if (sel.length) applyDd(items.map(i => i.v).filter(v => !sel.includes(v)));
    }
  });
  document.addEventListener('click', () => { if (openMenu) { openMenu = null; renderMenu(); } });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && openMenu) { openMenu = null; renderMenu(); } });

  // ---------- sélection ----------

  function renderSelection() {
    const sel = files.filter(f => isSel(f.uri));
    const pf = (preview && preview.perFile) || {};
    const total = preview ? preview.total : sel.reduce((a, f) => a + f.size, 0);
    const full = preview ? preview.fullChars : total;
    const over = total > pasteLimit;

    $('selTitle').textContent = sel.length ? 'Sélection (' + sel.length + ')' : 'Sélection';
    $('selStats').innerHTML = !sel.length ? '' :
      '<b>~' + fmtTok(total) + ' tokens</b>' +
      (mode === 'diff' && full > total * 1.15 ? ' · au lieu de ~' + fmtTok(full) + ' en complet (−' + Math.round((1 - total / full) * 100) + ' %)' : '') +
      (over ? ' · plus d\'un message' : '');
    const g = $('gauge');
    g.classList.toggle('over', over);
    g.firstElementChild.style.width = Math.min(100, (total / pasteLimit) * 100) + '%';
    g.title = total.toLocaleString('fr-FR') + ' / ' + pasteLimit.toLocaleString('fr-FR') + ' caractères par message';

    // groupé par projet (si plusieurs), puis par chemin
    const groups = new Map();
    for (const f of sel.slice().sort((a, b) => a.rel.localeCompare(b.rel))) {
      const k = multiProject() ? f.proj : '';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(f);
    }
    const rows = [];
    for (const [g2, list] of groups) {
      if (g2) rows.push('<div class="grp">' + esc(g2) + '</div>');
      for (const f of list) {
        const name = f.rel.split('/').pop();
        let dir = dirOf(f.rel);
        if (g2 && dir.startsWith(g2 + '/')) dir = dir.slice(g2.length + 1); else if (g2 && dir === g2) dir = '';
        const p = pf[f.uri];
        const kind = p ? p[1] : 'full';
        const badge = kind === 'diff' ? '<span class="badge diff" title="Modifications seulement : ' + esc(p[2]) + '">Δ ' + esc(p[2].split(',')[0]) + '</span>'
          : kind === 'new' ? '<span class="badge new" title="Fichier non suivi par git : envoyé en entier">nouveau</span>'
          : mode === 'diff' ? '<span class="badge full" title="Pas de modification git : envoyé en entier">complet</span>' : '';
        rows.push('<div class="item">' +
          '<span class="name" data-open="' + esc(f.uri) + '" title="' + esc(f.rel) + '"><b>' + esc(name) + '</b>' +
          (dir ? '<span class="path">' + esc(dir) + '</span>' : '') + '</span>' + badge +
          '<span class="size" title="Tokens estimés pour ce fichier">' + fmtTok(p ? p[0] : f.size) + ' tk</span>' +
          '<span class="acts"><span class="act" data-excl="' + esc(f.rel) + '" title="Exclure ce fichier du projet">⊘</span>' +
          '<span class="act" data-remove="' + esc(f.uri) + '" title="Retirer de la sélection">✕</span></span></div>');
      }
    }
    $('selList').innerHTML = rows.join('');

    ['send', 'copy', 'file', 'parts', 'separate', 'saveBasket'].forEach(id => { $(id).disabled = !sel.length; });
    $('hint').textContent = !sel.length ? '' : over
      ? 'Trop long pour un message : « Envoyer » proposera un fichier à joindre (📎) ou un découpage (🧩).'
      : '';
  }

  function renderParts() {
    $('partsBox').hidden = !parts.count;
    if (!parts.count) return;
    const next = parts.copied.findIndex(c => !c);
    $('partsBtns').innerHTML = Array.from({ length: parts.count }, (_, i) =>
      '<button data-part="' + i + '" class="' + (parts.copied[i] ? 'done' : '') + (i === next ? ' next' : '') + '">' +
      (parts.copied[i] ? '✓ ' : '') + (i + 1) + '/' + parts.count + '</button>').join('');
  }

  function renderReview() {
    const box = $('reviewBox');
    box.hidden = !review;
    if (!review) return;
    const todo = review.filter(r => !r.applied && (r.status === 'ready' || r.status === 'partial')).length;
    const done = review.filter(r => r.applied).length;
    $('rvTitle').textContent = 'Réponse de l\'IA · ' + review.length + ' fichier' + (review.length > 1 ? 's' : '') + (done ? ' · ' + done + ' appliqué' + (done > 1 ? 's' : '') : '');
    const BADGE = {
      ready: r => r.exists ? ['ok', r.kind === 'diff' ? 'diff' : 'modifié'] : ['ok', 'nouveau'],
      partial: () => ['warn', 'partiel'], failed: () => ['err', 'échec'], nopath: () => ['err', 'sans chemin'], same: () => ['mute', 'identique']
    };
    $('rvList').innerHTML = review.map(r => {
      const name = r.rel.split('/').pop();
      const dir = dirOf(r.rel);
      const [cls, label] = r.applied ? ['mute', '✓ appliqué'] : BADGE[r.status](r);
      const canApply = !r.applied && (r.status === 'ready' || r.status === 'partial');
      const btns = [];
      if (r.hasTarget && r.status !== 'nopath') btns.push('<button data-rv="rvDiff" data-id="' + r.id + '" title="Voir le diff avant / après">👁</button>');
      if (canApply) btns.push('<button class="ok" data-rv="rvApply" data-id="' + r.id + '" title="Appliquer ce fichier">✓</button>');
      if (r.applied) btns.push('<button data-rv="rvRevert" data-id="' + r.id + '" title="Annuler pour ce fichier">↶</button>');
      if (!r.applied && (r.status === 'nopath' || r.status === 'failed')) btns.push('<button data-rv="rvTarget" data-id="' + r.id + '" title="Choisir le fichier cible">📁</button>');
      if (!r.applied) btns.push('<button data-rv="rvSkip" data-id="' + r.id + '" title="Ignorer">✕</button>');
      return '<div class="rv' + (r.applied ? ' applied' : '') + '">' +
        '<span class="nm" data-rv="rvDiff" data-id="' + r.id + '" title="' + esc(r.rel) + '"><b>' + esc(name) + '</b>' + (dir ? '<span class="path">' + esc(dir) + '</span>' : '') + '</span>' +
        '<span class="btns">' + btns.join('') + '</span>' +
        '<span class="meta"><span class="badge ' + cls + '">' + label + '</span>' +
        (r.status !== 'nopath' && r.status !== 'failed' ? '<span class="plus">+' + r.added + '</span><span class="minus">−' + r.removed + '</span>' : '') +
        (r.note ? '<span class="note">' + esc(r.note) + '</span>' : '') + '</span></div>';
    }).join('');
    $('rvAll').disabled = !todo;
    $('rvAll').textContent = todo ? '✓ Tout appliquer (' + todo + ')' : '✓ Tout appliquer';
    $('rvUndoAll').disabled = !done;
  }

  function renderMode() {
    document.querySelectorAll('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
    $('ctxRow').classList.toggle('off', mode !== 'diff');
  }

  function renderAll() { renderDropdowns(); renderTree(); renderSelection(); renderParts(); renderMode(); renderReview(); }

  // ---------- actions ----------

  function toggle(uris, on) {
    for (const u of uris) on ? selected.add(key(u)) : selected.delete(key(u));
    vscode.postMessage({ type: 'toggle', uris, on });
    renderTree(); renderSelection();
  }
  const filters = () => ({ exts: ui.exts.slice(), projects: ui.projects.slice() });

  function onActClick(e) {
    const t = e.target;
    if (t.dataset.excl !== undefined) { vscode.postMessage({ type: 'exclude', rel: t.dataset.excl }); return true; }
    if (t.dataset.remove) { toggle([t.dataset.remove], false); return true; }
    if (t.dataset.open) { vscode.postMessage({ type: 'open', uri: t.dataset.open }); return true; }
    return false;
  }

  $('tree').addEventListener('click', e => {
    const t = e.target;
    if (t.dataset.toggle !== undefined) { ui.expanded[t.dataset.toggle] = !ui.expanded[t.dataset.toggle]; persist(); renderTree(); return; }
    onActClick(e);
  });
  $('tree').addEventListener('change', e => {
    const t = e.target;
    if (t.dataset.file) toggle([t.dataset.file], t.checked);
    else if (t.dataset.dir !== undefined) { const d = dirIndex.get(t.dataset.dir); if (d) toggle(d.all, t.checked); }
  });
  $('selList').addEventListener('click', onActClick);

  let ft;
  $('filter').value = ui.filter;
  $('filter').addEventListener('input', e => { clearTimeout(ft); ft = setTimeout(() => { ui.filter = e.target.value; persist(); renderTree(); }, 120); });
  $('filter').addEventListener('keydown', e => { if (e.key === 'Escape') { e.target.value = ''; ui.filter = ''; persist(); renderTree(); } });
  $('checkVisible').addEventListener('click', () => toggle(filtered().map(f => f.uri), true));

  $('modeSeg').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || b.dataset.mode === mode) return;
    mode = b.dataset.mode; renderMode(); renderSelection();
    vscode.postMessage({ type: 'mode', value: mode });
  });
  let ct;
  $('ctx').addEventListener('input', e => { clearTimeout(ct); ct = setTimeout(() => vscode.postMessage({ type: 'context', value: e.target.value }), 300); });

  let it;
  $('instruction').addEventListener('input', e => {
    clearTimeout(it);
    it = setTimeout(() => { instructionSent = e.target.value; vscode.postMessage({ type: 'instruction', value: e.target.value }); }, 300);
  });
  const flushInstruction = () => {
    const v = $('instruction').value;
    if (v !== instructionSent) { clearTimeout(it); instructionSent = v; vscode.postMessage({ type: 'instruction', value: v }); }
  };

  ['refresh', 'clear', 'send', 'copy', 'file', 'parts', 'separate', 'saveBasket', 'openChat', 'settings', 'cleanExports'].forEach(id =>
    $(id).addEventListener('click', () => { flushInstruction(); vscode.postMessage({ type: id }); }));
  $('addActive').addEventListener('click', () => vscode.postMessage({ type: 'addActive' }));
  $('answerFormat').addEventListener('change', e => vscode.postMessage({ type: 'answerFormat', value: e.target.checked }));
  $('review').addEventListener('click', () => vscode.postMessage({ type: 'review' }));
  $('rvList').addEventListener('click', e => {
    const b = e.target.closest('[data-rv]'); if (!b) return;
    vscode.postMessage({ type: b.dataset.rv, id: Number(b.dataset.id) });
  });
  ['rvAll', 'rvUndoAll', 'rvClose'].forEach(id => $(id).addEventListener('click', () => vscode.postMessage({ type: id })));
  $('gitChanged').addEventListener('click', () => vscode.postMessage({ type: 'gitChanged', filters: filters() }));
  $('openTabs').addEventListener('click', () => vscode.postMessage({ type: 'openTabs', filters: filters() }));
  $('partsBtns').addEventListener('click', e => { const b = e.target.closest('button'); if (b) vscode.postMessage({ type: 'copyPart', index: Number(b.dataset.part) }); });

  const basket = () => $('baskets').value;
  $('loadBasket').addEventListener('click', () => basket() && vscode.postMessage({ type: 'loadBasket', name: basket(), mode: 'replace' }));
  $('addBasket').addEventListener('click', () => basket() && vscode.postMessage({ type: 'loadBasket', name: basket(), mode: 'add' }));
  $('delBasket').addEventListener('click', () => basket() && vscode.postMessage({ type: 'deleteBasket', name: basket() }));
  $('excluded').addEventListener('click', e => { const x = e.target.closest('.x'); if (x) vscode.postMessage({ type: 'unexclude', rel: x.dataset.rel }); });
  $('more').open = ui.moreOpen;
  $('more').addEventListener('toggle', () => { ui.moreOpen = $('more').open; persist(); });

  // ---------- messages de l'extension ----------

  window.addEventListener('message', ev => {
    const m = ev.data;
    if (m.type === 'preview') { preview = m; renderSelection(); return; }
    if (m.type === 'active') { activeUri = m.uri || null; revealActive(); return; }
    if (m.type !== 'state') return;

    $('noWs').hidden = m.hasWorkspace; $('main').hidden = !m.hasWorkspace;
    scanning = m.scanning;
    $('refresh').innerHTML = scanning ? '<span class="spin">⟳</span>' : '⟳';
    if (m.files) {
      files = m.files.map(([uri, rel, size, proj]) => {
        const base = rel.split('/').pop();
        return { uri, rel, size, proj, ext: base.includes('.') ? base.split('.').pop().toLowerCase() : '' };
      });
      const known = projectsList();
      ui.projects = ui.projects.filter(p => known.includes(p));
      buildTree();
    }
    selected = new Set(m.selected.map(key));
    pasteLimit = m.pasteLimit || 30000;
    if (m.chatName) {
      $('sendLabel').textContent = 'Envoyer vers ' + m.chatName;
      $('send').title = 'Envoyer vers ' + m.chatName;
      $('openChat').textContent = '↗ Ouvrir ' + m.chatName;
    }
    parts = m.parts;
    if (mode !== m.mode) preview = null;
    mode = m.mode;
    if (document.activeElement !== $('ctx')) $('ctx').value = m.context;
    if (document.activeElement !== $('instruction') && $('instruction').value !== m.instruction) {
      $('instruction').value = m.instruction; instructionSent = m.instruction;
    }
    const cur = basket();
    $('baskets').innerHTML = m.baskets.length
      ? m.baskets.map(b => '<option' + (b === cur ? ' selected' : '') + '>' + esc(b) + '</option>').join('')
      : '<option value="">(aucune sélection enregistrée)</option>';
    ['loadBasket', 'addBasket', 'delBasket'].forEach(id => { $(id).disabled = !m.baskets.length; });
    $('excluded').innerHTML = m.excluded.length
      ? m.excluded.map(r => '<span class="chip excl" title="' + esc(r) + '">' + esc(r) + '<span class="x" data-rel="' + esc(r) + '" title="Ne plus exclure">✕</span></span>').join('')
      : '<span class="dim">Aucune exclusion propre à ce projet.</span>';
    $('answerFormat').checked = !!m.answerFormat;
    review = m.review || null;
    const firstFiles = !!m.files && !files.__revealed;
    if (m.active !== undefined && (m.active || null) !== activeUri) { activeUri = m.active || null; }
    renderAll();
    if (firstFiles && activeUri) { files.__revealed = true; revealActive(); }
  });

  vscode.postMessage({ type: 'ready' });
})();
