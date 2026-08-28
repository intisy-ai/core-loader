// Shared in-tab account/quota menu, used by BOTH loaders' Providers tab. A
// provider's handler exports menuModel() (= core-auth buildAccountMenu); this
// renders that model natively inside the loader chrome (login, accounts, quota,
// Auto-model config) via a stack of model builders + live/suspend actions. The
// model and all its logic live in core-auth; this module only draws + drives it.
// createAccountMenu() returns an isolated instance so each tab keeps its own state.

import { existsSync } from "fs";
import { pathToFileURL } from "url";
import { S } from "./state.js";
import { SPINNER_FRAMES } from "./env.js";
import type { CustomTabUi } from "./custom-tab.js";
import type { MenuAction, MenuInput, ProviderMenu, ProviderMenuItem } from "./provider-menu.js";

/** The slice of the tab api this menu drives itself through. */
export interface AccountMenuApi {
  /** Routes raw text to this tab instead of the loader's own key table. */
  setTextInput?: (on: boolean) => void;
  /** Redraws now, for work that finished off the keypress path. */
  refresh?: () => void;
  /** Shows a transient message. */
  flash?: (message: string) => void;
  /** Suspends the TUI, runs something that owns the terminal, then re-attaches input. */
  runBlocking?: (fn: () => unknown) => unknown;
}

/** What one account menu instance keeps while it is open. */
interface MenuNav {
  /** Whether the menu owns the tab. */
  active: boolean;
  /** Which row is selected. */
  cur: number;
  /** The menus that are open, innermost last. */
  stack: Array<() => ProviderMenu>;
  /** The prompt showing, when one is. */
  input: MenuInput | null;
  /** What has been typed into it. */
  inputBuf: string;
  /** The running action's spinner, when one is running. */
  busy: { label: string; tick: number } | null;
  /** That spinner's own interval. */
  busyTimer: ReturnType<typeof setInterval> | null;
  /** The hard timeout that stops a hung action animating forever. */
  busyTimeout: ReturnType<typeof setTimeout> | null;
}

const BAR_WIDTH = 22;

// Match the loader's OWN row palette exactly (same as buildPluginItem): plain
// rows are DIM; only genuinely positive/negative states use OK/BAD. No INFO/accent
// tinting of ordinary actions. The auth-login renderer (select.ts) keeps raw ANSI.
function paletteColor(color: string | undefined, h: CustomTabUi): string {
  if (color === "red") return h.BAD;                    // destructive
  if (color === "green") return h.OK;                   // positive (enabled, add)
  if (color === "yellow") return h.YELLOW;              // caution (disable, reset)
  if (color === "cyan") return h.CYAN || h.ACCENT;      // primary actions
  if (color === "magenta") return h.MAGENTA || h.ACCENT;
  return h.DIM;                                          // uncolored = plain row
}

// Usage-style bar row (filled = fraction USED), drawn in palette tones.
function pushBar(h: CustomTabUi, it: ProviderMenuItem): void {
  const frac = Math.max(0, Math.min(1, it.fraction || 0));
  const filled = Math.round(frac * BAR_WIDTH);
  const bar = h.ACCENT + "▓".repeat(filled) + h.RST + h.GRAY + "░".repeat(BAR_WIDTH - filled) + h.RST;
  h.pushBody("     " + h.BOLD + h.WHITE + it.label + h.RST + "  " + bar + " " + h.GRAY + Math.round(frac * 100) + "% used" + h.RST, false);
  if (it.reset) h.pushBody("     " + h.GRAY + "Resets " + it.reset + h.RST, false);
}

