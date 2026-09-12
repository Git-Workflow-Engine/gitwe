// src/infrastructure/config/changelog-config-loader.ts
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import type { WorkflowConfig } from "../../domain/entities/workflow-config.entity.js";
import { ChangelogConfig } from "../../domain/entities/changelog-config.entity.js";

export interface ChangelogConfigLoaderOptions {
  root: string;
  mainConfig: WorkflowConfig;
  explicitFile?: string;
}

export class ChangelogConfigLoader {
  async load(options: ChangelogConfigLoaderOptions): Promise<ChangelogConfig> {
    const { root, mainConfig, explicitFile } = options;
    const mainChangelog = mainConfig.changelog ?? { enabled: false };

    let filePath = explicitFile ?? mainChangelog.config ?? ".gitwe/changelog.yaml";
    filePath = join(root, filePath);

    let fileConfig: Partial<ChangelogConfig> = {};
    if (existsSync(filePath)) {
      const raw = await readFile(filePath, "utf8");
      fileConfig = (yaml.load(raw) as Partial<ChangelogConfig>) ?? {};
    }

    const merged = Object.assign(
      {
        enabled: false,
        file: "CHANGELOG.md",
        autoCommit: true,
        breakingChangeHeading: "Breaking Changes",
        commitTypes: {
          feat: "Added",
          fix: "Fixed",
          perf: "Performance",
          revert: "Reverted",
          docs: "Documentation",
        },
      },
      fileConfig,
      mainChangelog,
    ) as ChangelogConfig;

    merged.template = { path: ".gitwe/changelog.template", ...merged.template };

    return merged;
  }
}
