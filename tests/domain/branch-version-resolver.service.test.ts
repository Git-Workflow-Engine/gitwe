import { describe, expect, it } from "vitest";
import { BranchVersionResolverService } from "../../src/domain/services/branch-version-resolver.service.js";
import type { BranchVersionConfig } from "../../src/domain/entities/versioning-config.entity.js";

describe("BranchVersionResolverService", () => {
  const resolver = new BranchVersionResolverService();

  const baseConfig: BranchVersionConfig = {
    patterns: [
      "release/v{{version}}",
      "release/{{version}}",
      "hotfix/v{{version}}",
      "hotfix/{{version}}",
      "v{{version}}",
      "{{version}}",
    ],
  };

  it("matches a v-prefixed release branch", () => {
    const result = resolver.resolve("release/v0.35.2", baseConfig);
    expect(result).toEqual({ version: "0.35.2", pattern: "release/v{{version}}" });
  });

  it("matches a bare release branch", () => {
    const result = resolver.resolve("release/0.35.2", baseConfig);
    expect(result).toEqual({ version: "0.35.2", pattern: "release/{{version}}" });
  });

  it("matches a v-prefixed hotfix branch", () => {
    const result = resolver.resolve("hotfix/v0.35.3", baseConfig);
    expect(result).toEqual({ version: "0.35.3", pattern: "hotfix/v{{version}}" });
  });

  it("matches a bare tag-style branch", () => {
    const result = resolver.resolve("0.35.2", baseConfig);
    expect(result).toEqual({ version: "0.35.2", pattern: "{{version}}" });
  });

  it("strips the tag prefix by default so a bare pattern also matches v-prefixed names", () => {
    const config: BranchVersionConfig = { patterns: ["{{version}}"] };
    const result = resolver.resolve("v0.35.2", config, "v");
    expect(result).toEqual({ version: "0.35.2", pattern: "{{version}}" });
  });

  it("does not strip the tag prefix when stripPrefix is false", () => {
    const config: BranchVersionConfig = {
      patterns: ["{{version}}"],
      stripPrefix: false,
    };
    expect(resolver.resolve("v0.35.2", config, "v")).toBeUndefined();
  });

  it("returns undefined when nothing matches", () => {
    expect(resolver.resolve("feature/my-branch", baseConfig)).toBeUndefined();
  });

  it("skips a pattern whose captured text isn't a valid semver", () => {
    const config: BranchVersionConfig = {
      patterns: ["release/{{version}}", "{{version}}"],
    };
    // "not-semver" doesn't parse, so it falls through to the bare pattern —
    // which also fails, since the whole branch name isn't a semver either.
    expect(resolver.resolve("release/not-semver", config)).toBeUndefined();
  });
});
