import { describe, it } from "vitest";
import assert from "node:assert";
import { cliDispatchCmdLines, cliDispatchShLines, tuiCandidateResolveShLines } from "../dist/wrapper.js";

describe("wrapper: cliDispatchCmdLines", () => {
  it("emits the subcommand flags then one dispatch line per candidate, in order", () => {
    const lines = cliDispatchCmdLines(["a/cli.js", "b/cli.js"]);
    assert.deepEqual(lines, [
      'set "_iscli="',
      'if "%1"=="plugins" set "_iscli=1"',
      'if "%1"=="providers" set "_iscli=1"',
      'if "%1"=="proxy" set "_iscli=1"',
      'if "%1"=="doctor" set "_iscli=1"',
      'if defined _iscli if exist "a/cli.js" ( node "a/cli.js" %* & exit /b %errorlevel% )',
      'if defined _iscli if exist "b/cli.js" ( node "b/cli.js" %* & exit /b %errorlevel% )',
    ]);
  });
});

describe("wrapper: cliDispatchShLines", () => {
  it("emits a case statement listing every candidate in the for loop", () => {
    const lines = cliDispatchShLines(["a/cli.js", "b/cli.js"]);
    assert.deepEqual(lines, [
      'case "$1" in',
      '  plugins|providers|proxy|doctor)',
      "    for c in \\",
      '      "a/cli.js" \\',
      '      "b/cli.js"; do',
      '      if [ -f "$c" ] && command -v node >/dev/null 2>&1; then exec node "$c" "$@"; fi',
      "    done ;;",
      "esac",
    ]);
  });
});

describe("wrapper: tuiCandidateResolveShLines", () => {
  it("emits a for loop resolving TUI to the first existing candidate", () => {
    const lines = tuiCandidateResolveShLines(["a/tui.js", "b/tui.js"]);
    assert.deepEqual(lines, [
      'TUI=""',
      "for candidate in \\",
      '  "a/tui.js" \\',
      '  "b/tui.js"; do',
      '  if [ -f "$candidate" ]; then TUI="$candidate"; break; fi',
      "done",
    ]);
  });
});
