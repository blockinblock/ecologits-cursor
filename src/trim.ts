import * as fs from 'fs';

export const MAX_ENTRIES = 100;

/** Keep only the last `max` non-empty lines of a text file. */
export function trimFile(filePath: string, max: number = MAX_ENTRIES): void {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split('\n').filter(l => l.trim() !== '');
    if (lines.length <= max) return;
    fs.writeFileSync(filePath, lines.slice(-max).join('\n') + '\n', 'utf8');
  } catch { /* missing file or race with another window — ignore */ }
}

/** Append a line to a file, then trim it to the last `max` entries. */
export function appendAndTrim(filePath: string, line: string, max: number = MAX_ENTRIES): void {
  fs.appendFileSync(filePath, line, 'utf8');
  trimFile(filePath, max);
}
