param([string]$Src, [switch]$Quiet)
# Installe le widget Todo Claude. Lancé par TodoClaude-Setup.exe depuis le paquet extrait dans %TEMP%.
# Dossier %LOCALAPPDATA%\TodoClaude, raccourcis Bureau + menu Démarrer, entrée « Applications installées » (HKCU).
# Une ancienne copie (zip extrait à la main) est arrêtée et son « Lancer avec Windows » reporté ici ; son dossier n'est pas touché.
# Les réglages (%APPDATA%\zyphro-todo-widget) sont gardés. -Quiet : sans fenêtre (tests automatiques).
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
function Say($m, $icon, $btn = 'OK') { if ($Quiet) { return 'No' }; [System.Windows.Forms.MessageBox]::Show($m, 'Todo Claude', $btn, $icon) }

$Dir = Join-Path $env:LOCALAPPDATA 'TodoClaude'
$exe = Join-Path $Dir 'TodoClaude.exe'
$root = $Dir + '\'
try {
  # 1) arrêter le widget (toute copie) et son tunnel SSH
  $old = @(Get-Process TodoClaude -ErrorAction SilentlyContinue | ForEach-Object { $_.Path } |
    Where-Object { $_ -and -not $_.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Split-Path $_ } | Select-Object -Unique)
  Get-Process TodoClaude -ErrorAction SilentlyContinue | Stop-Process -Force
  Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" | Where-Object { $_.CommandLine -like '*18765:127.0.0.1:*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 800

  # 2) remplacer le dossier d'installation (quelques essais : un antivirus peut garder un fichier ouvert)
  for ($i = 0; $i -lt 5 -and (Test-Path -LiteralPath $Dir); $i++) {
    Remove-Item -LiteralPath $Dir -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $Dir) { Start-Sleep -Seconds 1 }
  }
  if (Test-Path -LiteralPath $Dir) { throw "l'ancienne version est encore utilisée : $Dir" }
  Move-Item -LiteralPath $Src -Destination $Dir
  $ver = (Get-Content -Raw -Encoding UTF8 (Join-Path $Dir 'resources\app\package.json') | ConvertFrom-Json).version

  # 3) raccourcis
  $sh = New-Object -ComObject WScript.Shell
  $ico = Join-Path $Dir '_install\todo.ico'
  function Lnk($path, $target, $desc) {
    $l = $sh.CreateShortcut($path); $l.TargetPath = $target; $l.WorkingDirectory = $Dir; $l.IconLocation = $ico; $l.Description = $desc; $l.Save()
  }
  $menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Todo Claude'
  New-Item -ItemType Directory -Force $menu | Out-Null
  Lnk (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Todo Claude.lnk') $exe 'Todo Claude'
  Lnk (Join-Path $menu 'Todo Claude.lnk') $exe 'Todo Claude'
  Lnk (Join-Path $menu 'Désinstaller Todo Claude.lnk') (Join-Path $Dir '_install\uninstall.cmd') 'Désinstaller Todo Claude'

  # 4) entrée « Applications installées »
  $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\TodoClaude'
  New-Item -Path $key -Force | Out-Null
  $vals = @{ DisplayName = 'Todo Claude'; DisplayVersion = $ver; Publisher = 'Zyphro'; InstallLocation = $Dir; DisplayIcon = $ico
             UninstallString = "cmd /c `"`"$Dir\_install\uninstall.cmd`"`"" }
  foreach ($k in $vals.Keys) { Set-ItemProperty -Path $key -Name $k -Value $vals[$k] }
  foreach ($k in 'NoModify', 'NoRepair') { Set-ItemProperty -Path $key -Name $k -Value 1 -Type DWord }

  # 5) « Lancer avec Windows » d'une ancienne copie : vise désormais celle-ci
  $run = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
  $p = Get-ItemProperty -Path $run -ErrorAction SilentlyContinue
  if ($p) {
    foreach ($n in $p.PSObject.Properties.Name) {
      $v = [string]$p.$n
      if ($v -like '*TodoClaude.exe*' -and $v -notlike "*$exe*") {
        Set-ItemProperty -Path $run -Name $n -Value ($v -replace '"?[^"]*TodoClaude\.exe"?', "`"$exe`"")
      }
    }
  }
} catch {
  Say "L'installation a échoué :`n$($_.Exception.Message)" 'Error' | Out-Null
  exit 1
}

$m = "Todo Claude $ver est installé.`nRaccourcis sur le Bureau et dans le menu Démarrer ; désinstallation par « Applications installées » ou le menu Démarrer."
if ($old.Count) { $m += "`n`nL'ancienne copie n'est plus utilisée, vous pouvez supprimer son dossier :`n" + ($old -join "`n") }
if ((Say "$m`n`nLe lancer maintenant ?" 'Information' 'YesNo') -eq 'Yes') { Start-Process -FilePath $exe -WorkingDirectory $Dir }
exit 0
