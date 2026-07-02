// @ts-nocheck
// Shared in-tab account/quota menu, used by BOTH loaders' Providers tab. A
// provider's handler exports menuModel() (= core-auth buildAccountMenu); this
// renders that model natively inside the loader chrome (login, accounts, quota,
// Auto-model config) via a stack of model builders + live/suspend actions. The
// model and all its logic live in core-auth; this module only draws + drives it.
// createAccountMenu() returns an isolated instance so each tab keeps its own state.

import { existsSync } from "fs";

export function createAccountMenu() {
  // per-instance state: a stack of menu builders, plus an optional text-input field
  const nav = { active: false, cur: 0, stack: [], input: null, inputBuf: "" };

  function curMenu() { return nav.stack.length ? nav.stack[nav.stack.length - 1]() : null; }

  function selectableIdx(items, from, dir) {
    const n = items.length; if (!n) return 0;
    for (let s = 1; s <= n; s++) { const i = ((from + dir * s) % n + n) % n; if (items[i] && typeof items[i].run === "function") return i; }
    return from;
  }

  function exit(tuiApi) { nav.active = false; nav.stack = []; nav.cur = 0; nav.input = null; nav.inputBuf = ""; if (tuiApi && tuiApi.setTextInput) tuiApi.setTextInput(false); }

  function applyAction(a, tuiApi) {
    if (!a) return;
    if (a.input) {
      nav.input = a.input; nav.inputBuf = "";   // collect a line of text in-tab
      const inp = a.input;
      if (inp.background) {
        // loopback auto-capture: if the browser completes the login while this paste
        // field is still showing, apply it and drop the field (no paste needed)
        inp.background.then(function (act) {
          if (nav.input === inp && act) { nav.input = null; applyAction(act, tuiApi); if (tuiApi && tuiApi.refresh) tuiApi.refresh(); }
        }).catch(function () {});
      }
      return;
    }
    if (a.push) { nav.stack.push(a.push); const m = curMenu(); nav.cur = m ? selectableIdx(m.items, -1, 1) : 0; }
    else if (a.pop) { if (nav.stack.length > 1) { nav.stack.pop(); nav.cur = 0; } else exit(tuiApi); }
    else if (a.close) exit(tuiApi);
    // refresh / void: stay (render rebuilds)
  }

  // Load a provider handler and open its menuModel() in-tab. Falls back to a
  // provider's own menu() (suspend) when it has no model. Returns true if an
  // in-tab menu is now active.
  function open(handlerPath, tuiApi, providerId) {
    const label = providerId || "provider";
    if (!handlerPath || !existsSync(handlerPath)) { try { tuiApi.flash("No menu for " + label); } catch (e) {} return false; }
    if (!tuiApi.runBlocking || !tuiApi.setTextInput) { try { tuiApi.flash("Loader too old — update to manage providers"); } catch (e) {} return false; }
    tuiApi.runBlocking(async function () {
      try {
        const mod = await import(handlerPath);
        if (typeof mod.menuModel === "function") { nav.stack = [mod.menuModel]; const m = curMenu(); nav.cur = m ? selectableIdx(m.items, -1, 1) : 0; nav.active = true; tuiApi.setTextInput(true); }
        else if (typeof mod.menu === "function") await mod.menu();   // fallback: provider has no model, use its own menu
        else process.stdout.write(label + " has no menu.\n");
      } catch (e) { process.stdout.write("Menu failed: " + (e && e.message || e) + "\n"); }
    });
    return nav.active;
  }

  function render(h) {
    if (!nav.active) return false;
    if (nav.input) {
      h.pushBody("  " + h.BOLD + h.WHITE + "" + (nav.input.title || "Input") + h.RST, false);
      if (nav.input.message) String(nav.input.message).split("\n").forEach(function (line) { h.pushBody("  " + h.DIM + line + h.RST, false); });
      h.pushBody("", false);
      if (nav.input.pending) {
        // complete() is in flight (e.g. a slow token exchange) — show progress in
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
    h.pushBody("  " + h.BOLD + h.WHITE + "" + (menu.title || "Menu") + h.RST, false);
    if (menu.subtitle) h.pushBody("  " + h.DIM + menu.subtitle + h.RST, false);
    h.pushBody("", false);
    menu.items.forEach(function (it, i) {
      if (it.separator) { h.pushBody("", false); return; }
      if (it.kind === "heading") { h.pushBody("  " + h.BOLD + h.WHITE + "" + it.label + h.RST, false); return; }
      const sel = i === nav.cur;
      // match the loader's row style: 3-space gutter / " ❯ ", BG_SEL when selected
      const gutter = sel ? (h.ACCENT + " ❯ " + h.RST) : "   ";
      const body = sel ? (h.BG_SEL + h.BOLD + h.WHITE) : (it.color === "red" ? h.RED : h.GRAY);
      h.pushBody("  " + gutter + body + it.label + h.RST + (it.hint ? h.DIM + "  " + it.hint + h.RST : ""), sel);
    });
    h.pushFoot("  " + h.GRAY + "─".repeat(h.barW) + h.RST);
    h.pushFoot("  " + h.DIM + "^v Move   Enter Select   Esc Back" + h.RST);
    return true;
  }

  // Returns true when the key was consumed by the active menu.
  function handleKey(key, tuiApi) {
    if (!nav.active) return false;
    if (nav.input) {
      if (nav.input.pending) return true;   // complete() in flight — ignore keys until it settles
      if (key === "escape") { const inpE = nav.input; nav.input = null; if (inpE.onClose) { try { inpE.onClose(); } catch (e) {} } return true; }
      if (key === "enter") {
        // run complete() live (no suspend) and keep the field showing progress until it
        // resolves — closing instantly made the account appear ~15s later with no feedback
        const inp = nav.input, buf = nav.inputBuf || ""; inp.pending = true; nav.inputBuf = ""; if (tuiApi.refresh) tuiApi.refresh();
        Promise.resolve(inp.complete(buf)).then(function (a) { if (nav.input === inp) nav.input = null; if (inp.onClose) { try { inp.onClose(); } catch (e) {} } applyAction(a, tuiApi); if (tuiApi.refresh) tuiApi.refresh(); }).catch(function (e) { if (nav.input === inp) nav.input = null; try { tuiApi.flash(String(e && e.message || e)); } catch (x) {} if (tuiApi.refresh) tuiApi.refresh(); });
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
      let r; try { r = item.run(); } catch (e) { return true; }
      if (r && typeof r.then === "function") {
        if (item.suspend) {
          // suspend items (provider login(), proxy pickers, confirm) need a clean terminal
          tuiApi.runBlocking(async function () { try { applyAction(await r, tuiApi); } catch (e) { process.stdout.write(String(e) + "\n"); } });
        } else {
          // async non-suspend (e.g. building an in-tab login input) resolves live, in chrome
          r.then(function (a) { applyAction(a, tuiApi); if (tuiApi.refresh) tuiApi.refresh(); }).catch(function (e) { try { tuiApi.flash(String(e && e.message || e)); } catch (x) {} if (tuiApi.refresh) tuiApi.refresh(); });
        }
      } else applyAction(r, tuiApi);
      return true;
    }
    return true;   // swallow other keys while the menu owns the tab
  }

  return { isActive: () => nav.active, open, render, handleKey, exit };
}
