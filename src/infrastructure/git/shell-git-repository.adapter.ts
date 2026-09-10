import { existsSync } from "node:fs";
import { join } from "node:path";
import { ConflictError, GitCommandError } from "../../domain/errors/index.js";
import type {
  AheadBehind,
  GitRepository,
  MergeOptions,
  PushOptions,
  TagOptions,
} from "../../domain/ports/git-repository.port.js";
import { runProcess } from "./process-runner.js";

export interface ShellGitOptions {
  readonly cwd: string;
  /** Optional tracer for every git argv (CLI `--verbose`). */
  readonly trace?: ((args: string[]) => void) | undefined;
}

/**
 * Real {@link GitRepository}: shells out to the `git` binary on PATH.
 *
 * Conflict-aware: merge/rebase failures that leave the repo in a conflict
 * state throw {@link ConflictError} so finish can persist and resume.
 * Version bumping and package.json I/O do **not** belong here — use
 * {@link VersionCalculatorService} and application use cases.
 */
export class ShellGitRepository implements GitRepository {
  readonly cwd: string;
  private readonly trace?: ((args: string[]) => void) | undefined;

  constructor(cwdOrOptions: string | ShellGitOptions) {
    if (typeof cwdOrOptions === "string") {
      this.cwd = cwdOrOptions;
    } else {
      this.cwd = cwdOrOptions.cwd;
      this.trace = cwdOrOptions.trace;
    }
  }

  private async exec(
    args: string[],
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    this.trace?.(args);
    return runProcess("git", args, { cwd: this.cwd });
  }

  /** Run git; throw ConflictError or GitCommandError on failure. */
  private async run(args: string[]): Promise<string> {
    const result = await this.exec(args);
    if (result.exitCode === 0) {
      return result.stdout.trim();
    }

    const conflicts = await this.conflictedFiles();
    const mergeActive = await this.mergeInProgress();
    const rebaseActive = await this.rebaseInProgress();
    const looksLikeConflict =
      result.exitCode === 2 ||
      mergeActive ||
      rebaseActive ||
      conflicts.length > 0 ||
      /conflict/i.test(result.stderr);

    if (looksLikeConflict) {
      throw new ConflictError(
        conflicts.length > 0
          ? `git ${args[0]} stopped on conflicts in: ${conflicts.join(", ")}`
          : `git ${args[0]} stopped on a conflict`,
        conflicts,
      );
    }

    throw new GitCommandError(
      `git ${args.join(" ")} failed with exit code ${result.exitCode}`,
      result.stderr.trim() || undefined,
    );
  }

  private async ok(args: string[]): Promise<boolean> {
    const result = await this.exec(args);
    return result.exitCode === 0;
  }

  private async gitDir(): Promise<string> {
    const result = await this.exec(["rev-parse", "--absolute-git-dir"]);
    if (result.exitCode !== 0) {
      throw new GitCommandError("not a git repository", result.stderr.trim() || undefined);
    }
    return result.stdout.trim();
  }

  async rebaseInProgress(): Promise<boolean> {
    try {
      const dir = await this.gitDir();
      return existsSync(join(dir, "rebase-merge")) || existsSync(join(dir, "rebase-apply"));
    } catch {
      return false;
    }
  }

