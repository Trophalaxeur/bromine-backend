import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';

export interface VersionInfo {
  version: string;
  commit: string | null;
  nodeEnv: string;
}

// Repo root is two levels up from src/lib/ — same layout pdf.ts relies on for its cache dir.
const repoRoot = path.join(import.meta.dirname, '..', '..');

function readPackageVersion(): string {
  try {
    const raw = readFileSync(path.join(repoRoot, 'package.json'), 'utf-8');
    return (JSON.parse(raw) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

// Resolved once at startup: the prod checkout is a plain git clone the bromine-deploy script
// pulls into (see README), so HEAD identifies exactly what's running. Falls back to null when
// git isn't available or this isn't a checkout (e.g. an unpacked tarball) rather than throwing.
function readGitCommit(): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, encoding: 'utf-8' }).trim() || null;
  } catch {
    return null;
  }
}

export const versionInfo: VersionInfo = {
  version: readPackageVersion(),
  commit: readGitCommit(),
  nodeEnv: config.nodeEnv,
};
