import { ShellGitRepository } from "../infrastructure/git/shell-git-repository.adapter.js";
import { YamlConfigRepository } from "../infrastructure/config/yaml-config-repository.adapter.js";
import { FileHookRunner } from "../infrastructure/hooks/file-hook-runner.adapter.js";
import { FileOperationStateStore } from "../infrastructure/state/file-operation-state-store.adapter.js";
import { ConsoleLogger } from "../infrastructure/logger/console-logger.adapter.js";
import type { EngineDeps } from "../application/engine.js";
import { HookConfig } from "../domain/entities/hook-config.entity.js";
import { readlineVersionPrompter } from "../cli/version-prompter.adapter.js";

export interface GlobalOptions {
  readonly cwd: string;
  readonly config?: string;
  readonly color: boolean;
  readonly verbose: boolean;
}

/** Composition root: wires infrastructure adapters into an {@link EngineDeps}. */
export function buildEngineDeps(options: GlobalOptions): EngineDeps {
  const root = options.cwd;
  const configRepo = new YamlConfigRepository(root, options.config);
  const git = new ShellGitRepository(root);
  const logger = new ConsoleLogger(options.color, options.verbose);
  const stateStore = new FileOperationStateStore(root);
  // Hook config is only known after loading the workflow file; default to
  // enabled + `.gitwe/hooks` and let callers override once config is loaded.
  const defaultHookConfig: HookConfig = {
    enabled: true,
    path: ".gitwe/hooks",
    config: ".gitwe/hooks.yaml",
    inline: {},
    advanced: {},
    typeOverrides: {},
  };
  const hooks = new FileHookRunner(root, defaultHookConfig, true);

  return { configRepo, git, hooks, stateStore, logger, prompter: readlineVersionPrompter };
}
