import type { WorkflowConfig } from "../domain/entities/workflow-config.entity.js";
import { NotInitializedError, ValidationError } from "../domain/errors/index.js";
import { WorkflowService } from "../domain/services/workflow.service.js";
import type { ConfigRepository } from "../domain/ports/config-repository.port.js";
import type { GitRepository, TagOptions } from "../domain/ports/git-repository.port.js";
import type { HookContext, HookRunner } from "../domain/ports/hook-runner.port.js";
import type { Logger } from "../domain/ports/logger.port.js";
import { silentLogger } from "../domain/ports/logger.port.js";
import type { OperationStateStore } from "../domain/ports/operation-state-store.port.js";
import type { VersionPrompter } from "../domain/ports/version-prompter.port.js";
import { noopVersionPrompter } from "../domain/ports/version-prompter.port.js";

import { InitWorkflowUseCase } from "./use-cases/init-workflow.use-case.js";
import { StartBranchUseCase } from "./use-cases/start-branch.use-case.js";
import { FinishBranchUseCase } from "./use-cases/finish-branch.use-case.js";
import { UpdateBranchUseCase } from "./use-cases/update-branch.use-case.js";
import { PublishBranchUseCase } from "./use-cases/publish-branch.use-case.js";
import { DeleteBranchUseCase } from "./use-cases/delete-branch.use-case.js";
import { ListBranchesUseCase } from "./use-cases/list-branches.use-case.js";
import { OverviewUseCase } from "./use-cases/overview.use-case.js";
import { ValidateWorkflowUseCase } from "./use-cases/validate-workflow.use-case.js";
import { BranchName } from "../domain/value-objects/branch-name.vo.js";
import { TrackBranchUseCase } from "./use-cases/track-branch.use-case.js";
import {
  AddBaseOptions,
  AddBranchTypeOptions,
  ConfigEditorService,
  EditBaseOptions,
  EditBranchTypeOptions,
} from "../domain/services/config-editor.service.js";
import { VersionConfigLoader } from "../infrastructure/config/version-config-loader.js";
import { ChangelogConfigLoader } from "../infrastructure/config/changelog-config-loader.js";
import { RemoteConfigLoader } from "../infrastructure/config/remote-config-loader.js";
import { HookConfigLoader } from "../infrastructure/config/hook-config-loader.js";
import { FileHookRunner } from "../infrastructure/hooks/file-hook-runner.adapter.js";

export interface EngineDeps {
  readonly configRepo: ConfigRepository;
  readonly git: GitRepository;
  readonly hooks: HookRunner;
  readonly stateStore: OperationStateStore;
  readonly logger?: Logger;
  readonly prompter?: VersionPrompter;
}

export interface InitEngineOptions {
  readonly preset?: "classic" | "github" | "gitlab";
  readonly config?: WorkflowConfig;
  readonly force?: boolean;
  readonly createBranches?: boolean;
}

/**
 * Public facade over every use case. This is what both the CLI and
 * library consumers talk to — nobody outside `application/` ever
 * imports a use case directly.
 */
export class Engine {
  private constructor(
    readonly workflow: WorkflowService,
    private readonly deps: Required<EngineDeps>,
  ) {}

  static async create(deps: EngineDeps): Promise<Engine> {
    const config = await deps.configRepo.load();
    if (!config) throw new NotInitializedError();

    const loader = new VersionConfigLoader();
    const versioning = await loader.load({
      root: deps.git.cwd,
      mainConfig: config,
    });

    const changelogLoader = new ChangelogConfigLoader();
    const changelog = await changelogLoader.load({
      root: deps.git.cwd,
      mainConfig: config,
    });

    const remoteLoader = new RemoteConfigLoader();
    const remote = await remoteLoader.load({
      root: deps.git.cwd,
      mainConfig: config,
    });

    const hookLoader = new HookConfigLoader();
    const hookConfig = await hookLoader.load({
      root: deps.git.cwd,
      mainConfig: config,
    });

    // ساخت HookRunner با تنظیمات کامل
    const hooks = new FileHookRunner(
      deps.git.cwd,
      hookConfig,
      !!deps.logger, // یا از options.verbose استفاده کنید
    );

    const workflow = new WorkflowService({ ...config, versioning, changelog, remote, hooks: hookConfig });
    return new Engine(workflow, { logger: silentLogger, prompter: noopVersionPrompter, ...deps, hooks });
  }

