import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { HookContext, HookName, HookRunner } from "../../domain/ports/hook-runner.port.js";
import type { HookConfig, HookDefinition } from "../../domain/entities/hook-config.entity.js";
import { GitweError } from "../../domain/errors/index.js";
import { formatTarget } from "../../utils.js";

export interface HookRunnerOptions {
  root: string;
  config: HookConfig;
  verbose?: boolean;
}

/**
 * Runs configured hooks (typeOverrides → advanced → inline → filesystem scripts).
 *
 * Fixes vs previous version:
 * - `when` is evaluated for every definition (was never applied in the live path)
 * - dead / broken `getDefinition` removed
 * - script vs shell-command resolution uses existence on disk, not brittle prefixes
 * - parallel group failures are collected and rethrown unless continueOnError
 * - extra context keys are exported as GITWE_* env vars
 * - path is treated as the scripts directory only (not a yaml file path)
 */
export class FileHookRunner implements HookRunner {
  constructor(
    private readonly root: string,
    private readonly config: HookConfig,
    private readonly verbose: boolean = false,
  ) {}

  async run(name: HookName, context: HookContext): Promise<void> {
    if (!this.config.enabled) return;

    const definitions = this.getAllDefinitions(name, context);
    if (definitions.length === 0) return;

    const parallelGroup = definitions.filter((d) => d.parallel === true);
    const sequentialGroup = definitions.filter((d) => d.parallel !== true);

    // Parallel: run all, then fail if any hard failure occurred.
    if (parallelGroup.length > 0) {
      const settled = await Promise.allSettled(
        parallelGroup.map((def) => this.runDefinition(def, name, context)),
      );
      const hardFailures = settled.filter(
        (r): r is PromiseRejectedResult => r.status === "rejected",
      );
      if (hardFailures.length > 0) {
        const first = hardFailures[0]!.reason;
        throw first instanceof Error ? first : new GitweError("HOOK_FAILED", String(first));
      }
    }

    for (const def of sequentialGroup) {
      await this.runDefinition(def, name, context);
    }
  }

  async runDefinition(
    definition: HookDefinition,
    name: HookName,
    context: HookContext,
  ): Promise<void> {
    if (!this.config.enabled) return;

    const script = this.resolveScript(definition, name);
    if (!script) return;

    const env = this.buildEnv(context);
    const useStdin = definition.stdin === true;
    const stdin = useStdin ? this.buildStdin(context) : undefined;

    try {
      if (this.verbose) {
        console.error(`[gitwe] Running hook: ${name} (${script})`);
      }

      if (useStdin) {
        await this.runWithStdin(script, stdin, env, definition.continueOnError);
      } else if (this.isShellCommand(script)) {
        await this.runInline(script, env, definition.continueOnError);
      } else {
        await this.runScript(script, env, definition.continueOnError);
      }
    } catch (error) {
      if (definition.continueOnError) {
        console.warn(`[gitwe] Hook ${name} failed but continueOnError is true:`, error);
        return;
      }
      throw error;
    }
  }

  /**
   * Collect definitions from typeOverrides, advanced, inline, and filesystem.
   * Each entry is filtered by optional `when` before returning.
   */
  private getAllDefinitions(name: HookName, context: HookContext): HookDefinition[] {
    const definitions: HookDefinition[] = [];
    const type = context.branchType ?? context.type;

    if (type && this.config.typeOverrides?.[type]) {
      const typeHook = this.config.typeOverrides[type]?.[name];
      if (typeHook) {
        definitions.push(typeof typeHook === "string" ? { script: typeHook } : typeHook);
      }
    }

    const advanced = this.config.advanced?.[name];
    if (advanced) {
      definitions.push(advanced);
    }

    const inline = this.config.inline?.[name];
    if (inline) {
      definitions.push({ script: inline });
    }

    const scriptsDir = this.scriptsDirectory();
    const scriptPath = join(scriptsDir, name);
    if (existsSync(scriptPath)) {
      definitions.push({ script: scriptPath });
    }

    // Deduplicate by script path/command while preserving first-seen order
    // (typeOverrides first → advanced → inline → file).
    const unique = new Map<string, HookDefinition>();
    for (const def of definitions) {
      const key = def.script;
      if (!unique.has(key)) {
        unique.set(key, def);
      }
    }

    return Array.from(unique.values()).filter((d) => !d.when || this.evaluateWhen(d.when, context));
  }

  /** Directory that holds executable hook scripts (never a YAML file path). */
  private scriptsDirectory(): string {
    const raw = this.config.path || ".gitwe/hooks";
    // Tolerate legacy values that pointed at a yaml file or "a | b" docs typos.
    if (raw.endsWith(".yaml") || raw.endsWith(".yml") || raw.includes("|")) {
      return join(this.root, ".gitwe/hooks");
    }
    return isAbsolute(raw) ? raw : join(this.root, raw);
  }

