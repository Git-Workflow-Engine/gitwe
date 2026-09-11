# Versioning and Changelog

gitwe can automatically bump versions, create Git tags, and generate changelogs based on your workflow definition.

## Enabling Versioning

In `.gitwe/gitwe.yaml`:

```yaml
versioning:
  enabled: true
  files:
    - package.json
    - Cargo.toml
  tagFormat: "v{{version}}"
  bumpRules:
    - type: release
      bump: minor
    - type: hotfix
      bump: patch
```

## Fields

| Field       | Description                                                                                                                       |
| :---------- | :-------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`   | Set to `true` to activate automatic versioning.                                                                                   |
| `files`     | List of file paths to update (currently supports `package.json`, `Cargo.toml`, and plain text files with `version =`).            |
| `tagFormat` | Template string. `{{version}}` is replaced with the bumped version. E.g., `v1.2.3`. You can also use `{{name}}` for branch names. |
| `bumpRules` | Maps branch types to semantic version increments (`major`, `minor`, `patch`, `prerelease`).                                       |

## Semantic Version Rules

- **Major:** Breaking changes (usually `release` branches).
- **Minor:** New features (usually `feature` branches if merged directly to `main`).
- **Patch:** Bug fixes (usually `hotfix` branches).
- **Prerelease:** Alpha/Beta versions (e.g., `1.0.0-alpha.1`).

## Changelog Generation

gitwe integrates with `cliff.toml` (or custom templates) to generate changelogs.

To generate a changelog manually:

```bash
gitwe changelog generate
```

This reads the commit history since the last tag and creates a `CHANGELOG.md` entry.

## Example Workflow

1. You finish a `release/1.2.0` branch.
2. `versioning.bumpRules` says `release` → `minor`.
3. The current version is `1.1.0`.
4. gitwe bumps `package.json` to `1.2.0`.
5. gitwe creates a Git tag `v1.2.0`.
6. (Optional) gitwe pushes the tag if `--push` is used.

## Prerelease Management

For `prerelease` bumps, gitwe adds a suffix like `-alpha.1`, `-beta.2`. The increment is handled automatically based on the existing version string.

## Updating Version Files (`targets`)

When `versioning.autoCommit` is enabled, gitwe can also rewrite the version in one or more project files as part of the same commit it uses to update `.gitwe/version.yaml`. Configure this with `targets` in `.gitwe/version.yaml`:

```yaml
targets:
  - file: package.json
    path: version # dot-notation JSON key path, e.g. "package.version"
  - file: src/version.ts
    pattern: "export const version = '{{version}}';"
```

| Field     | Description                                                                                                                                                           |
| :-------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `file`    | Path to the file, relative to the repository root.                                                                                                                    |
| `path`    | Dot-notation JSON key path to set to the new version. Use this for JSON files (`package.json`, etc).                                                                  |
| `pattern` | A template containing a single `{{version}}` placeholder; gitwe finds it in the file and rewrites the matched text with the new version. Use this for non-JSON files. |

Give each target exactly one of `path` or `pattern`.

## Extracting the Version From the Branch Name (`branchVersion`)

Instead of (or in addition to) computing the next version from `bumpRules`, gitwe can read it straight out of the branch name — useful when release/hotfix branches are already named after the version they ship, e.g. `release/v0.35.2`:

```yaml
branchVersion:
  enabled: true
  patterns:
    - "release/v{{version}}" # release/v0.35.2
    - "release/{{version}}" # release/0.35.2
    - "hotfix/v{{version}}" # hotfix/v0.35.3
    - "hotfix/{{version}}" # hotfix/0.35.3
    - "v{{version}}" # v0.35.2
    - "{{version}}" # 0.35.2
  fallback: bumpRules # bumpRules | initialVersion | error
  stripPrefix: true
  overrideBumpRules: true
```

| Field               | Description                                                                                                                                                                                                                   |
| :------------------ | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`           | Turn branch-name version extraction on.                                                                                                                                                                                       |
| `patterns`          | Templates containing a single `{{version}}` placeholder, tried in order against the branch name. The first one whose captured text is a valid semver wins.                                                                    |
| `fallback`          | What to do when the branch matches none of the patterns: `bumpRules` (fall back to the normal tag-discovery + bumpRules flow, the default), `initialVersion` (use `versioning.initialVersion`), or `error` (fail the finish). |
| `stripPrefix`       | When true (the default), a leading `tagPrefix` (e.g. `v`) in the captured text is stripped before parsing it as a semver — so a bare `{{version}}` pattern matches both `v0.35.2` and `0.35.2`.                               |
| `overrideBumpRules` | When true, the branch-extracted version is used verbatim as the release version, skipping `bumpRules` entirely. When false (the default), it's used as the _baseline_ that `bumpRules` bumps from.                            |

This only takes effect when `--current-version` isn't passed explicitly on the CLI — an explicit flag always wins.
