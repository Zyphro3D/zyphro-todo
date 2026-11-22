# zyphro-todo

Todo centrale alimentée par Claude Code, affichée dans un widget Windows. Un serveur Linux garde les tâches ; le widget s'y connecte par un tunnel SSH.

- `hub/hub.py` : service sur le serveur (`todo-hub.service`, user systemd), 127.0.0.1:8765, SQLite `~/.local/share/todo-hub/todo.db`.
- `bin/todo-hook.py` : hook `PostToolUse` sur `TodoWrite` (réglé dans `~/.claude/settings.json`), pousse la liste de la session.
- `bin/todo` : CLI (`todo add "…" -p projet`, `list`, `cal`, `due`, `check`, `done|doing|reopen|drop ID`, `project rename|merge|archive`), lien dans `~/.local/bin`. `todo --help` détaille les dates.
- `widget/` : appli Electron (fenêtre flottante, tray, tunnel SSH `-L 18765:127.0.0.1:8765` vers l'alias SSH `todo-server`). Config : `%APPDATA%\zyphro-todo-widget\config.json` (`sshHost`, `sshKey`).
- `build.py` : assemble `dist/TodoClaude-Setup.exe` (installateur) et `dist/TodoClaude-win.zip` (paquet portable) : Electron win32 de `build/electron.zip` + `widget/`, stub `installer/setup.c` compilé avec zig (`TODO_CC_PY` : un python qui a `ziglang` et `Pillow`).
- `installer/` : installation sans droits admin dans `%LOCALAPPDATA%\TodoClaude`, raccourcis Bureau + menu Démarrer, entrée « Applications installées » ; une ancienne copie est arrêtée et son « Lancer avec Windows » reporté. Désinstallation par « Applications installées » ou le menu Démarrer (réglages gardés sauf case cochée).

Projets : un dossier de travail est rattaché au projet de plus long préfixe, créé au besoin (nom du dossier). Une tâche faite disparaît du widget après 7 jours ; d'ici là, le bouton « ✓ Faites » la masque ou l'affiche (masquée par défaut depuis la 0.2.1, choix mémorisé, compteurs inchangés). Une tâche retirée d'un TodoWrite sans être faite est abandonnée ; une tâche ouverte de même titre dans le projet est reprise (une note devient la tâche de la session).

## Échéances et vérifs auto

Une tâche peut avoir une échéance (`--due demain --at 7:00`) : badge J-x gris, orange le jour même, rouge une fois dépassée ; bouton 📅 du widget pour la vue calendrier, 📅 au survol d'une tâche pour la dater. Le widget affiche une bulle Windows à l'échéance (9 h sans heure) et au résultat d'une vérif.

Vérif auto (`--check "commande"`) : à l'échéance, `todo run-checks` (timer `todo-checks`, chaque minute, hors sandbox) lance la commande sur le serveur. Code 0 = tâche cochée ; 75 = pas encore, nouvel essai 30 min plus tard, échec au bout de 12 h ; autre = échec, priorité haute, sortie visible au survol du ✗ (clic = relancer). Le hub stocke la commande mais n'exécute jamais rien.

Installation du timer :

    cp systemd/todo-checks.* ~/.config/systemd/user/ && systemctl --user daemon-reload && systemctl --user enable --now todo-checks.timer

## Licence

[PolyForm Noncommercial 1.0.0](LICENSE.md) : usage personnel, étude et modification libres ; usage commercial interdit.
