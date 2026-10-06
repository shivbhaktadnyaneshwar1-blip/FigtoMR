import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Resolve package root (directory containing package.json + mcp-config.json). */
export function findPackageRoot(): string {
  const candidates = [
    process.cwd(),
    resolve(process.cwd(), '..'),
    resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
  ];

  for (const start of candidates) {
    let dir = start;
    for (let i = 0; i < 8; i += 1) {
      const configPath = resolve(dir, 'mcp-config.json');
      const pkgPath = resolve(dir, 'package.json');
      if (existsSync(configPath) && existsSync(pkgPath)) {
        return dir;
      }
      const parent = dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  }

  return process.cwd();
}
