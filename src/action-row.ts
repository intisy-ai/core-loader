// The one shape every action menu in this UI is built from. It lives alone so the four modules
// that build menus and the two that render them share it without importing each other.

/** One entry of an action menu: a key the router switches on, and the label it is shown as. */
export interface ActionRow {
  /** What the router does when this row is chosen. */
  key: string;
  /** What the row is shown as. */
  label: string;
  /** The heading this row is grouped under. */
  cat?: string;
  /** A glyph shown before the label. */
  icon?: string;
}
