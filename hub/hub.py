#!/usr/bin/env python3
"""todo-hub : liste de tâches centrale alimentée par Claude Code.

Python stdlib + SQLite. Écoute sur 127.0.0.1 uniquement ; le widget Windows s'y
connecte par un tunnel SSH. Projets persistants, tâches de session (TodoWrite)
et notes « à faire plus tard » (CLI `todo add`).
"""
import json, os, queue, re, sqlite3, threading, time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOME = Path.home()
DB_PATH = Path(os.environ.get("TODO_DB", HOME / ".local/share/todo-hub/todo.db"))
PORT = int(os.environ.get("TODO_PORT", "8765"))
ARCHIVE_AFTER = 7 * 86400          # une tâche faite disparaît du widget après 7 jours
SESSION_ACTIVE = 15 * 60           # session « active » si vue il y a moins de 15 min
CHECK_RETRY = 30 * 60              # vérif auto qui répond « pas encore » (code 75) : on réessaie 30 min plus tard
CHECK_DEFAULT_TIME = "09:00"       # vérif auto sur une échéance sans heure
CHECK_GIVE_UP = 12 * 3600          # « pas encore » 12 h après l'échéance = échec

# Dossiers connus -> nom lisible (le reste est déduit du nom du dossier)
DEFAULT_NAMES = {str(HOME): "Général", str(HOME / "ops"): "Infra homelab"}

_lock = threading.RLock()
_db = None
_listeners = []


def db():
    global _db
    if _db is None:
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        _db = sqlite3.connect(DB_PATH, check_same_thread=False)
        _db.row_factory = sqlite3.Row
        _db.executescript("""
        CREATE TABLE IF NOT EXISTS projects(
          id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL,
          archived INTEGER DEFAULT 0, last_activity REAL DEFAULT 0,
          sort_order REAL DEFAULT 1000, manual INTEGER DEFAULT 0);
        CREATE TABLE IF NOT EXISTS paths(
          path TEXT PRIMARY KEY, project_id INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS tasks(
          id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, title TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'todo',   -- todo | doing | done | dropped
          source TEXT NOT NULL DEFAULT 'session', -- session | note
          session_id TEXT, position INTEGER DEFAULT 0,
          created REAL, updated REAL, done_at REAL);
        CREATE TABLE IF NOT EXISTS sessions(
          id TEXT PRIMARY KEY, project_id INTEGER, last_seen REAL);
        CREATE INDEX IF NOT EXISTS t_proj ON tasks(project_id, status);
        """)
        for tbl, col in (("projects", "sort_order REAL DEFAULT 1000"), ("projects", "manual INTEGER DEFAULT 0"),
                         ("tasks", "priority INTEGER DEFAULT 2"),
                         # échéance 'AAAA-MM-JJ' ou 'AAAA-MM-JJTHH:MM' (heure locale) et vérif auto
                         ("tasks", "due TEXT"), ("tasks", "check_cmd TEXT"), ("tasks", "check_at TEXT"),
                         ("tasks", "check_state TEXT"), ("tasks", "check_out TEXT"), ("tasks", "check_ran REAL")):   # bases créées avant
            try:
                _db.execute(f"ALTER TABLE {tbl} ADD COLUMN {col}")
            except sqlite3.OperationalError:
                pass
    return _db


def notify():
    for q in list(_listeners):
        try:
            q.put_nowait("changed")
        except queue.Full:
            pass


def project_for_cwd(cwd):
    """Projet rattaché au dossier (préfixe le plus long), créé au besoin."""
    cwd = os.path.normpath(cwd or str(HOME))
    c = db()
    best = None
    for r in c.execute("SELECT path, project_id FROM paths"):
        p = r["path"]
        if (cwd == p or cwd.startswith(p + "/")) and (best is None or len(p) > len(best[0])):
            best = (p, r["project_id"])
    if best:
        return best[1]
    name = DEFAULT_NAMES.get(cwd) or os.path.basename(cwd) or "Général"
    row = c.execute("SELECT id FROM projects WHERE name=?", (name,)).fetchone()
    pid = row["id"] if row else c.execute(
        "INSERT INTO projects(name) VALUES(?)", (name,)).lastrowid
    c.execute("INSERT OR REPLACE INTO paths VALUES(?,?)", (cwd, pid))
    c.commit()
    return pid


