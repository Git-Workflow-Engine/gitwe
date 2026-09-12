import type {
  WorkflowConfig,
  BaseBranch,
  BranchType,
  MergeStrategy,
  MergeConfig,
} from "../entities/index.js";
import { ConfigValidatorService } from "./config-validator.service.js";
import { ValidationError } from "../errors/index.js";

export interface AddBaseOptions {
  readonly base?: string;
  readonly aliases?: readonly string[];
  readonly protected?: boolean;
}

export interface AddBranchTypeOptions {
  readonly base: string;
  readonly target: readonly string[];
  readonly prefix: string;
  readonly aliases?: readonly string[];
  readonly pushRemote?: string;
}

export interface EditBaseOptions {
  readonly base?: string;
  readonly aliases?: readonly string[];
  readonly protected?: boolean;
}

export interface EditBranchTypeOptions {
  readonly base?: string;
  readonly target?: readonly string[];
  readonly prefix?: string;
  readonly aliases?: readonly string[];
  readonly pushRemote?: string;
}

/**
 * Pure domain service for mutating a workflow config.
 * Every mutation re‑validates the result and throws if invalid.
 */
export class ConfigEditorService {
  private readonly validator = new ConfigValidatorService();

  // ---- list --------------------------------------------------------------
  list(config: WorkflowConfig): WorkflowConfig {
    return config; // just return as-is
  }

  // ---- add base branch ---------------------------------------------------
  addBase(config: WorkflowConfig, name: string, opts: AddBaseOptions = {}): WorkflowConfig {
    if (config.baseBranches.some((b) => b.name === name)) {
      throw new ValidationError(`base branch "${name}" already exists`);
    }

    const newBase: BaseBranch = {
      name,
      ...(opts.base ? { base: opts.base } : {}),
      ...(opts.aliases ? { aliases: opts.aliases } : {}),
      ...(opts.protected !== undefined ? { protected: opts.protected } : {}),
    };

    const newConfig: WorkflowConfig = {
      ...config,
      baseBranches: [...config.baseBranches, newBase],
    };

    this.validator.validate(newConfig).assertValid();
    return newConfig;
  }

  // ---- add branch type ---------------------------------------------------
  addBranchType(config: WorkflowConfig, name: string, opts: AddBranchTypeOptions): WorkflowConfig {
    if (config.branchTypes.some((t) => t.name === name)) {
      throw new ValidationError(`branch type "${name}" already exists`);
    }

    const newType: BranchType = {
      name,
      base: opts.base,
      target: opts.target,
      prefix: opts.prefix,
      ...(opts.aliases ? { aliases: opts.aliases } : {}),
      ...(opts.pushRemote ? { pushRemote: opts.pushRemote } : {}),
    };

    const newConfig: WorkflowConfig = {
      ...config,
      branchTypes: [...config.branchTypes, newType],
    };

    this.validator.validate(newConfig).assertValid();
    return newConfig;
  }

  // ---- edit base branch --------------------------------------------------
  editBase(config: WorkflowConfig, name: string, opts: EditBaseOptions): WorkflowConfig {
    const idx = config.baseBranches.findIndex((b) => b.name === name);
    if (idx === -1) {
      throw new ValidationError(`base branch "${name}" not found`);
    }

    const existing = config.baseBranches[idx]!;
    const updated: BaseBranch = {
      name: existing.name,
      ...(opts.base !== undefined
        ? { base: opts.base }
        : existing.base !== undefined
          ? { base: existing.base }
          : {}),
      ...(opts.aliases !== undefined
        ? { aliases: opts.aliases }
        : existing.aliases !== undefined
          ? { aliases: existing.aliases }
          : {}),
      ...(opts.protected !== undefined
        ? { protected: opts.protected }
        : existing.protected !== undefined
          ? { protected: existing.protected }
          : {}),
    };

    const newBases = [...config.baseBranches];
    newBases[idx] = updated;

    const newConfig: WorkflowConfig = {
      ...config,
      baseBranches: newBases,
    };

    this.validator.validate(newConfig).assertValid();
    return newConfig;
  }

