import {
  ConflictError,
  GitCommandError,
  OperationInProgressError,
  ValidationError,
} from "../../domain/errors/index.js";
import type { WorkflowService } from "../../domain/services/workflow.service.js";
import {
  SemVer,
  VersionCalculatorService,
} from "../../domain/services/version-calculator.service.js";
import { BranchVersionResolverService } from "../../domain/services/branch-version-resolver.service.js";
import { VersionTargetsService } from "../../domain/services/version-targets.service.js";
import {
  ChangelogGeneratorService,
  DEFAULT_CHANGELOG_LINE_TEMPLATE,
  type ChangelogCommit,
} from "../../domain/services/changelog-generator.service.js";
import type { VersioningConfig } from "../../domain/entities/versioning-config.entity.js";
import type { ChangelogConfig } from "../../domain/entities/changelog-config.entity.js";
import type {
  GitRepository,
  PushOptions,
  TagOptions,
} from "../../domain/ports/git-repository.port.js";
import type { HookRunner } from "../../domain/ports/hook-runner.port.js";
import type { Logger } from "../../domain/ports/logger.port.js";
import type {
  OperationState,
  OperationStateStore,
} from "../../domain/ports/operation-state-store.port.js";
import type { VersionPrompter } from "../../domain/ports/version-prompter.port.js";
import { noopVersionPrompter } from "../../domain/ports/version-prompter.port.js";
import { omitUndefined } from "../../utils.js";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import yaml from "js-yaml";


export interface FinishBranchInput {
  readonly branch: string;
  readonly squash?: boolean;
  readonly push?: boolean;
  readonly currentVersion?: string;
  // جدید
  readonly rebase?: boolean;
  readonly noFF?: boolean;
  readonly mergeMessage?: string;
  readonly squashMessage?: string;
  readonly tag?: boolean;
  readonly noTag?: boolean;
  readonly tagname?: string;
  readonly tagMessage?: string;
  readonly signTag?: boolean;
  readonly signingKey?: string;
  readonly keep?: boolean;
  readonly keepRemote?: boolean;
  readonly forceDelete?: boolean;
  readonly force?: boolean;
  readonly fetch?: boolean;
  readonly bump?: "major" | "minor" | "patch";
}

export type FinishAction =
  | { readonly kind: "continue" }
  | { readonly kind: "abort" }
  | ({ readonly kind: "start" } & FinishBranchInput);

export interface FinishResult {
  readonly branch: string;
  readonly mergedInto: readonly string[];
  readonly tag?: string;
  readonly deleted: boolean;
}

interface FinishStateData {
  readonly branch: string;
  readonly typeName: string;
  readonly targets: readonly string[];
  readonly mergedInto: string[];
  readonly squash: boolean;
  readonly push: boolean;
  readonly tag?: string | undefined;
  readonly currentVersion?: string | undefined;
  /**
   * When `versioning.branchVersion` resolved a version from the branch name
   * AND `overrideBumpRules` is true, this holds that version verbatim; the
   * final tag/target version is used as-is, skipping the bumpRules math.
   */
  readonly branchVersionFinal?: string | undefined;
  readonly rebase: boolean;
  readonly noFF: boolean;
  readonly mergeMessage?: string | undefined;
  readonly squashMessage?: string | undefined;
  readonly tagOverride?: boolean | undefined; // true = create, false = skip
  readonly noTag?: boolean | undefined;
  readonly tagname?: string | undefined;
  readonly tagMessage?: string | undefined;
  readonly signTag?: boolean | undefined;
  readonly signingKey?: string | undefined;
  readonly keep: boolean; // true = keep local branch
  readonly keepRemote: boolean; // true = keep remote branch
  readonly forceDelete: boolean;
  readonly force: boolean; // skip remote sync check
  readonly fetch: boolean; // fetch before finishing
  readonly bump?: "major" | "minor" | "patch" | undefined;
}

const OPERATION = "finish";

