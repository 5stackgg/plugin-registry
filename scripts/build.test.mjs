// Two pieces of the build have real consequences. Asset selection: a Windows
// asset installs cleanly onto a Linux game server and then never loads. Change
// detection: a build wrongly judged identical to the live site is never
// deployed, and the registry silently stops updating.
import assert from "node:assert/strict";
import { selectLinuxAsset } from "./build.mjs";
import { sameIndex } from "./changed.mjs";

const glob = (pattern) =>
  new RegExp(
    `^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`,
  );

const named = (...names) => names.map((name) => ({ name }));

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

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\nall tests passed");
