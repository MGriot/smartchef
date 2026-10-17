// Reads the version from package.json at runtime rather than importing it,
// which would pull package.json outside tsc's rootDir in the Docker build.

import fs from "fs";
import path from "path";

function readVersion(): string {
  if (process.env.npm_package_version) return process.env.npm_package_version;
  for (const rel of ["package.json", "../package.json", "../../package.json", "backend/package.json"]) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), rel), "utf8"));
      if (pkg.name && pkg.version) return pkg.version;
    } catch {
      /* try next location */
    }
  }
  return "unknown";
}

export const APP_VERSION = readVersion();
