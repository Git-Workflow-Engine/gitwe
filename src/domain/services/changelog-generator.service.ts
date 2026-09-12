import type { ChangelogConfig } from "../entities/changelog-config.entity.js";

/** One commit's data, as gathered from `git log`. */
export interface ChangelogCommit {
  readonly hash: string;
  readonly author: string;
  /** Full commit message (subject + body/footers) — needed to detect "BREAKING CHANGE:" footers. */
  readonly message: string;
}

interface ParsedEntry {
  readonly heading: string;
  readonly scope?: string;
  readonly subject: string;
  readonly shortHash: string;
  readonly hash: string;
  readonly author: string;
}

const CONVENTIONAL_COMMIT_RE = /^(\w+)(\(([^)]+)\))?(!)?:\s*(.+)$/;
export const DEFAULT_CHANGELOG_LINE_TEMPLATE = "- {{scopePrefix}}{{subject}} ({{shortHash}})";

/**
 * Pure, unit-testable changelog logic: parses conventional-commit subjects,
 * groups them under Keep-a-Changelog-style headings, renders each entry
 * through a small placeholder template, and builds/prepends a version
 * section. No I/O — the use case gathers commits and writes files.
 */
export class ChangelogGeneratorService {
  /** Parses one commit into a changelog entry, or `undefined` if it should be skipped. */
  parseCommit(commit: ChangelogCommit, config: ChangelogConfig): ParsedEntry | undefined {
    const subject = commit.message.split("\n")[0]?.trim() ?? "";
    const match = CONVENTIONAL_COMMIT_RE.exec(subject);
    if (!match) return undefined; // not a conventional commit — keep the changelog clean

    const [, type, , scope, bang, description] = match;
    const isBreaking = Boolean(bang) || /BREAKING CHANGE:/.test(commit.message);
    const heading = isBreaking
      ? (config.breakingChangeHeading ?? "Breaking Changes")
      : config.commitTypes?.[type ?? ""];
    if (!heading) return undefined; // unmapped commit type, and not breaking — skip

    return {
      heading,
      ...(scope ? { scope } : {}),
      subject: (description ?? "").trim(),
      shortHash: commit.hash.slice(0, 7),
      hash: commit.hash,
      author: commit.author,
    };
  }

  /**
   * Renders one entry through a line template. `{{scopePrefix}}` expands to
   * `"**scope:** "` when the commit has a scope, or to `""` when it
   * doesn't — this is what lets a template mention scope without any
   * conditional template syntax.
   */
  renderEntry(entry: ParsedEntry, lineTemplate: string): string {
    const scopePrefix = entry.scope ? `**${entry.scope}:** ` : "";
    return lineTemplate
      .replace(/\{\{scopePrefix\}\}/g, scopePrefix)
      .replace(/\{\{scope\}\}/g, entry.scope ?? "")
      .replace(/\{\{subject\}\}/g, entry.subject)
      .replace(/\{\{shortHash\}\}/g, entry.shortHash)
      .replace(/\{\{hash\}\}/g, entry.hash)
      .replace(/\{\{author\}\}/g, entry.author);
  }

  /** Builds a `## [version] - date` section, grouped and ordered, from a batch of commits. */
  buildSection(
    version: string,
    date: string,
    commits: readonly ChangelogCommit[],
    config: ChangelogConfig,
    lineTemplate: string = DEFAULT_CHANGELOG_LINE_TEMPLATE,
  ): string {
    // Breaking changes always lead; the rest follow commitTypes' own order.
    const headingOrder: string[] = [config.breakingChangeHeading ?? "Breaking Changes"];
    for (const heading of Object.values(config.commitTypes ?? {})) {
      if (!headingOrder.includes(heading)) headingOrder.push(heading);
    }

    const grouped = new Map<string, string[]>();
    for (const commit of commits) {
      const entry = this.parseCommit(commit, config);
      if (!entry) continue;
      const lines = grouped.get(entry.heading) ?? [];
      lines.push(this.renderEntry(entry, lineTemplate));
      grouped.set(entry.heading, lines);
    }

    const body: string[] = [];
    for (const heading of headingOrder) {
      const lines = grouped.get(heading);
      if (!lines?.length) continue;
      body.push(`### ${heading}`, "", ...lines, "");
    }

    const header = `## [${version}] - ${date}`;
    return body.length > 0
      ? `${header}\n\n${body.join("\n").trimEnd()}\n`
      : `${header}\n\n_No notable changes._\n`;
  }

  /**
   * Inserts a new section right after the top-level "# Changelog" title
   * (added automatically if the file is new/missing one), keeping newest
   * releases at the top per Keep a Changelog convention.
   */
  prepend(existingContent: string, newSection: string): string {
    const trimmed = existingContent.trim();
    if (!trimmed) {
      return `# Changelog\n\n${newSection}`;
    }

    const lines = trimmed.split("\n");
    if (lines[0]?.startsWith("# ")) {
      const rest = lines.slice(1).join("\n").trimStart();
      return rest ? `${lines[0]}\n\n${newSection}\n${rest}\n` : `${lines[0]}\n\n${newSection}`;
    }
    return `# Changelog\n\n${newSection}\n${trimmed}\n`;
  }
}
