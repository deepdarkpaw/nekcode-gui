import type { NekReloadResult } from "@zcode/shared/nek-protocol";
import { targetPaths } from "./paths.js";
import type { ReloadChange, ReloadTrigger } from "./reloadAnnouncements.js";
import type { NekConfigSessionHandle, NekReloadOutcome } from "./runtime.js";

type ReloadRequest = { modelsOnly: boolean; trigger: ReloadTrigger };
const priority = { write: 0, login: 1, manual: 2 } as const;

export function emptyReloadOutcome(trigger?: ReloadTrigger): NekReloadOutcome {
  return {
    ...(trigger ? { trigger } : {}),
    reloaded: 0,
    deferred: 0,
    diagnostics: [],
    failures: [],
  };
}

/** Match each captured live lease once, preserving narrower full reloads within global model edits. */
export async function reloadLiveSessions(options: {
  agentDir: string;
  changes: readonly ReloadChange[];
  current(): boolean;
  sessions(): NekConfigSessionHandle[];
  control?: (modelsOnly: boolean) => Promise<NekReloadResult | undefined>;
  direct?: NekReloadOutcome;
}): Promise<NekReloadOutcome[]> {
  const { agentDir, changes, current, direct } = options;
  const outcomes = new Map<ReloadTrigger, NekReloadOutcome>();
  const outcomeFor = (trigger: ReloadTrigger) => {
    if (direct) return direct;
    const outcome = outcomes.get(trigger) ?? emptyReloadOutcome(trigger);
    outcomes.set(trigger, outcome);
    return outcome;
  };
  const assertCurrent = () => {
    if (!current())
      throw new Error("nek configuration target changed or disconnected; retry Reload");
  };
  try {
    const scopes = reloadScopes(agentDir, changes);
    assertCurrent();
    for (const session of options.sessions()) {
      assertCurrent();
      if (session.isLive?.() === false) continue;
      const cwd = session.cwd && workspaceKey(agentDir, session.cwd);
      const request = mergeReload(scopes.get(undefined), cwd ? scopes.get(cwd) : undefined);
      if (!request) continue;
      await reloadOne(
        outcomeFor(request.trigger),
        session.sessionKey,
        () =>
          request.modelsOnly && session.refreshModels
            ? session.refreshModels()
            : session.call({ type: "reload" }),
        { busy: session.busy },
      );
    }
    const control = direct?.trigger === "manual" ? { modelsOnly: false } : scopes.get(undefined);
    if (options.control && control) {
      assertCurrent();
      const call = options.control;
      await reloadOne(outcomeFor(direct?.trigger ?? "write"), "control", () =>
        call(control.modelsOnly),
      );
    }
  } catch (error) {
    const trigger = changes[0]?.trigger;
    if (trigger) pushFailure(outcomeFor(trigger), "runtime", error);
  }
  return [...outcomes.values()];
}

async function reloadOne(
  outcome: NekReloadOutcome,
  label: string,
  call: () => Promise<(NekReloadResult & { changed?: boolean }) | undefined>,
  task?: { busy: boolean },
): Promise<void> {
  try {
    const result = await call();
    if (!result) return;
    outcome.diagnostics.push(...result.diagnostics);
    const errors = result.diagnostics.filter(({ severity }) => severity === "error");
    if (errors.length) throw new Error(errors.map(({ message }) => message).join("; "));
    if (!task) {
      if (result.deferred) throw new Error("nek control reload was deferred; retry Reload");
      return;
    }
    if (result.deferred || task.busy) outcome.deferred += 1;
    else if (result.changed !== false) outcome.reloaded += 1;
  } catch (error) {
    pushFailure(outcome, label, error);
  }
}

function pushFailure(outcome: NekReloadOutcome, sessionKey: string, error: unknown): void {
  outcome.failures.push({
    sessionKey,
    message: error instanceof Error ? error.message : String(error),
  });
}

export function reloadChangesForWrite(
  agentDir: string,
  files: ReadonlyArray<{ path: string }>,
  scope?: { cwd?: string },
): ReloadChange[] {
  const paths = targetPaths(agentDir);
  const workspaces = new Map<string | undefined, Set<string>>();
  for (const { path } of files) {
    const file = targetPath(agentDir, path);
    const cwd = scope ? scope.cwd : workspaceOfWrite(agentDir, file);
    const key = cwd === undefined ? undefined : workspaceKey(agentDir, cwd);
    const names = workspaces.get(key) ?? new Set<string>();
    names.add(paths.basename(file));
    workspaces.set(key, names);
  }
  return [...workspaces].map(([cwd, names]) => ({ trigger: "write", cwd, files: [...names] }));
}

function targetPath(agentDir: string, path: string): string {
  const paths = targetPaths(agentDir);
  // Some settings paths are assembled on Windows before being sent to a POSIX executor.
  return paths.normalize(
    process.platform === "win32" && paths.sep === "/" ? path.replaceAll("\\", "/") : path,
  );
}

function workspaceKey(agentDir: string, cwd: string): string {
  const paths = targetPaths(agentDir);
  const path = targetPath(agentDir, cwd);
  const key =
    path !== paths.parse(path).root && path.endsWith(paths.sep) ? path.slice(0, -1) : path;
  return paths.sep === "\\" ? key.toLowerCase() : key;
}

/** Global writes affect all sessions; project files affect only their owning workspace. */
function workspaceOfWrite(agentDir: string, file: string): string | undefined {
  const paths = targetPaths(agentDir);
  const path = paths.relative(agentDir, file);
  if (path !== ".." && !path.startsWith(`..${paths.sep}`) && !paths.isAbsolute(path))
    return undefined;
  let directory = paths.dirname(file);
  while (paths.dirname(directory) !== directory) {
    if (paths.basename(directory) === ".nek") return paths.dirname(directory);
    directory = paths.dirname(directory);
  }
  return paths.dirname(file);
}

function mergeReload(left?: ReloadRequest, right?: ReloadRequest): ReloadRequest | undefined {
  if (!left || !right) return left ?? right;
  return {
    modelsOnly: left.modelsOnly && right.modelsOnly,
    trigger: priority[left.trigger] >= priority[right.trigger] ? left.trigger : right.trigger,
  };
}

function reloadScopes(
  agentDir: string,
  changes: readonly ReloadChange[],
): Map<string | undefined, ReloadRequest> {
  const scopes = new Map<string | undefined, ReloadRequest>();
  for (const { cwd, files, trigger } of changes) {
    const key = cwd === undefined ? undefined : workspaceKey(agentDir, cwd);
    const request = {
      trigger,
      modelsOnly:
        trigger === "write" && files.length > 0 && files.every((file) => file === "models.json"),
    };
    scopes.set(key, mergeReload(scopes.get(key), request)!);
  }
  return scopes;
}
