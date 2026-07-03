import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const logDir = path.join(process.cwd(), 'tmp', 'logs');
const logFile = path.join(logDir, 'cv-generate.log');

/** Appends a JSON line to tmp/logs/cv-generate.log and echoes a short summary
 *  to the console — used to debug why the LLM did/didn't follow instructions. */
export async function logGeneration(entry: Record<string, unknown>): Promise<void> {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry });
  await mkdir(logDir, { recursive: true });
  await appendFile(logFile, line + '\n', 'utf-8');
}