/**
 * Merges a topic branch into every configured target, tags it if the
 * workflow requires it, then deletes it. Modeled as an explicit,
 * resumable state machine: if a merge conflict stops the process, the
 * remaining steps are persisted via {@link OperationStateStore} and
 * can be resumed with `{ kind: "continue" }` or cancelled with
 * `{ kind: "abort" }` — even from a brand-new process.
 */
export class FinishBranchUseCase {
  private readonly versions = new VersionCalculatorService();
  private readonly branchVersionResolver = new BranchVersionResolverService();
  private readonly versionTargets = new VersionTargetsService();
  private readonly changelogGenerator = new ChangelogGeneratorService();

  constructor(
    private readonly workflow: WorkflowService,
    private readonly git: GitRepository,
    private readonly hooks: HookRunner,
    private readonly logger: Logger,
    private readonly stateStore: OperationStateStore,
    private readonly prompter: VersionPrompter = noopVersionPrompter,
  ) {}

  /**
   * Best-effort discovery of the "current version" to bump from, used when
   * the caller doesn't pass --current-version explicitly. Scans existing
   * git tags matching `${tagPrefix}X.Y.Z` and returns the highest stable
   * (non-prerelease) one found, without the prefix. Returns undefined if no
   * matching tag exists yet (e.g. this is the very first release), in which
   * case the caller must fall back to something else.
   */
  private async discoverCurrentVersion(tagPrefix: string): Promise<string | undefined> {
    const tags = await this.git.listTags();
    let best: SemVer | undefined;
    let bestRaw: string | undefined;

    for (const tag of tags) {
      if (!tag.startsWith(tagPrefix)) continue;
      const withoutPrefix = tag.slice(tagPrefix.length);

      let parsed: SemVer;
      try {
        parsed = this.versions.parse(withoutPrefix);
      } catch {
        continue; // not a semver tag (e.g. an unrelated tag) — skip it
      }
      if (parsed.prerelease) continue; // only stable releases count as the "current" baseline

      const isNewer =
        !best ||
        parsed.major > best.major ||
        (parsed.major === best.major && parsed.minor > best.minor) ||
        (parsed.major === best.major && parsed.minor === best.minor && parsed.patch > best.patch);

      if (isNewer) {
        best = parsed;
        bestRaw = withoutPrefix;
      }
    }

    return bestRaw;
  }

  /**
   * Walks `versioning.tagSource` (default `["branch", "tag"]`) in order and
   * returns the first strategy that resolves a version, or `undefined` if
   * none do (the caller then falls back to `versioning.currentVersion` /
   * a timestamp, same as before this existed).
   */
  private async resolveCurrentVersion(
    branchName: string,
    versioning: VersioningConfig,
  ): Promise<{ version: string; final: boolean } | undefined> {
    const sources = versioning.tagSource ?? ["branch", "tag"];
    const tagPrefix = versioning.tagPrefix ?? "v";

    for (const source of sources) {
      switch (source) {
        case "branch": {
          const branchVersionCfg = versioning.branchVersion;
          if (!branchVersionCfg?.patterns?.length) break;
          const resolution = this.branchVersionResolver.resolve(
            branchName,
            branchVersionCfg,
            tagPrefix,
          );
          if (resolution) {
            return { version: resolution.version, final: branchVersionCfg.overrideBumpRules === true };
          }
          break;
        }
        case "config": {
          const version = await this.readVersionFromFile(versioning);
          if (version) return { version, final: false };
          break;
        }
        case "tag": {
          const version = await this.discoverCurrentVersion(tagPrefix);
          if (version) return { version, final: false };
          break;
        }
        case "manual": {
          if (!this.prompter.isAvailable()) break;
          const answer = await this.prompter.promptVersion(
            "Enter the current version to bump from",
            versioning.currentVersion,
          );
          if (!answer) break;
          try {
            this.versions.parse(answer);
          } catch {
            throw new ValidationError(`"${answer}" is not a valid semantic version`);
          }
          return { version: answer, final: false };
        }
        case "error":
          throw new ValidationError(
            `could not determine the current version from any configured "versioning.tagSource" (${sources.join(", ")})`,
            `pass --current-version explicitly, or add "manual"/adjust versioning.tagSource in your config`,
          );
      }
    }
    return undefined;
  }

