import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { VersionSourcePort } from "../../domain/ports/version-source.port.js";

const execFileAsync = promisify(execFile);

export class VersionSourceAdapter implements VersionSourcePort {
  constructor(private readonly root: string) {}

  async listTags(): Promise<readonly string[]> {
    try {
      const { stdout } = await execFileAsync("git", ["tag", "--list"], { cwd: this.root });
      return stdout
        .split("\n")
        .map((t) => t.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  async readFile(relativePath: string): Promise<string | null> {
    const full = join(this.root, relativePath);
    if (!existsSync(full)) return null;
    try {
      return await readFile(full, "utf8");
    } catch {
      return null;
    }
  }
}
