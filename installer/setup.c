/* TodoClaude-Setup.exe : installateur du widget, sans droits administrateur (même principe que ZCoach-Setup).
   Le paquet (zip, dossier racine TodoClaude\) est collé à la fin de l'exécutable : [stub][zip][taille zip 8 o]["TODOSET1" 8 o].
   Le stub confirme, extrait le paquet dans %TEMP% (tar.exe, Windows 10/11) et lance TodoClaude\_install\install.ps1,
   qui fait le reste (dossier, raccourcis, « Applications installées »). /S : sans fenêtre (tests). */
#include <windows.h>
#include <shellapi.h>
#include <stdio.h>
#include <wchar.h>
#ifndef TC_VERSION
#define TC_VERSION L"0"
#endif
static int quiet = 0;
static int say(const wchar_t *m, UINT fl) { if (quiet) return IDOK; return MessageBoxW(NULL, m, L"Todo Claude", fl | MB_SETFOREGROUND); }
static int run(wchar_t *cmd, DWORD *code) {
  STARTUPINFOW si = {sizeof si}; PROCESS_INFORMATION pi; si.dwFlags = STARTF_USESHOWWINDOW; si.wShowWindow = SW_HIDE;
  if (!CreateProcessW(NULL, cmd, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, NULL, &si, &pi)) return 0;
  WaitForSingleObject(pi.hProcess, INFINITE); GetExitCodeProcess(pi.hProcess, code); CloseHandle(pi.hProcess); CloseHandle(pi.hThread); return 1;
}
int WINAPI wWinMain(HINSTANCE h, HINSTANCE p, LPWSTR c, int n) {
  wchar_t self[MAX_PATH * 2], tmp[MAX_PATH], work[MAX_PATH * 2], zip[MAX_PATH * 2], cmd[MAX_PATH * 6], msg[1024];
  quiet = (wcsstr(c, L"/S") != NULL || wcsstr(c, L"/s") != NULL);
  GetModuleFileNameW(NULL, self, MAX_PATH * 2);
  HANDLE f = CreateFileW(self, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
  if (f == INVALID_HANDLE_VALUE) { say(L"Impossible de lire l'installateur.", MB_ICONERROR); return 1; }
  LARGE_INTEGER sz; GetFileSizeEx(f, &sz); char tr[16]; DWORD got; LARGE_INTEGER o; o.QuadPart = sz.QuadPart - 16;
  SetFilePointerEx(f, o, NULL, FILE_BEGIN); ReadFile(f, tr, 16, &got, NULL);
  if (got != 16 || memcmp(tr + 8, "TODOSET1", 8)) { say(L"Installateur incomplet ou corrompu : refaites la copie.", MB_ICONERROR); return 1; }
  long long zs = *(long long *)tr;
  swprintf(msg, 1024, L"Installer Todo Claude %ls ?\n\nDossier : %%LOCALAPPDATA%%\\TodoClaude\nRaccourcis sur le Bureau et dans le menu Démarrer, désinstallation par « Applications installées ».\nAucun droit administrateur n'est nécessaire. Vos réglages sont gardés.", TC_VERSION);
  if (say(msg, MB_OKCANCEL | MB_ICONQUESTION) != IDOK) return 0;
  /* extraction dans un dossier temporaire */
  GetTempPathW(MAX_PATH, tmp);
  swprintf(work, MAX_PATH * 2, L"%lstodoclaude-setup-%lu", tmp, GetCurrentProcessId());
  swprintf(zip, MAX_PATH * 2, L"%ls.zip", work);
  CreateDirectoryW(work, NULL);
  HANDLE w = CreateFileW(zip, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_TEMPORARY, NULL);
  if (w == INVALID_HANDLE_VALUE) { say(L"Impossible d'écrire dans le dossier temporaire.", MB_ICONERROR); return 1; }
  o.QuadPart = sz.QuadPart - 16 - zs; SetFilePointerEx(f, o, NULL, FILE_BEGIN);
  static char buf[1 << 20]; long long left = zs;
  while (left > 0) {
    DWORD want = left > (long long)sizeof buf ? sizeof buf : (DWORD)left, wr;
    if (!ReadFile(f, buf, want, &got, NULL) || got == 0 || !WriteFile(w, buf, got, &wr, NULL) || wr != got) {
      CloseHandle(w); DeleteFileW(zip); say(L"Écriture impossible (disque plein ?).", MB_ICONERROR); return 1; }
    left -= got;
  }
  CloseHandle(w); CloseHandle(f);
  DWORD rc = 0;
  swprintf(cmd, MAX_PATH * 6, L"tar -xf \"%ls\" -C \"%ls\"", zip, work);
  int ok = run(cmd, &rc); DeleteFileW(zip);
  wchar_t chk[MAX_PATH * 2]; swprintf(chk, MAX_PATH * 2, L"%ls\\TodoClaude\\_install\\install.ps1", work);
  if (!ok || rc != 0 || GetFileAttributesW(chk) == INVALID_FILE_ATTRIBUTES) {
    say(L"L'extraction a échoué (Windows 10 ou 11 requis).", MB_ICONERROR); return 1; }
  /* le script fait le reste et affiche lui-même le résultat */
  swprintf(cmd, MAX_PATH * 6, L"powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"%ls\" -Src \"%ls\\TodoClaude\"%ls",
           chk, work, quiet ? L" -Quiet" : L"");
  ok = run(cmd, &rc);
  swprintf(cmd, MAX_PATH * 6, L"cmd /c rmdir /s /q \"%ls\"", work); DWORD r2; run(cmd, &r2);
  if (!ok) { say(L"PowerShell est introuvable.", MB_ICONERROR); return 1; }
  return (int)rc;
}
