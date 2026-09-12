import type { BaseBranch } from "./base-branch.entity.js";
import type { BranchType } from "./branch-type.entity.js";
import { HookConfig } from "./hook-config.entity.js";
import { RemoteConfig } from "./remote-config.entity.js";
import { VersioningConfig } from "./versioning-config.entity.js";
import type { ChangelogConfig } from "./changelog-config.entity.js";

export type MergeStrategy = "merge" | "squash" | "rebase";

export interface CliConfig {
  readonly enabled: boolean;
  readonly interactive?: boolean;
  readonly color?: boolean;
  readonly aliases?: Readonly<Record<string, string>>;
}

export interface SquashConfig {
  readonly enabled: boolean;
  readonly default: boolean;
  readonly branchTypes: readonly string[];
}

export interface MergeConfig {
  readonly strategy: MergeStrategy;
  readonly branchTypes?: Readonly<Record<string, MergeStrategy>>;
  readonly deleteOnFinish: readonly string[];
  readonly squash?: SquashConfig;
}

export type { ChangelogConfig } from "./changelog-config.entity.js";

export interface WorkflowConfig {
  readonly version: 1;
  readonly name: string;
  readonly baseBranches: readonly BaseBranch[];
  readonly branchTypes: readonly BranchType[];
  readonly cli?: CliConfig;
  readonly merge?: MergeConfig;
  readonly hooks?: HookConfig;
  readonly versioning?: VersioningConfig;
  readonly changelog?: ChangelogConfig;
  readonly remote?: RemoteConfig;
}
