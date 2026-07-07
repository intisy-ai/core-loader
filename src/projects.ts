// @ts-nocheck
// Project list: query recent projects (Claude history.jsonl or the opencode
// DB), build the display list, and the pin/hide/change-path actions.

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { APP_NAME, CONFIG_DIR, DB_PATH, HOME } from "./env.js";
import { S } from "./state.js";
import { loadConfig, saveConfig } from "./config.js";
import { cleanup } from "./out.js";
import { flash } from "./views/common.js";

// Lazy sqlite: node's built-in (node 22+) first, bun:sqlite fallback. Loaded lazily
// (NOT a top-level import) so the loader TUI runs under plain `node` — no bun required.
// Returns { query(sql) -> stmt with .all(), close() } or null if neither is available.
function openSqlite(path) {
  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(path, { readOnly: true });
    return { query: (sql) => db.prepare(sql), close: () => db.close() };
  } catch {}
  try {
    const { Database } = require("bun:sqlite");
    const db = new Database(path, { readonly: true });
    return { query: (sql) => db.query(sql), close: () => db.close() };
  } catch {}
  return null;
}

// Parse Claude history.jsonl TEXT into entries, skipping blank/malformed lines. Pure.
export function parseHistoryText(text) {
  var out = [];
  var lines = String(text || "").split("\n");
  for (var i = 0; i < lines.length; i++) {
    if (!lines[i]) continue;
    try { out.push(JSON.parse(lines[i])); } catch (e) {}
  }
  return out;
}

export function queryProjects() {
  if (APP_NAME === "Claude Code") {
    var historyPath = join(CONFIG_DIR, "history.jsonl");
    if (!existsSync(historyPath)) return [];
    try {
      var entries = parseHistoryText(readFileSync(historyPath, "utf8"));
      var projects = {};
      for (var ei = 0; ei < entries.length; ei++) {
        var parsed = entries[ei];
        if (parsed && parsed.project) {
          if (!projects[parsed.project]) {
            projects[parsed.project] = { last_used: 0, sessions: new Set() };
          }
          if (parsed.timestamp > projects[parsed.project].last_used) {
            projects[parsed.project].last_used = parsed.timestamp;
          }
          if (parsed.sessionId) {
            projects[parsed.project].sessions.add(parsed.sessionId);
          }
        }
      }
      return Object.keys(projects).map(function(dir) {
        return {
          directory: dir,
          last_used: projects[dir].last_used,
          sessions: projects[dir].sessions.size
        };
      }).sort(function(a, b) { return b.last_used - a.last_used; }).slice(0, 30);
    } catch (e) { return []; }
  }

  if (!existsSync(DB_PATH)) return [];
  try {
    var db = openSqlite(DB_PATH);
    if (!db) return [];
    var rows = db.query(
      "SELECT directory, MAX(time_updated) as last_used, COUNT(*) as sessions " +
      "FROM session WHERE parent_id IS NULL GROUP BY directory ORDER BY last_used DESC LIMIT 30"
    ).all();
    db.close();
    return rows;
  } catch (e) { return []; }
}

// Group Claude history entries into per-session summaries for ONE project dir.
// Pure (no I/O) so it is unit-testable. entries: parsed history.jsonl objects
// ({project, sessionId, display, timestamp}). Returns newest-first; title = the
// session's EARLIEST prompt (what it was about).
export function groupSessions(entries, dir) {
  var groups = {};
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (!e || e.project !== dir || !e.sessionId) continue;
    var g = groups[e.sessionId];
    if (!g) { g = groups[e.sessionId] = { id: e.sessionId, title: "", lastUsed: 0, count: 0, firstTs: Infinity }; }
    g.count++;
    var ts = typeof e.timestamp === "number" ? e.timestamp : (Date.parse(e.timestamp) || 0);
    if (ts > g.lastUsed) g.lastUsed = ts;
    if (ts <= g.firstTs && typeof e.display === "string" && e.display) { g.firstTs = ts; g.title = e.display; }
  }
  var out = Object.keys(groups).map(function (k) {
    var g = groups[k];
    return { id: g.id, title: g.title || "(no prompt)", lastUsed: g.lastUsed, count: g.count };
  });
  out.sort(function (a, b) { return b.lastUsed - a.lastUsed; });
  return out;
}