def find_project(name):
    """Projet par nom : exact, puis sans casse, puis sous-chaîne unique."""
    c = db()
    low = name.lower()
    for closed in (0, 1):               # un projet ouvert l'emporte sur un projet terminé
        rows = c.execute("SELECT id, name FROM projects WHERE archived=?", (closed,)).fetchall()
        for test in (lambda n: n == name, lambda n: n.lower() == low,
                     lambda n: low in n.lower()):
            m = [r for r in rows if test(r["name"])]
            if len(m) == 1:
                return m[0]["id"]
            if len(m) > 1:
                return None
    return None


def sweep(now):
    """Masque (statut 'dropped') les tâches faites depuis plus de 7 jours, sauf dans un projet terminé."""
    db().execute("UPDATE tasks SET status='dropped' WHERE status='done' AND done_at<? "
                 "AND project_id NOT IN (SELECT id FROM projects WHERE archived=1)",
                 (now - ARCHIVE_AFTER,))


def set_status(c, tid, status, now):
    c.execute("UPDATE tasks SET status=?, updated=?, done_at=? WHERE id=?",
              (status, now, now if status == "done" else None, tid))


def sync_session(sid, cwd, todos):
    """Réconcilie la liste TodoWrite d'une session avec la base."""
    now = time.time()
    with _lock:
        c = db()
        pid = project_for_cwd(cwd)
        c.execute("INSERT OR REPLACE INTO sessions VALUES(?,?,?)", (sid, pid, now))
        c.execute("UPDATE projects SET last_activity=? WHERE id=?", (now, pid))
        if any(t.get("status") != "completed" for t in todos):
            c.execute("UPDATE projects SET archived=0 WHERE id=?", (pid,))   # du travail arrive : on rouvre
        mine = {r["title"]: r for r in c.execute(
            "SELECT * FROM tasks WHERE session_id=? AND status!='dropped'", (sid,))}
        seen = set()
        for pos, t in enumerate(todos):
            title = (t.get("content") or "").strip()
            if not title:
                continue
            status = {"completed": "done", "in_progress": "doing"}.get(t.get("status"), "todo")
            seen.add(title)
            row = mine.get(title)
            if row is None:
                # reprise d'une tâche ouverte du même projet (note, ou autre session)
                row = c.execute(
                    "SELECT * FROM tasks WHERE project_id=? AND lower(title)=lower(?) "
                    "AND status IN ('todo','doing') ORDER BY id LIMIT 1", (pid, title)).fetchone()
                if row:
                    c.execute("UPDATE tasks SET session_id=? WHERE id=?", (sid, row["id"]))
            if row is None:
                c.execute("INSERT INTO tasks(project_id,title,status,source,session_id,position,"
                          "created,updated,done_at) VALUES(?,?,?,?,?,?,?,?,?)",
                          (pid, title, status, "session", sid, pos, now, now,
                           now if status == "done" else None))
            else:
                if row["status"] != status:
                    set_status(c, row["id"], status, now)
                c.execute("UPDATE tasks SET position=? WHERE id=?", (pos, row["id"]))
        for title, row in mine.items():       # retirée de la liste sans être faite
            if title not in seen and row["status"] != "done":
                c.execute("UPDATE tasks SET status='dropped', updated=? WHERE id=?",
                          (now, row["id"]))
        sweep(now)
        c.commit()
    notify()


