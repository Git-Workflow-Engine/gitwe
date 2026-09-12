/**
 * Infrastructure must implement this port.
 * Domain services never touch fs or git directly.
 */
export interface VersionSourcePort {
  /** All git tags in the repository (e.g. ["v0.34.0", "v0.35.0"]). */
  listTags(): Promise<readonly string[]>;

  /** Read raw file content. Returns null if file does not exist. */
  readFile(relativePath: string): Promise<string | null>;
}
