import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FinishBranchUseCase } from "../../src/application/use-cases/finish-branch.use-case.js";
import { WorkflowService } from "../../src/domain/services/workflow.service.js";
import { classicPreset } from "../../src/domain/config/presets.js";
import { silentLogger } from "../../src/domain/ports/logger.port.js";
import type { GitRepository } from "../../src/domain/ports/git-repository.port.js";
import type { HookRunner } from "../../src/domain/ports/hook-runner.port.js";
import type {
  OperationState,
  OperationStateStore,
} from "../../src/domain/ports/operation-state-store.port.js";

/** Minimal in-memory fakes so the use case is tested without real git or disk. */
function fakeGit(overrides: Partial<GitRepository> = {}): GitRepository {
  const branches = new Set(["main", "develop", "feature/login"]);
  return {
    cwd: "/tmp/fake",
    currentBranch: async () => "feature/login",
    listBranches: async () => [...branches],
    branchExists: async (b) => branches.has(b),
    remoteBranchExists: async () => false,
    upstreamOf: async () => undefined,
    aheadBehind: async () => ({ ahead: 0, behind: 0 }),
    isAncestor: async () => false,
    isClean: async () => true,
    conflictedFiles: async () => [],
    mergeInProgress: async () => false,
    createBranch: async () => undefined,
    checkout: async () => undefined,
    deleteBranch: async (b) => void branches.delete(b),
    deleteRemoteBranch: async () => undefined,
    renameBranch: async () => undefined,
    merge: async () => undefined,
    continueMerge: async () => undefined,
    abortMerge: async () => undefined,
    rebase: async () => undefined,
    createTag: async () => undefined,
    tagExists: async () => false,
    fetch: async () => undefined,
    push: async () => undefined,
    remoteExists: async () => true,
    setUpstream: async () => undefined,
    listTags: async () => [],
    deleteTag: async () => undefined,
    pushTags: async () => undefined,
    deleteRemoteTag: async () => undefined,
    raw: async (_args: string[]) => "",
    graph: async (_root?: string) => "",
    ...overrides,
  };
}

const noopHooks: HookRunner = { run: async () => undefined };

function memoryStateStore(): OperationStateStore {
  let state: OperationState | undefined;
  return {
    exists: async () => state !== undefined,
    read: async () => state,
    write: async (s) => void (state = s),
    clear: async () => void (state = undefined),
  };
}

