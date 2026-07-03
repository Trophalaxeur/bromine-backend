import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.ts';

const logDir = path.join(process.cwd(), 'tmp', 'logs');
const logFile = path.join(logDir, 'cv-generate.log');

// Bounds how much of each field (full prompts / LLM responses can run to tens
// of KB) ends up on disk per entry — this log is for spot-checking what the
// LLM did, not a full transcript archive.
const MAX_FIELD_LENGTH = 4000;

function truncate(value: unknown): unknown {
  if (typeof value === 'string' && value.length > MAX_FIELD_LENGTH) {
    return `${value.slice(0, MAX_FIELD_LENGTH)}... [truncated, ${value.length} chars total]`;
  }
  return value;
}

/** Appends a JSON line to tmp/logs/cv-generate.log — used to debug why the
 *  LLM did/didn't follow instructions. Opt-in via CV_GENERATION_LOG=true since
 *  entries include user instructions and LLM output. Best-effort: logging is
 *  diagnostic, so a disk-full or permissions error here must not fail the
 *  /cv/generate request that's actually doing the work. */
export async function logGeneration(entry: Record<string, unknown>): Promise<void> {
  if (!config.cvGenerationLogEnabled) return;

  const truncated = Object.fromEntries(Object.entries(entry).map(([key, value]) => [key, truncate(value)]));
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...truncated });
  try {
    await mkdir(logDir, { recursive: true, mode: 0o700 });
    await appendFile(logFile, line + '\n', { encoding: 'utf-8', mode: 0o600 });
  } catch (err) {
    console.warn('Failed to write cv-generate log entry (best-effort, ignoring):', err);
  }
}