  /** Reads `currentVersion` out of `.gitwe/version.yaml` (or `versioning.config`), if present and valid. */
  private async readVersionFromFile(versioning: VersioningConfig): Promise<string | undefined> {
    const versionFilePath = join(this.git.cwd, versioning.config ?? ".gitwe/version.yaml");
    let raw: string;
    try {
      raw = await readFile(versionFilePath, "utf8");
    } catch {
      return undefined; // file doesn't exist (yet) — not an error, just nothing to read
    }

    const parsed = yaml.load(raw) as Record<string, unknown> | undefined;
    const value = parsed?.["currentVersion"];
    if (typeof value !== "string") return undefined;

    try {
      this.versions.parse(value);
    } catch {
      return undefined; // not a valid semver — treat as "nothing found", try the next source
    }
    return value;
  }

  async execute(action: FinishAction): Promise<FinishResult> {
    if (action.kind === "abort") return this.abort();
    if (action.kind === "continue") return this.resume();
    return this.start(action);
  }

  // ---- entry points --------------------------------------------------------

  private async start(input: FinishBranchInput): Promise<FinishResult> {
    if (await this.stateStore.exists()) {
      throw new OperationInProgressError(OPERATION);
    }

    const resolved = this.workflow.resolveBranch(input.branch);
    if (!resolved) {
      throw new ValidationError(`"${input.branch}" is not a recognised topic branch`);
    }
    if (!(await this.git.branchExists(resolved.branch))) {
      throw new ValidationError(`branch "${resolved.branch}" does not exist`);
    }

    // تعیین مقادیر پیش‌فرض
    const squash = input.squash ?? this.workflow.allowsSquash(resolved.type);
    const rebase = input.rebase ?? false;
    const noFF = input.noFF ?? false;
    const mergeMessage = input.mergeMessage;
    const squashMessage = input.squashMessage;
    const tagOverride = input.tag;
    const noTag = input.noTag ?? false;
    const tagname = input.tagname;
    const tagMessage = input.tagMessage;
    const signTag = input.signTag ?? false;
    const signingKey = input.signingKey;
    const keep = input.keep ?? !this.workflow.shouldDeleteOnFinish(resolved.type);
    const keepRemote = input.keepRemote ?? true; // default: keep remote branch
    const forceDelete = input.forceDelete ?? false;
    const force = input.force ?? false;
    const fetch = input.fetch ?? true; // default: fetch
    const bump = input.bump;

    // ---- Determine the "current version" baseline (or final override) ----
    let currentVersion = input.currentVersion;
    let branchVersionFinal: string | undefined;
    const versioningCfg = this.workflow.config.versioning;
    const willTag = tagOverride ?? this.workflow.shouldTagForFinish(resolved.type, resolved.type.target);

    if (versioningCfg?.enabled && willTag && !input.currentVersion) {
      const resolution = await this.resolveCurrentVersion(resolved.branch, versioningCfg);
      if (resolution) {
        if (resolution.final) {
          branchVersionFinal = resolution.version;
        } else {
          currentVersion = resolution.version;
        }
      }
    }

    const state: FinishStateData = {
      branch: resolved.branch,
      typeName: resolved.type.name,
      targets: resolved.type.target,
      mergedInto: [],
      squash,
      push: input.push ?? false,
      currentVersion,
      branchVersionFinal,
      rebase,
      noFF,
      mergeMessage,
      squashMessage,
      tagOverride,
      noTag,
      tagname,
      tagMessage,
      signTag,
      signingKey,
      keep,
      keepRemote,
      forceDelete,
      force,
      fetch,
      bump,
    };

    await this.hooks.run("pre-finish", {
      operation: "pre-finish",
      branch: state.branch,
      branchType: state.typeName,
      target: state.targets as string[],
      dryRun: false,
      force: state.force,
      extra: { squash: state.squash, push: state.push, keep: state.keep },
    });
    return this.runFrom(state);
  }

