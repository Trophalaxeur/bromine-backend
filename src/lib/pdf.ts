import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { config } from '../config.ts';
import type { CvBase } from './josiane.ts';

const PDF_CACHE_DIR = path.join(import.meta.dirname, '..', '..', 'tmp', 'pdf');
const DEV_PORT = 4321; // astro dev default — matches bismuth-blog's own convention
const READY_TIMEOUT_MS = 30_000;

// Chromium flags tuned for a 1 GB LXC — see gallium-homelab/docs/bromine.md
// for the RAM/disk budget this keeps the render inside.
const CHROMIUM_ARGS = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process'];

// Requests are serialized: astro dev + Chromium both spawned fresh per
// render, and running two at once would double the RAM peak on a box sized
// for ~10 requests/week, not concurrency.
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task, task);
  queue = result.catch(() => undefined);
  return result;
}

function waitForServerReady(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('astro dev did not become ready in time')), READY_TIMEOUT_MS);
    const onData = (chunk: Buffer) => {
      if (chunk.toString().includes('ready in')) {
        clearTimeout(timeout);
        child.stdout?.off('data', onData);
        resolve();
      }
    };
    child.stdout?.on('data', onData);
    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function renderPdf(slug: string, base: CvBase, sessionId: string): Promise<string> {
  await mkdir(PDF_CACHE_DIR, { recursive: true });
  const outputPath = path.join(PDF_CACHE_DIR, `${sessionId}.pdf`);

  const astroProcess = spawn('npx', ['astro', 'dev', '--port', String(DEV_PORT)], {
    cwd: config.bismuthBlogPath,
    env: {
      ...process.env,
      TAILORED_CV_SLUG: slug,
      LOCAL_CARBON_NOTES: config.carbonNotesPath,
      CONTENT_TOKEN: config.contentToken ?? '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForServerReady(astroProcess);

    const url =
      base === 'career-channel' ? `http://localhost:${DEV_PORT}/cv/tailored/${slug}/career-channel` : `http://localhost:${DEV_PORT}/cv/tailored/${slug}/print?variant=${base}`;

    const browser = await chromium.launch({ args: CHROMIUM_ARGS });
    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);
      await page.pdf({ path: outputPath, printBackground: base === 'detailed', format: 'A4', preferCSSPageSize: true });
    } finally {
      await browser.close();
    }
  } finally {
    astroProcess.kill();
  }

  return outputPath;
}

export function renderTailoredPdf(slug: string, base: CvBase, sessionId: string): Promise<string> {
  return enqueue(() => renderPdf(slug, base, sessionId));
}
