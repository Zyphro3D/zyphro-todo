param([string]$Dir, [switch]$Quiet, [switch]$RemoveData)
# Désinstalle Todo Claude. Lancé par _install\uninstall.cmd, depuis une copie dans %TEMP% (pour pouvoir supprimer le dossier d'installation).
# Une case propose de supprimer aussi les réglages (%APPDATA%\zyphro-todo-widget), décochée par défaut.
# Les tâches vivent sur le serveur : jamais touchées. -Quiet [-RemoveData] : sans fenêtre (tests automatiques).
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
Set-Location $env:TEMP
function Say($m, $icon) { if (-not $Quiet) { [void][System.Windows.Forms.MessageBox]::Show($m, 'Todo Claude', 'OK', $icon) } }

$data = Join-Path $env:APPDATA 'zyphro-todo-widget'

# garde-fou : on ne supprime qu'un vrai dossier d'installation du widget
$Dir = [IO.Path]::GetFullPath($Dir).TrimEnd('\')
if (-not $Dir -or -not (Test-Path (Join-Path $Dir 'TodoClaude.exe')) -or -not (Test-Path (Join-Path $Dir 'resources\app\main.js'))) {
  Say "Dossier d'installation de Todo Claude introuvable :`n$Dir`n`nRien n'a été supprimé." 'Error'
  Remove-Item -LiteralPath $PSCommandPath -Force
  exit 1
}

if (-not $Quiet) {
  $f = New-Object System.Windows.Forms.Form
  $f.Text = 'Désinstaller Todo Claude'
  $f.FormBorderStyle = 'FixedDialog'; $f.MaximizeBox = $false; $f.MinimizeBox = $false; $f.StartPosition = 'CenterScreen'; $f.TopMost = $true
  $f.Font = New-Object System.Drawing.Font('Segoe UI', 9.5); $f.ClientSize = New-Object System.Drawing.Size(480, 210); $f.AutoScaleMode = 'Font'
  $ico = Join-Path $Dir '_install\todo.ico'; if (Test-Path $ico) { $f.Icon = New-Object System.Drawing.Icon($ico) }
  $l = New-Object System.Windows.Forms.Label
  $l.Text = "Le widget Todo Claude va être retiré de ce PC : programme, raccourcis, lancement avec Windows et entrée dans « Applications installées ».`n`nLes tâches restent sur le serveur."
  $l.SetBounds(16, 14, 448, 70)
  $c = New-Object System.Windows.Forms.CheckBox
  $c.Text = 'Supprimer aussi les réglages (position de la fenêtre, connexion SSH, rappels déjà vus)'
  $c.SetBounds(16, 96, 448, 40); $c.Enabled = (Test-Path $data)
  $ok = New-Object System.Windows.Forms.Button; $ok.Text = 'Désinstaller'; $ok.SetBounds(264, 166, 100, 30); $ok.DialogResult = 'OK'
  $no = New-Object System.Windows.Forms.Button; $no.Text = 'Annuler'; $no.SetBounds(372, 166, 92, 30); $no.DialogResult = 'Cancel'
  $f.Controls.AddRange(@($l, $c, $ok, $no)); $f.AcceptButton = $no; $f.CancelButton = $no
  if ($f.ShowDialog() -ne 'OK') { Remove-Item -LiteralPath $PSCommandPath -Force; exit 0 }
  $RemoveData = $c.Checked
}

# 1) arrêter le widget lancé depuis ce dossier, et son tunnel SSH
$root = $Dir + '\'
Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) } | Stop-Process -Force
Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" | Where-Object { $_.CommandLine -like '*18765:127.0.0.1:*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Milliseconds 1000

# 2) raccourcis, lancement avec Windows et entrée « Applications installées », seulement s'ils désignent CETTE installation
$sh = New-Object -ComObject WScript.Shell
$desk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Todo Claude.lnk'
if ((Test-Path $desk) -and $sh.CreateShortcut($desk).TargetPath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $desk -Force }
$menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Todo Claude'
$mine = Join-Path $menu 'Todo Claude.lnk'
if ((Test-Path $mine) -and $sh.CreateShortcut($mine).TargetPath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $menu -Recurse -Force }
$run = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$p = Get-ItemProperty -Path $run
if ($p) { foreach ($n in $p.PSObject.Properties.Name) { if (([string]$p.$n).IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0) { Remove-ItemProperty -Path $run -Name $n -Force } } }
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\TodoClaude'
$loc = (Get-ItemProperty -Path $key -Name InstallLocation).InstallLocation
if ($loc -and ([IO.Path]::GetFullPath($loc).TrimEnd('\') -ieq $Dir)) { Remove-Item -Path $key -Recurse -Force }

# 3) dossier d'installation (quelques essais : un antivirus peut garder un fichier ouvert quelques secondes)
for ($i = 0; $i -lt 6 -and (Test-Path -LiteralPath $Dir); $i++) {
  Remove-Item -LiteralPath $Dir -Recurse -Force
  if (Test-Path -LiteralPath $Dir) { Start-Sleep -Seconds 1 }
}

# 4) réglages, sur demande seulement
if ($RemoveData -and (Test-Path -LiteralPath $data)) { Remove-Item -LiteralPath $data -Recurse -Force }

$left = @(); if (Test-Path -LiteralPath $Dir) { $left += $Dir }; if ($RemoveData -and (Test-Path -LiteralPath $data)) { $left += $data }
if ($left.Count) {
  Say ("Todo Claude est désinstallé, mais ces dossiers n'ont pas pu être entièrement supprimés (un fichier est encore ouvert). Redémarrez le PC puis supprimez-les à la main :`n`n" + ($left -join "`n")) 'Warning'
} else {
  Say 'Todo Claude est désinstallé.' 'Information'
}
Remove-Item -LiteralPath $PSCommandPath -Force
if ($left.Count) { exit 2 } else { exit 0 }
