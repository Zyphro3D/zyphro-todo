@echo off
rem Desinstalle Todo Claude. La logique est dans uninstall.ps1, copie dans %TEMP% et lance de la-bas
rem pour pouvoir supprimer le dossier d'installation.
set "TC=%~dp0.."
set "T=%TEMP%\todoclaude-uninstall-%RANDOM%.ps1"
copy /y "%~dp0uninstall.ps1" "%T%" >nul || ( echo uninstall.ps1 introuvable & pause & exit /b 1 )
cd /d "%TEMP%"
start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%T%" -Dir "%TC%" %*