/** One isolated account menu, so each tab that opens one keeps its own navigation and input state. */
export function createAccountMenu() {
  // per-instance state: a stack of menu builders, plus an optional text-input field
  const nav: MenuNav = { active: false, cur: 0, stack: [], input: null, inputBuf: "", busy: null, busyTimer: null, busyTimeout: null };

  // Self-contained busy indicator for async in-tab actions. Owns its OWN animation
  // interval + tuiApi.refresh (not the global updateSpinner, which doesn't reliably
  // drive this in-tab menu) and a hard timeout so a hung action never freezes the
  // spinner forever. The spinner ticks only while the event loop is free, which it is
  // for the network actions this runs (refresh/verify/quota).
  function stopBusy() {
    if (nav.busyTimer) { clearInterval(nav.busyTimer); nav.busyTimer = null; }
    if (nav.busyTimeout) { clearTimeout(nav.busyTimeout); nav.busyTimeout = null; }
    nav.busy = null;
  }
  function startBusy(label: string, tuiApi: AccountMenuApi): void {
    stopBusy();
    nav.busy = { label: label, tick: 0 };
    nav.busyTimer = setInterval(function () { if (nav.busy) { nav.busy.tick++; tuiApi.refresh?.(); } }, 100);
    if (nav.busyTimer && nav.busyTimer.unref) nav.busyTimer.unref();
    nav.busyTimeout = setTimeout(function () { if (nav.busy) { stopBusy(); try { tuiApi.flash?.(label + " timed out"); } catch (e) {} tuiApi.refresh?.(); } }, 30000);
    if (nav.busyTimeout && nav.busyTimeout.unref) nav.busyTimeout.unref();
    tuiApi.refresh?.();
  }

  function curMenu() { return nav.stack.length ? nav.stack[nav.stack.length - 1]() : null; }

  function selectableIdx(items: ProviderMenuItem[], from: number, dir: number): number {
    const n = items.length; if (!n) return 0;
    for (let s = 1; s <= n; s++) { const i = ((from + dir * s) % n + n) % n; if (items[i] && typeof items[i].run === "function") return i; }
    return from;
  }

  function exit(tuiApi: AccountMenuApi): void { stopBusy(); nav.active = false; nav.stack = []; nav.cur = 0; nav.input = null; nav.inputBuf = ""; tuiApi.setTextInput?.(false); }

  function applyAction(a: MenuAction | null | undefined, tuiApi: AccountMenuApi): void {
    if (!a) return;
    if (a.input) {
      nav.input = a.input; nav.inputBuf = "";   // collect a line of text in-tab
      const inp = a.input;
      if (inp.background) {
        // loopback auto-capture: if the browser completes the login while this paste
        // field is still showing, apply it and drop the field (no paste needed)
        inp.background.then(function (act: MenuAction | null) {
          if (nav.input === inp && act) { nav.input = null; applyAction(act, tuiApi); tuiApi.refresh?.(); }
        }).catch(function () {});
      }
      return;
    }
    if (a.push) { nav.stack.push(a.push); const m = curMenu(); nav.cur = m ? selectableIdx(m.items, -1, 1) : 0; }
    else if (a.pop) {
      // pop may be a count (e.g. a confirm menu unwinding itself + the deleted subject's menu)
      const n = a.pop === true ? 1 : Math.max(1, a.pop | 0);
      for (let i = 0; i < n; i++) { if (nav.stack.length > 1) { nav.stack.pop(); nav.cur = 0; } else { exit(tuiApi); break; } }
    }
    else if (a.close) exit(tuiApi);
    // refresh / void: stay (render rebuilds)
  }


  // Runs a menu ACTION on its own, without a provider handler behind it: the Providers view
  // offers rows of its own (adding a custom provider) and they need the same in-tab input
  // field, chaining and feedback as any provider menu item. A step that asks for nothing more
  // closes the panel instead of leaving an empty menu on screen.
  function closeOnFinish(action: MenuAction | null | undefined): MenuAction | null | undefined {
    if (!action || !action.input) return action;
    const step = action.input;
    return {
      input: {
        ...step,
        complete: function (value: string): Promise<MenuAction> {
          return Promise.resolve(step.complete(value)).then(function (next): MenuAction {
            if (next && next.input) return closeOnFinish(next) as MenuAction;
            return { close: true, flash: next && next.flash };
          });
        },
      },
    };
  }

  function openAction(action: MenuAction | null | undefined, tuiApi: AccountMenuApi, title?: string): boolean {
    if (!action) return false;
    if (!tuiApi.setTextInput) { try { tuiApi.flash?.("Loader too old - update to manage providers"); } catch (e) {} return false; }
    nav.stack = [function () { return { title: title || "", items: [] }; }];
    nav.cur = 0;
    nav.active = true;
    tuiApi.setTextInput?.(true);
    applyAction(closeOnFinish(action), tuiApi);
    return true;
  }

  // Load a provider handler and open its menuModel() in-tab. Falls back to a
  // provider's own menu() (suspend) when it has no model. Returns true if an
  // in-tab menu is now active.
  function open(handlerPath: string, tuiApi: AccountMenuApi, providerId?: string): boolean {
    const label = providerId || "provider";
    if (!handlerPath || !existsSync(handlerPath)) { try { tuiApi.flash?.("No menu for " + label); } catch (e) {} return false; }
    if (!tuiApi.runBlocking || !tuiApi.setTextInput) { try { tuiApi.flash?.("Loader too old - update to manage providers"); } catch (e) {} return false; }
    tuiApi.runBlocking?.(async function () {
      try {
        // pathToFileURL: a raw Windows path (C:\...) is not a valid import specifier
        // ("protocol 'c:'"), so the account menu silently failed to open on Windows.
        const mod = await import(pathToFileURL(handlerPath).href);
        if (typeof mod.menuModel === "function") {
          nav.stack = [mod.menuModel]; const m = curMenu(); nav.cur = m ? selectableIdx(m.items, -1, 1) : 0; nav.active = true; tuiApi.setTextInput?.(true);
          // let the menu fetch live data (e.g. quota) then re-render so bars appear
          if (m && typeof m.onOpen === "function") Promise.resolve(m.onOpen()).then(function () { tuiApi.refresh?.(); }).catch(function () {});
        }
        else if (typeof mod.menu === "function") await mod.menu();   // fallback: provider has no model, use its own menu
        else process.stdout.write(label + " has no menu.\n");
      } catch (e) { process.stdout.write("Menu failed: " + (e instanceof Error ? e.message : e) + "\n"); }
    });
    return nav.active;
  }

  function render(h: CustomTabUi & { pushSticky?: CustomTabUi["pushBody"] }): boolean {
    if (!nav.active) return false;
    if (nav.input) {
      h.pushBody("  " + h.BOLD + h.WHITE + "" + (nav.input.title || "Input") + h.RST, false);
      if (nav.input.message) String(nav.input.message).split("\n").forEach(function (line) { h.pushBody("  " + h.DIM + line + h.RST, false); });
      h.pushBody("", false);
      if (nav.input.pending) {
        // complete() is in flight (e.g. a slow token exchange); show progress in
        // place of the field instead of closing the menu and surfacing later
        h.pushBody("  " + h.ACCENT + (nav.input.pendingLabel || "Working…") + h.RST, false);
        h.pushFoot("  " + h.GRAY + "─".repeat(h.barW) + h.RST);
        h.pushFoot("  " + h.DIM + "Please wait…" + h.RST);
        return true;
      }
      h.pushBody("  " + h.ACCENT + "❯ " + h.RST + h.WHITE + (nav.inputBuf || "") + h.RST + h.DIM + "_" + h.RST, false);
      h.pushFoot("  " + h.GRAY + "─".repeat(h.barW) + h.RST);
      h.pushFoot("  " + h.DIM + "Paste, then Enter   Esc Cancel" + h.RST);
      return true;
    }
    const menu = curMenu();
    if (!menu) { nav.active = false; return false; }
    // Pin the title/subtitle so they stay visible while the accounts list scrolls
    // (falls back to pushBody when the host's h object predates the sticky region).
    const pushSticky = h.pushSticky || h.pushBody;
    pushSticky("  " + h.BOLD + h.WHITE + "" + (menu.title || "Menu") + h.RST, false);
    if (menu.subtitle) pushSticky("  " + h.GRAY + menu.subtitle + h.RST, false);
    pushSticky("", false);
    menu.items.forEach(function (it: ProviderMenuItem, i: number) {
      if (it.separator) { h.pushBody("", false); return; }
      // headings + secondary text use GRAY like the loader's own rows (buildPluginItem).
      if (it.kind === "heading") { h.pushBody("  " + h.BOLD + h.WHITE + it.label + h.RST + (it.hint ? h.GRAY + "  " + it.hint + h.RST : ""), false); return; }
      if (it.kind === "note") { h.pushBody("     " + h.GRAY + it.label + h.RST, false); return; }
      if (it.kind === "bar") { pushBar(h, it); return; }
      const sel = i === nav.cur;
      // identical construction to buildPluginItem: BG_SEL wraps the arrow gutter,
      // the name is BOLD+WHITE when selected / paletteColor otherwise, hint in GRAY.
      const bg = sel ? h.BG_SEL : "";
      const arrow = sel ? (h.ACCENT + " ❯ " + h.RST) : "   ";
      const nameStyle = sel ? (h.BOLD + h.WHITE) : paletteColor(it.color, h);
      h.pushBody("  " + bg + arrow + nameStyle + it.label + h.RST + (it.hint ? h.GRAY + "  " + it.hint + h.RST : ""), sel);
    });
    h.pushFoot("  " + h.GRAY + "─".repeat(h.barW) + h.RST);
    // Show the transient flash (set by tuiApi.flash, e.g. "Models refreshed (N)") so
    // action feedback is visible INSIDE the account menu (which draws its own footer and
    // would otherwise swallow S.message).
    if (nav.busy) {
      // an async action is running; our own interval animates this frame + re-renders
      h.pushFoot("  " + h.ACCENT + SPINNER_FRAMES[nav.busy.tick % SPINNER_FRAMES.length] + " " + nav.busy.label + "…" + h.RST);
    } else if (S.message) {
      h.pushFoot("  " + h.ACCENT + S.message + h.RST);
    }
    h.pushFoot("  " + h.GRAY + "^v Move   Enter Select   Esc Back" + h.RST);
    return true;
  }

  // Returns true when the key was consumed by the active menu.
  function handleKey(key: string | null, tuiApi: AccountMenuApi): boolean {
    if (!nav.active) return false;
    if (nav.input) {
      if (nav.input.pending) return true;   // complete() in flight, ignore keys until it settles
      if (key === "escape") { const inpE = nav.input; nav.input = null; if (inpE.onClose) { try { inpE.onClose(); } catch (e) {} } return true; }
      if (key === "enter") {
        // run complete() live (no suspend) and keep the field showing progress until it
        // resolves; closing instantly makes the account appear ~15s later with no feedback
        const inp = nav.input, buf = nav.inputBuf || ""; inp.pending = true; nav.inputBuf = ""; tuiApi.refresh?.();
        Promise.resolve(inp.complete(buf)).then(function (a) { if (nav.input === inp) nav.input = null; if (inp.onClose) { try { inp.onClose(); } catch (e) {} } applyAction(a, tuiApi); tuiApi.refresh?.(); }).catch(function (e) { if (nav.input === inp) nav.input = null; try { tuiApi.flash?.(String(e instanceof Error ? e.message : e)); } catch (x) {} tuiApi.refresh?.(); });
        return true;
      }
      if (key === "backspace") { nav.inputBuf = (nav.inputBuf || "").slice(0, -1); return true; }
      if (key === "up" || key === "down" || key === "left" || key === "right" || key === "tab") return true;  // ignore nav keys
      if (typeof key === "string") { nav.inputBuf = (nav.inputBuf || "") + key; return true; }    // printable / paste
      return true;
    }
    const menu = curMenu();
    if (!menu) { exit(tuiApi); return true; }
    if (key === "escape") { applyAction({ pop: true }, tuiApi); return true; }
    if (key === "up" || key === "w") { nav.cur = selectableIdx(menu.items, nav.cur, -1); return true; }
    if (key === "down" || key === "s") { nav.cur = selectableIdx(menu.items, nav.cur, 1); return true; }
    if (key === "enter") {
      const item = menu.items[nav.cur];
      if (!item || typeof item.run !== "function") return true;
      // Always give feedback: prefer an action's own {flash}; otherwise, when it doesn't
      // navigate to another menu/input (push/pop/input/close), acknowledge the item so no
      // click ever feels dead. Errors always flash.
      const ack = function (a: MenuAction | null | undefined) {
        try {
          if (a && a.flash) tuiApi.flash?.(a.flash);
          else if (!a || (!a.push && !a.input && !a.pop && !a.close)) tuiApi.flash?.((item.label || "Done") + " ✓");
          else S.message = "";   // navigating action: clear any busy spinner (no flash)
        } catch (e) {}
      };
      var fail = function (e: unknown) { try { tuiApi.flash?.("Failed: " + (e instanceof Error ? e.message : e)); } catch (x) {} };
      if (item.suspend) {
        // suspend items (provider login(), proxy pickers, confirm) need a clean terminal.
        // run() must start INSIDE runBlocking: an async run() executes up to its first await
        // synchronously, and a confirm()/select() there grabs raw stdin, which runBlocking
        // would then clobber (setRawMode(false) + pause), freezing the prompt.
        const runSuspended = item.run;
        tuiApi.runBlocking?.(async function () { try { const a = await runSuspended(); applyAction(a, tuiApi); ack(a); } catch (e) { fail(e); } });
        return true;
      }
      let r: MenuAction | Promise<MenuAction>;
      try { r = item.run(); } catch (e) { fail(e); return true; }
      // Duck-typed, never `instanceof Promise`: a provider handler is bundled separately, so its
      // promise can come from another realm and would fail an identity check.
      const promised = r && typeof (r as Promise<MenuAction>).then === "function" ? (r as Promise<MenuAction>) : null;
      if (promised) {
        // async non-suspend (refresh/verify/build-login-input) resolves live, in chrome.
        // Animated busy spinner while it runs (own interval) so a slow network call never
        // looks dead; on settle stopBusy() + ack() shows the result flash (or clears it).
        startBusy(item.label || "Working", tuiApi);
        promised.then(function (a: MenuAction) { stopBusy(); applyAction(a, tuiApi); ack(a); tuiApi.refresh?.(); }).catch(function (e: unknown) { stopBusy(); fail(e); tuiApi.refresh?.(); });
      } else { applyAction(r as MenuAction, tuiApi); ack(r as MenuAction); }
      return true;
    }
    return true;   // swallow other keys while the menu owns the tab
  }

  return {
    /** Whether the menu currently owns the tab. */
    isActive: () => nav.active,
    /** Loads a provider handler and opens the menu it builds. */
    open,
    /** Opens one chained prompt with no provider behind it. */
    openAction,
    /** Draws the active menu, answering whether it drew anything at all. */
    render,
    /** Handles one key, answering whether the menu consumed it. */
    handleKey,
    /** Closes the menu and hands the tab back. */
    exit,
  };
}
