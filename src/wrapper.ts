// Shell fragments shared byte-for-byte between the cc and oc wrapper scripts.
// Only the app-agnostic pieces live here; the ROUTE/proxy/model-env blocks and
// the TUI invocation itself stay in each loader's own plugin.ts.

const CLI_SUBCOMMANDS = ["plugins", "providers", "proxy", "doctor"];

// cmd.exe: flag %1 as a CLI subcommand, then dispatch to the first candidate
// node CLI script that exists on disk.
export function cliDispatchCmdLines(cliCandidates: string[]): string[] {
  return [
    'set "_iscli="',
    ...CLI_SUBCOMMANDS.map((sub) => `if "%1"=="${sub}" set "_iscli=1"`),
    ...cliCandidates.map((candidate) => `if defined _iscli if exist "${candidate}" ( node "${candidate}" %* & exit /b %errorlevel% )`),
  ];
}

// POSIX sh equivalent: a case statement dispatching to the first candidate
// node CLI script that exists on disk.
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

// POSIX sh: resolve $TUI to the first candidate TUI script that exists on disk.
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
