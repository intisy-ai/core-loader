// The menu vocabulary this terminal RENDERS. A provider handler exports a `menuModel()` in this
// shape and the account menu draws it; a loader view builds an input action in the same shape for
// rows that have no provider behind them.
//
// It is declared here rather than imported because the library that builds these models sits in
// the SAME layer as this one, so neither may reference the other. What this file states is what
// this renderer needs, not a copy of anyone's contract: a model carrying more is drawn fine.

/** What an action reports when it finishes without navigating anywhere. */
export interface MenuActionResult {
  /** Whether the view redraws afterwards. */
  refresh?: boolean;
  /** The message to show. */
  flash?: string;
}

/** One prompt: a line of text collected in the tab, and what to do with it. */
export interface MenuInput {
  /** Its heading. */
  title: string;
  /** What it asks for. */
  message?: string;
  /** Whether what is typed is hidden. */
  secret?: boolean;
  /** What happens with the answer: a result, or the next step. */
  complete: (value: string) => MenuAction | Promise<MenuAction>;
  /**
   * A parallel completion that may land while the field is still showing.
   *
   * @remarks
   * A browser login finishing on its own, which drops the field rather than making the user paste
   * something they no longer need to.
   */
  background?: Promise<MenuAction | null>;
  /** Runs when the field closes, whichever way it closed. */
  onClose?: () => void;
  /** Set while `complete` is in flight, so the renderer shows progress instead of the field. */
  pending?: boolean;
  /** What that progress line says. */
  pendingLabel?: string;
}

/**
 * What one menu item does when it is chosen.
 *
 * @remarks
 * Every member is optional and they combine: an action that only flashes is as valid as one that
 * pushes a submenu, and an item whose action is nothing at all still gets acknowledged.
 */
export interface MenuAction extends MenuActionResult {
  /** A prompt to collect before anything else happens. */
  input?: MenuInput;
  /** A submenu to open. */
  push?: () => ProviderMenu;
  /** How many menus to unwind, or `true` for one. */
  pop?: boolean | number;
  /** Closes the whole menu. */
  close?: boolean;
}

/** One row of a provider menu. */
export interface ProviderMenuItem {
  /** What the row says. */
  label?: string;
  /** The secondary text after it. */
  hint?: string;
  /** How it is drawn: an ordinary row when absent, otherwise a heading, a note or a usage bar. */
  kind?: "heading" | "note" | "bar";
  /** Draws a blank spacer row instead of anything else. */
  separator?: boolean;
  /** The palette tone the label takes, which says what kind of thing the row does. */
  color?: string;
  /** How full the bar is, for a `bar` row. */
  fraction?: number;
  /** When the quota behind that bar resets. */
  reset?: string;
  /** Whether running this needs a clean terminal, so the TUI suspends itself around it. */
  suspend?: boolean;
  /** What choosing it does. A row without one is not selectable. */
  run?: () => MenuAction | Promise<MenuAction>;
}

/** One menu a provider handler builds, or a loader view stands in for one. */
export interface ProviderMenu {
  /** Its heading. */
  title?: string;
  /** The line under the heading. */
  subtitle?: string;
  /** Its rows. */
  items: ProviderMenuItem[];
  /** Fetches whatever the menu shows live, so the first frame is not blocked on the network. */
  onOpen?: () => unknown;
}
