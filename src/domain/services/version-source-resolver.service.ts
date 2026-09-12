import type {
  TagSource,
  VersioningFullConfig,
  VersionTargetConfig,
  BranchVersionConfig,
} from "../entities/versioning-config.entity.js";
import type { VersionSourcePort } from "../ports/version-source.port.js";
import { BranchVersionResolverService } from "./branch-version-resolver.service.js";
import { VersionCalculatorService } from "./version-calculator.service.js";
import { ValidationError } from "../errors/index.js";

export interface VersionSourceContext {
  /** Current git branch name (e.g. "release/v0.36.0"). */
  readonly branchName?: string;
  /** Explicit version from CLI (--current-version / --version). */
  readonly manualVersion?: string;
}

export interface VersionSourceResult {
  /** Bare semver without tag prefix (e.g. "0.35.2"). */
  readonly version: string;
  /** Which source produced this version. */
  readonly source: TagSource;
  /** Extra debug info (matched pattern, file, tag, …). */
  readonly detail?: string;
}

/**
 * Resolves the current project version by walking `config.tagSource`
 * in priority order until one source succeeds.
 *
 * Supported sources:
 *  - branch  → BranchVersionResolverService
 *  - file    → reads version from targetVersion entries
 *  - tag     → highest semver git tag (respecting tagPrefix)
 *  - manual  → context.manualVersion or config.currentVersion
 *  - error   → throws if reached (acts as terminator)
 */
export class VersionSourceResolverService {
  private readonly branchResolver = new BranchVersionResolverService();
  private readonly versions = new VersionCalculatorService();

  constructor(private readonly port: VersionSourcePort) {}

  async resolve(
    config: VersioningFullConfig,
    context: VersionSourceContext = {},
  ): Promise<VersionSourceResult> {
    const sources = config.tagSource?.length
      ? config.tagSource
      : (["branch", "config", "tag", "manual", "error"] as const);

    for (const source of sources) {
      const result = await this.trySource(source, config, context);
      if (result) return result;
    }

    // Should only reach here if "error" was not in the list
    throw new ValidationError("could not determine current version from any configured tagSource");
  }

  private async trySource(
    source: TagSource,
    config: VersioningFullConfig,
    context: VersionSourceContext,
  ): Promise<VersionSourceResult | undefined> {
    switch (source) {
      case "branch":
        return this.fromBranch(config, context);
      case "config":
        return this.fromFile(config);
      case "tag":
        return this.fromTag(config);
      case "manual":
        return this.fromManual(config, context);
      case "error":
        throw new ValidationError(
          "tagSource reached 'error' — no previous source could determine the version",
        );
      default: {
        throw new ValidationError(`unknown tagSource: ${String(source)}`);
      }
    }
  }

  // ─── branch ───────────────────────────────────────────────

  private fromBranch(
    config: VersioningFullConfig,
    context: VersionSourceContext,
  ): VersionSourceResult | undefined {
    const branchCfg = config.branchVersion;
    if (!branchCfg || !branchCfg.patterns?.length) return undefined;
    if (!context.branchName) return undefined;

    const resolved = this.branchResolver.resolve(
      context.branchName,
      branchCfg as BranchVersionConfig,
      config.tagPrefix,
    );
    if (!resolved) return undefined;

    return {
      version: resolved.version,
      source: "branch",
      detail: `pattern=${resolved.pattern}`,
    };
  }

  // ─── file ─────────────────────────────────────────────────

  private async fromFile(config: VersioningFullConfig): Promise<VersionSourceResult | undefined> {
    const targets = config.targetVersion ?? [];
    for (const target of targets) {
      const version = await this.readVersionFromTarget(target);
      if (version) {
        return {
          version,
          source: "config",
          detail: `file=${target.file}`,
        };
      }
    }
    return undefined;
  }

  private async readVersionFromTarget(target: VersionTargetConfig): Promise<string | undefined> {
    const content = await this.port.readFile(target.file);
    if (content === null) return undefined;

    try {
      if (target.path) {
        return this.extractJsonPath(content, target.path);
      }
      if (target.pattern) {
        return this.extractPattern(content, target.pattern);
      }
    } catch {
      // malformed file / no match → try next target
    }
    return undefined;
  }

  private extractJsonPath(content: string, path: string): string | undefined {
    const data = JSON.parse(content) as unknown;
    if (typeof data !== "object" || data === null) return undefined;

    const keys = path.split(".");
    let cursor: unknown = data;
    for (const key of keys) {
      if (typeof cursor !== "object" || cursor === null) return undefined;
      cursor = (cursor as Record<string, unknown>)[key];
    }
    if (typeof cursor !== "string") return undefined;

    // Validate it is a real semver
    this.versions.parse(cursor);
    return cursor;
  }

  private extractPattern(content: string, pattern: string): string | undefined {
    const PLACEHOLDER = "{{version}}";
    const index = pattern.indexOf(PLACEHOLDER);
    if (index === -1) return undefined;

    const before = this.escapeRegExp(pattern.slice(0, index));
    const after = this.escapeRegExp(pattern.slice(index + PLACEHOLDER.length));
    const regex = new RegExp(`${before}([^\\r\\n]*?)${after}`);
    const match = regex.exec(content);
    if (!match?.[1]) return undefined;

    const candidate = match[1].trim();
    this.versions.parse(candidate);
    return candidate;
  }

  // ─── tag ──────────────────────────────────────────────────

  private async fromTag(config: VersioningFullConfig): Promise<VersionSourceResult | undefined> {
    const tags = await this.port.listTags();
    const prefix = config.tagPrefix ?? "v";

    let best: string | undefined;
    let bestParsed: ReturnType<VersionCalculatorService["parse"]> | undefined;

    for (const tag of tags) {
      let bare = tag;
      if (prefix && bare.startsWith(prefix)) {
        bare = bare.slice(prefix.length);
      }
      try {
        const parsed = this.versions.parse(bare);
        if (!bestParsed || this.compareSemVer(parsed, bestParsed) > 0) {
          best = bare;
          bestParsed = parsed;
        }
      } catch {
        // ignore non-semver tags
      }
    }

    if (!best) return undefined;
    return {
      version: best,
      source: "tag",
      detail: `tag=${prefix}${best}`,
    };
  }

  /** Returns positive if a > b, negative if a < b, 0 if equal. */
  private compareSemVer(
    a: { major: number; minor: number; patch: number },
    b: { major: number; minor: number; patch: number },
  ): number {
    if (a.major !== b.major) return a.major - b.major;
    if (a.minor !== b.minor) return a.minor - b.minor;
    return a.patch - b.patch;
  }

  // ─── manual ───────────────────────────────────────────────

  private fromManual(
    config: VersioningFullConfig,
    context: VersionSourceContext,
  ): VersionSourceResult | undefined {
    const candidate = context.manualVersion ?? config.currentVersion;
    if (!candidate) return undefined;

    try {
      this.versions.parse(candidate);
    } catch {
      return undefined;
    }

    return {
      version: candidate,
      source: "manual",
      detail: context.manualVersion ? "cli" : "config.currentVersion",
    };
  }

  // ─── helpers ──────────────────────────────────────────────

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}