def add_task(project, title, cwd=None, priority=2, due=None, check=None):
    now = time.time()
    with _lock:
        c = db()
        pid = find_project(project) if project else project_for_cwd(cwd)
        if pid is None:
            if not project:
                raise ValueError("projet introuvable")
            pid = c.execute("INSERT INTO projects(name) VALUES(?)", (project,)).lastrowid
        dup = c.execute("SELECT id FROM tasks WHERE project_id=? AND lower(title)=lower(?) "
                        "AND status IN ('todo','doing')", (pid, title)).fetchone()
        if dup:
            tid = dup["id"]
        else:
            tid = c.execute("INSERT INTO tasks(project_id,title,source,created,updated,position,priority) "
                            "VALUES(?,?,?,?,?,?,?)", (pid, title, "note", now, now, 1000, valid_priority(priority))).lastrowid
        if due is not None or check is not None:
            set_due(c, tid, due, check)
        c.execute("UPDATE projects SET last_activity=?, archived=0 WHERE id=?", (now, pid))   # rouvre si terminé
        c.commit()
    notify()
    return tid


def valid_due(d):
    """'' ou None = pas d'échéance ; sinon 'AAAA-MM-JJ' ou 'AAAA-MM-JJTHH:MM'."""
    if not d:
        return None
    for fmt in ("%Y-%m-%d", "%Y-%m-%dT%H:%M"):
        try:
            return datetime.strptime(d, fmt).strftime(fmt)
        except ValueError:
            pass
    raise ValueError("échéance invalide (AAAA-MM-JJ ou AAAA-MM-JJTHH:MM)")


def set_due(c, tid, due=None, check=None):
    """Change l'échéance et/ou la vérif auto (chaîne vide = retirer) ; la vérif est replanifiée."""
    row = c.execute("SELECT due, check_cmd FROM tasks WHERE id=?", (tid,)).fetchone()
    due = valid_due(due) if due is not None else row["due"]
    cmd = (check.strip() or None) if check is not None else row["check_cmd"]
    if cmd and not due:
        raise ValueError("une vérif auto a besoin d'une échéance")
    at = (due if "T" in due else f"{due}T{CHECK_DEFAULT_TIME}") if cmd else None
    c.execute("UPDATE tasks SET due=?, check_cmd=?, check_at=?, check_state=?, check_out=NULL, check_ran=NULL "
              "WHERE id=?", (due, cmd, at, "wait" if cmd else None, tid))


def valid_priority(p):
    p = int(p if p is not None else 2)
    if p not in (1, 2, 3, 4):      # 1 basse, 2 normale, 3 haute, 4 urgente
        raise ValueError("priorité invalide (1 à 4)")
    return p


def update_task(tid, status=None, title=None, priority=None, due=None, check=None):
    now = time.time()
    with _lock:
        c = db()
        row = c.execute("SELECT * FROM tasks WHERE id=?", (tid,)).fetchone()
        if not row:
            raise ValueError("tâche inconnue")
        if status:
            if status not in ("todo", "doing", "done", "dropped"):
                raise ValueError("statut invalide")
            set_status(c, tid, status, now)
        if title:
            c.execute("UPDATE tasks SET title=? WHERE id=?", (title, tid))
        if priority is not None:
            c.execute("UPDATE tasks SET priority=? WHERE id=?", (valid_priority(priority), tid))
        if due is not None or check is not None:
            set_due(c, tid, due, check)
        c.execute("UPDATE projects SET last_activity=? WHERE id=?", (now, row["project_id"]))
        c.commit()
    notify()


def checks_due():
    """Vérifs auto arrivées à échéance (lues par `todo run-checks`, lancé chaque minute par un timer)."""
    now = datetime.now().strftime("%Y-%m-%dT%H:%M")
    with _lock:
        return [dict(r) for r in db().execute(
            "SELECT id, title, check_cmd FROM tasks WHERE check_cmd IS NOT NULL AND check_state='wait' "
            "AND check_at<=? AND status IN ('todo','doing') ORDER BY check_at", (now,))]


