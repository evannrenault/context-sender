import { execFile } from 'child_process';

/**
 * Met un ou plusieurs fichiers dans le presse-papiers « en tant que fichiers »
 * (comme un Ctrl+C dans l'explorateur Windows) : un Ctrl+V dans le chat les joint directement.
 * Retourne false si la plateforme ne le permet pas.
 */
export function copyFilesToClipboard(paths: string[]): Promise<boolean> {
  return new Promise(resolve => {
    if (!paths.length) { return resolve(false); }
    if (process.platform === 'win32') {
      const list = paths.map(p => `'${p.replace(/'/g, "''")}'`).join(',');
      execFile('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `Set-Clipboard -LiteralPath ${list}`],
        { windowsHide: true }, err => resolve(!err));
    } else if (process.platform === 'darwin') {
      const files = paths.map(p => `POSIX file "${p.replace(/"/g, '\\"')}"`).join(', ');
      execFile('osascript', ['-e', `set the clipboard to {${files}}`], err => resolve(!err));
    } else {
      resolve(false);
    }
  });
}
