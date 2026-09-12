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

/**
 * Extracts the release version directly from the branch name (e.g.
 * "release/v1.2.0"). Only consulted when `"branch"` appears in
 * `versioning.tagSource`.
 */
export interface BranchVersionConfig {
  /**
   * Templates containing a single "{{version}}" placeholder, tried in
   * order against the branch name. The first one that matches — and whose
   * captured text parses as a valid semantic version — wins.
   */
  patterns: readonly string[];
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

/**
 * Where gitwe can get the "current version" baseline for a release from.
 * Tried in the order listed in `versioning.tagSource`; the first one that
 * resolves a value wins.
 *  - "branch": extract it from the branch name via `branchVersion.patterns`.
 *  - "config": read the `currentVersion` field out of `.gitwe/version.yaml`.
 *  - "tag": scan existing `${tagPrefix}X.Y.Z` git tags for the highest one.
 *  - "manual": prompt the user interactively (skipped when not in a TTY).
 *  - "error": stop and fail immediately, instead of falling through to the
 *    `versioning.currentVersion` seed / timestamp fallback.
 */
export type TagSource = "branch" | "config" | "tag" | "manual" | "error";

/**
 * Governs prerelease (`-alpha.1`, `-beta.2`, ...) bumps. Lives at
 * `versioning.bumpRules.prerelease`, alongside the major/minor/patch rules.
 */
export interface PrereleaseBumpConfig {
  enabled: boolean;
  /** Branch type names that trigger a prerelease bump (e.g. ["alpha"]). */
  branchType: readonly string[];
  format: string;
  types: readonly string[];
}

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
    prerelease?: PrereleaseBumpConfig;
  };
  format?: string;
  annotated?: boolean;
  sign?: boolean;
  signingKey?: string;
  pushTags?: boolean;
  autoCommit?: boolean;
  commitMessage?: string;
  /**
   * The persisted "current version" of the project — both the seed value
   * used the very first time a release is cut (when no tag exists yet and
   * no other source resolves a version) and the field gitwe rewrites in
   * `.gitwe/version.yaml` (key `currentVersion`) after every bump, so this
   * file always reflects the latest released version. Defaults to "0.1.0".
   */
  currentVersion?: string;
  /**
   * Ordered list of strategies gitwe tries to determine the "current
   * version" baseline for a release; the first one that resolves a value
   * wins. Defaults to `["branch", "tag"]`. See {@link TagSource}.
   * Ignored when `--current-version` is passed explicitly on the CLI.
   */
  tagSource?: readonly TagSource[];
  /** Files to update (in addition to the tag) whenever the version is bumped. */
  targetVersion?: readonly VersionTargetConfig[];
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
}