  async currentBranch(): Promise<string | undefined> {
    const result = await this.exec(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (result.exitCode !== 0) return undefined;
    const branch = result.stdout.trim();
    return branch === "" ? undefined : branch;
  }

  /**
   * List local branch names matching `pattern` (git glob relative to refs/heads).
   *
   * IMPORTANT: in `git for-each-ref`, `*` does NOT match `/`. So `refs/heads/*`
   * only returns top-level branches (main, develop) and misses `feature/foo`.
   * That made `gitwe list` return empty while `gitwe overview` still counted
   * topic branches via patterns like `feature/*`.
   *
   * - `*` / empty  → walk the whole `refs/heads` namespace
   * - `feature/*`  → walk `refs/heads/feature` (all nested names under that prefix)
   * - anything else → pass through as a single for-each-ref pattern
   */
  async listBranches(pattern = "*"): Promise<string[]> {
    const ref =
      !pattern || pattern === "*"
        ? "refs/heads"
        : pattern.endsWith("/*")
          ? `refs/heads/${pattern.slice(0, -2)}`
          : `refs/heads/${pattern}`;

    const out = await this.run(["for-each-ref", "--format=%(refname:short)", ref]);
    const names = out.length ? out.split("\n").filter(Boolean) : [];

    // For "feature/*" we walked the namespace; keep only names under that prefix.
    if (pattern && pattern !== "*" && pattern.endsWith("/*")) {
      const prefix = pattern.slice(0, -1); // "feature/"
      return names.filter((n) => n.startsWith(prefix) && n.length > prefix.length);
    }
    return names;
  }

  async branchExists(branch: string): Promise<boolean> {
    return this.ok(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  }

  async remoteBranchExists(remote: string, branch: string): Promise<boolean> {
    return this.ok(["show-ref", "--verify", "--quiet", `refs/remotes/${remote}/${branch}`]);
  }

  async upstreamOf(branch: string): Promise<string | undefined> {
    const result = await this.exec([
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      `${branch}@{upstream}`,
    ]);
    if (result.exitCode !== 0) return undefined;
    const upstream = result.stdout.trim();
    return upstream === "" ? undefined : upstream;
  }

  async aheadBehind(ref: string, base: string): Promise<AheadBehind> {
    // left = base, right = ref  →  behind, ahead  (matches common "how far is ref from base")
    const out = await this.run(["rev-list", "--left-right", "--count", `${base}...${ref}`]);
    const [behind = "0", ahead = "0"] = out.split(/\s+/);
    return { ahead: Number(ahead) || 0, behind: Number(behind) || 0 };
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    return this.ok(["merge-base", "--is-ancestor", ancestor, descendant]);
  }

  /** Only tracked changes block operations; untracked files are ignored. */
  async isClean(): Promise<boolean> {
    const out = await this.run(["status", "--porcelain", "--untracked-files=no"]);
    return out.length === 0;
  }

  async conflictedFiles(): Promise<string[]> {
    const result = await this.exec(["diff", "--name-only", "--diff-filter=U"]);
    if (result.exitCode !== 0) return [];
    const out = result.stdout.trim();
    return out.length ? out.split("\n") : [];
  }

  async mergeInProgress(): Promise<boolean> {
    try {
      const dir = await this.gitDir();
      return existsSync(join(dir, "MERGE_HEAD"));
    } catch {
      return false;
    }
  }

  async createBranch(branch: string, startPoint: string): Promise<void> {
    await this.run(["branch", branch, startPoint]);
  }

  async checkout(branch: string): Promise<void> {
    await this.run(["checkout", branch]);
  }

  async deleteBranch(branch: string, force = false): Promise<void> {
    await this.run(["branch", force ? "-D" : "-d", branch]);
  }

  async deleteRemoteBranch(remote: string, branch: string): Promise<void> {
    await this.run(["push", remote, "--delete", branch]);
  }

  async renameBranch(from: string, to: string): Promise<void> {
    await this.run(["branch", "-m", from, to]);
  }

  async merge(branch: string, options: MergeOptions = {}): Promise<void> {
    const args = ["merge"];
    if (options.squash) {
      args.push("--squash");
    } else if (options.noFastForward) {
      args.push("--no-ff");
    }
    if (options.message) args.push("-m", options.message);
    args.push(branch);
    await this.run(args);
  }

  async continueMerge(): Promise<void> {
    await this.run(["merge", "--continue"]);
  }

  async abortMerge(): Promise<void> {
    await this.exec(["merge", "--abort"]);
  }

  async rebase(onto: string): Promise<void> {
    await this.run(["rebase", onto]);
  }

  async createTag(name: string, options: TagOptions = {}): Promise<void> {
    const args = ["tag"];
    if (options.annotated ?? true) {
      args.push("-a");
      if (options.message) args.push("-m", options.message);
      else args.push("-m", name);
    }
    if (options.sign) {
      args.push("--sign");
      if (options.signingKey) args.push("--local-user", options.signingKey);
    }
    args.push(name);
    await this.run(args);
  }

  async tagExists(name: string): Promise<boolean> {
    return this.ok(["show-ref", "--verify", "--quiet", `refs/tags/${name}`]);
  }

  async fetch(remote: string, refspec?: string): Promise<void> {
    const args = ["fetch", remote];
    if (refspec) args.push(refspec);
    await this.run(args);
  }

  async push(remote: string, branch: string, options: PushOptions = {}): Promise<void> {
    const args = ["push"];
    if (options.setUpstream) args.push("--set-upstream");
    if (options.force) args.push("--force");
    if (options.forceWithLease) args.push("--force-with-lease");
    if (options.followTags) args.push("--follow-tags");
    if (options.delete) {
      args.push("--delete", remote, branch);
    } else {
      args.push(remote, branch);
    }
    await this.run(args);
  }

  async remoteExists(remote: string): Promise<boolean> {
    const out = await this.run(["remote"]);
    return out.split("\n").includes(remote);
  }

  async setUpstream(branch: string, remote: string): Promise<void> {
    await this.run(["branch", "--set-upstream-to", `${remote}/${branch}`, branch]);
  }

  async listTags(pattern?: string): Promise<string[]> {
    const args = ["tag", "--list"];
    if (pattern) args.push(pattern);
    const out = await this.run(args);
    return out.length ? out.split("\n") : [];
  }

  async deleteTag(name: string): Promise<void> {
    await this.run(["tag", "-d", name]);
  }

  async pushTags(remote: string, pattern?: string): Promise<void> {
    const args = ["push", remote];
    if (pattern) {
      args.push("--tags", pattern);
    } else {
      args.push("--tags");
    }
    await this.run(args);
  }

  async deleteRemoteTag(remote: string, name: string): Promise<void> {
    await this.run(["push", remote, "--delete", name]);
  }

  async raw(args: string[]): Promise<string> {
    return this.run(args);
  }

  async graph(root?: string): Promise<string> {
    const args = ["log", "--graph", "--oneline", "--decorate"];
    if (root) {
      args.push(root);
    } else {
      args.push("--all");
    }
    return this.run(args);
  }
}