  static async init(deps: EngineDeps, options: InitEngineOptions): Promise<Engine> {
    const useCase = new InitWorkflowUseCase(deps.configRepo, deps.git, deps.hooks);
    const config = await useCase.execute({
      preset: options.preset,
      config: options.config,
      force: options.force,
      createBranches: options.createBranches,
    });
    return new Engine(new WorkflowService(config), { logger: silentLogger, prompter: noopVersionPrompter, ...deps });
  }
  /** Optional helper for older call sites that only pass a preset name. */
  static async initFromPreset(
    deps: EngineDeps,
    preset: "classic" | "github" | "gitlab",
    force = false,
  ): Promise<Engine> {
    return Engine.init(deps, { preset, force });
  }

  /**
   * Switch to a topic branch.
   *
   * - checkout("feature", "login")  → type + short name / unique prefix
   * - checkout("feature/login")     → full branch name only
   */
  async checkout(
    typeOrBranch: string,
    nameOrPrefix?: string,
  ): Promise<{ branch: string; shortName: string | null; type: string | null }> {
    // ---- حالت اول: نام کامل شاخه ------------------------------------------
    if (nameOrPrefix === undefined) {
      const branch = typeOrBranch;
      if (!(await this.deps.git.branchExists(branch))) {
        throw new ValidationError(
          `branch "${branch}" does not exist`,
          "pass an existing branch name, or: gitwe checkout <type> <name>",
        );
      }

      // resolve قبل از checkout (برای هوک post-checkout)
      const resolved = this.workflow.resolveBranch(branch);

      await this.deps.hooks.run("pre-checkout", {
        operation: "pre-checkout",
        branch,
      });

      await this.deps.git.checkout(branch);

      await this.deps.hooks.run("post-checkout", {
        operation: "post-checkout",
        branch,
        type: resolved?.type.name,
      } as HookContext);

      return {
        branch,
        shortName: resolved?.shortName ?? null,
        type: resolved?.type.name ?? null,
      };
    }

    // ---- حالت دوم: type + name / prefix ------------------------------------
    const type = this.workflow.requireBranchType(typeOrBranch);
    const all = await this.deps.git.listBranches(`${type.prefix}*`);

    const candidates = all
      .map((branch) => this.workflow.resolveBranch(branch))
      .filter((r): r is NonNullable<typeof r> => r !== undefined && r.type.name === type.name)
      .filter(
        (r) =>
          r.shortName === nameOrPrefix ||
          r.shortName.startsWith(nameOrPrefix) ||
          r.branch === nameOrPrefix,
      );

    if (candidates.length === 0) {
      throw new ValidationError(
        `no ${type.name} branch matching "${nameOrPrefix}"`,
        `known prefix: ${type.prefix}`,
      );
    }
    if (candidates.length > 1) {
      throw new ValidationError(
        `ambiguous ${type.name} name "${nameOrPrefix}"`,
        `matches: ${candidates.map((c) => c.branch).join(", ")}`,
      );
    }

    const resolved = candidates[0]!;

    await this.deps.hooks.run("pre-checkout", {
      operation: "pre-checkout",
      branch: resolved.branch,
    });

    await this.deps.git.checkout(resolved.branch);

    await this.deps.hooks.run("post-checkout", {
      operation: "post-checkout",
      branch: resolved.branch,
      type: resolved.type.name,
    });

    return {
      branch: resolved.branch,
      shortName: resolved.shortName,
      type: resolved.type.name,
    };
  }

