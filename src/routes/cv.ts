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
import { parseGenerationResponse, deriveSections, parseNotes } from '../lib/response-parser.ts';
import type { GenerationReport } from '../lib/generation-report.ts';
import { upsertDraft, getDraft, deleteDraft } from '../lib/sessions.ts';
import { writeTailoredFiles, commitTailoredSession, tailoredDir, readCommittedSession, pullContentRepos } from '../lib/git.ts';
import { renderTailoredPdf, renderCommittedPdf } from '../lib/pdf.ts';
import { logGeneration } from '../lib/logger.ts';
import { startProgress, setPhase, setReady, setError, getProgress } from '../lib/progress.ts';
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

type GenerateBody = z.infer<typeof generateSchema>;

/** The actual generation pipeline — deliberately NOT awaited by the route
 *  handler below. It can take anywhere from seconds to a few minutes (mostly
 *  the LLM call), and the extension polls GET /cv/sessions/:id/progress
 *  instead of holding one long-lived request open. */
async function runGeneration(sessionId: string, base: CvBase, body: GenerateBody): Promise<void> {
  // Refresh carbon-notes/bismuth-blog from their remotes before reading anything
  // from them — the prompt (loadJosiane/loadCvSource below) and the later PDF
  // render both read the on-disk checkout as-is, which otherwise only gets
  // updated at process startup. No-op in dev (see pullContentRepos).
  await pullContentRepos();

  const [josiane, cvSource] = await Promise.all([loadJosiane(base), loadCvSource(body.locale)]);
  const systemPrompt = `${josiane}\n\n---\n\n# Current CV source (ground truth — do not invent facts beyond this)\n\n${cvSource.content}`;
  const userPrompt = buildUserPrompt({
    name: body.name,
    base,
    locale: body.locale,
    instructions: body.instructions,
    hasAttachment: Boolean(body.attachment),
    experienceFiles: cvSource.experienceFiles,
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
  const llmStart = Date.now();
  const responseText = await llm.complete({ systemPrompt, userPrompt, attachment: body.attachment });
  console.log(`[cv/generate] LLM call took ${Date.now() - llmStart}ms`);

  const fallbackName = `Custom ${base} — ${new Date().toISOString().slice(0, 10)}`;
  const parsed = parseGenerationResponse(responseText, fallbackName);
  const sections = deriveSections(parsed.files, base);
  const slug = slugify(parsed.name);

  // An experience the LLM didn't emit falls back to the real cv/<locale>/experiences file at
  // render time (see bismuth-blog content.config.ts's localCvLoader) — i.e. it's reused as-is,
  // not dropped. The review/pageCheck fields land with §1/§5; for now the report carries the
  // call summary + any ## NOTES the model flagged.
  const rewrittenExperiences = parsed.files.filter((f) => f.relativePath.includes('/experiences/')).map((f) => f.relativePath.split('/').pop() as string);
  const report: GenerationReport = {
    callSummary: {
      experiencesRewritten: rewrittenExperiences,
      experiencesReused: cvSource.experienceFiles.filter((f) => !rewrittenExperiences.includes(f)),
    },
    notes: parseNotes(responseText),
  };

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

  setPhase(sessionId, 'writing_files');
  await writeTailoredFiles({ slug, name: parsed.name, base, locale: body.locale, instructions: body.instructions }, parsed.files, sections, report);

  setPhase(sessionId, 'rendering_pdf');
  const pdfPath = await renderTailoredPdf(slug, base, sessionId);

  const draft = upsertDraft(sessionId, {
    slug,
    name: parsed.name,
    base,
    locale: body.locale,
    instructions: body.instructions,
    files: parsed.files,
    sections,
    report,
    pdfPath,
  });

  setReady(sessionId, {
    sessionId: draft.sessionId,
    slug: draft.slug,
    name: draft.name,
    sections: draft.sections,
    report: draft.report,
    pdf_url: `/cv/sessions/${draft.sessionId}/pdf`,
  });
}

cvRoutes.post('/cv/generate', async (c) => {
  const body = generateSchema.parse(await c.req.json());
  const base = body.base as CvBase;

  // Reuse the existing sessionId when re-generating a live draft, otherwise
  // mint a fresh one — this id is used for both the draft store key and the
  // rendered PDF's on-disk filename, so the two always stay in sync. Decided
  // upfront (not after the LLM call) since the client needs it immediately to
  // start polling progress.
  const sessionId = body.sessionId && getDraft(body.sessionId) ? body.sessionId : randomUUID();
  startProgress(sessionId);

  runGeneration(sessionId, base, body).catch((err) => {
    console.error(`[cv/generate] session=${sessionId} failed:`, err);
    setError(sessionId, err instanceof Error ? err.message : String(err));
  });

  return c.json({ sessionId, status: 'generating' }, 202);
});

cvRoutes.get('/cv/sessions/:sessionId/progress', (c) => {
  const sessionId = c.req.param('sessionId');
  const progress = getProgress(sessionId);
  if (!progress) return c.json({ error: 'Session not found or expired' }, 404);
  return c.json(progress);
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

  // instructions/report are absent on sessions committed before those fields existed — the
  // extension treats them as optional (undefined → no prefill / no report panel).
  return c.json({
    slug,
    name: committed.name,
    sections: committed.sections,
    instructions: committed.instructions,
    report: committed.report,
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
