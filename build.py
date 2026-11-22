#!/usr/bin/env python3
"""Assemble le widget Windows, sans compilation de l'appli : Electron (zip officiel) + dossier widget/ dans resources/app.
  dist/TodoClaude-win.zip    paquet portable (dossier racine TodoClaude/, scripts d'installation dans _install/)
  dist/TodoClaude-Setup.exe  installateur : stub C (installer/setup.c, compilé avec zig) + paquet collé à la fin
Compilateur : TODO_CC_PY (python avec les paquets ziglang et Pillow), python3 par défaut."""
import json, os, shutil, struct, subprocess, tempfile, zipfile
from pathlib import Path

ROOT = Path(__file__).parent
ELECTRON = ROOT / "build/electron.zip"
APP = ["package.json", "main.js", "preload.js", "index.html", "renderer.js", "icon.png"]
CC_PY = os.environ.get("TODO_CC_PY", "python3")
VERSION = json.loads((ROOT / "widget/package.json").read_text())["version"]
DIST = ROOT / "dist"
DIST.mkdir(exist_ok=True)
work = Path(tempfile.mkdtemp(prefix="todo-build-"))

# icône .ico (raccourcis, désinstallation, installateur) depuis widget/icon.png
subprocess.run([CC_PY, "-c", "import sys; from PIL import Image; Image.open(sys.argv[1]).convert('RGBA').save(sys.argv[2], "
                "sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)])", ROOT / "widget/icon.png", work / "todo.ico"], check=True)


def windows_text(path, bom):
    """Fins de ligne CRLF ; BOM UTF-8 pour PowerShell 5, qui lit sinon les accents en ANSI."""
    t = path.read_text().replace("\r\n", "\n").replace("\n", "\r\n")
    return ("﻿" + t).encode("utf-8") if bom else t.encode("ascii")


pkg = DIST / "TodoClaude-win.zip"
with zipfile.ZipFile(ELECTRON) as src, zipfile.ZipFile(pkg, "w", zipfile.ZIP_DEFLATED) as dst:
    for i in src.infolist():
        if i.filename.startswith("resources/default_app") or i.is_dir():
            continue
        name = "TodoClaude.exe" if i.filename == "electron.exe" else i.filename
        dst.writestr("TodoClaude/" + name, src.read(i))
    for f in APP:
        dst.write(ROOT / "widget" / f, f"TodoClaude/resources/app/{f}")
    for f in ("install.ps1", "uninstall.ps1"):
        dst.writestr(f"TodoClaude/_install/{f}", windows_text(ROOT / "installer" / f, bom=True))
    dst.writestr("TodoClaude/_install/uninstall.cmd", windows_text(ROOT / "installer/uninstall.cmd", bom=False))
    dst.write(work / "todo.ico", "TodoClaude/_install/todo.ico")

(work / "setup.rc").write_text('1 ICON "todo.ico"\n')
stub = work / "stub.exe"
subprocess.run([CC_PY, "-m", "ziglang", "cc", "-target", "x86_64-windows-gnu", "-O2", "-s", "-Wl,--subsystem,windows",
                "-municode", f'-DTC_VERSION=L"{VERSION}"', str(ROOT / "installer/setup.c"), str(work / "setup.rc"),
                "-lshell32", "-luser32", "-o", str(stub)], check=True, cwd=work)
setup = DIST / "TodoClaude-Setup.exe"
with open(setup, "wb") as o:
    o.write(stub.read_bytes())
    with open(pkg, "rb") as f:
        shutil.copyfileobj(f, o, 1 << 20)
    o.write(struct.pack("<q", pkg.stat().st_size) + b"TODOSET1")
shutil.rmtree(work)
for f in (pkg, setup):
    print(f, round(f.stat().st_size / 1e6), "Mo")