def check_result(tid, code, out):
    """0 = OK -> tâche faite ; 75 = pas encore -> nouvel essai dans 30 min (12 h max) ; autre = échec -> priorité haute."""
    now = time.time()
    with _lock:
        c = db()
        row = c.execute("SELECT * FROM tasks WHERE id=?", (tid,)).fetchone()
        if not row or not row["check_cmd"]:
            raise ValueError("tâche sans vérif auto")
        out = (out or "")[-2000:]
        start = datetime.strptime(row["due"] if "T" in row["due"] else f"{row['due']}T{CHECK_DEFAULT_TIME}",
                                  "%Y-%m-%dT%H:%M").timestamp()
        if code == 75 and now - start > CHECK_GIVE_UP:
            code, out = 1, f"toujours pas de résultat 12 h après l'échéance\n{out}"
        if code == 75:
            at = datetime.fromtimestamp(now + CHECK_RETRY).strftime("%Y-%m-%dT%H:%M")
            c.execute("UPDATE tasks SET check_at=?, check_out=?, check_ran=? WHERE id=?", (at, out, now, tid))
        else:
            c.execute("UPDATE tasks SET check_state=?, check_out=?, check_ran=? WHERE id=?",
                      ("ok" if code == 0 else "ko", out, now, tid))
            if code == 0:
                set_status(c, tid, "done", now)
            else:
                c.execute("UPDATE tasks SET priority=max(priority,3) WHERE id=?", (tid,))
        c.execute("UPDATE projects SET last_activity=? WHERE id=?", (now, row["project_id"]))
        c.commit()
    notify()


def project_ref(ref):
    if isinstance(ref, int) or str(ref).isdigit():
        r = db().execute("SELECT id FROM projects WHERE id=?", (int(ref),)).fetchone()
        return r["id"] if r else None
    return find_project(ref)


def project_op(name, op, arg=None):
    """create | rename | merge (dans arg) | close (= archive) | reopen (= unarchive) | link (dossier dans arg)."""
    with _lock:
        c = db()
        if op == "create":
            if c.execute("SELECT 1 FROM projects WHERE name=?", (name,)).fetchone():
                raise ValueError("ce projet existe déjà")
            c.execute("INSERT INTO projects(name, manual, last_activity) VALUES(?,1,?)",
                      (name, time.time()))
            c.commit()
            notify()
            return
        pid = project_ref(name)
        if pid is None:
            raise ValueError("projet introuvable ou ambigu")
        if op == "link":
            c.execute("INSERT OR REPLACE INTO paths VALUES(?,?)",
                      (os.path.normpath(os.path.expanduser(arg)), pid))
        elif op == "rename":
            if c.execute("SELECT 1 FROM projects WHERE name=? AND id!=?", (arg, pid)).fetchone():
                raise ValueError("ce nom existe déjà (utiliser merge)")
            c.execute("UPDATE projects SET name=?, manual=1 WHERE id=?", (arg, pid))
        elif op == "merge":
            dest = project_ref(arg)
            if dest is None or dest == pid:
                raise ValueError("projet cible introuvable")
            c.execute("UPDATE tasks SET project_id=? WHERE project_id=?", (dest, pid))
            c.execute("UPDATE paths SET project_id=? WHERE project_id=?", (dest, pid))
            c.execute("DELETE FROM projects WHERE id=?", (pid,))
        elif op in ("archive", "close", "unarchive", "reopen"):
            c.execute("UPDATE projects SET archived=? WHERE id=?", (op in ("archive", "close"), pid))
        else:
            raise ValueError("opération inconnue")
        c.commit()
    notify()


def move_task(tid, project_id=None, before_id=None):
    """Déplace une tâche (autre projet et/ou avant une autre tâche) et renumérote."""
    with _lock:
        c = db()
        row = c.execute("SELECT * FROM tasks WHERE id=?", (tid,)).fetchone()
        if not row:
            raise ValueError("tâche inconnue")
        pid = project_id or row["project_id"]
        if c.execute("SELECT 1 FROM projects WHERE id=?", (pid,)).fetchone() is None:
            raise ValueError("projet inconnu")
        ids = [r["id"] for r in c.execute(
            "SELECT id FROM tasks WHERE project_id=? AND status!='dropped' AND id!=? "
            "ORDER BY position, id", (pid, tid))]
        at = ids.index(before_id) if before_id in ids else len(ids)
        ids.insert(at, tid)
        c.execute("UPDATE tasks SET project_id=? WHERE id=?", (pid, tid))
        for i, t in enumerate(ids):
            c.execute("UPDATE tasks SET position=? WHERE id=?", (i * 10, t))
        c.commit()
    notify()


