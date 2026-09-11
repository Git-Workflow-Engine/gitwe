import type { BranchVersionConfig } from "../entities/versioning-config.entity.js";
import { VersionCalculatorService } from "./version-calculator.service.js";

export interface BranchVersionResolution {
  /** The bare semantic version extracted from the branch name (no tag prefix). */
  readonly version: string;
  /** The `branchVersion.patterns` entry that matched. */
  readonly pattern: string;
}

const PLACEHOLDER = "{{version}}";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compiles a `branchVersion.patterns` template (e.g. "release/v{{version}}")
 * into a RegExp that captures whatever sits in place of "{{version}}" for a
 * single path segment (no "/").
 */
function compilePattern(pattern: string): RegExp {
  const index = pattern.indexOf(PLACEHOLDER);
  if (index === -1) {
    throw new Error(`branchVersion pattern "${pattern}" must contain a "{{version}}" placeholder`);
  }
  const before = escapeRegExp(pattern.slice(0, index));
  const after = escapeRegExp(pattern.slice(index + PLACEHOLDER.length));
  return new RegExp(`^${before}([^/\\s]+)${after}$`);
}

/**
 * Pure, unit-testable service that extracts a semantic version out of a
 * branch name (e.g. "release/v0.35.2" -> "0.35.2"), driven entirely by
 * {@link BranchVersionConfig}. No I/O.
 */
export class BranchVersionResolverService {
  private readonly versions = new VersionCalculatorService();

  /**
   * Tries every pattern, in order, against `branchName`. Returns the first
   * match whose captured text is (after optional prefix stripping) a valid
   * semantic version, or `undefined` if nothing matches.
   */
  resolve(
    branchName: string,
    config: BranchVersionConfig,
    tagPrefix = "v",
  ): BranchVersionResolution | undefined {
    for (const pattern of config.patterns ?? []) {
      const regex = compilePattern(pattern);
      const match = regex.exec(branchName);
      if (!match) continue;

      const captured = match[1] ?? "";
      const candidate =
        config.stripPrefix !== false ? this.stripPrefix(captured, tagPrefix) : captured;

      try {
        this.versions.parse(candidate);
      } catch {
        continue; // captured text isn't a valid semver — try the next pattern
      }

      return { version: candidate, pattern };
    }
    return undefined;
  }

  private stripPrefix(value: string, tagPrefix: string): string {
    if (tagPrefix && value.startsWith(tagPrefix)) {
      return value.slice(tagPrefix.length);
    }
    return value;
  }
}
