import { describe, expect, it } from "vitest";
import { WorkflowService } from "../../src/domain/services/workflow.service.js";
import { classicPreset } from "../../src/domain/config/presets.js";

describe("WorkflowService", () => {
  const workflow = new WorkflowService(classicPreset());

  it("finds the root base branch", () => {
    expect(workflow.rootBranch.name).toBe("main");
  });

  it("resolves a branch type by alias", () => {
    expect(workflow.requireBranchType("feat").name).toBe("feature");
  });

  it("resolves a full branch name back to type + short name", () => {
    const resolved = workflow.resolveBranch("feature/login");
    expect(resolved?.type.name).toBe("feature");
    expect(resolved?.shortName).toBe("login");
  });

  it("returns undefined for a branch that matches no prefix", () => {
    expect(workflow.resolveBranch("main")).toBeUndefined();
  });

  it("derives the tag/version-bump rule for release branches", () => {
    const release = workflow.requireBranchType("release");
    expect(workflow.shouldTag(release)).toBe(true);
    expect(workflow.versionBumpFor(release)).toBe("minor");
  });

  it("derives squash eligibility from merge.squash config", () => {
    expect(workflow.allowsSquash(workflow.requireBranchType("feature"))).toBe(true);
    expect(workflow.allowsSquash(workflow.requireBranchType("hotfix"))).toBe(false);
  });

  it("derives a prerelease bump from bumpRules.prerelease.branchType", () => {
    const customWorkflow = new WorkflowService({
      ...classicPreset(),
      versioning: {
        ...classicPreset().versioning,
        enabled: true,
        bumpRules: {
          ...classicPreset().versioning?.bumpRules,
          prerelease: {
            enabled: true,
            branchType: ["support"],
            format: "{{type}}.{{number}}",
            types: ["alpha", "beta", "rc"],
          },
        },
      },
    });

    expect(customWorkflow.versionBumpFor(customWorkflow.requireBranchType("support"))).toBe(
      "prerelease",
    );
    // untouched branch types still resolve to their own rule
    expect(customWorkflow.versionBumpFor(customWorkflow.requireBranchType("release"))).toBe(
      "minor",
    );
  });
});
