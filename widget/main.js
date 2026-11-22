// Widget todo-hub : fenêtre flottante, tunnel SSH vers le serveur, flux temps réel.
const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, nativeImage } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const LOCAL_PORT = 18765;
const BASE = `http://127.0.0.1:${LOCAL_PORT}`;
const cfgFile = path.join(app.getPath('userData'), 'config.json');
const DEFAULTS = { sshHost: 'todo-server', sshKey: '', hubPort: 8765, bounds: { width: 340, height: 560 } };
let cfg = { ...DEFAULTS };
try { cfg = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')) }; } catch {}
const saveCfg = () => { try { fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2)); } catch {} };
saveCfg(); // crée le fichier pour qu'on puisse l'éditer (sshHost, sshKey)

let win, tray, tunnel, quitting = false, online = false, lastState = null;

if (!app.requestSingleInstanceLock()) app.quit();
// Identité Windows fixe : nom de la ligne « Lancer avec Windows » (celui que gèrent l'installateur et le désinstallateur)
// et des notifications. Sans elle, Electron écrit « electron.app.Electron ».
const AUMID = 'electron.app.TodoClaude';
if (process.platform === 'win32') app.setAppUserModelId(AUMID);

function startTunnel() {
  const args = ['-N', '-L', `127.0.0.1:${LOCAL_PORT}:127.0.0.1:${cfg.hubPort}`,
    '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3'];
  if (cfg.sshKey) args.push('-i', cfg.sshKey);
  args.push(cfg.sshHost);
  tunnel = spawn('ssh', args, { windowsHide: true, stdio: 'ignore' });
  tunnel.on('error', () => {});
  tunnel.on('exit', () => { tunnel = null; if (!quitting) setTimeout(startTunnel, 3000); });
}

const send = (ch, v) => win && !win.isDestroyed() && win.webContents.send(ch, v);
function setOnline(v) { if (v !== online) { online = v; send('online', v); } }

async function api(p, body) {
  const r = await fetch(BASE + p, body === undefined ? {} :
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}
async function refresh() {
  try { lastState = await api('/api/state'); setOnline(true); send('state', lastState); reminders(); }
  catch { setOnline(false); }
}

// Rappels : échéance atteinte (9 h si pas d'heure), vérif auto OK ou en échec. Une fois par événement ;
// au tout premier lancement on mémorise l'existant sans rien afficher.
const REMIND_AT = '09:00';
function reminders() {
  if (!lastState || !tray) return;
  const d = new Date(), pad = n => String(n).padStart(2, '0');
  const now = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const ev = [];
  for (const p of lastState.projects) for (const t of p.tasks) {
    if (t.check_state === 'ko') ev.push([`ko:${t.id}:${t.check_ran}`, `✗ Vérif en échec : ${t.title}`]);
    else if (t.check_state === 'ok') ev.push([`ok:${t.id}:${t.check_ran}`, `✓ Vérif OK : ${t.title}`]);
    else if (t.due && !t.check_cmd && t.status !== 'done' && now >= (t.due.length > 10 ? t.due : `${t.due}T${REMIND_AT}`))
      ev.push([`due:${t.id}:${t.due}`, `📅 ${t.title}`]);
  }
  const first = !cfg.notified, seen = new Set(cfg.notified || []);
  const fresh = ev.filter(([k]) => !seen.has(k));
  if (!first && !fresh.length) return;
  cfg.notified = [...seen, ...fresh.map(e => e[0])].slice(-500); saveCfg();
  if (first) return;
  const title = fresh.length > 1 ? `Todo Claude : ${fresh.length} rappels` : 'Todo Claude';
  const content = fresh.map(e => e[1]).join('\n').slice(0, 250);
  if (process.platform === 'win32')
    tray.displayBalloon({ title, content, iconType: fresh.some(e => e[0].startsWith('ko')) ? 'warning' : 'info' });
  else new Notification({ title, body: content }).show();
}

// Flux SSE : se reconnecte tout seul ; chaque événement déclenche un rafraîchissement.
async function listen() {
  while (!quitting) {
    try {
      const r = await fetch(BASE + '/events');
      setOnline(true); await refresh();
      const reader = r.body.getReader(), dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (dec.decode(value).includes('changed')) refresh();
      }
    } catch {}
    setOnline(false);
    await new Promise(r => setTimeout(r, 3000));
  }
}

function createWindow() {
  const b = cfg.bounds;
  win = new BrowserWindow({
    ...b, minWidth: 260, minHeight: 200, frame: false, alwaysOnTop: true, skipTaskbar: true,
    backgroundColor: '#14161a', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.loadFile('index.html');
  win.once('ready-to-show', () => { win.show(); if (lastState) send('state', lastState); send('online', online); });
  const keep = () => { cfg.bounds = win.getBounds(); saveCfg(); };
  win.on('moved', keep); win.on('resized', keep);
  win.on('close', e => { if (!quitting) { e.preventDefault(); win.hide(); } });
}

const toggle = () => (win.isVisible() ? win.hide() : (win.show(), win.focus()));

app.whenReady().then(() => {
  startTunnel(); createWindow(); listen();
  const icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
  tray = new Tray(icon);
  tray.setToolTip('Todo Claude');
  tray.on('click', toggle);
  tray.on('balloon-click', () => { win.show(); win.focus(); });
  setInterval(reminders, 60000);
  // « Lancer avec Windows » activé d'office une seule fois (0.2.1) ; ensuite la case du menu fait foi.
  if (process.platform === 'win32') {
    // ancienne ligne écrite sous le nom par défaut d'Electron (0.2.0) : reprise sous le bon nom puis retirée
    const old = (app.getLoginItemSettings().launchItems || []).find(i => i.name === 'electron.app.Electron' && /TodoClaude/i.test(i.path || ''));
    if (old) { app.setLoginItemSettings({ openAtLogin: false, name: 'electron.app.Electron' }); app.setLoginItemSettings({ openAtLogin: true, name: AUMID }); }
    if (!cfg.autostartSet) { app.setLoginItemSettings({ openAtLogin: true, name: AUMID }); cfg.autostartSet = true; saveCfg(); }
  }
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Afficher / masquer', click: toggle },
    { label: 'Lancer avec Windows', type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: m => app.setLoginItemSettings({ openAtLogin: m.checked, name: AUMID }) },
    { type: 'separator' },
    { label: 'Quitter', click: () => { quitting = true; tunnel && tunnel.kill(); app.quit(); } },
  ]));
});
app.on('second-instance', () => { win.show(); win.focus(); });
app.on('window-all-closed', e => e.preventDefault());

ipcMain.handle('task-status', (_, id, status) => api(`/api/task/${id}`, { status }).then(refresh));
ipcMain.handle('task-add', (_, project, title) => api('/api/task', { project, title }).then(refresh));
ipcMain.handle('api', (_, p, body) => api(p, body).then(refresh));
ipcMain.handle('hide', () => win.hide());
