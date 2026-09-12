/**
 * Abstraction over asking the user for input, used only by
 * `versioning.tagSource: ["manual", ...]`. Kept as a port so the domain/
 * application layers never depend on a concrete CLI prompt library.
 */
export interface VersionPrompter {
  /** Whether this prompter can actually prompt right now (e.g. an attached TTY). */
  isAvailable(): boolean;
  /**
   * Asks the user for a version string. Returns `undefined` if the user
   * gives no input (and no default applies) or prompting isn't available.
   */
  promptVersion(message: string, defaultValue?: string): Promise<string | undefined>;
}

/** Default used wherever no interactive prompter is wired up (e.g. library/CI use). */
export const noopVersionPrompter: VersionPrompter = {
  isAvailable: () => false,
  promptVersion: async () => undefined,
};