  // ---- edit branch type --------------------------------------------------
  editBranchType(
    config: WorkflowConfig,
    name: string,
    opts: EditBranchTypeOptions,
  ): WorkflowConfig {
    const idx = config.branchTypes.findIndex((t) => t.name === name);
    if (idx === -1) {
      throw new ValidationError(`branch type "${name}" not found`);
    }

    const existing = config.branchTypes[idx]!;
    const updated: BranchType = {
      name: existing.name,
      base: opts.base ?? existing.base,
      target: opts.target ?? existing.target,
      prefix: opts.prefix ?? existing.prefix,
      ...(opts.aliases !== undefined
        ? { aliases: opts.aliases }
        : existing.aliases
          ? { aliases: existing.aliases }
          : {}),
      ...(opts.pushRemote !== undefined
        ? { pushRemote: opts.pushRemote }
        : existing.pushRemote
          ? { pushRemote: existing.pushRemote }
          : {}),
    };

    const newTypes = [...config.branchTypes];
    newTypes[idx] = updated;

    const newConfig: WorkflowConfig = {
      ...config,
      branchTypes: newTypes,
    };

    this.validator.validate(newConfig).assertValid();
    return newConfig;
  }

  // ---- rename base branch ------------------------------------------------
  renameBase(config: WorkflowConfig, from: string, to: string): WorkflowConfig {
    if (from === to) return config;

    const idx = config.baseBranches.findIndex((b) => b.name === from);
    if (idx === -1) {
      throw new ValidationError(`base branch "${from}" not found`);
    }
    if (config.baseBranches.some((b) => b.name === to)) {
      throw new ValidationError(`base branch "${to}" already exists`);
    }

    // Update the branch itself
    const bases = [...config.baseBranches];
    bases[idx] = { ...bases[idx]!, name: to };

    // Update references in other base branches (base field)
    const updatedBases = bases.map((b) => ({
      ...b,
      ...(b.base === from ? { base: to } : {}),
    }));

    // Update references in branch types (base and target)
    const types = config.branchTypes.map((t) => ({
      ...t,
      ...(t.base === from ? { base: to } : {}),
      target: t.target.map((x) => (x === from ? to : x)),
    }));

    const newConfig: WorkflowConfig = {
      ...config,
      baseBranches: updatedBases,
      branchTypes: types,
    };

    this.validator.validate(newConfig).assertValid();
    return newConfig;
  }

  // ---- rename branch type ------------------------------------------------
  renameBranchType(config: WorkflowConfig, from: string, to: string): WorkflowConfig {
    if (from === to) return config;

    const idx = config.branchTypes.findIndex((t) => t.name === from);
    if (idx === -1) {
      throw new ValidationError(`branch type "${from}" not found`);
    }
    if (config.branchTypes.some((t) => t.name === to)) {
      throw new ValidationError(`branch type "${to}" already exists`);
    }

    const types = [...config.branchTypes];
    types[idx] = { ...types[idx]!, name: to };

    // Update merge config references (deleteOnFinish, squash.branchTypes, branchTypes override)
    const merge = config.merge;
    let newMerge: MergeConfig = merge as MergeConfig;
    if (merge) {
      const deleteOnFinish = merge.deleteOnFinish?.map((x) => (x === from ? to : x));
      const squash = merge.squash
        ? {
            ...merge.squash,
            branchTypes: merge.squash.branchTypes?.map((x) => (x === from ? to : x)),
          }
        : undefined;
      const branchTypesOverride: Record<string, MergeStrategy> = {};
      for (const [key, val] of Object.entries(merge.branchTypes ?? {})) {
        branchTypesOverride[key === from ? to : key] = val;
      }
      newMerge = {
        strategy: merge.strategy,
        deleteOnFinish: deleteOnFinish ?? [],
        ...(squash ? { squash } : {}),
        ...(Object.keys(branchTypesOverride).length > 0
          ? { branchTypes: branchTypesOverride }
          : {}),
      };
    }

    // Update versioning bumpRules references
    const versioning = config.versioning;
    let newVersioning = versioning;
    if (versioning) {
      const bumpRules = versioning.bumpRules;
      if (bumpRules) {
        const newRules: typeof bumpRules = {
          ...(bumpRules.major ? { major: bumpRules.major.map((x) => (x === from ? to : x)) } : {}),
          ...(bumpRules.minor ? { minor: bumpRules.minor.map((x) => (x === from ? to : x)) } : {}),
          ...(bumpRules.patch ? { patch: bumpRules.patch.map((x) => (x === from ? to : x)) } : {}),
          ...(bumpRules.prerelease
            ? {
                prerelease: {
                  ...bumpRules.prerelease,
                  branchType: bumpRules.prerelease.branchType.map((x) => (x === from ? to : x)),
                },
              }
            : {}),
        };
        newVersioning = { ...versioning, bumpRules: newRules };
      }
    }

    const newConfig: WorkflowConfig = {
      ...config,
      branchTypes: types,
      ...(newMerge ? { merge: newMerge } : {}),
      ...(newVersioning ? { versioning: newVersioning } : {}),
    };

    this.validator.validate(newConfig).assertValid();
    return newConfig;
  }

