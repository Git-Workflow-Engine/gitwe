import { Command } from "commander";
import { loadEngine, action } from "./shared.js";
import { ValidationError } from "../../domain/errors/index.js";
import { style } from "../output.js";

type SyncOpts = { rebase: boolean; all: boolean };

interface BranchSyncResult {
  branch: string;
  ok: boolean;
  pulled: boolean;
  updated: boolean;
  upstream: string | null;
  error?: string;
}

/**
 * Fetch remotes, integrate upstream, then (for topic branches) update from the workflow base.
 *
 *   gitwe sync              → current branch (topic: remote+parent; base: remote only)
 *   gitwe sync --all        → every configured topic branch
 *   gitwe sync --rebase     → use rebase instead of merge
 */
export function syncCommand(): Command {
  return new Command("sync")
    .description(
      "fetch remote and integrate upstream; on topic branches also update from workflow base (use --all for every topic)",
    )
    .option("--rebase", "use rebase instead of merge for both integrations", false)
    .option("--all", "sync every configured topic branch", false)
    .action(
      action(async function (this: Command, out) {
        const engine = await loadEngine(this);
        const opts = this.opts<SyncOpts>();
        const git = engine["deps"].git;

        // 1. Fetch remotes once
        const fetchRemotes = engine.workflow.fetchRemotes();
        const fetched: string[] = [];
        for (const remote of fetchRemotes) {
          if (await git.remoteExists(remote)) {
            await git.fetch(remote);
            fetched.push(remote);
          }
        }

        if (opts.all) {
          const results = await syncAllTopicBranches(engine, git, opts.rebase);
          const okCount = results.filter((r) => r.ok).length;
          const failCount = results.length - okCount;

          out.ok({
            data: {
              all: true,
              rebase: opts.rebase,
              fetched,
              results,
              ok: okCount,
              failed: failCount,
            },
            message:
              failCount === 0
                ? `synced ${okCount} topic branch(es)`
                : `synced ${okCount} topic branch(es), ${failCount} failed`,
            details: [
              ...(fetched.length ? [style.dim(`fetched: ${fetched.join(", ")}`)] : []),
              ...results.map((r) =>
                r.ok
                  ? style.dim(`✓ ${r.branch}`)
                  : `${style.bold(r.branch)}  ${style.dim(r.error ?? "failed")}`,
              ),
            ],
          });
          return;
        }

        // ---- single-branch path ------------------------------------------
        const branch = await git.currentBranch();
        if (!branch) {
          throw new ValidationError(
            "no branch is currently checked out",
            "check out a branch before running `gitwe sync`",
          );
        }

        const resolved = engine.workflow.resolveBranch(branch);
        const isBase = engine.workflow.isBaseBranch(branch);

        // 2. Integrate upstream (topic and base branches alike)
        const { pulled, upstream } = await integrateUpstream(git, branch, opts.rebase);

        // 3. Topic only: update from workflow base (parent)
        if (resolved) {
          await engine.update(branch, { rebase: opts.rebase, fetch: false });
          out.ok({
            data: {
              branch,
              kind: "topic",
              rebase: opts.rebase,
              fetched,
              pulled,
              updated: true,
            },
            message: `synced ${branch} (remote + parent)`,
            details: [
              ...(fetched.length ? [style.dim(`fetched: ${fetched.join(", ")}`)] : []),
              ...(pulled && upstream ? [style.dim(`merged/rebased from ${upstream}`)] : []),
              style.dim(`updated from base ${resolved.type.base}`),
            ],
          });
          return;
        }

        // Base branch: fetch + upstream only (same idea as `gitwe pull`)
        if (isBase) {
          out.ok({
            data: {
              branch,
              kind: "base",
              rebase: opts.rebase,
              fetched,
              pulled,
              updated: false,
            },
            message: pulled
              ? `synced base branch ${branch} from ${upstream}`
              : `fetched remotes for base branch ${branch}` +
                (upstream ? "" : " — no upstream set"),
            details: [
              ...(fetched.length ? [style.dim(`fetched: ${fetched.join(", ")}`)] : []),
              ...(pulled && upstream ? [style.dim(`merged/rebased from ${upstream}`)] : []),
              ...(!pulled
                ? [
                    style.dim("set upstream with: git branch -u <remote>/" + branch),
                    style.dim("parent update is only applied on topic branches"),
                  ]
                : [style.dim("parent update is only applied on topic branches")]),
            ],
          });
          return;
        }

        // Neither topic nor base
        throw new ValidationError(
          `"${branch}" is not a configured topic or base branch`,
          "check out a workflow branch, or use `gitwe sync --all` for every topic branch",
        );
      }),
    );
}

/** Pull/rebase from the branch's upstream tracking ref, if any. */
async function integrateUpstream(
  git: {
    upstreamOf(branch: string): Promise<string | undefined>;
    rebase(onto: string): Promise<void>;
    merge(branch: string): Promise<void>;
  },
  branch: string,
  rebase: boolean,
): Promise<{ pulled: boolean; upstream: string | null }> {
  const upstream = (await git.upstreamOf(branch)) ?? null;
  if (!upstream) return { pulled: false, upstream: null };

  if (rebase) {
    await git.rebase(upstream);
  } else {
    await git.merge(upstream);
  }
  return { pulled: true, upstream };
}

/**
 * Sync every topic branch returned by `engine.list()`.
 * Restores the originally checked-out branch when finished (best-effort).
 */
async function syncAllTopicBranches(
  engine: Awaited<ReturnType<typeof loadEngine>>,
  git: {
    currentBranch(): Promise<string | undefined>;
    checkout(branch: string): Promise<void>;
    upstreamOf(branch: string): Promise<string | undefined>;
    rebase(onto: string): Promise<void>;
    merge(branch: string): Promise<void>;
  },
  rebase: boolean,
): Promise<BranchSyncResult[]> {
  const original = await git.currentBranch();
  const topics = await engine.list();
  const results: BranchSyncResult[] = [];

  for (const topic of topics) {
    const branch = topic.branch;
    try {
      await git.checkout(branch);
      const { pulled, upstream } = await integrateUpstream(git, branch, rebase);
      await engine.update(branch, { rebase, fetch: false });
      results.push({
        branch,
        ok: true,
        pulled,
        updated: true,
        upstream,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        branch,
        ok: false,
        pulled: false,
        updated: false,
        upstream: null,
        error: message,
      });
    }
  }

  if (original) {
    try {
      await git.checkout(original);
    } catch {
      // leave HEAD where the last successful checkout was
    }
  }

  return results;
}
