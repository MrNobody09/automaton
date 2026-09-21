import { spawnSync, type ChildProcess } from "node:child_process";

/**
 * Terminate a spawned process together with descendants.
 *
 * POSIX callers must spawn the child with detached=true so the child becomes
 * process-group leader. Windows uses taskkill /T to walk the descendant tree.
 */
export function terminateProcessTree(child: ChildProcess): void {
  if (!child.pid) return;

  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }

  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // The process already exited.
    }
  }
}
