import { CONFIG_SUBDIR } from "./env.js";
// Shared slash-command engine for BOTH loaders. Each loader deploys ONLY to its
// own app's command dir (not cross-app), so its /plugins + /accounts don't collide
// with the other loader's. Kept core-free: every core function it needs is injected
// by the caller from the caller's own bundle, so this module links no core.

import { join } from "path";
import { readJson } from "./json.js";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "fs";

/** What one loader supplies so the shared engine can speak as that loader's app. */
export interface LoaderCommandsOptions {
  /** The loader's package name, which is also the `/<plugin>-config` command name. */
  plugin: string;
  /** The app's command subdirectory, taken from the caller's own descriptor. */
  commandDir: string;
  /** Resolves the absolute path of the loader's runtime `plugin.js` for one home. */
  loaderEntry: (configDir: string) => string;
  /** Core's `runConfigCli`, bound to the caller's bundle. */
  runConfigCli: (pluginName: string, argv: string[]) => void;
  /** Core's `runAllConfigCli`. Absent means this loader serves no cross-plugin settings command. */
  runAllConfigCli?: (argv: string[], opts: { plugins: string[] }) => void;
  /** The config names this home declares, read fresh because the CLI runs in its own process. */
  configTargets?: (configDir: string) => string[];
  /** The trailing sentence `/accounts` prints when no account is signed in. */
  authHint: string;
  /**
   * Drains the event bus through the app's own notification channel.
   *
   * @remarks
   * Wired only by a loader whose app has such a channel, which is why it is optional rather than
   * a no-op every caller must supply.
   */
  busDrain?: () => void;
}

/** The little `/accounts` needs of one account to list it. */
interface AccountLike {
  /** The address it was signed in with. */
  email?: string;
  /** Its id, shown when there is no address. */
  id?: string;
  /** Whether it is in use. Only an explicit `false` disables it. */
  enabled?: boolean;
}

/**
 * The account store, by provider.
 *
 * @remarks
 * Two shapes are read because the store has carried both: a bare array per provider, and an object
 * holding one. A reader that assumed either would list nothing for half the homes in existence.
 */
type AccountStore = Record<string, AccountLike[] | { accounts?: AccountLike[] }>;

/** One slash command, before it is rendered to the markdown file the app reads. */
interface CommandDef {
  /** The command's name, and the basename of the file it is written to. */
  name: string;
  /** The one-line summary the app lists. */
  description: string;
  /** The argument syntax shown beside the description. */
  argumentHint?: string;
  /** The shell line the app runs before handing the output to the model. */
  shell?: string;
  /** What the model is told to do with that output. */
  body?: string;
}

/**
 * Builds one loader's slash commands: the deploy step and the CLI that answers them.
 *
 * @param opts the app-specific bits the shared engine cannot know.
 * @returns the two entry points a loader wires into its plugin hook.
 */
export function makeLoaderCommands(opts: LoaderCommandsOptions) {
  const { plugin, commandDir, loaderEntry, runConfigCli, runAllConfigCli, configTargets, authHint, busDrain } = opts;

  function commandDefs(entry: string): CommandDef[] {
    const node = `node "${entry}"`;
    return [
      {
        name: `${plugin}-config`,
        description: `View/change ${plugin} configuration`,
        argumentHint: "list | get <key> | set <key> <value>",
        shell: `${node} config $ARGUMENTS`,
        body: `Above is the ${plugin} config result. Report it; if the user changed a setting, confirm the new value.`,
      },
      {
        name: "config",
        description: "View/change any plugin's settings and the global settings",
        argumentHint: "[global | <plugin>] [list | get <key> | set <key> <value>]",
        shell: `${node} config-all $ARGUMENTS`,
        body: "Above is the global settings block plus one block per installed plugin. Present it clearly. To change one, run `/config <target> set <key> <value>`, where the target is `global` or a plugin name, then confirm the new value.",
      },
      {
        name: "plugins",
        description: "List the loader-managed plugins (from plugins.json)",
        shell: `${node} plugins`,
        body: "Above are the installed plugins and their state. Report them.",
      },
      {
        name: "accounts",
        description: "List signed-in accounts across all providers",
        shell: `${node} accounts`,
        body: `Above are the signed-in accounts across every provider. Report them; if none, ${authHint}.`,
      },
    ];
  }

  function render(def: CommandDef) {
    const fm = ["---", `description: ${def.description}`];
    if (def.argumentHint) fm.push(`argument-hint: ${def.argumentHint}`);
    fm.push("---", "");
    const lines = [fm.join("\n")];
    if (def.shell) lines.push("!`" + def.shell + "`", "");
    lines.push(def.body || "");
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  }

  function deployLoaderCommands(configDir: string) {
    try {
      const dir = join(configDir, commandDir);
      mkdirSync(dir, { recursive: true });
      for (const def of commandDefs(loaderEntry(configDir))) {
        writeFileSync(join(dir, `${def.name}.md`), render(def));
      }
    } catch {
      /* best-effort */
    }
  }

  function listPlugins(configDir: string) {
    for (const p of [join(configDir, CONFIG_SUBDIR, "plugins.json"), join(configDir, "plugins.json")]) {
      const arr = readJson(p);
      if (arr === null) continue;
      if (!Array.isArray(arr) || !arr.length) return console.log("No plugins configured.");
      for (const e of arr) console.log(`- ${e.name}${e.enabled === false ? " (disabled)" : ""}${e.sync ? " [sync]" : ""}`);
      return;
    }
    console.log("No plugins.json found.");
  }

  function listAccounts(configDir: string) {
    for (const p of [join(configDir, CONFIG_SUBDIR, "accounts.json"), join(configDir, "accounts.json"), join(configDir, CONFIG_SUBDIR, "core-auth-accounts.json"), join(configDir, "core-auth-accounts.json")]) {
      const store = readJson<AccountStore>(p);
      if (store === null || typeof store !== "object") continue;
      const lines: string[] = [];
      for (const provider of Object.keys(store)) {
        const held = store[provider];
        const accts = Array.isArray(held) ? held : (held?.accounts || []);
        for (const a of accts) lines.push(`- [${provider}] ${a.email || a.id}${a.enabled === false ? " (disabled)" : ""}`);
      }
      return console.log(lines.length ? lines.join("\n") : "No accounts signed in.");
    }
    console.log("No accounts store found.");
  }

  async function maybeRunCli(configDir: string) {
    const argv = process.argv.slice(2);
    if (argv[0] === "config") {
      runConfigCli(plugin, argv.slice(1));
      return true;
    }
    // The app's settings command, which the LOADER owns: a plugin declares what its settings ARE
    // and knows nothing about how they are edited, so one command serves every plugin here rather
    // than each plugin shipping its own.
    if (argv[0] === "config-all") {
      if (typeof runAllConfigCli !== "function" || typeof configTargets !== "function") return true;
      // Registering the installed plugins declarations is what makes them answerable HERE: this is
      // a fresh process, so nothing has read a manifest yet.
      const declared = configTargets(configDir);
      runAllConfigCli(argv.slice(1), { plugins: declared });
      return true;
    }
    if (argv[0] === "plugins") {
      listPlugins(configDir);
      return true;
    }
    if (argv[0] === "accounts") {
      listAccounts(configDir);
      return true;
    }
    if (argv[0] === "bus-drain") {
      if (typeof busDrain === "function") busDrain();
      return true;
    }
    return false;
  }

  return {
    /** Writes this loader's command files into the app's command directory. */
    deployLoaderCommands,
    /** Answers one of those commands, saying whether it was one of them. */
    maybeRunCli,
  };
}
