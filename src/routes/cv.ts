import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { requireAuth } from '../lib/auth-middleware.ts';
import { createLLMProvider } from '../lib/llm-provider.ts';
import { loadJosiane, type CvBase } from '../lib/josiane.ts';
import { loadCvSource } from '../lib/cv-content.ts';
import { buildUserPrompt } from '../lib/prompt.ts';
import { parseGenerationResponse } from '../lib/response-parser.ts';
import { upsertDraft, getDraft, deleteDraft } from '../lib/sessions.ts';
import { writeTailoredFiles, commitTailoredSession, tailoredDir, readCommittedSession } from '../lib/git.ts';
import { renderTailoredPdf, renderCommittedPdf } from '../lib/pdf.ts';
import { logGeneration } from '../lib/logger.ts';
import { config } from '../config.ts';
import type { HonoEnv } from '../hono-env.ts';

export const cvRoutes = new Hono<HonoEnv>();
cvRoutes.use('*', requireAuth);

const generateSchema = z.object({
  sessionId: z.string().uuid().optional(),
  name: z.string().optional(),
  base: z.enum(['short', 'detailed', 'career-channel']),
  locale: z.enum(['fr', 'en']),
  instructions: z.string().min(1).max(20_000),
  attachment: z
    .object({
      base64: z.string().max(10_000_000),
      mimeType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
    })
    .optional(),
});

function slugify(name: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const slug = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining diacritics left by NFD normalization
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${date}-${slug}`;
}

cvRoutes.post('/cv/generate', async (c) => {
  const body = generateSchema.parse(await c.req.json());
  const base = body.base as CvBase;

  const [josiane, cvSource] = await Promise.all([loadJosiane(base), loadCvSource(body.locale)]);
  const systemPrompt = `${josiane}\n\n---\n\n# Current CV source (ground truth — do not invent facts beyond this)\n\n${cvSource}`;
  const userPrompt = buildUserPrompt({
    name: body.name,
    base,
    locale: body.locale,
    instructions: body.instructions,
    hasAttachment: Boolean(body.attachment),
  });

  // Full instructions can be arbitrary user/job-offer text up to 20k chars —
  // fine in dev (own terminal), but stdout in prod flows into centralized
  // logs (journald via the bromine-agent Ansible role), so only log length there.
  if (config.isDev) {
    console.log(`[cv/generate] base=${base} locale=${body.locale} instructions=${JSON.stringify(body.instructions)}`);
  } else {
    console.log(`[cv/generate] base=${base} locale=${body.locale} instructions_length=${body.instructions.length}`);
  }

  const llm = createLLMProvider();
  const responseText = await llm.complete({ systemPrompt, userPrompt, attachment: body.attachment });

  const fallbackName = `Custom ${base} — ${new Date().toISOString().slice(0, 10)}`;
  const parsed = parseGenerationResponse(responseText, fallbackName);
  const slug = slugify(parsed.name);

  console.log(`[cv/generate] name=${parsed.name} files=${parsed.files.map((f) => f.relativePath).join(', ')}`);
  await logGeneration({
    base,
    locale: body.locale,
    name: body.name,
    instructions: body.instructions,
    hasAttachment: Boolean(body.attachment),
    userPrompt,
    responseText,
    parsedName: parsed.name,
    parsedFiles: parsed.files.map((f) => f.relativePath),
  });

  await writeTailoredFiles({ slug, name: parsed.name, base, locale: body.locale, instructions: body.instructions }, parsed.files, parsed.sections);

  // Reuse the existing sessionId when re-generating a live draft, otherwise
  // mint a fresh one — this id is used for both the draft store key and the
  // rendered PDF's on-disk filename, so the two always stay in sync.
  const sessionId = body.sessionId && getDraft(body.sessionId) ? body.sessionId : randomUUID();
  const pdfPath = await renderTailoredPdf(slug, base, sessionId);

  const draft = upsertDraft(sessionId, {
    slug,
    name: parsed.name,
    base,
    locale: body.locale,
    instructions: body.instructions,
    files: parsed.files,
    sections: parsed.sections,
    pdfPath,
  });

  return c.json({
    sessionId: draft.sessionId,
    slug: draft.slug,
    name: draft.name,
    sections: draft.sections,
    pdf_url: `/cv/sessions/${draft.sessionId}/pdf`,
  });
});

cvRoutes.post('/cv/sessions/:sessionId/commit', async (c) => {
  const sessionId = c.req.param('sessionId');
  const draft = getDraft(sessionId);
  if (!draft) return c.json({ error: 'Session not found or expired' }, 404);

  const result = await commitTailoredSession(draft.slug);
  return c.json({ committed: result.committed, slug: draft.slug });
});

cvRoutes.delete('/cv/sessions/:sessionId', (c) => {
  const sessionId = c.req.param('sessionId');
  const deleted = deleteDraft(sessionId);
  return c.json({ deleted });
});

// Serves both a live draft (by sessionId, in-memory) and a committed session
// (by slug, read from carbon-notes) — the two id spaces never collide since
// slugs are date-prefixed kebab-case and sessionIds are UUIDs, and this keeps
// a single pdf_url shape for both cases.
cvRoutes.get('/cv/sessions/:id/pdf', async (c) => {
  const id = c.req.param('id');

  const draft = getDraft(id);
  if (draft) {
    const buffer = await readFile(draft.pdfPath);
    return c.body(buffer, 200, { 'Content-Type': 'application/pdf' });
  }

  const committed = await readCommittedSession(id);
  if (!committed) return c.json({ error: 'Session not found or expired' }, 404);

  const pdfPath = await renderCommittedPdf(id, committed.base);
  const buffer = await readFile(pdfPath);
  return c.body(buffer, 200, { 'Content-Type': 'application/pdf' });
});

// Reload a previously-committed session for the "historique" dropdown — the
// in-memory Draft is TTL'd at 24h and gone after commit anyway, so this reads
// session.json (written by writeTailoredFiles alongside brief.md) instead.
cvRoutes.get('/cv/sessions/:slug', async (c) => {
  const slug = c.req.param('slug');
  const committed = await readCommittedSession(slug);
  if (!committed) return c.json({ error: 'Session not found' }, 404);

  return c.json({
    slug,
    name: committed.name,
    sections: committed.sections,
    pdf_url: `/cv/sessions/${slug}/pdf`,
  });
});

cvRoutes.get('/cv/sessions', async (c) => {
  const tailoredRoot = path.join(config.carbonNotesPath, 'cv', 'tailored');
  const slugs = await readdir(tailoredRoot).catch(() => [] as string[]);

  const sessions = await Promise.all(
    slugs.map(async (slug) => {
      const briefPath = path.join(tailoredDir(slug), 'brief.md');
      const brief = await readFile(briefPath, 'utf-8').catch(() => null);
      return { slug, brief };
    })
  );

  return c.json({ sessions: sessions.filter((s) => s.brief !== null) });
});
