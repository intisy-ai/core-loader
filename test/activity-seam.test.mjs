import { describe, it, afterEach } from "vitest";
import assert from "node:assert";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const seam = require("../dist/activity-seam.js");

describe("activity-seam", () => {
  afterEach(() => seam.setActivitySeam(null));

  it("is a harmless no-op with no seam installed", () => {
    assert.doesNotThrow(() => seam.emitLoaderActivity({ topic: "t", action: "a" }));
    assert.deepStrictEqual(seam.loaderActivityEnv(), {});
    assert.strictEqual(seam.withLoaderCause({ kind: "user" }, () => 7), 7);
  });

  it("forwards emits, scopes, and env to the installed seam", () => {
    const emitted = [];
    const causes = [];
    seam.setActivitySeam({
      emit: (spec) => emitted.push(spec),
      scope: (cause, fn) => { causes.push(cause); return fn(); },
      env: () => ({ HUB_ACTIVITY_TRACE: "abc" }),
    });

    assert.strictEqual(seam.withLoaderCause({ kind: "user", surface: "plugins" }, () => 42), 42);
    seam.emitLoaderActivity({ topic: "t", action: "a" });

    assert.deepStrictEqual(causes, [{ kind: "user", surface: "plugins" }]);
    assert.strictEqual(emitted.length, 1);
    assert.deepStrictEqual(seam.loaderActivityEnv(), { HUB_ACTIVITY_TRACE: "abc" });
  });

  it("still runs the action when the seam itself is broken", () => {
    let ran = 0;
    seam.setActivitySeam({
      emit: () => { throw new Error("emit boom"); },
      scope: () => { throw new Error("scope boom"); },
      env: () => { throw new Error("env boom"); },
    });

    assert.strictEqual(seam.withLoaderCause({ kind: "user" }, () => { ran++; return "ok"; }), "ok");
    assert.strictEqual(ran, 1);
    assert.doesNotThrow(() => seam.emitLoaderActivity({ topic: "t", action: "a" }));
    assert.deepStrictEqual(seam.loaderActivityEnv(), {});
  });

  it("propagates an error the action itself throws", () => {
    seam.setActivitySeam({ scope: (cause, fn) => fn() });
    assert.throws(() => seam.withLoaderCause({ kind: "user" }, () => { throw new Error("action boom"); }), /action boom/);
  });

  it("emits an activation as a startup cause carrying the plugin's own name", () => {
    const emitted = [];
    seam.setActivitySeam({ emit: (spec) => emitted.push(spec) });
    seam.emitPluginActivated("some-loader", { version: "1.2.3" });

    assert.strictEqual(emitted[0].topic, "plugin.activated");
    assert.strictEqual(emitted[0].action, "activated");
    assert.strictEqual(emitted[0].cause.kind, "startup");
    assert.strictEqual(emitted[0].subject.id, "some-loader");
    assert.strictEqual(emitted[0].details.version, "1.2.3");
  });

  it("returns the action's own value when the scope throws AFTER the action already succeeded", () => {
    let calls = 0;
    seam.setActivitySeam({ scope: (cause, fn) => { fn(); throw new Error("boom-after"); } });

    let result;
    assert.doesNotThrow(() => {
      result = seam.withLoaderCause({ kind: "user" }, () => { calls++; return "computed-value"; });
    });
    assert.strictEqual(result, "computed-value");
    assert.strictEqual(calls, 1);
  });

  it("still runs the action exactly once when the scope returns without ever invoking fn", () => {
    let calls = 0;
    seam.setActivitySeam({ scope: () => undefined });

    const result = seam.withLoaderCause({ kind: "user" }, () => { calls++; return "R"; });
    assert.strictEqual(result, "R");
    assert.strictEqual(calls, 1);
  });

  it("propagates an error the action itself throws, having run the action exactly once", () => {
    let calls = 0;
    seam.setActivitySeam({ scope: (cause, fn) => fn() });

    assert.throws(
      () => seam.withLoaderCause({ kind: "user" }, () => { calls++; throw new Error("action boom"); }),
      /action boom/,
    );
    assert.strictEqual(calls, 1);
  });

  it("runs the action exactly once, unscoped, when the scope throws before ever calling fn", () => {
    let calls = 0;
    seam.setActivitySeam({ scope: () => { throw new Error("scope boom"); } });

    const result = seam.withLoaderCause({ kind: "user" }, () => { calls++; return "ok"; });
    assert.strictEqual(result, "ok");
    assert.strictEqual(calls, 1);
  });

  it("does not let a scope's own return value override the action's result", () => {
    let calls = 0;
    seam.setActivitySeam({ scope: (cause, fn) => { fn(); return "hijacked"; } });

    const result = seam.withLoaderCause({ kind: "user" }, () => { calls++; return "real-value"; });
    assert.strictEqual(result, "real-value");
    assert.strictEqual(calls, 1);
  });

  it("returns falsy action values exactly, uncoerced, through every scope path, running the action exactly once each time", () => {
    const values = [0, "", false, null, undefined];
    const scopeFactories = {
      noSeamInstalled: null,
      workingScope: () => (cause, fn) => fn(),
      throwsAfterAction: () => (cause, fn) => { fn(); throw new Error("boom"); },
      neverCallsAction: () => () => undefined,
      throwsBeforeAction: () => () => { throw new Error("boom"); },
      hijacksReturnValue: () => (cause, fn) => { fn(); return "hijacked"; },
    };

    for (const [name, factory] of Object.entries(scopeFactories)) {
      for (const v of values) {
        let calls = 0;
        seam.setActivitySeam(factory ? { scope: factory() } : null);

        const result = seam.withLoaderCause({ kind: "user" }, () => { calls++; return v; });

        assert.ok(Object.is(result, v), name + " with value " + String(v) + " returned " + String(result));
        assert.strictEqual(calls, 1, name + " with value " + String(v) + " ran the action " + calls + " times");
      }
    }
  });
});

describe("spawned children inherit the loader's trace", () => {
  afterEach(() => seam.setActivitySeam(null));

  it("merges the seam env into a child environment without dropping process.env", () => {
    seam.setActivitySeam({ env: () => ({ HUB_ACTIVITY_TRACE: "t1", HUB_ACTIVITY_CAUSE: '{"kind":"user"}' }) });
    const childEnv = { ...process.env, ...seam.loaderActivityEnv() };
    assert.strictEqual(childEnv.HUB_ACTIVITY_TRACE, "t1");
    assert.strictEqual(childEnv.PATH, process.env.PATH);
  });
});

describe("cause shape the TUI's per-keypress scope relies on", () => {
  afterEach(() => seam.setActivitySeam(null));

  it("forwards a cause with no detail key untouched, never inventing one", () => {
    const causes = [];
    seam.setActivitySeam({ scope: (cause, fn) => { causes.push(cause); return fn(); } });

    const typingCause = { kind: "user", surface: "plugins > pcfginput" };
    seam.withLoaderCause(typingCause, () => "ok");

    assert.strictEqual(causes.length, 1);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(causes[0], "detail"), false);
    assert.deepStrictEqual(causes[0], { kind: "user", surface: "plugins > pcfginput" });
  });
});
