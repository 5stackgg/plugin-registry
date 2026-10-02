// Two pieces of the build have real consequences. Asset selection: a Windows
// asset installs cleanly onto a Linux game server and then never loads. Change
// detection: a build wrongly judged identical to the live site is never
// deployed, and the registry silently stops updating.
import assert from "node:assert/strict";
import { selectLinuxAsset } from "./build.mjs";
import { sameIndex } from "./changed.mjs";
import { validateConfig, validateMapRotation } from "./validate.mjs";

const glob = (pattern) =>
  new RegExp(
    `^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`,
  );

const named = (...names) => names.map((name) => ({ name }));

const rotation = (files, map = { Name: "{{label}}", Id: "{{id}}" }) => ({
  kind: "game",
  map_rotation: { files, map },
});

let failures = 0;
const test = (what, fn) => {
  try {
    fn();
    console.log(`  ok  ${what}`);
  } catch (error) {
    failures++;
    console.error(`  FAIL ${what}\n       ${error.message}`);
  }
};

test("prefers the linux asset when a project ships both", () => {
  const { asset, rejected } = selectLinuxAsset(
    named(
      "swiftlys2-windows-v1.4.5-with-runtimes.zip",
      "swiftlys2-linux-v1.4.5-with-runtimes.zip",
    ),
    glob("swiftlys2-*-with-runtimes.zip"),
  );
  assert.equal(asset.name, "swiftlys2-linux-v1.4.5-with-runtimes.zip");
  assert.equal(rejected, 1);
});

test("takes a cross-platform asset that names no platform at all", () => {
  const { asset } = selectLinuxAsset(
    named("InventorySimulator-v3.1.0.zip"),
    glob("InventorySimulator-v*.zip"),
  );
  assert.equal(asset.name, "InventorySimulator-v3.1.0.zip");
});

test("returns nothing when only foreign-platform assets match", () => {
  const { asset, rejected } = selectLinuxAsset(
    named("plugin-windows-v1.zip", "plugin-osx-v1.zip"),
    glob("plugin-*-v1.zip"),
  );
  assert.equal(asset, null);
  assert.equal(rejected, 2);
});

test("does not mistake a substring for a platform token", () => {
  const { asset } = selectLinuxAsset(
    named("WindowBreaker-v2.zip"),
    glob("WindowBreaker-v*.zip"),
  );
  assert.equal(asset.name, "WindowBreaker-v2.zip");
});

test("ignores assets the glob does not match", () => {
  const { asset } = selectLinuxAsset(
    named("something-else.zip", "MyPlugin-v1.zip"),
    glob("MyPlugin-v*.zip"),
  );
  assert.equal(asset.name, "MyPlugin-v1.zip");
});

const index = (plugins, generated_at = "2026-01-01T00:00:00.000Z") =>
  JSON.stringify({ version: 1, generated_at, plugins }, null, 2);

test("treats a rebuild that only moved generated_at as unchanged", () => {
  assert.equal(
    sameIndex(
      index([{ slug: "a", versions: [] }], "2026-01-01T00:00:00.000Z"),
      index([{ slug: "a", versions: [] }], "2026-01-01T01:00:00.000Z"),
    ),
    true,
  );
});

test("notices a new upstream version", () => {
  assert.equal(
    sameIndex(
      index([{ slug: "a", versions: [{ version: "1.0.0" }] }]),
      index([{ slug: "a", versions: [{ version: "1.1.0" }, { version: "1.0.0" }] }]),
    ),
    false,
  );
});

test("notices a plugin added to or dropped from the catalog", () => {
  assert.equal(sameIndex(index([{ slug: "a" }]), index([{ slug: "a" }, { slug: "b" }])), false);
  assert.equal(sameIndex(index([{ slug: "a" }, { slug: "b" }]), index([{ slug: "a" }])), false);
});

test("treats an unreadable published index as changed", () => {
  assert.equal(sameIndex("<html>404</html>", index([])), false);
});

test("accepts a map rotation that writes the map list", () => {
  const problems = validateMapRotation(
    rotation({ "a/maps.jsonc": { Maps: "{{maps}}" }, "a/config.jsonc": { Random: "{{shuffle}}" } }),
    "x.json",
  );
  assert.deepEqual(problems, []);
});

