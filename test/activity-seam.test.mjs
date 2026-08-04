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
});
