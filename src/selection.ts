// Pure helpers for marketplace multi-select. Kept dependency-free so the batch
// logic is unit-testable without the TUI/config side effects.

/** The little a catalog entry must carry to be selected, so this stays independent of any one list's row. */
export interface SelectableEntry {
  /** What the entry is shown as, and its identity of last resort. */
  name: string;
  /** The repository's `owner/name`, which is the stablest identity an entry has. */
  full_name?: string;
  /** The GitHub account that owns it. */
  author?: string;
  /** The repository's own name, which is also what a clone is installed as. */
  repoName?: string;
}

/**
 * stable identity for a catalog entry, so a selection survives search filtering
 * and list refreshes (which reorder/rebuild S.marketplaceItems)
 */
export function selectionKey(item: SelectableEntry): string {
  if (item.full_name) return item.full_name;
  if (item.author && item.repoName) return item.author + "/" + item.repoName;
  return item.name;
}

/**
 * catalog entries the user selected that are NOT already installed. installedNames
 * is the list of installed plugin names; an entry counts as installed if its name
 * or repoName matches (mirrors buildMarketplaceList's installed check).
 */
export function selectedInstallables<T extends SelectableEntry>(catalog: T[], installedNames: string[], selectedMap: Record<string, boolean>): T[] {
  var res = [];
  for (var i = 0; i < catalog.length; i++) {
    var m = catalog[i];
    if (!selectedMap[selectionKey(m)]) continue;
    var repoName = m.repoName || m.name;
    if (installedNames.indexOf(m.name) !== -1 || installedNames.indexOf(repoName) !== -1) continue;
    res.push(m);
  }
  return res;
}