// Pure: sessions for one dir from raw history TEXT, Claude only. Unit-testable, no I/O.
export function sessionsFromHistory(text, dir, appName) {
  if (appName !== "Claude Code") return [];
  return groupSessions(parseHistoryText(text), dir);
}

// Thin I/O shell: read history.jsonl (empty on any failure) and delegate.
export function querySessions(dir) {
  var historyPath = join(CONFIG_DIR, "history.jsonl");
  var text = "";
  try { if (existsSync(historyPath)) text = readFileSync(historyPath, "utf8"); } catch (e) {}
  return sessionsFromHistory(text, dir, APP_NAME);
}

export function shortPath(dir) {
  var h = HOME.replace(/\\/g, "/");
  var d = dir.replace(/\\/g, "/");
  if (d.startsWith(h)) d = "~" + d.substring(h.length);
  return d;
}

export function buildList() {
  var cfg = loadConfig();
  var rows = queryProjects();
  var list = [];

  var pinnedItems = [];
  for (var dir of cfg.pinned) {
    var row = rows.find(function(r) { return r.directory === dir; });
    if (cfg.hidden.indexOf(dir) !== -1) continue;
    pinnedItems.push({
      dir: dir,
      name: dir.split(/[\\/]/).pop() || dir,
      sessions: row ? row.sessions : 0,
      lastUsed: row ? row.last_used : 0,
      pinned: true
    });
  }
  pinnedItems.sort(function(a, b) { return (b.lastUsed || 0) - (a.lastUsed || 0); });
  for (var pi = 0; pi < pinnedItems.length; pi++) { list.push(pinnedItems[pi]); }

  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (cfg.pinned.indexOf(r.directory) !== -1) continue;
    if (cfg.hidden.indexOf(r.directory) !== -1) continue;
    list.push({
      dir: r.directory,
      name: r.directory.split(/[\\/]/).pop() || r.directory,
      sessions: r.sessions,
      lastUsed: r.last_used,
      pinned: false
    });
  }
  if (S.inputBuf) {
    var q = S.inputBuf.toLowerCase();
    list = list.filter(function(m) { return (m.name||"").toLowerCase().indexOf(q) !== -1 || (m.desc||"").toLowerCase().indexOf(q) !== -1; });
  }
  return list;
}

export function getActions(item) {
  var a = [
    { key: "open", label: "Open in " + APP_NAME, icon: ">" },
  ];
  if (item.pinned) {
    a.push({ key: "unpin", label: "Unpin from favorites", icon: "x" });
  } else {
    a.push({ key: "pin", label: "Pin to favorites", icon: "*" });
  }
  a.push({ key: "hide", label: "Hide from list", icon: "-" });
  a.push({ key: "chpath", label: "Change path", icon: "~" });
  a.push({ key: "unhide", label: "Show hidden projects", icon: "+" });
  a.push({ key: "cancel", label: "Cancel", icon: "<" });
  return a;
}

export function outputDir(dir) {
  var outFile = process.env.HUB_OUTPUT || process.env.OC_OUTPUT || process.env.CC_OUTPUT;
  if (outFile) {
    writeFileSync(outFile, dir, "utf-8");
  } else {
    process.stdout.write(dir);
  }
}

export function openProject(item) {
  cleanup();
  outputDir(item.dir);
  process.exit(0);
}

// Exact cc-wrapper payload: dir alone (new session) or dir + LF + sessionId (resume).
// Pure so the cross-repo contract with the cc wrapper is unit-testable.
export function sessionPayload(dir, sessionId) {
  return sessionId ? (dir + "\n" + sessionId) : dir;
}

// Emit the launch payload for the cc wrapper: line 1 = dir, optional line 2 =
// sessionId. A null/empty id writes the dir alone (identical to openProject, so
// the wrapper starts a fresh session). Uses the same CC_OUTPUT channel.
export function openProjectSession(dir, sessionId) {
  cleanup();
  outputDir(sessionPayload(dir, sessionId));
  process.exit(0);
}

