// A keypress in a text-input mode is content the user is typing (a config value, a
// URL, a token), and the cause is stamped onto every event that keypress produces,
// so only the page and mode are recorded there. In list mode the key is a command
// and worth keeping.
export function inputCause(page: unknown, mode: unknown, key: unknown): { kind: string; surface: string; detail?: string } {
  const typing = !!mode && mode !== "list";
  const cause: { kind: string; surface: string; detail?: string } = {
    kind: "user",
    surface: String(page || "") + (typing ? " > " + String(mode) : ""),
  };
  if (!typing && key) cause.detail = String(key);
  return cause;
}