  private async resume(): Promise<FinishResult> {
    const persisted = await this.stateStore.read();
    if (!persisted || persisted.operation !== OPERATION) {
      throw new ValidationError("no finish operation is in progress");
    }
    if (await this.git.mergeInProgress()) {
      const conflicts = await this.git.conflictedFiles();
      if (conflicts.length > 0) {
        throw new ConflictError(
          `${conflicts.length} file(s) still have unresolved conflicts`,
          conflicts,
        );
      }
      const target = persisted.data["pendingTarget"] as string;
      await this.git.continueMerge();
      this.logger.info(`resumed merge into ${target}`);
    }
    return this.runFrom(persisted.data as unknown as FinishStateData, persisted.completedSteps);
  }

  private async abort(): Promise<FinishResult> {
    if (await this.git.mergeInProgress()) {
      await this.git.abortMerge();
    }
    await this.stateStore.clear();
    return { branch: "", mergedInto: [], deleted: false };
  }

  // ---- state machine --------------------------------------------------------
  private async runFrom(
    state: FinishStateData,
    completed: readonly string[] = [],
  ): Promise<FinishResult> {
    const done = new Set(completed);
    const type = this.workflow.requireBranchType(state.typeName);

    // ---- Fetch (if enabled) ------------------------------------------------
    if (state.fetch && !done.has("fetch")) {
      const fetchRemotes = this.workflow.fetchRemotesFor(type);
      for (const remote of fetchRemotes) {
        await this.git.fetch(remote);
      }
      done.add("fetch");
    }

    // ---- Remote sync check (unless --force) --------------------------------
    if (!state.force && !done.has("remote-sync")) {
      const upstream = await this.git.upstreamOf(state.branch);
      if (upstream) {
        const { behind } = await this.git.aheadBehind(state.branch, upstream);
        if (behind > 0) {
          throw new GitCommandError(
            `Topic branch "${state.branch}" is behind its remote (${upstream}) by ${behind} commit(s).`,
            `Run 'git pull --rebase' first, or use --force to skip this check.`,
          );
        }
      }
      done.add("remote-sync");
    }

    // ---- Rebase if requested ----------------------------------------------
    if (state.rebase && !done.has("rebase")) {
      const parent = type.base;
      await this.git.checkout(state.branch);
      await this.git.rebase(parent);
      done.add("rebase");
    }

    // ---- Merge into targets ------------------------------------------------
    for (const target of state.targets) {
      const step = `merge:${target}`;
      if (done.has(step)) continue;

      await this.git.checkout(target);
      try {
        const mergeOptions: any = {
          noFastForward: state.noFF,
          squash: state.squash,
        };
        if (state.squash && state.squashMessage) {
          mergeOptions.message = state.squashMessage;
        } else if (state.mergeMessage) {
          const msg = state.mergeMessage.replace(/%b/g, state.branch).replace(/%p/g, target);
          mergeOptions.message = msg;
        }
        await this.git.merge(state.branch, mergeOptions);
      } catch {
        if (await this.git.mergeInProgress()) {
          await this.persist(state, [...done], step, target);
          const conflicts = await this.git.conflictedFiles();
          throw new ConflictError(`conflict merging ${state.branch} into ${target}`, conflicts);
        }
        throw new ConflictError(`failed to merge ${state.branch} into ${target}`);
      }

      state.mergedInto.push(target);
      done.add(step);
    }

    // ---- Tagging ----------------------------------------------------------
    const shouldTag = state.tagOverride ?? this.workflow.shouldTagForFinish(type, state.targets);
    const versioningCfg = this.workflow.config.versioning;

    if (shouldTag && !done.has("tag")) {
      let tagName: string;
      // Bare version (no tagPrefix), used for versioning.targetVersion/version.yaml
      // updates. Left undefined when a custom --tagname or the timestamp
      // fallback is used, since neither is a real semantic version.
      let bareVersion: string | undefined;
      // The tag we bumped FROM, if any — used to scope changelog commit
      // gathering to "since the last release" instead of full history.
      let previousTagName: string | undefined;

      if (state.tagname) {
        tagName = state.tagname;
      } else {
        const tagPrefix = this.workflow.tagPrefix();
        const bump = state.bump ?? this.workflow.versionBumpFor(type);

        if (state.branchVersionFinal) {
          // versioning.branchVersion.overrideBumpRules: use the version
          // extracted from the branch name as-is, skipping bumpRules.
          const parsed = this.versions.parse(state.branchVersionFinal);
          bareVersion = this.versions.format(parsed);
          tagName = this.versions.format(parsed, tagPrefix);
        } else {
          const baseVersion = state.currentVersion;

          if (baseVersion && bump !== "none") {
            const next = this.versions.bump(baseVersion, bump);
            bareVersion = this.versions.format(next);
            tagName = this.versions.format(next, tagPrefix);
            const candidatePreviousTag = this.versions.format(
              this.versions.parse(baseVersion),
              tagPrefix,
            );
            if (await this.git.tagExists(candidatePreviousTag)) {
              previousTagName = candidatePreviousTag;
            }
          } else if (bump !== "none") {
            // No --current-version, and no existing "${tagPrefix}X.Y.Z" tag at
            // all — this is the very first release, so start from the
            // persisted/seed currentVersion instead of a meaningless timestamp.
            const seedVersionRaw = versioningCfg?.currentVersion ?? "0.1.0";
            this.logger.info(
              `no --current-version given and no existing "${tagPrefix}X.Y.Z" tags found; ` +
                `treating this as the first release and starting from ${tagPrefix}${seedVersionRaw}`,
            );
            const parsedSeed = this.versions.parse(seedVersionRaw);
            bareVersion = this.versions.format(parsedSeed);
            tagName = this.versions.format(parsedSeed, tagPrefix);
          } else {
            this.logger.warn(
              `versioning is enabled but bump is "none" and no --tagname was given — ` +
                `falling back to a timestamp-based tag name.`,
            );
            tagName = `${tagPrefix}${Date.now()}`;
          }
        }
      }
      if (!(await this.git.tagExists(tagName))) {
        await this.git.createTag(
          tagName,
          omitUndefined({
            annotated: true,
            message: state.tagMessage,
            sign: state.signTag,
            signingKey: state.signingKey,
          }) as TagOptions,
        );
      }
      (state as { tag?: string }).tag = tagName;
      done.add("tag");

      // ---- Update .gitwe/version.yaml + versioning.targetVersion (+ changelog), then commit ---
      if (versioningCfg?.autoCommit && bareVersion && !done.has("version-files")) {
        await this.applyVersionToFiles(
          versioningCfg,
          this.workflow.config.changelog,
          bareVersion,
          previousTagName,
        );
        done.add("version-files");
      }
    }

    // ---- Push (if requested) ----------------------------------------------
    if (state.push && !done.has("push")) {
      const remotes = this.workflow.pushRemotesFor(type);
      const pushOpts = this.workflow.getPushOptionsFor(type);

      // Pre‑push validation: ensure each target is not behind its remote
      for (const remote of remotes) {
        for (const target of state.targets) {
          const upstream = await this.git.upstreamOf(target);
          if (upstream) {
            const { behind } = await this.git.aheadBehind(target, upstream);
            if (behind > 0) {
              throw new GitCommandError(
                `Cannot push ${target} because it is behind its remote (${upstream}) by ${behind} commit(s).`,
                `Run 'git pull --rebase ${remote} ${target}' first, or use --force if you are sure.`,
              );
            }
          }
        }
      }

      // Push each target to each configured remote
      for (const remote of remotes) {
        for (const target of state.targets) {
          try {
            // استفاده از pushOpts به‌همراه اولویت state.force
            await this.git.push(remote, target, {
              followTags: pushOpts.followTags ?? true,
              force: state.force ? true : undefined,
              forceWithLease: !state.force ? pushOpts.forceWithLease : undefined,
            } as PushOptions | undefined);
          } catch (error) {
            if (error instanceof GitCommandError) {
              const msg = error.message.toLowerCase();
              if (msg.includes("non-fast-forward")) {
                throw new GitCommandError(
                  `Push to ${remote}/${target} was rejected because it is behind the remote.`,
                  `Run 'git pull --rebase ${remote} ${target}' to integrate remote changes, then try again.`,
                );
              }
              if (msg.includes("permission denied") || msg.includes("403")) {
                throw new GitCommandError(
                  `Permission denied when pushing to ${remote}/${target}.`,
                  `Check your credentials and push permissions for ${remote}.`,
                );
              }
              if (msg.includes("repository not found") || msg.includes("404")) {
                throw new GitCommandError(
                  `Remote repository ${remote} not found or you have no access.`,
                  `Verify the remote URL and your access rights.`,
                );
              }
            }
            throw error;
          }
        }
      }
      done.add("push");
    }

    // ---- Delete local branch ----------------------------------------------
    let deleted = false;
    if (!state.keep && !done.has("delete")) {
      const force = state.forceDelete || false;
      await this.git.deleteBranch(state.branch, force);
      deleted = true;
      done.add("delete");
    }

    // ---- Delete remote branch if requested --------------------------------
    if (!state.keepRemote && !done.has("delete-remote")) {
      for (const remote of this.workflow.pushRemotesFor(type)) {
        if (await this.git.remoteBranchExists(remote, state.branch)) {
          await this.git.deleteRemoteBranch(remote, state.branch);
        }
      }
      done.add("delete-remote");
    }

    // ---- Cleanup ----------------------------------------------------------
    await this.stateStore.clear();
    await this.hooks.run("post-finish", {
      operation: "post-finish",
      branch: state.branch,
      branchType: type.name,
      target: (state.mergedInto.length > 0 ? state.mergedInto : state.targets) as string[],
      tagName: state.tag,
      force: state.force,
      extra: {
        deleted,
        mergedInto: state.mergedInto,
        keep: state.keep,
        keepRemote: state.keepRemote,
        pushed: state.push,
      },
    });
    return {
      branch: state.branch,
      mergedInto: state.mergedInto,
      ...(state.tag ? { tag: state.tag } : {}),
      deleted,
    };
  }

