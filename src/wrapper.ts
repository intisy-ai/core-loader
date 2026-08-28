// Shell fragments shared byte-for-byte between the cc and oc wrapper scripts.
// Only the app-agnostic pieces live here; the ROUTE/proxy/model-env blocks and
// the TUI invocation itself stay in each loader's own plugin.ts.

const CLI_SUBCOMMANDS = ["plugins", "providers", "proxy", "doctor"];

/**
 * The storage subdirectory names, written into the wrapper for the components that cannot read the
 * registry themselves: a shell script, and core-auth, which sits in this library's own layer and may
 * not reference core. Only names that differ from the convention are emitted, so an app that never
 * renamed anything gets no extra lines.
 */
export interface SubdirNames {
  /** What this app calls its clones directory. */
  repos?: string;
  /** What it calls its deployed-bundle directory. */
  plugin?: string;
  /** What it calls its cache directory. */
  cache?: string;
  /** What it calls its config directory. */
  config?: string;
}

const SUBDIR_ENV: Record<keyof SubdirNames, [string, string]> = {
  repos: ["HUB_REPOS_SUBDIR", "repos"],
  plugin: ["HUB_PLUGIN_SUBDIR", "plugin"],
  cache: ["HUB_CACHE_SUBDIR", "cache"],
  config: ["HUB_CONFIG_SUBDIR", "config"],
};

function changedSubdirs(names: SubdirNames): [string, string][] {
  return (Object.keys(SUBDIR_ENV) as (keyof SubdirNames)[])
    .map((kind) => [SUBDIR_ENV[kind][0], names[kind], SUBDIR_ENV[kind][1]] as const)
    .filter((entry): entry is readonly [string, string, string] => typeof entry[1] === "string" && entry[1] !== entry[2])
    .map(([envVar, value]) => [envVar, value] as [string, string]);
}

/** The Windows lines a wrapper needs to pass this home's non-default subdirectory names down. */
export function subdirEnvCmdLines(names: SubdirNames): string[] {
  return changedSubdirs(names).map(([envVar, value]) => `set "${envVar}=${value}"`);
}

/** The same, for a POSIX shell. */
export function subdirEnvShLines(names: SubdirNames): string[] {
  return changedSubdirs(names).map(([envVar, value]) => `export ${envVar}="${value}"`);
}

/**
 * cmd.exe: flag %1 as a CLI subcommand, then dispatch to the first candidate
 * node CLI script that exists on disk.
 */
export function cliDispatchCmdLines(cliCandidates: string[]): string[] {
  return [
    'set "_iscli="',
    ...CLI_SUBCOMMANDS.map((sub) => `if "%1"=="${sub}" set "_iscli=1"`),
    ...cliCandidates.map((candidate) => `if defined _iscli if exist "${candidate}" ( node "${candidate}" %* & exit /b %errorlevel% )`),
  ];
}

/**
 * POSIX sh equivalent: a case statement dispatching to the first candidate
 * node CLI script that exists on disk.
 */
export function cliDispatchShLines(cliCandidates: string[]): string[] {
  return [
    'case "$1" in',
    `  ${CLI_SUBCOMMANDS.join("|")})`,
    "    for c in \\",
    ...cliCandidates.map((candidate, index) =>
      `      "${candidate}"${index < cliCandidates.length - 1 ? " \\" : "; do"}`),
    '      if [ -f "$c" ] && command -v node >/dev/null 2>&1; then exec node "$c" "$@"; fi',
    "    done ;;",
    "esac",
  ];
}

/** POSIX sh: resolve $TUI to the first candidate TUI script that exists on disk. */
export function tuiCandidateResolveShLines(tuiCandidates: string[]): string[] {
  return [
    'TUI=""',
    "for candidate in \\",
    ...tuiCandidates.map((candidate, index) =>
      `  "${candidate}"${index < tuiCandidates.length - 1 ? " \\" : "; do"}`),
    '  if [ -f "$candidate" ]; then TUI="$candidate"; break; fi',
    "done",
  ];
}