  private resolveScript(definition: HookDefinition, name: HookName): string | null {
    if (definition.script) {
      const s = definition.script;
      if (this.isShellCommand(s)) return s;
      if (isAbsolute(s)) return existsSync(s) ? s : null;
      const abs = join(this.root, s);
      if (existsSync(abs)) return abs;
      // Relative path that does not exist — still return it so shell can try
      // (e.g. PATH binaries used as "script" by mistake); prefer null for clarity.
      return existsSync(s) ? s : abs;
    }

    const fallback = join(this.scriptsDirectory(), name);
    return existsSync(fallback) ? fallback : null;
  }

  /**
   * Treat as a shell one-liner when it looks like a command, not a filesystem path.
   * Paths: no spaces (or only as part of a real existing path), or start with ./ /
   * Commands: contain shell metacharacters / spaces and do not exist as a file.
   */
  private isShellCommand(script: string): boolean {
    if (existsSync(script) || existsSync(join(this.root, script))) {
      return false;
    }
    // Common inline patterns and anything with spaces / metacharacters
    if (/[\s|&;<>$`]/.test(script)) return true;
    if (/^(echo|npm|npx|node|bash|sh|curl|wget)\b/.test(script)) return true;
    return false;
  }

  private buildEnv(context: HookContext): NodeJS.ProcessEnv {
    const env: Record<string, string> = {};

    if (context.branch) env.GITWE_BRANCH = context.branch;
    if (context.config) env.GITWE_CONFIG = context.config;
    if (context.branchType) env.GITWE_TYPE = context.branchType;
    else if (context.type) env.GITWE_TYPE = context.type;
    if (context.base) env.GITWE_BASE = context.base;
    if (context.target !== undefined) {
      env.GITWE_TARGET = formatTarget(context.target);
    }
    if (context.dryRun !== undefined) env.GITWE_DRY_RUN = String(context.dryRun);
    if (context.force !== undefined) env.GITWE_FORCE = String(context.force);
    if (context.tagName) env.GITWE_TAG_NAME = context.tagName;
    if (context.oldName) env.GITWE_OLD_NAME = context.oldName;
    if (context.newName) env.GITWE_NEW_NAME = context.newName;
    if (context.remote) env.GITWE_REMOTE = context.remote;
    env.GITWE_OPERATION = context.operation;

    // Surface common extra keys used by sample scripts
    const extra = context.extra ?? {};
    if (extra.deleted !== undefined) env.GITWE_BRANCH_DELETED = String(extra.deleted);
    if (extra.mergedInto !== undefined) {
      env.GITWE_MERGED_INTO = Array.isArray(extra.mergedInto)
        ? extra.mergedInto.join(",")
        : String(extra.mergedInto);
    }
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined || v === null) continue;
      const key = `GITWE_${k.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()}`;
      if (!(key in env)) {
        env[key] = Array.isArray(v) ? v.join(",") : String(v);
      }
    }

    return { ...process.env, ...env };
  }

  private buildStdin(context: HookContext): string {
    return JSON.stringify({
      operation: context.operation,
      branch: context.branch,
      type: context.branchType ?? context.type,
      base: context.base,
      target: context.target,
      dryRun: context.dryRun,
      force: context.force,
      tagName: context.tagName,
      oldName: context.oldName,
      newName: context.newName,
      remote: context.remote,
      extra: context.extra ?? {},
    });
  }

  private async runScript(
    script: string,
    env: NodeJS.ProcessEnv,
    continueOnError?: boolean,
  ): Promise<void> {
    try {
      const { stdout, stderr } = spawn(script, [], {
        cwd: this.root,
        env,
        shell: true,
      });
      if (this.verbose) {
        if (stdout) console.error(stdout);
        if (stderr) console.error(stderr);
      }
    } catch (error: unknown) {
      this.handleExecError(error, script, continueOnError);
    }
  }

  private async runInline(
    command: string,
    env: NodeJS.ProcessEnv,
    continueOnError?: boolean,
  ): Promise<void> {
    try {
      const { stdout, stderr } = spawn(command, {
        cwd: this.root,
        env,
        shell: true,
      });
      if (this.verbose) {
        if (stdout) console.error(stdout);
        if (stderr) console.error(stderr);
      }
    } catch (error: unknown) {
      this.handleExecError(error, command, continueOnError);
    }
  }

  private async runWithStdin(
    script: string,
    stdin: string | undefined,
    env: NodeJS.ProcessEnv,
    continueOnError?: boolean,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(script, [], {
        cwd: this.root,
        env,
        shell: true,
        stdio: ["pipe", "pipe", "pipe"],
      });

      if (stdin) {
        child.stdin?.write(stdin);
        child.stdin?.end();
      }

      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (data: Buffer | string) => {
        stdout += data.toString();
      });
      child.stderr?.on("data", (data: Buffer | string) => {
        stderr += data.toString();
      });

      child.on("close", (code) => {
        if (this.verbose) {
          if (stdout) console.error(stdout);
          if (stderr) console.error(stderr);
        }

        if (stdout) {
          try {
            const result = JSON.parse(stdout) as { continue?: boolean; message?: string };
            if (result.continue === false) {
              reject(
                new GitweError(
                  "HOOK_BLOCKED",
                  `Hook "${script}" blocked the operation: ${result.message || "no reason given"}`,
                ),
              );
              return;
            }
          } catch {
            // stdout is not JSON — ignore
          }
        }

        if (code === 0) {
          resolve();
          return;
        }
        if (code === 2 && continueOnError) {
          console.warn(`[gitwe] Hook warning (exit code 2): ${stderr || stdout}`);
          resolve();
          return;
        }
        if (continueOnError) {
          console.warn(`[gitwe] Hook failed (exit ${code}) but continueOnError is true`);
          resolve();
          return;
        }
        reject(new GitweError("HOOK_FAILED", `Hook "${script}" failed with code ${code}`));
      });

      child.on("error", reject);
    });
  }

  private handleExecError(error: unknown, label: string, continueOnError?: boolean): void {
    const err = error as { code?: number | string; message?: string };
    const code = typeof err.code === "number" ? err.code : 1;
    const message = err.message ?? String(error);

    if (code === 2 && continueOnError) {
      console.warn(`[gitwe] Hook warning (exit code 2): ${message}`);
      return;
    }
    if (code !== 0 && continueOnError) {
      console.warn(`[gitwe] Hook failed but continueOnError is true: ${message}`);
      return;
    }
    if (code !== 0) {
      throw new GitweError("HOOK_FAILED", `Hook "${label}" exited with code ${code}: ${message}`);
    }
  }

  /**
   * Safe-ish predicate evaluator for `when` strings.
   * Supports:
   *   type == 'release'
   *   target == 'main'
   *   tagName == 'v1.0.0'
   *   branch == 'feature/x'
   *   type != 'hotfix'
   *   tagName =~ '^v[0-9]'   (converted to JS RegExp test)
   *
   * Does not execute arbitrary JS beyond a constrained expression rewrite.
   */
  private evaluateWhen(condition: string, context: HookContext): boolean {
    if (!condition || !condition.trim()) return true;

    const type = context.branchType ?? context.type ?? "";
    const target = formatTarget(context.target);
    const tagName = context.tagName ?? "";
    const branch = context.branch ?? "";

    // Regex form: field =~ 'pattern' or field =~ "pattern"
    const regexMatch = condition.match(/^\s*(type|target|tagName|branch)\s*=~\s*['"](.+?)['"]\s*$/);
    if (regexMatch) {
      const field = regexMatch[1]!;
      const pattern = regexMatch[2]!;
      const value =
        field === "type"
          ? type
          : field === "target"
            ? target
            : field === "tagName"
              ? tagName
              : branch;
      try {
        return new RegExp(pattern).test(value);
      } catch {
        return false;
      }
    }

    // Equality / inequality: field == 'value' | field != "value"
    const cmpMatch = condition.match(
      /^\s*(type|target|tagName|branch)\s*(==|!=)\s*['"](.*?)['"]\s*$/,
    );
    if (cmpMatch) {
      const field = cmpMatch[1]!;
      const op = cmpMatch[2]!;
      const expected = cmpMatch[3]!;
      const value =
        field === "type"
          ? type
          : field === "target"
            ? target
            : field === "tagName"
              ? tagName
              : branch;
      return op === "==" ? value === expected : value !== expected;
    }

    // Fallback: very constrained rewrite (same fields only, no free identifiers)
    const expr = condition
      .replace(/\btype\b/g, JSON.stringify(type))
      .replace(/\btarget\b/g, JSON.stringify(target))
      .replace(/\btagName\b/g, JSON.stringify(tagName))
      .replace(/\bbranch\b/g, JSON.stringify(branch));

    // Block anything that still looks like a free identifier or call
    if (
      /[a-zA-Z_$][a-zA-Z0-9_$]*\s*\(/.test(expr) ||
      /\b(process|require|global|Function)\b/.test(expr)
    ) {
      return false;
    }

    try {
      // eslint-disable-next-line no-new-func
      const fn = new Function(`return !!(${expr});`);
      return Boolean(fn());
    } catch {
      return false;
    }
  }
}