  /**
   * Report or remove a stale resumable-operation state file.
   * Never deletes branches or worktree files.
   */
  async clean(options: { force?: boolean } = {}): Promise<{
    existed: boolean;
    removed: boolean;
    path: string;
    operation?: string;
    currentStep?: string;
    startedAt?: string;
  }> {
    const store = this.deps.stateStore;
    const path =
      "file" in store && typeof (store as { file?: string }).file === "string"
        ? (store as { file: string }).file
        : ".git/gitwe/operation.json";

    const existed = await store.exists();
    if (!existed) {
      return { existed: false, removed: false, path };
    }

    const state = await store.read();
    const summary = {
      existed: true,
      removed: false,
      path,
      ...(state?.operation ? { operation: state.operation } : {}),
      ...(state?.currentStep ? { currentStep: state.currentStep } : {}),
      ...(state?.startedAt ? { startedAt: state.startedAt } : {}),
    };

    if (!options.force) {
      return summary;
    }

    await store.clear();
    return { ...summary, removed: true };
  }

  /**
   * Fetch configured workflow remotes, then integrate the current branch
   * with its upstream (merge or rebase). Does not change the workflow base
   * (that is `update`); this follows the branch's tracking ref.
   */
  async pull(options: { rebase?: boolean } = {}): Promise<{
    branch: string;
    fetched: string[];
    upstream: string | null;
    integrated: boolean;
    rebase: boolean;
  }> {
    const fetchRemotes = [...this.workflow.fetchRemotes()];
    const fetched: string[] = [];

    for (const remote of fetchRemotes) {
      if (await this.deps.git.remoteExists(remote)) {
        await this.deps.git.fetch(remote);
        fetched.push(remote);
      }
    }

    const branch = await this.deps.git.currentBranch();
    if (!branch) {
      throw new ValidationError("HEAD is detached", "check out a branch before pulling");
    }

    const upstream = await this.deps.git.upstreamOf(branch);
    if (!upstream) {
      return {
        branch,
        fetched,
        upstream: null,
        integrated: false,
        rebase: options.rebase === true,
      };
    }

    if (options.rebase) {
      await this.deps.git.rebase(upstream);
    } else {
      await this.deps.git.merge(upstream);
    }

    return {
      branch,
      fetched,
      upstream,
      integrated: true,
      rebase: options.rebase === true,
    };
  }

  /**
   * Rename the current topic branch (keeps type prefix; only the short name changes).
   * Example: on `feature/login`, rename("auth") → `feature/auth`
   */
  async rename(newShortName: string): Promise<{
    from: string;
    to: string;
    type: string;
    shortName: string;
  }> {
    const current = await this.deps.git.currentBranch();
    if (!current) {
      throw new ValidationError("HEAD is detached", "check out a topic branch before renaming");
    }

    const resolved = this.workflow.resolveBranch(current);
    if (!resolved) {
      throw new ValidationError(
        `"${current}" is not a configured topic branch`,
        "rename only applies to topic branches defined in the workflow",
      );
    }

    // BranchName VO validates git-safe short names
    const short = BranchName.create(newShortName).value;
    const to = this.workflow.branchName(resolved.type, short);

    if (to === current) {
      throw new ValidationError(`branch is already named "${to}"`);
    }

    if (await this.deps.git.branchExists(to)) {
      throw new ValidationError(`branch "${to}" already exists`);
    }

    if (this.workflow.isProtected(to) || this.workflow.isBaseBranch(to)) {
      throw new ValidationError(
        `"${to}" collides with a base branch name`,
        "choose a different short name",
      );
    }

    await this.deps.hooks.run("pre-rename", {
      operation: "pre-rename",
      oldName: current,
      newName: to,
    } as HookContext);

    await this.deps.git.renameBranch(current, to);

    await this.deps.hooks.run("post-rename", {
      operation: "post-rename",
      oldName: current,
      newName: to,
      type: resolved.type.name,
    });

    return {
      from: current,
      to,
      type: resolved.type.name,
      shortName: short,
    };
  }

  // src/application/engine.ts

  async track(branchOrType: string, name?: string): Promise<{ branch: string; remote: string }> {
    // Pre-track hook: اطلاعات ورودی را ارسال می‌کنیم
    await this.deps.hooks.run("pre-track", {
      operation: "pre-track",
      extra: { branchOrType, name },
    });

    const useCase = new TrackBranchUseCase(this.workflow, this.deps.git, this.deps.logger);
    const result = await useCase.execute({ branchOrType, name });

    // Post-track hook: نتیجه اجرا را ارسال می‌کنیم
    await this.deps.hooks.run("post-track", {
      operation: "post-track",
      branch: result.branch,
      remote: result.remote,
    });

    return result;
  }

