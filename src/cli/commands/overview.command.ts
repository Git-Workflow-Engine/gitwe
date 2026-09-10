import { Command } from "commander";
import { loadEngine, action } from "./shared.js";
import { style } from "../output.js";
import { toArray } from "../../utils.js";

export function overviewCommand(): Command {
  return new Command("overview")
    .alias("status")
    .description("show the workflow definition and branch counts")
    .action(
      action(async function (this: Command, out) {
        const engine = await loadEngine(this);
        const overview = await engine.overview();

        const details = [
          `${style.bold("Workflow")}  ${overview.workflowName}`,
          `${style.dim("branch")}    ${overview.currentBranch ?? "(detached)"}`,
          "",
          style.bold("Base branches"),
          ...overview.baseBranches.map((name) => `  ${style.cyan(name)}`),
          "",
          style.bold("Topic types"),
          ...overview.branchTypes.map(
            (t) =>
              `  ${style.cyan(t.type.padEnd(10))} base=${t.base.padEnd(10)} ` +
              `target=[${toArray(t.target as string[])}]  count=${t.count}`,
          ),
        ];

        out.ok({
          data: overview,
          details,
        });
      }),
    );
}