  private async persist(
    state: FinishStateData,
    completedSteps: string[],
    currentStep: string,
    pendingTarget: string,
  ): Promise<void> {
    const record: OperationState = {
      operation: OPERATION,
      currentStep,
      completedSteps,
      data: { ...state, pendingTarget },
      startedAt: new Date().toISOString(),
    };
    await this.stateStore.write(record);
  }

  /**
   * Updates `.gitwe/version.yaml`'s (or `versioning.config`'s) `currentVersion`
   * field, every configured `versioning.targetVersion` file, and (when
   * `changelog.enabled`) the changelog file, to `newVersion` (a bare semver,
   * no tagPrefix) — then commits everything staged. Called right after a
   * release tag is created, when `versioning.autoCommit` is enabled.
   */
  private async applyVersionToFiles(
    versioning: VersioningConfig,
    changelog: ChangelogConfig | undefined,
    newVersion: string,
    previousTagName: string | undefined,
  ): Promise<void> {
    const versionFilePath = join(this.git.cwd, versioning.config ?? ".gitwe/version.yaml");
    let raw = "";
    try {
      raw = await readFile(versionFilePath, "utf8");
    } catch {
      // first release / file not created yet — start from an empty document
    }
    const currentContent = (yaml.load(raw) as Record<string, unknown>) ?? {};
    currentContent.currentVersion = newVersion;
    const updatedYaml = yaml.dump(currentContent, { lineWidth: 100 });

    await writeFile(versionFilePath, updatedYaml, "utf8");
    await this.git.raw(["add", versionFilePath]);

    for (const target of versioning.targetVersion ?? []) {
      const targetPath = join(this.git.cwd, target.file);
      let rawTarget: string;
      try {
        rawTarget = await readFile(targetPath, "utf8");
      } catch (error) {
        throw new ValidationError(
          `could not read versioning target "${target.file}": ${(error as Error).message}`,
        );
      }
      const updatedTarget = this.versionTargets.apply(target, rawTarget, newVersion);
      await writeFile(targetPath, updatedTarget, "utf8");
      await this.git.raw(["add", targetPath]);
    }

    if (changelog?.enabled) {
      await this.updateChangelog(changelog, newVersion, previousTagName);
    }

    const message =
      versioning.commitMessage?.replace(/{{version}}/g, newVersion) ??
      `chore: bump version to ${newVersion}`;
    await this.git.raw(["commit", "-m", message]);
  }

