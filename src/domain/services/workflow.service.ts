import type { BaseBranch } from "../entities/base-branch.entity.js";
import type { BranchType, ResolvedBranch } from "../entities/branch-type.entity.js";
import type { RemoteOverride } from "../entities/remote-config.entity.js";
import type { VersionBump } from "../entities/versioning-config.entity.js";
import type { MergeStrategy, WorkflowConfig } from "../entities/workflow-config.entity.js";
import { ValidationError } from "../errors/index.js";
import type { PushOptions } from "../ports/git-repository.port.js";

/**
 * Read-only lookups and derived rules over a {@link WorkflowConfig}.
 * This is the single place that answers "given the definition, what
 * should happen?" — use cases never inspect the raw config directly.
 */
export class WorkflowService {
  constructor(readonly config: WorkflowConfig) {}

  // ---- base branches -----------------------------------------------------

  get baseBranches(): readonly BaseBranch[] {
    return this.config.baseBranches;
  }

  get rootBranch(): BaseBranch {
    const root = this.config.baseBranches.find((b) => b.base === undefined);
    if (!root) {
      throw new ValidationError(`workflow "${this.config.name}" has no root base branch`);
    }
    return root;
  }

  findBase(nameOrAlias: string): BaseBranch | undefined {
    const needle = nameOrAlias.trim().toLowerCase();
    return this.config.baseBranches.find(
      (b) => b.name.toLowerCase() === needle || b.aliases?.some((a) => a.toLowerCase() === needle),
    );
  }

  requireBase(nameOrAlias: string): BaseBranch {
    const base = this.findBase(nameOrAlias);
    if (!base) {
      throw new ValidationError(
        `"${nameOrAlias}" is not a base branch of the "${this.config.name}" workflow`,
        `known base branches: ${this.config.baseBranches.map((b) => b.name).join(", ")}`,
      );
    }
    return base;
  }

  childrenOf(name: string): readonly BaseBranch[] {
    return this.config.baseBranches.filter((b) => b.base === name);
  }

  isBaseBranch(branch: string): boolean {
    return this.findBase(branch) !== undefined;
  }

  isProtected(branch: string): boolean {
    return this.findBase(branch)?.protected ?? false;
  }

  // ---- branch types -------------------------------------------------------

  get branchTypes(): readonly BranchType[] {
    return this.config.branchTypes;
  }

  findBranchType(nameOrAlias: string): BranchType | undefined {
    const needle = nameOrAlias.trim().toLowerCase();
    return this.config.branchTypes.find(
      (t) => t.name.toLowerCase() === needle || t.aliases?.some((a) => a.toLowerCase() === needle),
    );
  }

  requireBranchType(nameOrAlias: string): BranchType {
    const type = this.findBranchType(nameOrAlias);
    if (!type) {
      throw new ValidationError(
        `unknown branch type "${nameOrAlias}"`,
        `known types: ${this.config.branchTypes.map((t) => t.name).join(", ")}`,
      );
    }
    return type;
  }

  branchName(type: BranchType, shortName: string): string {
    return `${type.prefix}${shortName}`;
  }

  /** Resolve a full branch name (e.g. `feature/login`) back to its type + short name. */
  resolveBranch(branch: string): ResolvedBranch | undefined {
    const type = [...this.config.branchTypes]
      .filter((t) => branch.startsWith(t.prefix))
      .sort((a, b) => b.prefix.length - a.prefix.length)[0];
    if (!type) return undefined;

    const shortName = branch.slice(type.prefix.length);
    if (shortName.length === 0) return undefined;

    return { branch, shortName, type };
  }

  resolveBranchType(type: BranchType, name: string): ResolvedBranch {
    const shortName = name.startsWith(type.prefix) ? name.slice(type.prefix.length) : name;
    if (shortName.length === 0) {
      throw new ValidationError(`a ${type.name} name is required`);
    }
    return { branch: this.branchName(type, shortName), shortName, type };
  }

  // ---- merge / tagging / versioning rules ---------------------------------

  mergeStrategyFor(type: BranchType): MergeStrategy {
    const merge = this.config.merge;
    return merge?.branchTypes?.[type.name] ?? merge?.strategy ?? "merge";
  }

  allowsSquash(type: BranchType): boolean {
    const squash = this.config.merge?.squash;
    return squash?.enabled === true && (squash.branchTypes?.includes(type.name) ?? false);
  }

