export type VersionBump = "major" | "minor" | "patch" | "prerelease" | "none";
export interface PrereleaseConfig {
  enabled: boolean;
  format: string;
  types: readonly string[];
}

/**
 * A file whose contents should be updated whenever gitwe bumps the version.
 * Exactly one of `path` or `pattern` should be given:
 *  - `path`: a dot-notation key path into a JSON file (e.g. "version" or
 *    "package.version") whose value is set to the new version string.
 *  - `pattern`: a template string containing a single "{{version}}"
 *    placeholder (e.g. "export const version = '{{version}}';") that is
 *    located in the file and rewritten with the new version.
 */
export interface VersionTargetConfig {
  file: string;
  path?: string;
  pattern?: string;
}

/** What to do when the current branch doesn't match any `branchVersion.patterns`. */
export type BranchVersionFallback = "bumpRules" | "initialVersion" | "error";

/**
 * Extracts the release version directly from the branch name (e.g.
 * "release/v1.2.0") instead of (or in addition to) computing it from
 * `bumpRules`.
 */
export interface BranchVersionConfig {
  enabled: boolean;
  /**
   * Templates containing a single "{{version}}" placeholder, tried in
   * order against the branch name. The first one that matches — and whose
   * captured text parses as a valid semantic version — wins.
   */
  patterns: readonly string[];
  /**
   * Strategy used when `enabled` is true but the branch name doesn't match
   * any pattern. Defaults to "bumpRules".
   *  - "bumpRules": ignore branchVersion and fall back to the normal
   *    tag-discovery + bumpRules calculation.
   *  - "initialVersion": use `versioning.initialVersion` as the version.
   *  - "error": throw a validation error.
   */
  fallback?: BranchVersionFallback;
  /**
   * When true, a leading `tagPrefix` (e.g. "v") found in the text captured
   * for "{{version}}" is stripped before parsing it as a semantic version.
   * Lets a single pattern like "{{version}}" match both "v1.2.0" and
   * "1.2.0". Defaults to true.
   */
  stripPrefix?: boolean;
  /**
   * When true, the version extracted from the branch name is used as the
   * final release version as-is, bypassing `bumpRules` entirely. When
   * false, it's used only as the baseline that `bumpRules` bumps from.
   * Defaults to false.
   */
  overrideBumpRules?: boolean;
}

// domain/entities/versioning-config.entity.ts (جدید)
export interface VersioningConfig {
  enabled: boolean;
  config?: string;
  tagPrefix?: string;
  tagTypes?: readonly string[];
  tagTargets?: readonly string[];
  bumpRules?: {
    major?: readonly string[];
    minor?: readonly string[];
    patch?: readonly string[];
    prerelease?: readonly string[];
  };
  format?: string;
  annotated?: boolean;
  sign?: boolean;
  signingKey?: string;
  pushTags?: boolean;
  autoCommit?: boolean;
  commitMessage?: string;
  /**
   * Version to start from when versioning is enabled, no --current-version
   * was given, and no existing "${tagPrefix}X.Y.Z" tag can be found (i.e.
   * this is the very first release). Defaults to "0.1.0".
   */
  initialVersion?: string;
  prerelease?: {
    enabled: boolean;
    format: string;
    types: readonly string[];
  };
  /** Files to update (in addition to the tag) whenever the version is bumped. */
  targets?: readonly VersionTargetConfig[];
  /** Extract the release version from the branch name instead of/alongside bumpRules. */
  branchVersion?: BranchVersionConfig;
}

export interface VersioningFullConfig extends VersioningConfig {
  format?: string;
  annotated?: boolean;
  sign?: boolean;
  signingKey?: string;
  pushTags?: boolean;
  autoCommit?: boolean;
  commitMessage?: string;
  prerelease?: PrereleaseConfig;
}

export interface PrereleaseConfig {
  enabled: boolean;
  format: string;
  types: readonly string[];
}