  /**
   * Generates the changelog section for this release from commits since
   * `previousTagName` (or full history, if this is the first release) and
   * prepends it to `changelog.file`. Stages the file for the commit
   * `applyVersionToFiles` is about to make, unless `changelog.autoCommit`
   * is explicitly `false` — in which case the file is still written, just
   * left unstaged for the user to review.
   */
  private async updateChangelog(
    changelog: ChangelogConfig,
    newVersion: string,
    previousTagName: string | undefined,
  ): Promise<void> {
    const range = previousTagName ? `${previousTagName}..HEAD` : "HEAD";
    const commits = await this.gatherChangelogCommits(range);
    const lineTemplate = await this.readChangelogTemplate(changelog);
    const date = new Date().toISOString().slice(0, 10);
    const section = this.changelogGenerator.buildSection(
      newVersion,
      date,
      commits,
      changelog,
      lineTemplate,
    );

    const outputPath = join(this.git.cwd, changelog.file ?? "CHANGELOG.md");
    let existing = "";
    try {
      existing = await readFile(outputPath, "utf8");
    } catch {
      // no changelog yet — start fresh
    }
    const updated = this.changelogGenerator.prepend(existing, section);
    await writeFile(outputPath, updated, "utf8");

    if (changelog.autoCommit ?? true) {
      await this.git.raw(["add", outputPath]);
    }
  }

