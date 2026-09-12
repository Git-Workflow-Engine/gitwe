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

| Field | Description |
| :--- | :--- |
| `enabled` | Set to `true` to activate automatic versioning. |
| `files` | List of file paths to update (currently supports `package.json`, `Cargo.toml`, and plain text files with `version =`). |
| `tagFormat` | Template string. `{{version}}` is replaced with the bumped version. E.g., `v1.2.3`. You can also use `{{name}}` for branch names. |
| `bumpRules` | Maps branch types to semantic version increments (`major`, `minor`, `patch`, `prerelease`). |

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

## Determining the Current Version (`tagSource`)

Before bumping, gitwe needs a "current version" baseline. `versioning.tagSource` is an ordered list of strategies it tries, in order — the first one that resolves a value wins:

```yaml
tagSource: [branch, config, tag, manual, error]
```

| Strategy   | What it does                                                                                                   |
| :--------- | :--------------------------------------------------------------------------------------------------------------- |
| `branch`   | Extracts the version from the branch name via `branchVersion.patterns` (see below).                              |
| `config`   | Reads the `currentVersion` field out of `.gitwe/version.yaml`.                                                   |
| `tag`      | Scans existing `${tagPrefix}X.Y.Z` git tags for the highest one.                                                  |
| `manual`   | Prompts the user interactively for a version. Skipped automatically outside a TTY (e.g. in CI).                  |
| `error`    | Stops and fails the finish immediately, instead of falling through to the `currentVersion` seed / timestamp.     |

Defaults to `[branch, tag]` when omitted. This chain is only consulted when `--current-version` isn't passed explicitly on the CLI — an explicit flag always wins over every strategy. If nothing in the chain resolves a value (and `error` wasn't hit), gitwe treats this as the very first release and uses `versioning.currentVersion` as-is (see below), falling back further to a timestamp-based tag if that isn't set either.

## Extracting the Version From the Branch Name (`branchVersion`)

Only consulted when `"branch"` appears in `tagSource`. Useful when release/hotfix branches are already named after the version they ship, e.g. `release/v0.35.2`:

```yaml
branchVersion:
  patterns:
    - "release/v{{version}}" # release/v0.35.2
    - "release/{{version}}" # release/0.35.2
    - "hotfix/v{{version}}" # hotfix/v0.35.3
    - "hotfix/{{version}}" # hotfix/0.35.3
    - "v{{version}}" # v0.35.2
    - "{{version}}" # 0.35.2
  stripPrefix: true
  overrideBumpRules: true
```

| Field               | Description                                                                                                                                                     |
| :------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `patterns`          | Templates containing a single `{{version}}` placeholder, tried in order against the branch name. The first one whose captured text is a valid semver wins.     |
| `stripPrefix`       | When true (the default), a leading `tagPrefix` (e.g. `v`) in the captured text is stripped before parsing it as a semver — so a bare `{{version}}` pattern matches both `v0.35.2` and `0.35.2`. |
| `overrideBumpRules` | When true, the branch-extracted version is used verbatim as the release version, skipping `bumpRules` entirely. When false (the default), it's used as the *baseline* that `bumpRules` bumps from. |

If `"branch"` is in `tagSource` but the branch name matches none of the patterns, this strategy simply yields nothing and gitwe moves on to the next entry in `tagSource`.

## Updating Version Files (`targetVersion`)

When `versioning.autoCommit` is enabled, gitwe can also rewrite the version in one or more project files as part of the same commit it uses to update `.gitwe/version.yaml`. Configure this with `targetVersion` in `.gitwe/version.yaml`:

```yaml
targetVersion:
  - file: package.json
    path: version # dot-notation JSON key path, e.g. "package.version"
  - file: src/version.ts
    pattern: "export const version = '{{version}}';"
```

| Field     | Description                                                                                        |
| :-------- | :-------------------------------------------------------------------------------------------------- |
| `file`    | Path to the file, relative to the repository root.                                                  |
| `path`    | Dot-notation JSON key path to set to the new version. Use this for JSON files (`package.json`, etc). |
| `pattern` | A template containing a single `{{version}}` placeholder; gitwe finds it in the file and rewrites the matched text with the new version. Use this for non-JSON files. |

Give each target exactly one of `path` or `pattern`. There's no need to list `.gitwe/version.yaml` itself here — it's always kept in sync automatically.

## `versioning.currentVersion`

`currentVersion` in `.gitwe/version.yaml` serves two purposes at once:

- **Seed value:** used as the starting point for the very first release, when `--current-version` wasn't passed and nothing in `tagSource` resolved a baseline. Used verbatim (not bumped). Defaults to `"0.1.0"`.
- **Live record:** whenever `versioning.autoCommit` is enabled, gitwe rewrites this same field to the newly released version as part of the bump commit — so `.gitwe/version.yaml` always reflects the latest released version, the same way `package.json`'s `version` field does. This is also what the `"config"` entry in `tagSource` reads back.