test("rejects a map rotation that never writes {{maps}}", () => {
  const problems = validateMapRotation(rotation({ "a/config.jsonc": { Random: "{{shuffle}}" } }), "x.json");
  assert.equal(problems.length, 1);
  assert.match(problems[0], /never writes \{\{maps\}\}/);
});

test("rejects map rotation paths that escape game/csgo", () => {
  assert.equal(validateMapRotation(rotation({ "/etc/maps.jsonc": { Maps: "{{maps}}" } }), "x.json").length, 1);
  assert.equal(validateMapRotation(rotation({ "../maps.jsonc": { Maps: "{{maps}}" } }), "x.json").length, 1);
});

test("rejects a file token embedded in longer text", () => {
  const problems = validateMapRotation(rotation({ "a/maps.jsonc": { Maps: "x{{maps}}" } }), "x.json");
  assert.equal(problems.length, 1);
  assert.match(problems[0], /as a whole value/);
});

test("rejects map rotation tokens used in the wrong place", () => {
  assert.equal(validateMapRotation(rotation({ "a/maps.jsonc": { Maps: "{{maps}}", Id: "{{id}}" } }), "x.json").length, 1);
  assert.equal(
    validateMapRotation(rotation({ "a/maps.jsonc": { Maps: "{{maps}}" } }, { Name: "{{maps}}" }), "x.json").length,
    1,
  );
});

const modes = {
  type: "array",
  items: {
    type: "object",
    required: ["name"],
    properties: {
      name: { type: "string" },
      duration: { type: "integer", minimum: 1 },
      weapons: { type: "array", items: { type: "string", enum: ["ak47", "awp"] } },
    },
  },
};

const configEntry = (fields) => ({ kind: "game", config_path: "a/modes.json", ...fields });

test("accepts a config default the form can render", () => {
  const problems = validateConfig(
    configEntry({ config_schema: modes, config_default: [{ name: "Rifles", duration: 60, weapons: ["ak47"] }] }),
    "x.json",
  );
  assert.deepEqual(problems, []);
});

// The panel opens the editor on the default, so one that breaks the schema is an
// editor that is broken before anyone touches it.
test("rejects a config default that breaks its own schema", () => {
  const problems = validateConfig(
    configEntry({
      config_schema: modes,
      config_default: [{ duration: 0, weapons: ["knife"], helmet: true }],
    }),
    "x.json",
  );
  assert.equal(problems.length, 4);
  assert.match(problems.join("\n"), /name is required/);
  assert.match(problems.join("\n"), /below its minimum/);
  assert.match(problems.join("\n"), /"knife", which is not one of its options/);
  assert.match(problems.join("\n"), /helmet is not described by the schema/);
});

test("rejects a list the schema says holds each value once", () => {
  const problems = validateConfig(
    configEntry({
      config_schema: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            weapons: { type: "array", uniqueItems: true, items: { type: "string", enum: ["ak47", "awp"] } },
          },
        },
      },
      config_default: [{ name: "Rifles", weapons: ["ak47", "awp", "ak47"] }],
    }),
    "x.json",
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /"ak47" more than once/);
});

test("treats an empty required value as missing, as the editor does", () => {
  const problems = validateConfig(
    configEntry({ config_schema: modes, config_default: [{ name: "" }] }),
    "x.json",
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /name is required/);
});

test("rejects config fields with no file to describe", () => {
  const problems = validateConfig(
    { kind: "game", config_cvar: "dm_modes_file", config_default: {} },
    "x.json",
  );
  assert.equal(problems.length, 2);
});

test("rejects a config path that escapes game/csgo", () => {
  assert.equal(validateConfig(configEntry({ config_path: "../modes.json" }), "x.json").length, 1);
});

test("rejects a shipped config path that escapes game/csgo", () => {
  const problems = validateConfig(
    configEntry({ config_shipped: { path: "../default.json", repo_path: "resources/default.json" } }),
    "x.json",
  );
  assert.equal(problems.length, 1);
});

test("rejects forced cvars that are not console variable names", () => {
  const problems = validateConfig(
    configEntry({ forced_cvars: ["mp_timelimit", "mp_timelimit 2"] }),
    "x.json",
  );
  assert.equal(problems.length, 1);
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\nall tests passed");
