// The Libraries tab: what is actually resolvable from this home. The shared store holds the
// libraries plugins stopped inlining, so a plugin that will not load is usually one whose
// library is missing or at the wrong version, and that is invisible everywhere else.
//
// The reading comes from the plugin manager, which is the thing that fills the store; the loader
// keeps no second copy of the rules. Without the manager there is no store to read.

import { CONFIG_DIR } from "../env.js";
import { getUpdater } from "../updater.js";
import type { HomeLibraries, LibraryReading } from "../plugin-manager.js";
import type { CustomTab, CustomTabUi } from "../custom-tab.js";

function readLibraries(): HomeLibraries | null {
  var updater = getUpdater();
  if (!updater || typeof updater.homeLibraries !== "function") return null;
  try {
    return updater.homeLibraries(CONFIG_DIR);
  } catch (e) {
    return null;
  }
}

function versionLabel(library: LibraryReading, api: CustomTabUi): string {
  if (library.version) return api.GRAY + library.version + api.RST;
  return api.RED + "missing" + api.RST;
}

/** The Libraries tab, contributed the same way a plugin contributes one. */
export var librariesTab: CustomTab = {
  id: "libraries",
  label: "Libraries",
  render: function(ctx, api) {
    var reading = readLibraries();
    if (!reading) {
      api.pushBody("  " + api.GRAY + "Install a plugin manager to see what is installed here." + api.RST, false);
      api.pushFoot("  " + api.DIM + "tab switch · q quit" + api.RST);
      return;
    }

    var pluginCount = reading.plugins.length;
    api.pushSticky("  " + api.BOLD + api.WHITE + "Libraries" + api.RST + " " + api.GRAY
      + "(" + reading.shared.length + " shared, " + pluginCount + (pluginCount === 1 ? " plugin" : " plugins") + ")" + api.RST);

    if (reading.shared.length > 0) {
      api.pushBody("", false);
      api.pushBody("  " + api.DIM + "SHARED" + api.RST, false);
      for (var i = 0; i < reading.shared.length; i++) {
        var library = reading.shared[i];
        var users = library.usedBy.length > 0 ? library.usedBy.join(", ") : "unused";
        api.pushBody("  " + api.pad(api.trunc(library.specifier, ctx.nameW), ctx.nameW) + "  "
          + versionLabel(library, api) + "  " + api.DIM + users + api.RST, false);
      }
    }

    for (var p = 0; p < reading.plugins.length; p++) {
      var group = reading.plugins[p];
      api.pushBody("", false);
      api.pushBody("  " + api.DIM + group.plugin.toUpperCase() + api.RST, false);
      for (var d = 0; d < group.dependencies.length; d++) {
        var dependency = group.dependencies[d];
        api.pushBody("  " + api.pad(api.trunc(dependency.specifier, ctx.nameW), ctx.nameW) + "  "
          + versionLabel(dependency, api), false);
      }
    }

    if (reading.shared.length === 0 && pluginCount === 0) {
      api.pushBody("  " + api.GRAY + "Nothing installed in this home yet." + api.RST, false);
    }
    api.pushFoot("  " + api.DIM + "tab switch · q quit" + api.RST);
  },
};