  get config(): WorkflowConfig {
    return this.workflow.config;
  }

  start(typeNameOrAlias: string, name: string, options: { base?: string; fetch?: boolean } = {}) {
    return new StartBranchUseCase(
      this.workflow,
      this.deps.git,
      this.deps.hooks,
      this.deps.logger,
    ).execute({
      typeNameOrAlias,
      name,
      ...(options.base ? { baseOverride: options.base } : {}),
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    });
  }

  finish(
    branch: string,
    options: {
      squash?: boolean;
      push?: boolean;
      currentVersion?: string;
      // جدید
      rebase?: boolean;
      noFF?: boolean;
      mergeMessage?: string;
      squashMessage?: string;
      tag?: boolean;
      noTag?: boolean;
      tagname?: string;
      tagMessage?: string;
      signTag?: boolean;
      signingKey?: string;
      keep?: boolean;
      keepRemote?: boolean;
      forceDelete?: boolean;
      force?: boolean;
      fetch?: boolean;
      bump?: "major" | "minor" | "patch";
    } = {},
  ) {
    return new FinishBranchUseCase(
      this.workflow,
      this.deps.git,
      this.deps.hooks,
      this.deps.logger,
      this.deps.stateStore,
      this.deps.prompter,
    ).execute({ kind: "start", branch, ...options });
  }

  continueFinish() {
    return new FinishBranchUseCase(
      this.workflow,
      this.deps.git,
      this.deps.hooks,
      this.deps.logger,
      this.deps.stateStore,
    ).execute({ kind: "continue" });
  }

  abortFinish() {
    return new FinishBranchUseCase(
      this.workflow,
      this.deps.git,
      this.deps.hooks,
      this.deps.logger,
      this.deps.stateStore,
    ).execute({ kind: "abort" });
  }

  update(branch: string, options: { rebase?: boolean; fetch?: boolean } = {}) {
    return new UpdateBranchUseCase(
      this.workflow,
      this.deps.git,
      this.deps.hooks,
      this.deps.logger,
    ).execute({
      branch,
      ...options,
    });
  }

  publish(branch: string, options: { force?: boolean } = {}) {
    return new PublishBranchUseCase(
      this.workflow,
      this.deps.git,
      this.deps.hooks,
      this.deps.logger,
    ).execute({
      branch,
      ...options,
    });
  }

  delete(branch: string, options: { force?: boolean; remote?: boolean } = {}) {
    return new DeleteBranchUseCase(this.workflow, this.deps.git, this.deps.hooks).execute({
      branch,
      ...options,
    });
  }

  list(typeNameOrAlias?: string, pattern?: string) {
    return new ListBranchesUseCase(this.workflow, this.deps.git).execute({
      ...(typeNameOrAlias ? { typeNameOrAlias } : {}),
      ...(pattern ? { pattern } : {}),
    });
  }

  overview() {
    return new OverviewUseCase(this.workflow, this.deps.git).execute();
  }

  validate() {
    return new ValidateWorkflowUseCase().execute(this.config);
  }

