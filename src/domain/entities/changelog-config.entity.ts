/** Governs the per-commit line rendered into the changelog. */
export interface ChangelogTemplateConfig {
  /**
   * Path to a template file, relative to the repository root, containing
   * one line with "{{...}}" placeholders. Falls back to a built-in default
   * ("- {{scopePrefix}}{{subject}} ({{shortHash}})") when missing/unreadable.
   */
  path?: string;
}

/**
 * The full schema loaded from `.gitwe/changelog.yaml` (path configurable
 * via the top-level `changelog.config` pointer, same convention as
 * `versioning.config`).
 */
export interface ChangelogConfig {
  enabled: boolean;
  /** Path to the changelog.yaml this was loaded from. */
  config?: string;
  /** Output file, relative to the repository root. Defaults to "CHANGELOG.md". */
  file?: string;
  /**
   * Bundle the changelog update into the same commit as
   * `versioning.targetVersion` / `.gitwe/version.yaml`. Defaults to true.
   * Only takes effect when `versioning.autoCommit` is also producing that
   * commit in the first place.
   */
  autoCommit?: boolean;
  /**
   * Conventional-commit type (e.g. "feat", "fix") -> "Keep a Changelog"
   * section heading (e.g. "Added", "Fixed"). Commit types not listed here
   * are skipped, keeping the changelog free of noise like chore/test/ci.
   */
  commitTypes?: Readonly<Record<string, string>>;
  /** Heading used for commits with a "!" or a "BREAKING CHANGE:" footer. Defaults to "Breaking Changes". */
  breakingChangeHeading?: string;
  template?: ChangelogTemplateConfig;
}
