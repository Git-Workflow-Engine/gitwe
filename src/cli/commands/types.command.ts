import { Command } from "commander";
import { loadEngine, action } from "./shared.js";
import { style } from "../output.js";
import { toArray } from "../../utils.js";

export function typesCommand(): Command {
  return new Command("types").description("list topic types defined in the active workflow").action(
    action(async function (this: Command, out) {
      const engine = await loadEngine(this);
      const types = engine.workflow.branchTypes.map((t) => ({
        name: t.name,
        prefix: t.prefix,
        base: t.base,
        target: [...t.target],
        aliases: t.aliases ? [...t.aliases] : [],
      }));

      const data = { types };

      if (types.length === 0) {
        out.ok({
          data,
          message: style.dim("no topic types defined"),
        });
        return;
      }

      out.ok({
        data,
        details: types.map(
          (t) =>
            `${style.bold(t.name)}  ${style.dim(
              `prefix=${t.prefix}  base=${t.base}  target=[${toArray(t.target)}]`,
            )}`,
        ),
      });
    }),
  );
}
