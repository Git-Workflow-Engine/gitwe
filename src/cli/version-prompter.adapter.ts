import type { VersionPrompter } from "../domain/ports/version-prompter.port.js";
import { ask, isInteractive } from "./prompts.js";

/** Interactive `versioning.tagSource: ["manual", ...]` prompter, wired up by the CLI composition root. */
export const readlineVersionPrompter: VersionPrompter = {
  isAvailable(): boolean {
    return isInteractive();
  },

  async promptVersion(message: string, defaultValue?: string): Promise<string | undefined> {
    if (!isInteractive()) return undefined;
    const answer = await ask(message, defaultValue);
    return answer === "" ? undefined : answer;
  },
};
