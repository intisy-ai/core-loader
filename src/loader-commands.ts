// @ts-nocheck
// Shared slash-command engine for BOTH loaders. Each loader deploys ONLY to its
// own app's command dir (not cross-app), so its /plugins + /accounts don't collide
// with the other loader's. Kept core-free — the caller injects runConfigCli (from
// its own core bundle) plus the app-specific bits.
//
//   makeLoaderCommands({ plugin, commandDir, loaderEntry, runConfigCli, authHint })
//     plugin       - package name (also the /<plugin>-config command name)
//     commandDir   - app command subdir ("commands" for Claude, "command" for opencode)
//     loaderEntry  - (configDir) => absolute path to the loader's runtime plugin.js
//     runConfigCli - core's runConfigCli, bound to the caller's bundle
//     authHint     - trailing sentence for the /accounts body when none are signed in

import { join } from "path";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "fs";

export function makeLoaderCommands(opts) {
  const { plugin, commandDir, loaderEntry, runConfigCli, authHint } = opts;

  function commandDefs(entry) {
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

  function render(def) {
    const fm = ["---", `description: ${def.description}`];
    if (def.argumentHint) fm.push(`argument-hint: ${def.argumentHint}`);
    fm.push("---", "");
    const lines = [fm.join("\n")];
    if (def.shell) lines.push("!`" + def.shell + "`", "");
    lines.push(def.body || "");
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  }

  function deployLoaderCommands(configDir) {
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

  function listPlugins(configDir) {
    for (const p of [join(configDir, "config", "plugins.json"), join(configDir, "plugins.json")]) {
      if (!existsSync(p)) continue;
      try {
        const arr = JSON.parse(readFileSync(p, "utf8"));
        if (!Array.isArray(arr) || !arr.length) return console.log("No plugins configured.");
        for (const e of arr) console.log(`- ${e.name}${e.enabled === false ? " (disabled)" : ""}${e.sync ? " [sync]" : ""}`);
        return;
      } catch { /* try next */ }
    }
    console.log("No plugins.json found.");
  }

  function listAccounts(configDir) {
    for (const p of [join(configDir, "config", "accounts.json"), join(configDir, "accounts.json"), join(configDir, "config", "core-auth-accounts.json"), join(configDir, "core-auth-accounts.json")]) {
      if (!existsSync(p)) continue;
      try {
        const store = JSON.parse(readFileSync(p, "utf8"));
        const lines = [];
        for (const provider of Object.keys(store)) {
          const accts = Array.isArray(store[provider]) ? store[provider] : (store[provider]?.accounts || []);
          for (const a of accts) lines.push(`- [${provider}] ${a.email || a.id}${a.enabled === false ? " (disabled)" : ""}`);
        }
        return console.log(lines.length ? lines.join("\n") : "No accounts signed in.");
      } catch { /* try next */ }
    }
    console.log("No accounts store found.");
  }

  async function maybeRunCli(configDir) {
    const argv = process.argv.slice(2);
    if (argv[0] === "config") {
      runConfigCli(plugin, argv.slice(1));
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
    return false;
  }

  return { deployLoaderCommands, maybeRunCli };
}
