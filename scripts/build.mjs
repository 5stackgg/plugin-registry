import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { validateAll } from "./validate.mjs";

const DIST_DIR = path.join(process.cwd(), "dist");
const MAX_VERSIONS_PER_RUNTIME = 10;
const GITHUB_API = "https://api.github.com";

const headers = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "5stack-plugin-registry",
  ...(process.env.GITHUB_TOKEN
    ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
    : {}),
};

// 5Stack game servers are Linux containers (steamrt sniper). An asset built for
// another platform unpacks perfectly well and then never loads, so it does not
// belong in the catalog at all -- and where a project ships one asset per
// platform, the Linux one has to be chosen rather than whichever GitHub happens
// to return first.
const FOREIGN_PLATFORM =
  /(^|[-_.])(win|win32|win64|windows|osx|macos|darwin)([-_.]|$)/i;
const LINUX_ASSET = /(^|[-_.])(linux|linuxsteamrt64)([-_.]|$)/i;

export function selectLinuxAsset(assets, matches) {
  const candidates = assets.filter((asset) => matches.test(asset.name));
  const portable = candidates.filter((asset) => !FOREIGN_PLATFORM.test(asset.name));

  return {
    asset: portable.find((asset) => LINUX_ASSET.test(asset.name)) ?? portable[0] ?? null,
    rejected: candidates.length - portable.length,
  };
}

function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function normalizeVersion(tag) {
  return tag.replace(/^v/, "");
}

async function fetchReleases(repo) {
  const response = await fetch(
    `${GITHUB_API}/repos/${repo}/releases?per_page=100`,
    { headers },
  );

  if (!response.ok) {
    throw new Error(
      `GitHub returned ${response.status} for ${repo}: ${await response.text()}`,
    );
  }

  return await response.json();
}

// GitHub publishes a sha256 on release assets, but only for assets uploaded
// after that field shipped. Older ones have to be hashed by hand.
async function resolveDigest(asset) {
  const published = asset.digest?.replace(/^sha256:/, "");

  if (published && /^[a-f0-9]{64}$/.test(published)) {
    return published;
  }

  const response = await fetch(asset.browser_download_url, { headers });

  if (!response.ok) {
    throw new Error(
      `could not download ${asset.browser_download_url} to hash it (${response.status})`,
    );
  }

  return createHash("sha256")
    .update(Buffer.from(await response.arrayBuffer()))
    .digest("hex");
}

async function resolveVariant(slug, runtime, variant) {
  const releases = await fetchReleases(variant.repo);
  const matches = globToRegExp(variant.asset);
  const versions = [];

  for (const release of releases) {
    if (release.draft) {
      continue;
    }

    if (release.prerelease && !variant.include_prereleases) {
      continue;
    }

    const { asset, rejected } = selectLinuxAsset(release.assets ?? [], matches);

    if (!asset) {
      if (rejected > 0) {
        console.warn(
          `  warning: ${slug}/${runtime} ${release.tag_name} only publishes non-Linux assets`,
        );
      }
      continue;
    }

    versions.push({
      version: normalizeVersion(release.tag_name),
      runtime,
      url: asset.browser_download_url,
      sha256: await resolveDigest(asset),
      size: asset.size,
      published_at: release.published_at,
      prerelease: Boolean(release.prerelease),
      layout: variant.layout ?? "csgo",
      ...(variant.install_path ? { install_path: variant.install_path } : {}),
    });

    if (versions.length >= MAX_VERSIONS_PER_RUNTIME) {
      break;
    }
  }

  if (versions.length === 0) {
    console.warn(
      `  warning: ${slug}/${runtime} matched no release asset against "${variant.asset}" in ${variant.repo}`,
    );
  }

  return versions;
}

export async function main() {
  const { entries, problems } = await validateAll();

  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`  ${problem}`);
    }
    console.error(`\n${problems.length} problem(s); refusing to build`);
    process.exit(1);
  }

  const plugins = [];

  for (const { entry } of entries) {
    const versions = [];

    for (const [runtime, variant] of Object.entries(entry.variants ?? {})) {
      versions.push(...(await resolveVariant(entry.slug, runtime, variant)));
    }

    versions.sort((a, b) => b.published_at.localeCompare(a.published_at));

    plugins.push({ ...entry, $schema: undefined, versions });
    console.log(`  ${entry.slug}: ${versions.length} version(s)`);
  }

  plugins.sort((a, b) => a.slug.localeCompare(b.slug));

  await mkdir(path.join(DIST_DIR, "plugins"), { recursive: true });

  // The published artifact becomes the whole site root, so the custom domain has
  // to travel with it. Without this, a deploy can drop registry.5stack.gg back to
  // the github.io URL -- and that URL is the default every panel ships with.
  // A fork with no CNAME file simply publishes without one.
  try {
    await copyFile(path.join(process.cwd(), "CNAME"), path.join(DIST_DIR, "CNAME"));
    console.log("  carried CNAME into dist/");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  const index = {
    version: 1,
    generated_at: new Date().toISOString(),
    plugins,
  };

  await writeFile(
    path.join(DIST_DIR, "index.json"),
    `${JSON.stringify(index, null, 2)}\n`,
  );

  for (const plugin of plugins) {
    await writeFile(
      path.join(DIST_DIR, "plugins", `${plugin.slug}.json`),
      `${JSON.stringify(plugin, null, 2)}\n`,
    );
  }

  console.log(`\nbuilt dist/index.json with ${plugins.length} plugins`);
}

// Importable without running: the tests pull selectLinuxAsset out of here,
// and building on import would hit the GitHub API to do it.
if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
