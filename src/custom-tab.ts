import type { TuiApi } from "./tui.js";

// The contract a plugin's tui-extension implements to add its own tab (see tui.ts registerTab).
// It lives in its own module so both the renderer and the key router can name it without either
// importing the other.

/** The ANSI tokens a contributed tab paints with, so its rows match the active loader's theme. */
export type PaletteTokens = Record<
  "BOLD" | "WHITE" | "BG_SEL" | "RST" | "GRAY" | "DIM" | "YELLOW" | "GREEN" |
  "MAGENTA" | "CYAN" | "RED" | "ACCENT" | "OK" | "BAD" | "INFO",
  string
>;

/** What a contributed tab is told when it is asked to handle a key. */
export interface CustomTabContext {
  /** The sub-page id currently active, which is this tab's own id while it is showing. */
  pluginSubPage: string;
  /** The key-handling mode, so a tab can tell a normal frame from its own text input. */
  mode: string;
}

/** What it is told when it is asked to draw, which is the key context plus the frame's measurements. */
export interface CustomTabRenderContext extends CustomTabContext {
  /** The terminal width. */
  cols: number;
  /** The width the plugin-name column was given, so a tab lines up with the built-in ones. */
  nameW: number;
  /** The status message the frame is already showing. */
  message: string;
}

/** The helpers and palette a contributed tab draws with. */
export type CustomTabUi = PaletteTokens & {
  /** Appends one scrollable body line, saying whether it is the selected row. */
  pushBody: (line: string, selected: boolean) => void;
  /** Appends one line that stays pinned above the body. */
  pushSticky: (line: string) => void;
  /** Appends one line to the footer. */
  pushFoot: (line: string) => void;
  /** Pads text to a column width. */
  pad: (text: string, width: number) => string;
  /** Truncates text to a column width. */
  trunc: (text: string, width: number) => string;
  /** The width of a full-width separator rule. */
  barW: number;
};

/**
 * One tab a plugin contributes to the Plugins page.
 *
 * @remarks
 * Both members are optional because a tab that only renders and a tab that only reacts are both
 * legitimate, and because a tab written against an older loader must not break this one.
 */
export interface CustomTab {
  /** Its id, which is also its sub-page key and how a double registration is deduplicated. */
  id: string;
  /** The name shown in the sub-tab strip. */
  label: string;
  /** Draws the tab's frame. */
  render?: (context: CustomTabRenderContext, ui: CustomTabUi) => void;
  /**
   * Handles one key.
   *
   * @remarks
   * A custom tab owns ALL its keys, Escape included, so it can back out of its own sub-views
   * instead of the loader quitting underneath it.
   */
  handleKey?: (key: string | null, context: CustomTabContext, api: TuiApi) => void;
}
