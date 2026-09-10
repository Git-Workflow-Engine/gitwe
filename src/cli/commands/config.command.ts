import { Command } from "commander";
import { loadEngine, action } from "./shared.js";
import {
  AddBaseOptions,
  AddBranchTypeOptions,
  EditBaseOptions,
  EditBranchTypeOptions,
} from "../../domain/services/config-editor.service.js";
import { omitUndefined, parseCsv, toArray } from "../../utils.js";

// ---- root config command -------------------------------------------------
export function configCommand(): Command {
  const root = new Command("config").description("inspect and edit the workflow definition");

  // ---- list -------------------------------------------------------------
  root
    .command("list")
    .description("show the current workflow definition")
    .action(
      action(async function (this: Command, out) {
        const engine = await loadEngine(this);
        const config = engine.configList();

        out.ok({
          data: config,
          details: [
            `version: ${config.version}`,
            `name: ${config.name}`,
            "",
            "Base branches:",
            ...config.baseBranches.map(
              (b) =>
                `  ${b.name}${b.base ? ` ← ${b.base}` : ""}${b.protected ? " (protected)" : ""}`,
            ),
            "",
            "Branch types:",
            ...config.branchTypes.map(
              (t) =>
                `  ${t.name} (prefix: ${t.prefix}, base: ${t.base}, target: ${toArray(t.target as string[])})`,
            ),
          ],
        });
      }),
    );

  // ---- add --------------------------------------------------------------
  root
    .command("add")
    .description("add a base branch or branch type")
    .argument("<kind>", "base or branchType")
    .argument("<name>", "branch or branch type name")
    .argument("[base]", "parent base branch for branch type, or base for base branch")
    .option("--prefix <prefix>", "branch prefix (for branch types)")
    .option("--target <target>", "target branch(es) (comma-separated for multiple)")
    .option("--aliases <aliases>", "comma-separated aliases")
    .option("--protected", "mark base branch as protected", false)
    .action(
      action(async function (
        this: Command,
        out,
        kind: string,
        name: string,
        base: string | undefined,
      ) {
        const engine = await loadEngine(this);
        const opts = this.opts<{
          prefix?: string;
          target?: string;
          aliases?: string;
          protected: boolean;
        }>();

        if (kind === "base") {
          const updated = await engine.configAdd(
            "base",
            name,
            omitUndefined({
              base,
              aliases: opts.aliases ? parseCsv(opts.aliases) : undefined,
              protected: opts.protected,
            }) as AddBaseOptions & { kind?: "base" },
          );

          out.ok({
            data: { kind: "base", name, updated },
            message: `added base branch "${name}"`,
          });
        } else if (kind === "branchType") {
          if (!opts.prefix) {
            throw new Error("--prefix is required for branch types");
          }
          if (!opts.target) {
            throw new Error("--target is required for branch types");
          }
          if (!base) {
            throw new Error("base argument is required for branch types");
          }
          const updated = await engine.configAdd(
            "branchType",
            name,
            omitUndefined({
              base,
              target: parseCsv(opts.target),
              prefix: opts.prefix,
              aliases: opts.aliases ? parseCsv(opts.aliases) : undefined,
            }) as AddBranchTypeOptions & { kind?: "branchType" },
          );

          out.ok({
            data: { kind: "branchType", name, updated },
            message: `added branch type "${name}"`,
          });
        } else {
          throw new Error(`unknown kind: ${kind} (use "base" or "branchType")`);
        }
      }),
    );

  // ---- edit -------------------------------------------------------------
  root
    .command("edit")
    .description("edit a base branch or branch type")
    .argument("<kind>", "base or branchType")
    .argument("<name>", "branch or branch type name")
    .option("--base <branch>", "new base branch")
    .option("--prefix <prefix>", "new prefix (for branch types)")
    .option("--target <target>", "new target branch(es) (comma-separated)")
    .option("--aliases <aliases>", "new aliases (comma-separated)")
    .option("--protected", "set protected (for base branches)")
    .option("--no-protected", "remove protected")
    .action(
      action(async function (this: Command, out, kind: string, name: string) {
        const engine = await loadEngine(this);
        const opts = this.opts<{
          base?: string;
          prefix?: string;
          target?: string;
          aliases?: string;
          protected?: boolean;
          noProtected?: boolean;
        }>();

        const protectedVal = opts.noProtected ? false : opts.protected ?? undefined;

        if (kind === "base") {
          const updated = await engine.configEdit(
            "base",
            name,
            omitUndefined({
              base: opts.base,
              aliases: opts.aliases ? parseCsv(opts.aliases) : undefined,
              protected: protectedVal,
            }) as EditBaseOptions & { kind?: "base" },
          );

          out.ok({
            data: { kind: "base", name, updated },
            message: `updated base branch "${name}"`,
          });
        } else if (kind === "branchType") {
          const updated = await engine.configEdit(
            "branchType",
            name,
            omitUndefined({
              base: opts.base,
              prefix: opts.prefix,
              target: opts.target ? parseCsv(opts.target) : undefined,
              aliases: opts.aliases ? parseCsv(opts.aliases) : undefined,
            }) as EditBranchTypeOptions & { kind?: "branchType" },
          );

          out.ok({
            data: { kind: "branchType", name, updated },
            message: `updated branch type "${name}"`,
          });
        } else {
          throw new Error(`unknown kind: ${kind} (use "base" or "branchType")`);
        }
      }),
    );

  // ---- rename -----------------------------------------------------------
  root
    .command("rename")
    .description("rename a base branch or branch type")
    .argument("<kind>", "base or branchType")
    .argument("<from>", "current name")
    .argument("<to>", "new name")
    .action(
      action(async function (this: Command, out, kind: string, from: string, to: string) {
        const engine = await loadEngine(this);
        const updated = await engine.configRename(kind as "base" | "branchType", from, to);
        out.ok({
          data: { kind, from, to, updated },
          message: `renamed ${kind} "${from}" → "${to}"`,
        });
      }),
    );

  // ---- delete -----------------------------------------------------------
  root
    .command("delete")
    .description("remove a base branch or branch type from the definition")
    .argument("<kind>", "base or branchType")
    .argument("<name>", "branch or branch type name")
    .action(
      action(async function (this: Command, out, kind: string, name: string) {
        const engine = await loadEngine(this);
        const updated = await engine.configDelete(kind as "base" | "branchType", name);
        out.ok({
          data: { kind, name, updated },
          message: `deleted ${kind} "${name}"`,
        });
      }),
    );

  return root;
}
