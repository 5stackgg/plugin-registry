// The cron rebuilds hourly, but upstream releases are rare, so most builds
// reproduce byte-for-byte what the registry already serves. Redeploying anyway
// churns the deployment history and the Pages CDN for nothing, so the workflow
// compares dist/ against the live site and only deploys when something differs.
//
// The comparison fails open: anything that stops us from reading the live site
// (DNS not set up yet, an outage, a new file that has never been published)
// counts as a difference, because a needless deploy is cheap and a stale
// registry is not.
import { appendFile, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const DIST_DIR = path.join(process.cwd(), "dist");

// `generated_at` is the build's own timestamp, so it is the one thing that
// differs between two builds of identical content.
export function sameIndex(publishedText, builtText) {
  const strip = (text) => {
    const { generated_at: _ignored, ...rest } = JSON.parse(text);
    return JSON.stringify(rest);
  };

  try {
    return strip(publishedText) === strip(builtText);
  } catch {
    return false;
  }
}

async function registryUrl() {
  if (process.env.REGISTRY_URL) {
    return process.env.REGISTRY_URL;
  }

  try {
    const cname = (await readFile(path.join(DIST_DIR, "CNAME"), "utf8")).trim();
    return `https://${cname}`;
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  // A fork without a custom domain publishes to the project's github.io URL.
  const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? "").split("/");
  return owner && repo ? `https://${owner}.github.io/${repo}` : null;
}

async function fetchPublished(base, file) {
  // Pages sits behind a CDN with a ten-minute TTL; a deploy a few minutes ago
  // must not be mistaken for "nothing changed" because a stale copy came back.
  const url = new URL(file, `${base.replace(/\/?$/, "/")}`);
  url.searchParams.set("nocache", String(Date.now()));

  const response = await fetch(url, {
    headers: { "Cache-Control": "no-cache", "User-Agent": "5stack-plugin-registry" },
  });

  if (!response.ok) {
    throw new Error(`${response.status} for ${url.pathname}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

async function distFiles() {
  const names = await readdir(DIST_DIR, { recursive: true });
  const files = [];

  for (const name of names) {
    if ((await stat(path.join(DIST_DIR, name))).isFile()) {
      files.push(name.split(path.sep).join("/"));
    }
  }

  return files.sort();
}

export async function findChanges() {
  const base = await registryUrl();

  if (!base) {
    return ["cannot tell where the registry is published"];
  }

  console.log(`comparing dist/ against ${base}`);
  const changes = [];

  for (const file of await distFiles()) {
    const built = await readFile(path.join(DIST_DIR, file));
    let published;

    try {
      published = await fetchPublished(base, file);
    } catch (error) {
      changes.push(`${file}: not readable from the live registry (${error.message})`);
      continue;
    }

    const same =
      file === "index.json"
        ? sameIndex(published.toString("utf8"), built.toString("utf8"))
        : published.equals(built);

    if (!same) {
      changes.push(`${file}: differs from the published copy`);
    }
  }

  return changes;
}

export async function main() {
  const changes = await findChanges();

  if (changes.length === 0) {
    console.log("  nothing changed since the last deploy");
  } else {
    for (const change of changes) {
      console.log(`  ${change}`);
    }
    console.log(`\n${changes.length} change(s); deploy needed`);
  }

  if (process.env.GITHUB_OUTPUT) {
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `changed=${changes.length > 0}\n`,
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