## Prerelease Bumps (`bumpRules.prerelease`)

Prerelease rules live nested inside `bumpRules`, alongside `major`/`minor`/`patch`:

```yaml
bumpRules:
  major: []
  minor: ["release"]
  patch: ["hotfix"]
  prerelease:
    enabled: false
    branchType: [] # branch type names that trigger a prerelease bump
    format: "{{type}}.{{number}}"
    types: ["alpha", "beta", "rc"]
```

| Field        | Description                                                                                          |
| :----------- | :----------------------------------------------------------------------------------------------------- |
| `enabled`    | Turn prerelease bumps on.                                                                                |
| `branchType` | Branch type names that resolve to a `prerelease` bump (checked after `major`/`minor`/`patch`).           |
| `format`     | Template for the prerelease suffix, e.g. `"{{type}}.{{number}}"` → `-alpha.1`, `-alpha.2`, ...           |
| `types`      | Allowed prerelease type names (e.g. `alpha`, `beta`, `rc`) that `{{type}}` can resolve to.                |

## Changelog Generation (`.gitwe/changelog.yaml`)

Referenced from the top-level config the same way versioning is:

```yaml
changelog:
  enabled: false
  config: .gitwe/changelog.yaml
```

`.gitwe/changelog.yaml` follows [Keep a Changelog](https://keepachangelog.com) + [Conventional Commits](https://www.conventionalcommits.org):

```yaml
enabled: false
file: CHANGELOG.md
autoCommit: true

commitTypes:
  feat: Added
  fix: Fixed
  perf: Performance
  revert: Reverted
  docs: Documentation

breakingChangeHeading: "Breaking Changes"

template:
  path: ".gitwe/changelog.template"
```

| Field                    | Description                                                                                                     |
| :------------------------ | :---------------------------------------------------------------------------------------------------------- |
| `file`                   | Output file, relative to the repository root. Defaults to `CHANGELOG.md`.                                        |
| `autoCommit`             | When true (the default), the changelog update is staged into the same commit as `versioning.targetVersion`. When false, the file is still written, just left unstaged for manual review. |
| `commitTypes`            | Maps a conventional-commit type (`feat`, `fix`, ...) to a section heading. **Types not listed here are skipped** — this is what keeps `chore`/`test`/`ci`/etc. noise out of the changelog. |
| `breakingChangeHeading`  | Heading used for any commit with a `!` (e.g. `feat!:`) or a `BREAKING CHANGE:` footer, regardless of its type. Always rendered first. |
| `template.path`          | Path to a one-line template controlling how each commit is rendered (see below). If missing/unreadable, gitwe uses a built-in default. |

### How it runs

Only at the moment a release tag is created (when `versioning.autoCommit` is also producing a commit):

1. Gathers commits between the previous release tag and `HEAD` (or full history, for the very first release).
2. Parses each subject as `type(scope)!: description`; anything that doesn't match this shape, or whose `type` isn't in `commitTypes` (and isn't breaking), is silently skipped.
3. Groups matched commits under their heading, breaking changes first, then in `commitTypes`' own order.
4. Prepends a new `## [version] - date` section to the top of `file` (newest first, per Keep a Changelog), adding a `# Changelog` title if the file is new.

### `.gitwe/changelog.template`

Controls only the per-commit *line* — the overall document structure (title, version headers, section headings) is always the standard Keep a Changelog shape, so there's nothing else to configure. The file's first non-comment, non-blank line is used as the template:

```
- {{scopePrefix}}{{subject}} ({{shortHash}})
```

| Placeholder      | Expands to                                                                                                    |
| :---------------- | :------------------------------------------------------------------------------------------------------------ |
| `{{subject}}`    | The commit's description, with the `type(scope)!:` prefix stripped.                                             |
| `{{scope}}`      | The raw `(scope)` text, or an empty string if the commit had none.                                              |
| `{{scopePrefix}}`| `` **scope:** `` (bold, with a trailing space) when the commit has a scope, or an empty string when it doesn't. Lets a template mention scope without any `{{#if}}`-style conditional syntax — the whole bolded prefix just disappears cleanly when there's nothing to show. |
| `{{shortHash}}`  | The first 7 characters of the commit hash.                                                                      |
| `{{hash}}`       | The full commit hash.                                                                                           |
| `{{author}}`     | The commit author's name.                                                                                       |

Prefer `{{scopePrefix}}` over hand-rolling `**{{scope}}:**` in the template — the latter leaves a stray `**:**` on scopeless commits.
