#!/usr/bin/env python3
"""Hook PostToolUse(TodoWrite) : pousse la todo de la session vers todo-hub.
Ne casse jamais Claude Code : timeout court, toute erreur est ignorée."""
import json, sys, urllib.request

try:
    d = json.load(sys.stdin)
    todos = (d.get("tool_input") or {}).get("todos")
    if todos is not None:
        body = json.dumps({"session_id": d.get("session_id", "?"), "cwd": d.get("cwd"),
                           "todos": todos}).encode()
        req = urllib.request.Request("http://127.0.0.1:8765/api/sync", body,
                                     {"Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=2).read()
except Exception:
    pass