def order_projects(ids):
    with _lock:
        for i, pid in enumerate(ids):
            db().execute("UPDATE projects SET sort_order=? WHERE id=?", (i * 10, pid))
        db().commit()
    notify()


def state():
    now = time.time()
    with _lock:
        c = db()
        sweep(now)
        c.commit()
        out = []
        for p in c.execute("SELECT * FROM projects ORDER BY archived, sort_order, last_activity DESC"):
            tasks = [dict(r) for r in c.execute(
                "SELECT id,title,status,source,priority,created,updated,done_at,"
                "due,check_cmd,check_at,check_state,check_out,check_ran FROM tasks "
                "WHERE project_id=? AND status!='dropped' "
                "ORDER BY (status='done'), position, id", (p["id"],))]
            if not tasks and not p["manual"]:
                continue
            done = sum(t["status"] == "done" for t in tasks)
            active = int(p["last_activity"] > now - SESSION_ACTIVE)   # activité récente dans le projet
            out.append({"id": p["id"], "name": p["name"], "closed": bool(p["archived"]),
                        "percent": round(100 * done / len(tasks)) if tasks else 0,
                        "done": done, "total": len(tasks), "last_activity": p["last_activity"],
                        "active_sessions": active, "tasks": tasks})
    return {"now": now, "projects": out}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/state":
            return self._json(state())
        if self.path == "/api/checks/due":
            return self._json(checks_due())
        if self.path == "/events":
            q = queue.Queue(maxsize=8)
            _listeners.append(q)
            try:
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.end_headers()
                self.wfile.write(b"data: hello\n\n")
                self.wfile.flush()
                while True:
                    try:
                        q.get(timeout=20)
                        self.wfile.write(b"data: changed\n\n")
                    except queue.Empty:
                        self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionError, OSError):
                pass
            finally:
                _listeners.remove(q)
            return
        self._json({"error": "not found"}, 404)

    def do_POST(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
            d = json.loads(self.rfile.read(n) or b"{}")
            if self.path == "/api/sync":
                sync_session(d["session_id"], d.get("cwd"), d.get("todos") or [])
                return self._json({"ok": True})
            if self.path == "/api/task":
                return self._json({"id": add_task(d.get("project"), d["title"], d.get("cwd"), d.get("priority"),
                                                  d.get("due"), d.get("check"))})
            if self.path == "/api/projects/order":
                order_projects([int(i) for i in d["ids"]])
                return self._json({"ok": True})
            m = re.fullmatch(r"/api/task/(\d+)/move", self.path)
            if m:
                move_task(int(m[1]), d.get("project_id"), d.get("before_id"))
                return self._json({"ok": True})
            m = re.fullmatch(r"/api/task/(\d+)", self.path)
            if m:
                update_task(int(m[1]), d.get("status"), d.get("title"), d.get("priority"),
                            d.get("due"), d.get("check"))
                return self._json({"ok": True})
            m = re.fullmatch(r"/api/task/(\d+)/check", self.path)
            if m:
                check_result(int(m[1]), int(d["code"]), d.get("out"))
                return self._json({"ok": True})
            if self.path == "/api/project":
                project_op(d["name"], d["op"], d.get("arg"))
                return self._json({"ok": True})
            self._json({"error": "not found"}, 404)
        except (KeyError, ValueError, json.JSONDecodeError) as e:
            self._json({"error": str(e)}, 400)


def main():
    db()
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    srv.daemon_threads = True
    srv.serve_forever()


if __name__ == "__main__":
    main()
