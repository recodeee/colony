/**
 * Best-effort liveness probe for a pid. Uses `process.kill(pid, 0)` which
 * sends no signal but throws ESRCH when the pid does not exist. Returns
 * false on any error so callers do not need to differentiate.
 */
export function isAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
