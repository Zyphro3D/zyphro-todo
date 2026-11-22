const $ = s => document.querySelector(s);
const esc = s => s.replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
let collapsed = {}; try { collapsed = JSON.parse(localStorage.collapsed || '{}'); } catch {}
let state = null, drag = null, dirty = false;
let showClosed = localStorage.showClosed === '1';
let hideDone = localStorage.hideDone !== '0';   // tâches faites masquées par défaut (les compteurs restent justes)
const visible = t => !hideDone || t.status !== 'done';
let calView = localStorage.calView === '1';
let sort = { by: 'manual', dir: 'desc' }; try { sort = { ...sort, ...JSON.parse(localStorage.sort || '{}') }; } catch {}
const PRIO = { 1: ['basse', '⚐'], 2: ['normale', '⚑'], 3: ['haute', '⚑'], 4: ['urgente', '⚑'] };

function ago(t) {
  const s = Math.max(0, Date.now() / 1000 - t);
  if (s < 90) return "à l'instant";
  if (s < 5400) return `il y a ${Math.round(s / 60)} min`;
  if (s < 129600) return `il y a ${Math.round(s / 3600)} h`;
  return `il y a ${Math.round(s / 86400)} j`;
}

// Échéance 'AAAA-MM-JJ' ou 'AAAA-MM-JJTHH:MM' : J-3 (gris), auj. (orange), J+2 = en retard (rouge)
const DAY = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'];
function dueInfo(t) {
  if (!t.due) return null;
  const [y, mo, d] = t.due.slice(0, 10).split('-').map(Number), day = new Date(y, mo - 1, d), now = new Date();
  const n = Math.round((day - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
  const hm = t.due.slice(11), past = n < 0 || (n === 0 && hm && now.toTimeString().slice(0, 5) >= hm);
  const open = t.status !== 'done';
  return {
    n, hm, day,
    label: (n === 0 ? 'auj.' : n > 0 ? `J-${n}` : `J+${-n}`) + (hm ? ' ' + hm : ''),
    cls: !open ? '' : past ? 'late' : n === 0 ? 'today' : '',
    date: `${DAY[day.getDay()]} ${String(d).padStart(2, '0')}/${String(mo).padStart(2, '0')}`,
  };
}

function taskLi(t, stale, pname) {
  const di = dueInfo(t);
  const due = di ? `<span class="due ${di.cls}" data-due="${t.id}" title="Échéance ${di.date}${di.hm ? ' à ' + di.hm : ''} (clic : changer)">${di.label}</span>` : '';
  const out = t.check_out ? '\n\n' + esc(t.check_out.split('\n').slice(-8).join('\n')) : '';
  const ck = !t.check_state ? '' : t.check_state === 'wait'
    ? `<span class="ck wait" title="Vérif auto le ${t.check_at.replace('T', ' à ')} :\n${esc(t.check_cmd)}${out}">⏱</span>`
    : t.check_state === 'ok' ? `<span class="ck ok" title="Vérif auto OK${out}">✓ auto</span>`
    : `<span class="ck ko" data-rearm="${t.id}" title="Vérif auto en échec (clic : relancer)${out}">✗ vérif</span>`;
  return `<li class="${t.status} ${t.source} ${stale} ${di && di.cls === 'late' ? 'late' : ''}" draggable="true" data-id="${t.id}" data-st="${t.status}"><i class="b">${t.status === 'done' ? '✓' : ''}</i><span>${esc(t.title)}</span>${pname ? `<span class="pj">${esc(pname)}</span>` : ''}${ck}${due}<button class="pr p${t.priority}" data-pr="${t.id}" data-lv="${t.priority}" title="Priorité ${PRIO[t.priority][0]} (clic : changer)">${PRIO[t.priority][1]}</button>${di ? '' : `<button class="x" data-due="${t.id}" title="Donner une échéance">📅</button>`}<button class="x" data-drop="${t.id}" title="Abandonner la tâche">✕</button></li>`;
}

// Vue calendrier : tâches datées ouvertes de tous les projets, groupées par jour
function renderCal(ps) {
  const ts = ps.flatMap(p => p.tasks.filter(t => t.due && t.status !== 'done').map(t => ({ t, p })))
    .sort((a, b) => a.t.due.localeCompare(b.t.due));
  if (!ts.length) return '<div class="empty">Aucune tâche datée<br><span class="sub">📅 au survol d’une tâche, ou todo add … --due demain</span></div>';
  let html = '', cur = null;
  for (const { t, p } of ts) {
    const di = dueInfo(t), g = di.n < 0 ? 'late' : t.due.slice(0, 10);
    if (g !== cur) {
      if (cur !== null) html += '</ul></div>';
      cur = g;
      const head = g === 'late' ? 'En retard' : di.n === 0 ? 'Aujourd’hui' : di.n === 1 ? 'Demain' : di.date;
      html += `<div class="card"><div class="day ${g === 'late' ? 'late' : di.n === 0 ? 'today' : ''}">${head}<span class="sub">${g === 'late' ? '' : di.n > 1 ? 'J-' + di.n : di.date}</span></div><ul>`;
    }
    html += taskLi(t, '', p.name);
  }
  return html + '</ul></div>';
}

// Tâches faites toujours en bas ; ensuite selon le tri choisi (égalité : ordre manuel)
function sortTasks(ts) {
  if (sort.by === 'manual') return ts;
  if (sort.by === 'due') {   // ↓ : la plus proche d'abord ; sans échéance toujours après
    const s = sort.dir === 'desc' ? 1 : -1;
    return [...ts].sort((a, b) => (a.status === 'done') - (b.status === 'done') || !a.due - !b.due || s * (a.due || '').localeCompare(b.due || ''));
  }
  const k = sort.by === 'prio' ? t => t.priority : t => t.created, s = sort.dir === 'desc' ? -1 : 1;
  return [...ts].sort((a, b) => (a.status === 'done') - (b.status === 'done') || s * (k(a) - k(b)));
}
// En tri par importance, les projets sont classés selon leur tâche ouverte la plus importante
function sortProjects(ps) {
  if (sort.by !== 'prio') return ps;
  const top = p => Math.max(0, ...p.tasks.filter(t => t.status !== 'done').map(t => t.priority));
  const s = sort.dir === 'desc' ? -1 : 1;
  return [...ps].sort((a, b) => s * (top(a) - top(b)));
}

function render() {
  const m = $('#m');
  if (!state) return;
  // pas de redessin pendant une saisie ou un glisser-déposer : on le fait ensuite
  if (drag || (document.activeElement && document.activeElement.tagName === 'INPUT' && document.activeElement.id !== 'q')) { dirty = true; return; }
  dirty = false;
  syncCal();
  const norm = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const q = norm($('#q').value.trim());
  let ps = state.projects.filter(p => showClosed || !p.closed);
  if (q) {   // un projet dont le nom correspond reste entier ; sinon seules les tâches qui correspondent
    ps = ps.map(p => norm(p.name).includes(q) ? p
      : { ...p, tasks: p.tasks.filter(t => visible(t) && norm(t.title).includes(q)) }).filter(p => p.tasks.some(visible));
    const n = ps.reduce((a, p) => a + p.tasks.filter(visible).length, 0);
    $('#sum').textContent = `${n} résultat${n > 1 ? 's' : ''}`;
    if (!ps.length) { m.innerHTML = '<div class="empty">Aucun résultat</div>'; return; }
  }
  ps = sortProjects(ps.map(p => ({ ...p, tasks: sortTasks(p.tasks) }))).sort((a, b) => a.closed - b.closed);
  const open = ps.filter(p => !p.closed).reduce((n, p) => n + p.total - p.done, 0);
  if (!q) $('#sum').textContent = `${open} à faire`;
  if (calView) { m.innerHTML = renderCal(ps.filter(p => !p.closed)); return; }
  if (!ps.length) { m.innerHTML = '<div class="empty">Aucune tâche pour l’instant</div>'; return; }
  m.innerHTML = ps.map(p => {
    const col = collapsed[p.id] && !q, stale = p.active_sessions ? '' : 'stale';
    const tasks = col ? '' : '<ul>' + p.tasks.filter(visible).map(t => taskLi(t, stale)).join('') +
      `</ul><form class="add" data-p="${p.id}"><input placeholder="+ ajouter une tâche" maxlength="200"></form>`;
    return `<div class="card ${p.closed ? 'closed' : ''}" draggable="true" data-pid="${p.id}"><div class="head" data-pid="${p.id}">
      <button class="chev" title="${col ? 'Déplier' : 'Réduire'}">${col ? '▸' : '▾'}</button><i class="live ${stale}" title="${stale ? 'pas d’activité récente' : 'Claude travaille ici'}"></i>
      <span class="n" title="Double-clic : renommer">${esc(p.name)}</span><span class="p">${p.percent}%</span>${p.closed ? `<button class="fin" data-close="${p.id}" data-op="reopen" title="Rouvrir le projet">↺</button>` : p.percent === 100 ? `<button class="fin ok" data-close="${p.id}" data-op="close" title="Valider : projet terminé (masqué, pas supprimé)">✔</button>` : ''}</div>
      <div class="bar ${p.percent === 100 ? 'full' : ''}"><i style="width:${p.percent}%"></i></div>
      <div class="sub">${p.done}/${p.total} · ${ago(p.last_activity)}</div>${tasks}</div>`;
  }).join('');
}

const m = $('#m');
const clearOver = () => document.querySelectorAll('.over,.overt').forEach(e => e.classList.remove('over', 'overt'));

m.addEventListener('click', e => {
  const fin = e.target.closest('[data-close]');
  if (fin) return todo.api('/api/project', { op: fin.dataset.op, name: fin.dataset.close });
  const pr = e.target.closest('[data-pr]');
  if (pr) { const next = { 2: 3, 3: 4, 4: 1, 1: 2 }[pr.dataset.lv]; return todo.api(`/api/task/${pr.dataset.pr}`, { priority: next }); }
  const rearm = e.target.closest('[data-rearm]');
  if (rearm) { const t = findTask(+rearm.dataset.rearm); return todo.api(`/api/task/${t.id}`, { due: t.due }); }   // replanifie la vérif : relancée dans la minute
  const dd = e.target.closest('[data-due]');
  if (dd) return editDue(dd, findTask(+dd.dataset.due));
  if (e.target.closest('li input')) return;
  const x = e.target.closest('[data-drop]'), h = e.target.closest('.head'), li = e.target.closest('li');
  if (x) return todo.api(`/api/task/${x.dataset.drop}`, { status: 'dropped' });
  if (h && !e.target.closest('input')) { collapsed[h.dataset.pid] = !collapsed[h.dataset.pid]; localStorage.collapsed = JSON.stringify(collapsed); render(); }
  else if (li) todo.api(`/api/task/${li.dataset.id}`, { status: li.dataset.st === 'done' ? 'todo' : 'done' });
});

const findTask = id => state.projects.flatMap(p => p.tasks).find(t => t.id === id);
// Choix de la date sur place ; vider la date retire l'échéance (l'heure éventuelle est gardée)
function editDue(el, t) {
  const i = document.createElement('input'); i.type = 'date'; i.value = (t.due || '').slice(0, 10);
  el.replaceWith(i); i.focus();
  try { i.showPicker(); } catch {}
  let gone = false;
  const done = ok => {
    if (gone) return; gone = true;
    if (ok && i.value !== (t.due || '').slice(0, 10)) todo.api(`/api/task/${t.id}`, { due: i.value ? i.value + (t.due && t.due.length > 10 ? t.due.slice(10) : '') : '' });
    dirty = true; i.blur(); render();
  };
  i.onchange = () => done(true);
  i.onkeydown = ev => { if (ev.key === 'Enter') done(true); if (ev.key === 'Escape') done(false); };
  i.onblur = () => setTimeout(() => done(true), 0);
}

m.addEventListener('dblclick', e => {   // renommer un projet sur place
  const n = e.target.closest('.n');
  if (!n) return;
  const id = n.closest('.head').dataset.pid, old = n.textContent;
  const i = document.createElement('input'); i.value = old; n.replaceWith(i); i.focus(); i.select();
  const done = ok => { if (ok && i.value.trim() && i.value.trim() !== old) todo.api('/api/project', { op: 'rename', name: id, arg: i.value.trim() }); else { dirty = false; i.blur(); render(); } };
  i.onkeydown = ev => { if (ev.key === 'Enter') done(true); if (ev.key === 'Escape') done(false); };
  i.onblur = () => setTimeout(() => done(false), 0);
});

m.addEventListener('submit', e => {
  e.preventDefault();
  const i = e.target.querySelector('input'), v = i.value.trim();
  if (v) { todo.api('/api/task', { project: state.projects.find(p => p.id == e.target.dataset.p).name, title: v }); i.value = ''; }
  i.blur();
});
$('#np').addEventListener('submit', e => {
  e.preventDefault();
  const i = e.target.querySelector('input'), v = i.value.trim();
  if (v) todo.api('/api/project', { op: 'create', name: v });
  i.value = ''; i.blur();
});

// Glisser-déposer : tâches (vers une tâche ou un projet) et projets (vers un projet)
m.addEventListener('dragstart', e => {
  if (calView) return e.preventDefault();
  const li = e.target.closest('li'), card = e.target.closest('.card');
  if (li) drag = { type: 'task', id: +li.dataset.id };
  else if (card) drag = { type: 'project', id: +card.dataset.pid };
  else return;
  e.stopPropagation();
  e.dataTransfer.setData('text/plain', 'x'); e.dataTransfer.effectAllowed = 'move';
});
m.addEventListener('dragover', e => {
  if (!drag) return;
  const li = e.target.closest('li'), card = e.target.closest('.card');
  if (!card) return;
  e.preventDefault(); clearOver();
  if (drag.type === 'task' && li && +li.dataset.id !== drag.id) li.classList.add('overt');
  else if (drag.type === 'project' && +card.dataset.pid !== drag.id) card.classList.add('overt');
  else card.classList.add('over');
});
m.addEventListener('drop', e => {
  if (!drag) return;
  e.preventDefault();
  const li = e.target.closest('li'), card = e.target.closest('.card'), d = drag;
  drag = null; clearOver();
  if (!card) return;
  const pid = +card.dataset.pid;
  if (d.type === 'task') {
    todo.api(`/api/task/${d.id}/move`, { project_id: pid, before_id: li && sort.by === 'manual' ? +li.dataset.id : null });
  } else if (pid !== d.id && sort.by !== 'prio') {
    const ids = state.projects.map(p => p.id).filter(i => i !== d.id);
    ids.splice(ids.indexOf(pid), 0, d.id);
    todo.api('/api/projects/order', { ids });
  }
});
m.addEventListener('dragend', () => { drag = null; clearOver(); if (dirty) render(); });
m.addEventListener('focusout', () => setTimeout(() => { if (dirty) render(); }, 100));

const syncSort = () => {
  $('#sby').value = sort.by;
  $('#sdir').disabled = sort.by === 'manual';
  $('#sdir').textContent = sort.dir === 'desc' ? '↓' : '↑';
  $('#sdir').title = sort.dir === 'desc' ? 'Plus important / plus récent / échéance la plus proche d’abord' : 'Moins important / plus ancien / échéance la plus lointaine d’abord';
};
const saveSort = () => { localStorage.sort = JSON.stringify(sort); syncSort(); render(); };
const syncClosed = () => { $('#shc').className = showClosed ? 'on' : ''; $('#shc').title = showClosed ? 'Masquer les projets terminés' : 'Afficher les projets terminés'; };
$('#shc').onclick = () => { showClosed = !showClosed; localStorage.showClosed = showClosed ? '1' : '0'; syncClosed(); render(); };
syncClosed();
const syncDone = () => { $('#shd').className = hideDone ? '' : 'on'; $('#shd').title = hideDone ? 'Afficher les tâches faites' : 'Masquer les tâches faites'; };
$('#shd').onclick = () => { hideDone = !hideDone; localStorage.hideDone = hideDone ? '1' : '0'; syncDone(); render(); };
syncDone();
// Bouton calendrier : nombre de tâches en retard ou du jour
function syncCal() {
  const ts = state ? state.projects.filter(p => !p.closed).flatMap(p => p.tasks).filter(t => t.due && t.status !== 'done') : [];
  const late = ts.filter(t => dueInfo(t).cls === 'late').length, today = ts.filter(t => dueInfo(t).cls === 'today').length;
  $('#cal').className = calView ? 'on' : '';
  $('#cal').innerHTML = '📅' + (late ? `<span class="n late">${late}</span>` : today ? `<span class="n today">${today}</span>` : '');
  $('#cal').title = calView ? 'Revenir aux projets' : `Calendrier : ${ts.length} tâche${ts.length > 1 ? 's' : ''} datée${ts.length > 1 ? 's' : ''}` + (late ? `, ${late} en retard` : '');
}
$('#cal').onclick = () => { calView = !calView; localStorage.calView = calView ? '1' : '0'; render(); };
$('#sby').onchange = e => { sort.by = e.target.value; saveSort(); };
$('#sdir').onclick = () => { sort.dir = sort.dir === 'desc' ? 'asc' : 'desc'; saveSort(); };
syncSort();
$('#q').addEventListener('input', render);
$('#q').addEventListener('keydown', e => { if (e.key === 'Escape') { e.target.value = ''; render(); e.target.blur(); } });
$('#all').onclick = () => {   // tout réduire, ou tout déplier si tout est déjà réduit
  const shut = state.projects.some(p => !collapsed[p.id]);
  state.projects.forEach(p => { collapsed[p.id] = shut; });
  localStorage.collapsed = JSON.stringify(collapsed); render();
};
$('#x').onclick = () => todo.hide();
todo.onState(s => { state = s; render(); });
todo.onOnline(v => { $('#dot').className = v ? 'on' : ''; $('#dot').title = v ? 'connecté' : 'hors ligne'; });
setInterval(render, 60000);
