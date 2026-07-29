import type { BunPlugin } from "bun";
import { dirname, join } from "node:path";

const CREDMAN_LOADER =
  /let credmanBootstrap = null;[\s\S]*?async function getCredmanBootstrap\(\) \{[\s\S]*?\n\}/;

/**
 * Replaces cross-keychain's runtime filesystem lookup with the helper text.
 *
 * Bun compiled executables use a virtual module directory, so files addressed
 * relative to import.meta.url are not available beside the standalone binary.
 */
export function embedCrossKeychainCredman(
  source: string,
  credmanScript: string,
): string {
  if (!CREDMAN_LOADER.test(source)) {
    throw new Error(
      "cross-keychain's Credential Manager loader no longer matches the expected shape",
    );
  }

  return source.replace(
    CREDMAN_LOADER,
    `const credmanBootstrap = ${JSON.stringify(credmanScript)};
async function getCredmanBootstrap() {
    return credmanBootstrap;
}`,
  );
}

export const embedCrossKeychainAssets: BunPlugin = {
  name: "embed-cross-keychain-assets",
  setup(build) {
    build.onLoad(
      { filter: /cross-keychain[\\/]dist[\\/]index\.js$/ },
      async ({ path }) => {
        const source = await Bun.file(path).text();
        const credmanPath = join(dirname(path), "scripts", "credman.ps1");
        const credmanScript = await Bun.file(credmanPath).text();

        return {
          contents: embedCrossKeychainCredman(source, credmanScript),
          loader: "js",
        };
      },
    );
  },
};
