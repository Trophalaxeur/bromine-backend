import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { config } from '../config.ts';
import type { CvBase } from './josiane.ts';

const PDF_CACHE_DIR = path.join(import.meta.dirname, '..', '..', 'tmp', 'pdf');
// Just a hint passed as --port: vite silently picks another port if this one
// is taken (e.g. by an orphaned astro dev from a previous render), so the
// actual port is always read back from astro's own stdout — see
// waitForAstroServer — rather than assumed to be this value.
const PREFERRED_DEV_PORT = 4321;
const READY_TIMEOUT_MS = 30_000;

// Same Satoshi → IBM Plex Sans swap as bismuth-blog/scripts/generate-cv-pdf.ts
// (the canonical PDF generator) — Satoshi's variable font shows visible glyph
// gaps on s-t pairs in Chromium's page.pdf() pipeline. Kept in sync manually;
// see that script's IBM_PLEX_SANS_FACE_CSS for the source of truth.
function buildFontFaceCss(baseUrl: string): string {
  return [400, 500, 600, 700]
    .flatMap((weight) => [
      `@font-face {
        font-family: 'IBM Plex Sans';
        font-style: normal;
        font-weight: ${weight};
        font-display: block;
        src: url('${baseUrl}/fonts/cv/ibm-plex-sans-latin.woff2') format('woff2');
        unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
      }`,
      `@font-face {
        font-family: 'IBM Plex Sans';
        font-style: normal;
        font-weight: ${weight};
        font-display: block;
        src: url('${baseUrl}/fonts/cv/ibm-plex-sans-latin-ext.woff2') format('woff2');
        unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF;
      }`,
    ])
    .join('\n');
}

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

// Resolves with the port astro actually bound to — vite logs "ready in"
// before the "Local  http://localhost:PORT/" line, and the two can name
// different ports when the preferred one was taken, so both must be seen
// before this is trustworthy.
function waitForAstroServer(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    let port: number | null = null;
    let readyLogged = false;
    const timeout = setTimeout(() => reject(new Error('astro dev did not become ready in time')), READY_TIMEOUT_MS);
    const tryResolve = () => {
      if (port === null || !readyLogged) return;
      clearTimeout(timeout);
      child.stdout?.off('data', onData);
      resolve(port);
    };
    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      if (text.includes('ready in')) readyLogged = true;
      const match = /https?:\/\/localhost:(\d+)/.exec(text);
      if (match) port = Number(match[1]);
      tryResolve();
    };
    child.stdout?.on('data', onData);
    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

// npx doesn't reliably forward SIGTERM to the astro process it spawns, so
// killing just the returned ChildProcess leaves astro (and its esbuild
// children) running as an orphan holding the dev port — the next render then
// binds a different port while this file's BASE_URL still points at the
// stale one, silently serving a 404 for the new slug. Spawning detached puts
// astro in its own process group; killing the negated pid signals the whole
// group at once.
function killProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    // Group already exited — nothing to clean up.
  }
}

async function renderPdf(slug: string, base: CvBase, sessionId: string): Promise<string> {
  await mkdir(PDF_CACHE_DIR, { recursive: true });
  const outputPath = path.join(PDF_CACHE_DIR, `${sessionId}.pdf`);

  const t0 = Date.now();
  const elapsed = () => `${Date.now() - t0}ms`;

  const astroProcess = spawn('npx', ['astro', 'dev', '--port', String(PREFERRED_DEV_PORT)], {
    cwd: config.bismuthBlogPath,
    env: {
      ...process.env,
      TAILORED_CV_SLUG: slug,
      LOCAL_CARBON_NOTES: config.carbonNotesPath,
      CONTENT_TOKEN: config.contentToken ?? '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  // Drain stderr unconditionally — an unread pipe fills its OS buffer and blocks
  // the child on its next write(), which would hang the render with no error.
  astroProcess.stderr?.on('data', (chunk: Buffer) => console.error(`[astro] ${chunk.toString().trimEnd()}`));
  // Same for stdout — waitForAstroServer only listens long enough to see "ready
  // in" and the port line, then removes its own listener; any output astro writes afterwards
  // (request logs, warnings) would otherwise sit unread and eventually block
  // the child's write(), hanging the render.
  astroProcess.stdout?.on('data', (chunk: Buffer) => console.log(`[astro] ${chunk.toString().trimEnd()}`));

  try {
    const port = await waitForAstroServer(astroProcess);
    const baseUrl = `http://localhost:${port}`;
    console.log(`[pdf] astro ready on port ${port} in ${elapsed()}`);

    const url = base === 'career-channel' ? `${baseUrl}/cv/tailored/${slug}/career-channel` : `${baseUrl}/cv/tailored/${slug}/print?variant=${base}`;

    const browser = await chromium.launch({ args: CHROMIUM_ARGS });
    console.log(`[pdf] chromium launched at ${elapsed()}`);
    try {
      const page = await browser.newPage();
      const response = await page.goto(url, { waitUntil: 'networkidle' });
      // page.goto only rejects on network failure, never on a non-2xx status —
      // without this check astro's own 404 page (e.g. a getStaticPaths that
      // didn't match this slug) gets happily printed to PDF instead of failing.
      if (!response || !response.ok()) {
        throw new Error(`astro returned HTTP ${response?.status() ?? 'no response'} for ${url} — refusing to render the error page to PDF`);
      }
      console.log(`[pdf] page loaded (networkidle) at ${elapsed()}`);
      await page.addStyleTag({ content: buildFontFaceCss(baseUrl) });
      await page.addStyleTag({ content: ".font-satoshi { font-family: 'IBM Plex Sans', sans-serif !important; }" });
      await page.evaluate(() => document.fonts.ready);
      console.log(`[pdf] fonts ready at ${elapsed()}`);
      await page.pdf({ path: outputPath, printBackground: base === 'detailed', format: 'A4', preferCSSPageSize: true });
      console.log(`[pdf] pdf written at ${elapsed()}`);
    } finally {
      await browser.close();
    }
  } finally {
    killProcessTree(astroProcess);
  }

  return outputPath;
}

export function renderTailoredPdf(slug: string, base: CvBase, sessionId: string): Promise<string> {
  return enqueue(() => renderPdf(slug, base, sessionId));
}

/** Committed sessions are immutable (writeTailoredFiles only ever runs once
 *  per slug's content, before commit) — so unlike renderTailoredPdf, a cached
 *  file on disk keyed by slug is always still valid and worth reusing instead
 *  of re-running the astro+Chromium pipeline on every "historique" pick. */
export async function renderCommittedPdf(slug: string, base: CvBase): Promise<string> {
  const cachedPath = path.join(PDF_CACHE_DIR, `${slug}.pdf`);
  const cached = await stat(cachedPath).catch(() => null);
  if (cached) return cachedPath;
  return enqueue(() => renderPdf(slug, base, slug));
}
