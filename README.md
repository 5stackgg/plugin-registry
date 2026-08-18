# 5Stack Plugin Registry

The catalog behind the **5Stack plugin directory**. Every 5Stack panel polls the
index this repo publishes and renders it at `/plugins`, so adding a plugin here
makes it one-click installable on every install in the world.

Published to <https://registry.5stack.gg/index.json> by GitHub Pages, rebuilt
hourly so new upstream plugin releases appear on their own.

The custom domain lives in the root `CNAME`, which the build copies into `dist/`
— the published artifact is the site root, so the domain has to travel with it.

## What's in a plugin

Two different things are called "plugin" in 5Stack, and both live here:

| `kind` | What it is | Installed by |
| --- | --- | --- |
| `game` | A CS2 server plugin (SwiftlyS2 or CounterStrikeSharp) that loads into the game server | The panel, into each node's plugin store |
| `panel` | A Vue Module Federation remote that mounts as a page at `/apps/<slug>` | `./plugin.sh <repo>` on the panel host |
| `bundle` | Both halves of one product, wired together on install | Both of the above |

## Adding a plugin

1. Drop a JSON file in `registry/<kind>/<slug>.json`. The filename must match the
   slug. Start from `registry/game/inventory-simulator.json`.
2. `npm run validate`.
3. Open a PR. `verified: true` is set during review, not by the submitter — it is
   the only thing telling an operator a maintainer actually looked at the plugin.

**Never write a `versions` array.** CI resolves it from the upstream repo's
GitHub releases on every build, pinning each asset's URL and SHA-256 so a panel
can verify what it downloads. Hand-written versions are rejected by the validator.

### Archive layout

`layout` tells the installer how to unpack the release asset:

- `csgo` (default) — the archive root *is* `game/csgo`, so it already contains
  `addons/...`. This is what the inventory simulator ships.
- `plugin` — the archive root is the plugin folder itself. Set `install_path`
  (e.g. `addons/{runtime}/plugins/MyPlugin`) and the installer places it there.
  `{runtime}` expands to `swiftlys2` or `counterstrikesharp`.

### Runtimes are not interchangeable

A CounterStrikeSharp plugin will not load under SwiftlyS2 and vice versa, so a
game plugin declares one `variants` entry per runtime it actually ships. A plugin
with only a `counterstrikesharp` variant simply won't be offered on a SwiftlyS2
deployment (unless that deployment runs the CSS compatibility layer).

## Local development

```sh
npm run validate      # schema + cross-entry checks, no network
npm run build         # resolves releases and writes dist/index.json
```

`build` hits the GitHub API. Set `GITHUB_TOKEN` to avoid the unauthenticated
rate limit.

## Pointing a panel somewhere else

An operator can mirror or fork this registry and point their panel at it:

**Settings → Application → Game Plugins → Registry URL**, or the
`public.plugin_registry_url` setting.
