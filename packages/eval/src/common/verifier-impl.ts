import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const PACKAGE = "ipfs-unixfs-importer";

export function verifierImpl(): string {
  let dir = import.meta.dirname;
  while (true) {
    const candidate = join(dir, "node_modules", PACKAGE, "package.json");
    if (existsSync(candidate)) {
      const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { version: string };
      return `${PACKAGE}@${pkg.version}`;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`could not locate ${PACKAGE}/package.json`);
    dir = parent;
  }
}