  /** Reads commits in `range` via `git log`, using ASCII separators to survive arbitrary commit messages. */
  private async gatherChangelogCommits(range: string): Promise<ChangelogCommit[]> {
    const UNIT_SEP = "\x1f";
    const RECORD_SEP = "\x1e";
    let raw: string;
    try {
      raw = await this.git.raw(["log", range, `--pretty=format:%H${UNIT_SEP}%an${UNIT_SEP}%B${RECORD_SEP}`]);
    } catch {
      return []; // e.g. no commits at all yet
    }
    return raw
      .split(RECORD_SEP)
      .map((record) => record.trim())
      .filter(Boolean)
      .map((record) => {
        const [hash = "", author = "", ...rest] = record.split(UNIT_SEP);
        return { hash, author, message: rest.join(UNIT_SEP) };
      })
      .filter((commit) => commit.hash);
  }

  /** Reads the first non-comment, non-blank line of `changelog.template.path` as the entry line template. */
  private async readChangelogTemplate(changelog: ChangelogConfig): Promise<string> {
    const templatePath = changelog.template?.path;
    if (!templatePath) return DEFAULT_CHANGELOG_LINE_TEMPLATE;

    try {
      const raw = await readFile(join(this.git.cwd, templatePath), "utf8");
      const line = raw
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.length > 0 && !l.startsWith("#"));
      return line ?? DEFAULT_CHANGELOG_LINE_TEMPLATE;
    } catch {
      return DEFAULT_CHANGELOG_LINE_TEMPLATE; // template file missing — fall back quietly
    }
  }
}
