import { mkdir, writeFile } from "node:fs/promises";
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

    const asset = (release.assets ?? []).find((candidate) =>
      matches.test(candidate.name),
    );

    if (!asset) {
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
