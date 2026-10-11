import nodePath from "node:path";
import { homedir } from "node:os";

const ENV_REF = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;

/** Expands a leading `~` and `$VAR` / `${VAR}` references. A reference to an unset variable is
 *  left as written so preflight reports the path instead of launching in a silently shortened one. */
export function expandCwd(
  authored: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const tilded = authored === "~" || authored.startsWith("~/") ? home + authored.slice(1) : authored;
  return tilded.replace(ENV_REF, (ref, braced?: string, bare?: string) => env[braced ?? bare!] ?? ref);
}

export function resolveLaunchCwd(
  authoredCwd: string | null | undefined,
  specRoot: string,
  cwdOverride?: string | null,
): string {
  if (cwdOverride && cwdOverride.trim().length > 0) {
    return nodePath.resolve(cwdOverride);
  }
  if (!authoredCwd || authoredCwd.trim().length === 0) {
    return nodePath.resolve(specRoot);
  }
  const expanded = expandCwd(authoredCwd);
  return nodePath.isAbsolute(expanded)
    ? expanded
    : nodePath.resolve(specRoot, expanded);
}

export function getOpenRigInstallRoot(): string {
  return nodePath.resolve(import.meta.dirname, "../..");
}

export function isPathInsideRoot(candidatePath: string, rootPath: string): boolean {
  const relative = nodePath.relative(nodePath.resolve(rootPath), nodePath.resolve(candidatePath));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${nodePath.sep}`) && !nodePath.isAbsolute(relative));
}

export function getOpenRigInstallCwdError(
  resolvedCwd: string,
  cwdOverride?: string | null,
  installRoot: string = getOpenRigInstallRoot(),
): string | null {
  if (cwdOverride && cwdOverride.trim().length > 0) {
    return null;
  }
  if (!isPathInsideRoot(resolvedCwd, installRoot)) {
    return null;
  }
  return `Resolved cwd '${resolvedCwd}' is inside the OpenRig installation '${installRoot}', which is not a valid project workspace. Pass --cwd <path> to launch into your project directory.`;
}
