import { describe, expect, it } from "vitest";
import { VersionTargetsService } from "../../src/domain/services/version-targets.service.js";

describe("VersionTargetsService", () => {
  const service = new VersionTargetsService();

  it("updates a top-level JSON key path (package.json style)", () => {
    const content = JSON.stringify({ name: "gitwe", version: "0.34.0", private: true }, null, 2);
    const updated = service.apply({ file: "package.json", path: "version" }, content, "0.35.2");
    expect(JSON.parse(updated)).toEqual({ name: "gitwe", version: "0.35.2", private: true });
    expect(updated.endsWith("\n")).toBe(true);
  });

  it("creates intermediate objects for a nested JSON key path", () => {
    const content = JSON.stringify({ name: "gitwe" }, null, 2);
    const updated = service.apply(
      { file: "manifest.json", path: "package.version" },
      content,
      "1.2.3",
    );
    expect(JSON.parse(updated)).toEqual({ name: "gitwe", package: { version: "1.2.3" } });
  });

  it("rejects invalid JSON for a path target", () => {
    expect(() =>
      service.apply({ file: "package.json", path: "version" }, "not json", "1.0.0"),
    ).toThrow();
  });

  it("updates a pattern target in place", () => {
    const content = "export const version = '0.34.0';\nexport default version;\n";
    const updated = service.apply(
      { file: "src/version.ts", pattern: "export const version = '{{version}}';" },
      content,
      "0.35.2",
    );
    expect(updated).toBe("export const version = '0.35.2';\nexport default version;\n");
  });

  it("throws when the pattern isn't found in the file", () => {
    expect(() =>
      service.apply(
        { file: "src/version.ts", pattern: "export const version = '{{version}}';" },
        "some unrelated content",
        "0.35.2",
      ),
    ).toThrow();
  });

  it("throws when neither path nor pattern is given", () => {
    expect(() => service.apply({ file: "src/version.ts" }, "content", "0.35.2")).toThrow();
  });
});