  shouldDeleteOnFinish(type: BranchType): boolean {
    return this.config.merge?.deleteOnFinish?.includes(type.name) ?? false;
  }

  shouldTag(type: BranchType): boolean {
    return this.shouldTagForFinish(type, type.target);
  }

  tagPrefix(): string {
    return this.config.versioning?.tagPrefix ?? "v";
  }

  shouldTagForFinish(type: BranchType, targets: readonly string[]): boolean {
    const versioning = this.config.versioning;
    if (!versioning?.enabled) return false;
    const typeBased = versioning.tagTypes?.includes(type.name) ?? false;
    const targetBased =
      versioning.tagTargets?.some((target) => {
        if (target === "root") {
          return targets.includes(this.rootBranch.name);
        }
        return targets.includes(target);
      }) ?? false;
    return typeBased || targetBased;
  }

  versionBumpFor(type: BranchType): VersionBump {
    const rules = this.config.versioning?.bumpRules;
    if (!this.config.versioning?.enabled || !rules) return "none";
    if (rules.major?.includes(type.name)) return "major";
    if (rules.minor?.includes(type.name)) return "minor";
    if (rules.patch?.includes(type.name)) return "patch";
    if (rules.prerelease?.branchType?.includes(type.name)) return "prerelease";
    return "none";
  }

  // ---- remotes --------------------------------------------------------------

  get defaultRemote(): string {
    return this.config.remote?.default ?? "origin";
  }

  private resolveOverride(type: BranchType, field: keyof RemoteOverride): any {
    const remote = this.config.remote;
    if (!remote) return undefined;

    // ۱. اولویت با type override
    const typeOverride = remote.typeOverrides?.[type.name] as RemoteOverride | undefined;
    if (typeOverride && typeOverride[field] !== undefined) {
      return typeOverride[field];
    }

    // ۲. سپس نوع override (global for types)
    const typeDefaults = remote.typeOverrides?.pushOptions;
    if (field === "pushOptions" && typeDefaults !== undefined) {
      return typeDefaults;
    }

    // ۳. سپس base override (از شاخه پایه‌ی type)
    const baseOverride = remote.baseOverrides?.[type.base] as RemoteOverride | undefined;
    if (baseOverride && baseOverride[field] !== undefined) {
      return baseOverride[field];
    }

    // ۴. سپس base override global
    const baseDefaults = remote.baseOverrides?.pushOptions;
    if (field === "pushOptions" && baseDefaults !== undefined) {
      return baseDefaults;
    }

    return undefined;
  }

  pushRemotesFor(type: BranchType): readonly string[] {
    const push = this.resolveOverride(type, "push");
    if (push) return push;
    if (type.pushRemote) return [type.pushRemote];
    return this.config.remote?.push ?? [this.defaultRemote];
  }

  fetchRemotesFor(type: BranchType): readonly string[] {
    const fetch = this.resolveOverride(type, "fetch");
    if (fetch) return fetch;
    return this.config.remote?.fetch ?? [this.defaultRemote];
  }

  /**
   * Global fetch remotes (no branch type context)
   */
  fetchRemotes(): readonly string[] {
    return this.config.remote?.fetch ?? [this.defaultRemote];
  }

  getPushOptionsFor(type?: BranchType): PushOptions {
    const defaultOpts: PushOptions = {
      forceWithLease: false,
      followTags: true,
      ...(this.config.remote?.pushOptions || {}),
    };

    if (!type) return defaultOpts;

    const opts = this.resolveOverride(type, "pushOptions") as PushOptions | undefined;
    if (opts) {
      return { ...defaultOpts, ...opts };
    }

    // چک کردن global pushOptions در typeOverrides و baseOverrides
    const typePushOpts = this.config.remote?.typeOverrides?.pushOptions;
    if (typePushOpts) {
      return { ...defaultOpts, ...typePushOpts };
    }

    const basePushOpts = this.config.remote?.baseOverrides?.pushOptions;
    if (basePushOpts) {
      return { ...defaultOpts, ...basePushOpts };
    }

    return defaultOpts;
  }

  shouldAutoFetchFor(type: BranchType): boolean {
    const autoFetch = this.resolveOverride(type, "autoFetch");
    return autoFetch !== undefined ? autoFetch : this.config.remote?.autoFetch ?? true;
  }

  shouldAutoPushFor(type: BranchType): boolean {
    const autoPush = this.resolveOverride(type, "autoPush");
    return autoPush !== undefined ? autoPush : this.config.remote?.autoPush ?? false;
  }
}