describe("FinishBranchUseCase", () => {
  let workflow: WorkflowService;

  beforeEach(() => {
    workflow = new WorkflowService(classicPreset());
  });

  it("merges a feature branch into develop and deletes it", async () => {
    const git = fakeGit();
    const useCase = new FinishBranchUseCase(
      workflow,
      git,
      noopHooks,
      silentLogger,
      memoryStateStore(),
    );

    const result = await useCase.execute({ kind: "start", branch: "feature/login" });

    expect(result.mergedInto).toEqual(["develop"]);
    expect(result.deleted).toBe(true);
  });

  it("persists resumable state and throws a ConflictError on merge failure", async () => {
    const git = fakeGit({
      merge: async () => {
        throw new Error("CONFLICT");
      },
      mergeInProgress: async () => true,
      conflictedFiles: async () => ["src/index.ts"],
    });
    const stateStore = memoryStateStore();
    const useCase = new FinishBranchUseCase(workflow, git, noopHooks, silentLogger, stateStore);

    await expect(useCase.execute({ kind: "start", branch: "feature/login" })).rejects.toMatchObject(
      {
        code: "CONFLICT",
        files: ["src/index.ts"],
      },
    );
    await expect(stateStore.exists()).resolves.toBe(true);
  });

  it("resumes a persisted finish after conflicts are resolved", async () => {
    const git = fakeGit({ mergeInProgress: async () => false });
    const stateStore = memoryStateStore();
    await stateStore.write({
      operation: "finish",
      currentStep: "merge:develop",
      completedSteps: [],
      data: {
        branch: "feature/login",
        typeName: "feature",
        targets: ["develop"],
        mergedInto: [],
        squash: false,
        push: false,
        pendingTarget: "develop",
      },
      startedAt: new Date().toISOString(),
    });

    const useCase = new FinishBranchUseCase(workflow, git, noopHooks, silentLogger, stateStore);
    const result = await useCase.execute({ kind: "continue" });

    expect(result.mergedInto).toEqual(["develop"]);
    await expect(stateStore.exists()).resolves.toBe(false);
  });

  it("discovers the current version from existing tags when --current-version is omitted", async () => {
    const git = fakeGit({
      branchExists: async (b) => new Set(["main", "develop", "release/2.0"]).has(b),
      listTags: async () => ["v0.35.2", "v1.2.0", "v1.2.0-beta.1", "not-a-version"],
    });
    let createdTag: string | undefined;
    const gitWithTagCapture = {
      ...git,
      createTag: async (name: string) => void (createdTag = name),
    };

    const useCase = new FinishBranchUseCase(
      workflow,
      gitWithTagCapture,
      noopHooks,
      silentLogger,
      memoryStateStore(),
    );

    const result = await useCase.execute({ kind: "start", branch: "release/2.0" });

    // highest stable tag is v1.2.0 (v1.2.0-beta.1 and the malformed tag are
    // ignored); "release" bumps minor per classicPreset -> v1.3.0, not a
    // Date.now() timestamp.
    expect(createdTag).toBe("v1.3.0");
    expect(result.tag).toBe("v1.3.0");
  });

  it("uses a sensible initial version (0.1.0 by default) for the very first tag ever", async () => {
    const git = fakeGit({
      branchExists: async (b) => new Set(["main", "develop", "release/2.0"]).has(b),
      listTags: async () => [], // nothing tagged yet in this repo
    });
    let createdTag: string | undefined;
    const gitWithTagCapture = {
      ...git,
      createTag: async (name: string) => void (createdTag = name),
    };

    const useCase = new FinishBranchUseCase(
      workflow,
      gitWithTagCapture,
      noopHooks,
      silentLogger,
      memoryStateStore(),
    );

    const result = await useCase.execute({ kind: "start", branch: "release/2.0" });

    expect(createdTag).toBe("v0.1.0");
    expect(result.tag).toBe("v0.1.0");
  });

  it("honours a custom versioning.initialVersion for the first tag", async () => {
    const customWorkflow = new WorkflowService({
      ...classicPreset(),
      versioning: { ...classicPreset().versioning, enabled: true, initialVersion: "1.0.0" },
    });
    const git = fakeGit({
      branchExists: async (b) => new Set(["main", "develop", "release/2.0"]).has(b),
      listTags: async () => [],
    });
    let createdTag: string | undefined;
    const gitWithTagCapture = {
      ...git,
      createTag: async (name: string) => void (createdTag = name),
    };

    const useCase = new FinishBranchUseCase(
      customWorkflow,
      gitWithTagCapture,
      noopHooks,
      silentLogger,
      memoryStateStore(),
    );

    const result = await useCase.execute({ kind: "start", branch: "release/2.0" });

    expect(createdTag).toBe("v1.0.0");
    expect(result.tag).toBe("v1.0.0");
  });

  it("aborts an in-progress merge and clears state", async () => {
    let aborted = false;
    const git = fakeGit({
      mergeInProgress: async () => true,
      abortMerge: async () => void (aborted = true),
    });
    const stateStore = memoryStateStore();
    await stateStore.write({
      operation: "finish",
      currentStep: "merge:develop",
      completedSteps: [],
      data: {},
      startedAt: new Date().toISOString(),
    });

    const useCase = new FinishBranchUseCase(workflow, git, noopHooks, silentLogger, stateStore);
    await useCase.execute({ kind: "abort" });

    expect(aborted).toBe(true);
    await expect(stateStore.exists()).resolves.toBe(false);
  });

  // ---- branchVersion ---------------------------------------------------

  describe("versioning.branchVersion", () => {
    function branchVersionWorkflow(overrides: Record<string, unknown> = {}) {
      return new WorkflowService({
        ...classicPreset(),
        versioning: {
          ...classicPreset().versioning,
          enabled: true,
          branchVersion: {
            enabled: true,
            patterns: [
              "release/v{{version}}",
              "release/{{version}}",
              "hotfix/v{{version}}",
              "hotfix/{{version}}",
              "v{{version}}",
              "{{version}}",
            ],
            ...overrides,
          },
        },
      });
    }

    it("extracts the current version from the branch name instead of scanning tags", async () => {
      const git = fakeGit({
        branchExists: async (b) => new Set(["main", "develop", "release/v0.35.2"]).has(b),
        // no matching tags on purpose — proves the version came from the branch name
        listTags: async () => [],
      });
      let createdTag: string | undefined;
      const gitWithTagCapture = {
        ...git,
        createTag: async (name: string) => void (createdTag = name),
      };

      const useCase = new FinishBranchUseCase(
        branchVersionWorkflow(),
        gitWithTagCapture,
        noopHooks,
        silentLogger,
        memoryStateStore(),
      );

      // "release" bumps minor per classicPreset's bumpRules, baseline 0.35.2 -> 0.36.0
      const result = await useCase.execute({ kind: "start", branch: "release/v0.35.2" });

      expect(createdTag).toBe("v0.36.0");
      expect(result.tag).toBe("v0.36.0");
    });

    it("overrideBumpRules uses the branch-extracted version verbatim", async () => {
      const git = fakeGit({
        branchExists: async (b) => new Set(["main", "develop", "release/v0.35.2"]).has(b),
        listTags: async () => [],
      });
      let createdTag: string | undefined;
      const gitWithTagCapture = {
        ...git,
        createTag: async (name: string) => void (createdTag = name),
      };

      const useCase = new FinishBranchUseCase(
        branchVersionWorkflow({ overrideBumpRules: true }),
        gitWithTagCapture,
        noopHooks,
        silentLogger,
        memoryStateStore(),
      );

      const result = await useCase.execute({ kind: "start", branch: "release/v0.35.2" });

      expect(createdTag).toBe("v0.35.2");
      expect(result.tag).toBe("v0.35.2");
    });

    it("falls back to initialVersion when the branch name matches no pattern", async () => {
      const customWorkflow = new WorkflowService({
        ...classicPreset(),
        versioning: {
          ...classicPreset().versioning,
          enabled: true,
          initialVersion: "2.0.0",
          branchVersion: {
            enabled: true,
            patterns: ["release/v{{version}}"],
            fallback: "initialVersion",
          },
        },
      });
      const git = fakeGit({
        branchExists: async (b) => new Set(["main", "develop", "release/no-version-here"]).has(b),
        listTags: async () => [],
      });
      let createdTag: string | undefined;
      const gitWithTagCapture = {
        ...git,
        createTag: async (name: string) => void (createdTag = name),
      };

      const useCase = new FinishBranchUseCase(
        customWorkflow,
        gitWithTagCapture,
        noopHooks,
        silentLogger,
        memoryStateStore(),
      );

      // "release" bumps minor per classicPreset -> 2.0.0 becomes v2.1.0
      const result = await useCase.execute({ kind: "start", branch: "release/no-version-here" });

      expect(createdTag).toBe("v2.1.0");
      expect(result.tag).toBe("v2.1.0");
    });

    it('throws when the branch matches no pattern and fallback is "error"', async () => {
      const customWorkflow = new WorkflowService({
        ...classicPreset(),
        versioning: {
          ...classicPreset().versioning,
          enabled: true,
          branchVersion: {
            enabled: true,
            patterns: ["release/v{{version}}"],
            fallback: "error",
          },
        },
      });
      const git = fakeGit({
        branchExists: async (b) => new Set(["main", "develop", "release/no-version-here"]).has(b),
      });

      const useCase = new FinishBranchUseCase(
        customWorkflow,
        git,
        noopHooks,
        silentLogger,
        memoryStateStore(),
      );

      await expect(
        useCase.execute({ kind: "start", branch: "release/no-version-here" }),
      ).rejects.toThrow(/branchVersion\.patterns/);
    });
  });

  // ---- versioning.targets ------------------------------------------------

  describe("versioning.targets", () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "gitwe-targets-"));
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "demo", version: "0.34.0" }, null, 2) + "\n",
        "utf8",
      );
      await writeFile(join(dir, "src-version.ts"), "export const version = '0.34.0';\n", "utf8");
      await mkdir(join(dir, ".gitwe"), { recursive: true });
      await writeFile(join(dir, ".gitwe/version.yaml"), "version: 1\n", "utf8");
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("updates every configured target file when the version is bumped", async () => {
      const targetsWorkflow = new WorkflowService({
        ...classicPreset(),
        versioning: {
          ...classicPreset().versioning,
          enabled: true,
          autoCommit: true,
          targets: [
            { file: "package.json", path: "version" },
            { file: "src-version.ts", pattern: "export const version = '{{version}}';" },
          ],
        },
      });

      const git = fakeGit({
        cwd: dir,
        branchExists: async (b) => new Set(["main", "develop", "release/2.0"]).has(b),
        listTags: async () => ["v0.34.0"],
        raw: async (args: string[]) => {
          if (args[0] === "cat-file") {
            const path = args[2] as string;
            return readFile(path, "utf8");
          }
          return "";
        },
      });

      const useCase = new FinishBranchUseCase(
        targetsWorkflow,
        git,
        noopHooks,
        silentLogger,
        memoryStateStore(),
      );

      const result = await useCase.execute({ kind: "start", branch: "release/2.0" });

      // "release" bumps minor per classicPreset -> v0.35.0
      expect(result.tag).toBe("v0.35.0");

      const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
      expect(pkg.version).toBe("0.35.0");

      const versionTs = await readFile(join(dir, "src-version.ts"), "utf8");
      expect(versionTs).toBe("export const version = '0.35.0';\n");
    });
  });
});
