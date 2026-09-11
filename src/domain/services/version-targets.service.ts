import type { VersionTargetConfig } from "../entities/versioning-config.entity.js";
import { ValidationError } from "../errors/index.js";

const PLACEHOLDER = "{{version}}";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Pure, unit-testable service that computes the new contents of a
 * `versioning.targets` file given its current contents and the new version
 * string. No I/O — callers are responsible for reading/writing the file.
 */
export class VersionTargetsService {
  /** Computes the updated file contents for a single target. */
  apply(target: VersionTargetConfig, content: string, version: string): string {
    if (target.path) {
      return this.applyJsonPath(content, target.path, version);
    }
    if (target.pattern) {
      return this.applyPattern(target.file, content, target.pattern, version);
    }
    throw new ValidationError(
      `versioning target "${target.file}" must specify either "path" or "pattern"`,
    );
  }

  /** Sets a dot-notation key path (e.g. "version" or "package.version") in a JSON file. */
  applyJsonPath(content: string, path: string, version: string): string {
    let data: unknown;
    try {
      data = JSON.parse(content);
    } catch (error) {
      throw new ValidationError(
        `could not parse JSON while applying version target "${path}": ${(error as Error).message}`,
      );
    }
    if (typeof data !== "object" || data === null) {
      throw new ValidationError(`expected a JSON object while applying version target "${path}"`);
    }

    const keys = path.split(".");
    const lastKey = keys[keys.length - 1] ?? path;
    let cursor = data as Record<string, unknown>;
    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i] ?? "";
      const next = cursor[key];
      if (typeof next !== "object" || next === null) {
        cursor[key] = {};
      }
      cursor = cursor[key] as Record<string, unknown>;
    }
    cursor[lastKey] = version;

    // Preserve the common two-space-indent, trailing-newline convention used
    // by package.json and friends.
    return `${JSON.stringify(data, null, 2)}\n`;
  }

  /**
   * Locates a "{{version}}"-templated pattern (e.g.
   * "export const version = '{{version}}';") in `content` and rewrites the
   * matched text with `version` substituted in.
   */
  applyPattern(file: string, content: string, pattern: string, version: string): string {
    const index = pattern.indexOf(PLACEHOLDER);
    if (index === -1) {
      throw new ValidationError(
        `versioning target pattern "${pattern}" must contain a "{{version}}" placeholder`,
      );
    }
    const before = pattern.slice(0, index);
    const after = pattern.slice(index + PLACEHOLDER.length);
    const regex = new RegExp(`${escapeRegExp(before)}([^\\r\\n]*?)${escapeRegExp(after)}`);

    if (!regex.test(content)) {
      throw new ValidationError(`pattern "${pattern}" was not found in target file "${file}"`);
    }

    return content.replace(regex, `${before}${version}${after}`);
  }
}
