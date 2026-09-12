import { describe, expect, it } from "vitest";
import {
  ChangelogGeneratorService,
  type ChangelogCommit,
} from "../../src/domain/services/changelog-generator.service.js";
import type { ChangelogConfig } from "../../src/domain/entities/changelog-config.entity.js";

describe("ChangelogGeneratorService", () => {
  const generator = new ChangelogGeneratorService();

  const config: ChangelogConfig = {
    enabled: true,
    commitTypes: {
      feat: "Added",
      fix: "Fixed",
      perf: "Performance",
      docs: "Documentation",
    },
    breakingChangeHeading: "Breaking Changes",
  };

  function commit(overrides: Partial<ChangelogCommit>): ChangelogCommit {
    return { hash: "abcdef1234567890", author: "Ada", message: "chore: noop", ...overrides };
  }

  describe("parseCommit", () => {
    it("parses a plain conventional commit", () => {
      const entry = generator.parseCommit(commit({ message: "feat: add dark mode" }), config);
      expect(entry).toMatchObject({ heading: "Added", subject: "add dark mode" });
      expect(entry?.scope).toBeUndefined();
    });

    it("parses a scoped conventional commit", () => {
      const entry = generator.parseCommit(
        commit({ message: "fix(auth): handle expired tokens" }),
        config,
      );
      expect(entry).toMatchObject({ heading: "Fixed", scope: "auth", subject: "handle expired tokens" });
    });

    it("treats a '!' commit as breaking, regardless of type mapping", () => {
      const entry = generator.parseCommit(commit({ message: "feat!: drop node 16 support" }), config);
      expect(entry?.heading).toBe("Breaking Changes");
      expect(entry?.subject).toBe("drop node 16 support");
    });

    it("treats a BREAKING CHANGE: footer as breaking", () => {
      const entry = generator.parseCommit(
        commit({ message: "feat: new api\n\nBREAKING CHANGE: removes the old endpoint" }),
        config,
      );
      expect(entry?.heading).toBe("Breaking Changes");
      expect(entry?.subject).toBe("new api");
    });

    it("skips commits with an unmapped type", () => {
      expect(generator.parseCommit(commit({ message: "chore: bump deps" }), config)).toBeUndefined();
    });

    it("skips commits that aren't conventional at all", () => {
      expect(generator.parseCommit(commit({ message: "quick fix" }), config)).toBeUndefined();
    });
  });

  describe("renderEntry", () => {
    it("expands scopePrefix when a scope is present", () => {
      const entry = generator.parseCommit(commit({ message: "fix(auth): handle expired tokens" }), config)!;
      const line = generator.renderEntry(entry, "- {{scopePrefix}}{{subject}} ({{shortHash}})");
      expect(line).toBe("- **auth:** handle expired tokens (abcdef1)");
    });

    it("expands scopePrefix to nothing when there's no scope", () => {
      const entry = generator.parseCommit(commit({ message: "feat: add dark mode" }), config)!;
      const line = generator.renderEntry(entry, "- {{scopePrefix}}{{subject}} ({{shortHash}})");
      expect(line).toBe("- add dark mode (abcdef1)");
    });
  });

  describe("buildSection", () => {
    it("groups entries under their headings, breaking changes first", () => {
      const commits: ChangelogCommit[] = [
        commit({ hash: "1111111", message: "feat: add dark mode" }),
        commit({ hash: "2222222", message: "fix(auth): handle expired tokens" }),
        commit({ hash: "3333333", message: "feat!: drop node 16 support" }),
        commit({ hash: "4444444", message: "chore: bump deps" }), // skipped
      ];

      const section = generator.buildSection("1.2.0", "2026-09-12", commits, config);

      expect(section).toContain("## [1.2.0] - 2026-09-12");
      expect(section.indexOf("### Breaking Changes")).toBeLessThan(section.indexOf("### Added"));
      expect(section).toContain("- drop node 16 support (3333333)");
      expect(section).toContain("- add dark mode (1111111)");
      expect(section).toContain("- **auth:** handle expired tokens (2222222)");
      expect(section).not.toContain("bump deps");
    });

    it("renders a placeholder when nothing in the batch is a mapped conventional commit", () => {
      const section = generator.buildSection(
        "1.0.0",
        "2026-09-12",
        [commit({ message: "chore: repo cleanup" })],
        config,
      );
      expect(section).toBe("## [1.0.0] - 2026-09-12\n\n_No notable changes._\n");
    });
  });

  describe("prepend", () => {
    it("creates a fresh changelog with a title when there's no existing content", () => {
      const result = generator.prepend("", "## [1.0.0] - 2026-09-12\n\n### Added\n\n- first release\n");
      expect(result).toBe(
        "# Changelog\n\n## [1.0.0] - 2026-09-12\n\n### Added\n\n- first release\n",
      );
    });

    it("inserts the new section right after an existing title, above older entries", () => {
      const existing = "# Changelog\n\n## [1.0.0] - 2026-01-01\n\n### Added\n\n- old thing\n";
      const result = generator.prepend(existing, "## [1.1.0] - 2026-09-12\n\n### Fixed\n\n- new fix\n");
      expect(result).toBe(
        "# Changelog\n\n## [1.1.0] - 2026-09-12\n\n### Fixed\n\n- new fix\n\n## [1.0.0] - 2026-01-01\n\n### Added\n\n- old thing\n",
      );
    });

    it("adds a title when existing content doesn't start with one", () => {
      const result = generator.prepend("some notes\n", "## [1.0.0] - 2026-09-12\n\n- x\n");
      expect(result).toBe("# Changelog\n\n## [1.0.0] - 2026-09-12\n\n- x\n\nsome notes\n");
    });
  });
});
