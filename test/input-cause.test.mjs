import { describe, it } from "vitest";
import assert from "node:assert";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { inputCause } = require("../dist/input-cause.js");

const TEXT_INPUT_MODES = ["input", "pinput", "mkinput", "mcpaddinput", "pcfginput", "search", "tabinput"];

describe("inputCause", () => {
  it("keeps detail and a plain surface in list mode", () => {
    const cause = inputCause("plugins", "list", "j");
    assert.strictEqual(cause.detail, "j");
    assert.strictEqual(cause.surface, "plugins");
  });

  for (const mode of TEXT_INPUT_MODES) {
    it("drops detail and qualifies the surface in " + mode + " mode", () => {
      const cause = inputCause("plugins", mode, "j");
      assert.strictEqual(Object.prototype.hasOwnProperty.call(cause, "detail"), false);
      assert.strictEqual(cause.surface, "plugins > " + mode);
    });
  }

  it("still drops detail in a text-input mode even for a plausible typed character", () => {
    const cause = inputCause("plugins", "pcfginput", "a");
    assert.strictEqual(Object.prototype.hasOwnProperty.call(cause, "detail"), false);
  });

  it("carries no detail key in list mode when key is null or undefined", () => {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(inputCause("plugins", "list", null), "detail"), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(inputCause("plugins", "list", undefined), "detail"), false);
  });

  it("never throws and produces a sensible surface for missing page/mode", () => {
    assert.doesNotThrow(() => inputCause(undefined, undefined, "j"));
    assert.doesNotThrow(() => inputCause("", null, "j"));
    assert.strictEqual(inputCause(undefined, undefined, "j").surface, "");
    assert.strictEqual(inputCause("", "", "j").surface, "");
    assert.strictEqual(inputCause("plugins", null, "j").surface, "plugins");
  });

  it("always reports kind user", () => {
    assert.strictEqual(inputCause("plugins", "list", "j").kind, "user");
    assert.strictEqual(inputCause("plugins", "pcfginput", "j").kind, "user");
  });
});