  async tag(
    name?: string,
    options: {
      message?: string | undefined;
      delete?: boolean | undefined;
      deleteRemote?: boolean | undefined;
      push?: boolean | undefined;
      pushAll?: boolean | undefined;
    } = {},
  ): Promise<{
    tags: string[];
    created?: string;
    deleted?: string;
    deletedRemote?: string;
    pushed?: boolean;
    pushedAll?: boolean;
  }> {
    if (options.delete && !name) {
      throw new ValidationError("tag name is required for deletion");
    }
    if (options.deleteRemote && !name) {
      throw new ValidationError("tag name is required for remote deletion");
    }

    // --- Delete local + optionally remote ---
    if (name && options.delete) {
      await this.deps.git.deleteTag(name);
      const result: any = { tags: await this.deps.git.listTags(), deleted: name };

      if (options.deleteRemote) {
        const remote = this.workflow.defaultRemote;
        await this.deps.git.deleteRemoteTag(remote, name);
        result.deletedRemote = name;
      }

      return result;
    }

    // --- Delete remote only (without local deletion) ---
    if (name && options.deleteRemote) {
      const remote = this.workflow.defaultRemote;
      await this.deps.git.deleteRemoteTag(remote, name);
      return { tags: await this.deps.git.listTags(), deletedRemote: name };
    }

    // --- Create ---
    if (name) {
      await this.deps.hooks.run("pre-tag", {
        operation: "pre-tag",
        tagName: name,
        extra: options,
      });
      await this.deps.git.createTag(name, {
        annotated: true,
        message: options.message,
      } as TagOptions);
      const result: any = { tags: await this.deps.git.listTags(), created: name };

      if (options.push) {
        const remote = this.workflow.defaultRemote;
        await this.deps.git.pushTags(remote, name);
        result.pushed = true;
      } else if (options.pushAll) {
        const remote = this.workflow.defaultRemote;
        await this.deps.git.pushTags(remote);
        result.pushedAll = true;
      }

      await this.deps.hooks.run("post-tag", {
        operation: "post-tag",
        tagName: name,
        extra: { pushed: options.push, deleted: options.delete },
      });
      return result;
    }

    // --- List ---
    return { tags: await this.deps.git.listTags() };
  }

  /** Run an arbitrary git command and return stdout. For internal use only. */
  runGit(args: string[]): Promise<string> {
    return this.deps.git.raw(args);
  }

  graph(root?: string): Promise<string> {
    return this.deps.git.graph(root);
  }

  configList(): WorkflowConfig {
    return this.workflow.config;
  }

  async configAdd(
    kind: "base" | "branchType",
    name: string,
    options:
      | (AddBaseOptions & { kind?: "base" })
      | (AddBranchTypeOptions & { kind?: "branchType" }),
  ): Promise<WorkflowConfig> {
    const editor = new ConfigEditorService();
    const current = await this.deps.configRepo.load();
    if (!current) throw new NotInitializedError();

    let updated: WorkflowConfig;
    if (kind === "base") {
      const opts = options as AddBaseOptions;
      updated = editor.addBase(current, name, opts);
    } else {
      const opts = options as AddBranchTypeOptions;
      updated = editor.addBranchType(current, name, opts);
    }

    await this.deps.configRepo.save(updated);
    return updated;
  }

  async configEdit(
    kind: "base" | "branchType",
    name: string,
    options:
      | (EditBaseOptions & { kind?: "base" })
      | (EditBranchTypeOptions & { kind?: "branchType" }),
  ): Promise<WorkflowConfig> {
    const editor = new ConfigEditorService();
    const current = await this.deps.configRepo.load();
    if (!current) throw new NotInitializedError();

    let updated: WorkflowConfig;
    if (kind === "base") {
      const opts = options as EditBaseOptions;
      updated = editor.editBase(current, name, opts);
    } else {
      const opts = options as EditBranchTypeOptions;
      updated = editor.editBranchType(current, name, opts);
    }

    await this.deps.configRepo.save(updated);
    return updated;
  }

  async configRename(
    kind: "base" | "branchType",
    from: string,
    to: string,
  ): Promise<WorkflowConfig> {
    const editor = new ConfigEditorService();
    const current = await this.deps.configRepo.load();
    if (!current) throw new NotInitializedError();

    let updated: WorkflowConfig;
    if (kind === "base") {
      updated = editor.renameBase(current, from, to);
    } else {
      updated = editor.renameBranchType(current, from, to);
    }

    await this.deps.configRepo.save(updated);
    return updated;
  }

  async configDelete(kind: "base" | "branchType", name: string): Promise<WorkflowConfig> {
    const editor = new ConfigEditorService();
    const current = await this.deps.configRepo.load();
    if (!current) throw new NotInitializedError();

    let updated: WorkflowConfig;
    if (kind === "base") {
      updated = editor.deleteBase(current, name);
    } else {
      updated = editor.deleteBranchType(current, name);
    }

    await this.deps.configRepo.save(updated);
    return updated;
  }
}