  // ---- delete base branch ------------------------------------------------
  deleteBase(config: WorkflowConfig, name: string): WorkflowConfig {
    if (config.baseBranches.length === 1) {
      throw new ValidationError("cannot delete the last base branch");
    }

    // Check if any branch type uses it as base or target
    const used = config.branchTypes.some((t) => t.base === name || t.target.includes(name));
    if (used) {
      throw new ValidationError(
        `base branch "${name}" is referenced by one or more branch types`,
        "update or remove those branch types first",
      );
    }

    // Check if any other base branch uses it as base
    const child = config.baseBranches.some((b) => b.base === name);
    if (child) {
      throw new ValidationError(
        `base branch "${name}" has child base branches`,
        "update or remove those child branches first",
      );
    }

    const newBases = config.baseBranches.filter((b) => b.name !== name);
    const newConfig: WorkflowConfig = {
      ...config,
      baseBranches: newBases,
    };

    this.validator.validate(newConfig).assertValid();
    return newConfig;
  }

  // ---- delete branch type ------------------------------------------------
  deleteBranchType(config: WorkflowConfig, name: string): WorkflowConfig {
    const exists = config.branchTypes.some((t) => t.name === name);
    if (!exists) {
      throw new ValidationError(`branch type "${name}" not found`);
    }

    // Remove from merge config references
    const merge = config.merge;
    let newMerge: MergeConfig = merge as MergeConfig;
    if (merge) {
      const deleteOnFinish = merge.deleteOnFinish?.filter((x) => x !== name);
      const squash = merge.squash
        ? {
            ...merge.squash,
            branchTypes: merge.squash.branchTypes?.filter((x) => x !== name),
          }
        : undefined;
      const branchTypesOverride = { ...merge.branchTypes };
      delete branchTypesOverride[name];
      newMerge = {
        strategy: merge.strategy,
        deleteOnFinish: deleteOnFinish ?? [],
        ...(squash ? { squash } : {}),
        ...(Object.keys(branchTypesOverride).length > 0
          ? { branchTypes: branchTypesOverride }
          : {}),
      };
    }

    // Remove from versioning bumpRules
    const versioning = config.versioning;
    let newVersioning = versioning;
    if (versioning?.bumpRules) {
      const { prerelease, ...rest } = versioning.bumpRules;
      const bumpRules: typeof versioning.bumpRules = { ...rest };
      for (const [bump, types] of Object.entries(rest)) {
        bumpRules[bump as keyof typeof rest] = types?.filter((x) => x !== name);
      }
      if (prerelease) {
        bumpRules.prerelease = {
          ...prerelease,
          branchType: prerelease.branchType.filter((x) => x !== name),
        };
      }
      newVersioning = { ...versioning, bumpRules };
    }

    const newTypes = config.branchTypes.filter((t) => t.name !== name);
    const newConfig: WorkflowConfig = {
      ...config,
      branchTypes: newTypes,
      ...(newMerge ? { merge: newMerge } : {}),
      ...(newVersioning ? { versioning: newVersioning } : {}),
    };

    this.validator.validate(newConfig).assertValid();
    return newConfig;
  }
}
