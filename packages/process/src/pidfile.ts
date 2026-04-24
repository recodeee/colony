import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

/**
 * Write the current (or caller-provided) pid to a file. Overwrites any stale
 * content; callers are responsible for deciding whether it is safe to do so.
 */
export function writePidFile(path: string, pid: number = process.pid): void {
  writeFileSync(path, String(pid));
}

/**
 * Read the pid from a pidfile. Returns null when the file is missing, empty,
 * or contains a non-numeric / non-positive value. Does not probe liveness —
 * pair with {@link isAlive} when you need to know the pid is still valid.
 */
export function readPidFile(path: string): number | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8').trim();
    if (!raw) return null;
    const pid = Number(raw);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Remove a pidfile silently. No-op if it is already gone. */
export function removePidFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}
