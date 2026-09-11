// src/infrastructure/config/version-config-loader.ts
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import type { WorkflowConfig } from "../../domain/entities/workflow-config.entity.js";
import { VersioningConfig } from "../../domain/entities/versioning-config.entity.js";

export interface VersionConfigLoaderOptions {
  root: string;
  mainConfig: WorkflowConfig;
  explicitFile?: string;
}

export class VersionConfigLoader {
  async load(options: VersionConfigLoaderOptions): Promise<VersioningConfig> {
    const { root, mainConfig, explicitFile } = options;
    const mainVersioning = mainConfig.versioning ?? { enabled: false };

    let filePath = explicitFile ?? mainVersioning.config ?? ".gitwe/version.yaml";
    filePath = join(root, filePath);

    let fileConfig: Partial<VersioningConfig> = {};
    if (existsSync(filePath)) {
      const raw = await readFile(filePath, "utf8");
      fileConfig = yaml.load(raw) as Partial<VersioningConfig>;
    }

    const merged = Object.assign(
      {
        enabled: false,
        tagPrefix: "v",
        format: "{{tagPrefix}}{{major}}.{{minor}}.{{patch}}",
        annotated: true,
        sign: false,
        pushTags: false,
        autoCommit: false,
        commitMessage: "chore: bump version to {{version}}",
        prerelease: {
          enabled: false,
          format: "{{type}}.{{number}}",
          types: ["alpha", "beta", "rc"],
        },
      },
      fileConfig,
      mainVersioning,
    ) as VersioningConfig;

    merged.tagTypes = merged.tagTypes ?? [];
    merged.tagTargets = merged.tagTargets ?? [];
    merged.targets = merged.targets ?? [];
    merged.branchVersion = {
      enabled: false,
      patterns: [],
      fallback: "bumpRules",
      stripPrefix: true,
      overrideBumpRules: false,
      ...merged.branchVersion,
    };

    return merged;
  }
}