export function togglePin(idx) {
  var item = S.items[idx];
  var cfg = loadConfig();
  if (item.pinned) {
    cfg.pinned = cfg.pinned.filter(function(d) { return d !== item.dir; });
    flash("Unpinned: " + item.name);
  } else {
    cfg.pinned.push(item.dir);
    flash("Pinned: " + item.name);
  }
  saveConfig(cfg);
  S.items = buildList();
  if (S.cursor >= S.items.length) S.cursor = Math.max(0, S.items.length - 1);
}

export function hideItem(idx) {
  var item = S.items[idx];
  var cfg = loadConfig();
  if (cfg.hidden.indexOf(item.dir) === -1) cfg.hidden.push(item.dir);
  cfg.pinned = cfg.pinned.filter(function(d) { return d !== item.dir; });
  saveConfig(cfg);
  flash("Hidden: " + item.name);
  S.items = buildList();
  if (S.cursor >= S.items.length) S.cursor = Math.max(0, S.items.length - 1);
}

export function unhideAll() {
  var cfg = loadConfig();
  var count = cfg.hidden.length;
  cfg.hidden = [];
  saveConfig(cfg);
  flash("Restored " + count + " hidden project(s)");
  S.items = buildList();
  if (S.cursor >= S.items.length) S.cursor = Math.max(0, S.items.length - 1);
}

export function getProjectId(dir) {
  try {
    var root = execSync("git rev-list --max-parents=0 HEAD", { cwd: dir, encoding: "utf-8", timeout: 5000 });
    var lines = root.trim().split("\n").filter(Boolean).map(function(x) { return x.trim(); }).sort();
    return lines[0] || null;
  } catch (e) { return null; }
}

export function changeProjectPath(oldDir, newDir) {
  if (!existsSync(DB_PATH)) { flash("DB not found"); return; }
  try {
    var db = new Database(DB_PATH);
    var count = db.query("SELECT COUNT(*) as c FROM session WHERE directory = ?").get(oldDir);
    if (!count || count.c === 0) { db.close(); flash("No sessions at old path"); return; }

    var oldSess = db.query("SELECT project_id FROM session WHERE directory = ? LIMIT 1").get(oldDir);
    var oldPid = oldSess.project_id;
    var newPid = getProjectId(newDir);

    if (newPid) {
      var existing = db.query("SELECT id FROM project WHERE id = ?").get(newPid);
      if (existing) {
        db.run("UPDATE session SET project_id = ?, directory = ? WHERE directory = ?", [newPid, newDir, oldDir]);
      } else if (oldPid !== "global") {
        db.run("UPDATE project SET id = ?, worktree = ? WHERE id = ?", [newPid, newDir, oldPid]);
        db.run("UPDATE session SET project_id = ?, directory = ? WHERE directory = ?", [newPid, newDir, oldDir]);
      } else {
        var now = Date.now();
        db.run("INSERT OR IGNORE INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES (?, ?, ?, ?, '[]')", [newPid, newDir, now, now]);
        db.run("UPDATE session SET project_id = ?, directory = ? WHERE directory = ?", [newPid, newDir, oldDir]);
      }
      try {
        var gitDir = join(newDir, ".git");
        if (existsSync(gitDir)) writeFileSync(join(gitDir, "opencode"), newPid);
      } catch (e) {}
    } else {
      db.run("UPDATE session SET project_id = 'global', directory = ? WHERE directory = ?", [newDir, oldDir]);
    }

    if (oldPid !== "global" && oldPid !== newPid) {
      var rem = db.query("SELECT COUNT(*) as c FROM session WHERE project_id = ?").get(oldPid);
      if (!rem || rem.c === 0) db.run("DELETE FROM project WHERE id = ?", [oldPid]);
    }

    db.close();
    var cfg = loadConfig();
    var pidx = cfg.pinned.indexOf(oldDir);
    if (pidx !== -1) cfg.pinned[pidx] = newDir;
    var hidx = cfg.hidden.indexOf(oldDir);
    if (hidx !== -1) cfg.hidden[hidx] = newDir;
    saveConfig(cfg);
    flash("Moved " + count.c + " sessions to new path");
    S.items = buildList();
    if (S.cursor >= S.items.length) S.cursor = Math.max(0, S.items.length - 1);
  } catch (e) {
    flash("Error: " + (e.message || e));
  }
}

