import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { requireAuth } from '../lib/auth-middleware.ts';
import { createLLMProvider } from '../lib/llm-provider.ts';
import { loadJosiane, type CvBase } from '../lib/josiane.ts';
import { loadCvSource, rewritePriorityOf } from '../lib/cv-content.ts';
import { buildCorePrompt, buildExperiencePrompt, buildReviewPrompt } from '../lib/prompt.ts';
import { parseCoreResponse, parseExperienceResponse, parseReviewResponse, deriveSections } from '../lib/response-parser.ts';
import type { GenerationReport, ReviewOutcome } from '../lib/generation-report.ts';
import { runWithLimit } from '../lib/concurrency.ts';
import { upsertDraft, getDraft, deleteDraft, HISTORY_CAP, type TailoredFile } from '../lib/sessions.ts';
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

// Per-call output caps. Kept ≤16000 so non-streaming stays under the SDK's HTTP timeout window
// (the reason the old monolith had to stream at 32000). The fail-loud guard in llm-provider.ts
// turns an undersized cap into a hard error, so these carry real headroom: the fattest real
// experience file (~8.6 KB → ~3k output tokens) sits well under EXPERIENCE_MAX_TOKENS.
const CORE_MAX_TOKENS = 8000;
const EXPERIENCE_MAX_TOKENS = 8000;
const REVIEW_MAX_TOKENS = 16000; // may re-emit several full files at once
// Conservative default — one generation is ever in flight, and typical fan-out is ~4-5 calls.
// Revisit against the account's real Anthropic tier concurrency limit if it ever bottlenecks.
const EXPERIENCE_CONCURRENCY = 4;

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
  const hasAttachment = Boolean(body.attachment);

  // Full instructions can be arbitrary user/job-offer text up to 20k chars —
  // fine in dev (own terminal), but stdout in prod flows into centralized
  // logs (journald via the bromine-agent Ansible role), so only log length there.
  if (config.isDev) {
    console.log(`[cv/generate] base=${base} locale=${body.locale} instructions=${JSON.stringify(body.instructions)}`);
  } else {
    console.log(`[cv/generate] base=${base} locale=${body.locale} instructions_length=${body.instructions.length}`);
  }

  // Split experiences by the rewritePriority frontmatter flag: `high` → always rewritten,
  // everything else → reused as-is unless the core call promotes it via ## ALSO_REWRITE.
  // Graceful degradation: if NOTHING is flagged high (the carbon-notes prereq isn't applied yet),
  // treat every experience as priority — i.e. fall back to today's "tailor them all" behavior,
  // just parallelized. That way the flag is a pure speed optimization, never a correctness
  // prerequisite: a missing prereq costs latency, not CV quality.
  const flaggedHigh = cvSource.experienceFiles.filter((f) => rewritePriorityOf(cvSource.experienceContents[f] ?? '') === 'high');
  const priorityFiles = flaggedHigh.length > 0 ? flaggedHigh : cvSource.experienceFiles;
  const otherFiles = cvSource.experienceFiles.filter((f) => !priorityFiles.includes(f));

  const llm = createLLMProvider();
  const fallbackName = `Custom ${base} — ${new Date().toISOString().slice(0, 10)}`;

  // 1. CORE call first — NAME + profile/skills/summary/domains. It also warms Anthropic's 1h
  //    prompt cache on the shared system prompt, so the experience fan-out reads the cache
  //    instead of each call paying the pricier cache-write.
  const coreStart = Date.now();
  const coreText = await llm.complete({
    systemPrompt,
    userPrompt: buildCorePrompt({ name: body.name, base, locale: body.locale, instructions: body.instructions, hasAttachment, priorityFiles, otherFiles }),
    attachment: body.attachment,
    maxTokens: CORE_MAX_TOKENS,
  });
  console.log(`[cv/generate] core call took ${Date.now() - coreStart}ms`);
  const core = parseCoreResponse(coreText, fallbackName);

  // 2. Which experiences get a rewrite call: the always-rewrite set ∪ any the core promoted
  //    (filtered to real reused candidates so a hallucinated filename can't sneak in).
  const alsoRewrite = core.alsoRewrite.filter((f) => otherFiles.includes(f));
  const toRewrite = [...priorityFiles, ...alsoRewrite];
  const toReuse = cvSource.experienceFiles.filter((f) => !toRewrite.includes(f));

  // 3. Fan out one call per experience to rewrite, concurrency-capped (cache is warm now).
  const experienceResults = await runWithLimit(
    toRewrite.map((file) => async () => {
      const start = Date.now();
      const text = await llm.complete({
        systemPrompt,
        userPrompt: buildExperiencePrompt({ base, locale: body.locale, instructions: body.instructions, hasAttachment, experienceFile: file }),
        maxTokens: EXPERIENCE_MAX_TOKENS,
      });
      console.log(`[cv/generate] experience ${file} took ${Date.now() - start}ms`);
      return parseExperienceResponse(text);
    }),
    EXPERIENCE_CONCURRENCY
  );

  // 4. Assemble the full set: core files, then every experience in the canonical checklist order —
  //    rewritten where we called, reused verbatim from source otherwise. Nothing is ever dropped;
  //    reused files are written explicitly so the committed tailored dir is a complete self-contained
  //    record rather than one that silently depends on the render-time fallback to the real CV.
  const experienceByName = new Map<string, TailoredFile>();
  for (const r of experienceResults) experienceByName.set(r.file.relativePath.split('/').pop() as string, r.file);
  for (const file of toReuse) experienceByName.set(file, { relativePath: `${body.locale}/experiences/${file}`, content: cvSource.experienceContents[file] });
  const orderedExperiences = cvSource.experienceFiles.map((f) => experienceByName.get(f)).filter((f): f is TailoredFile => Boolean(f));
  let files: TailoredFile[] = [...core.files, ...orderedExperiences];

  // 5. Editorial review pass over the whole assembled set — closes the coherence / tone /
  //    anti-hallucination gap that independent parallel calls open up. Runs before the PDF so the
  //    render reflects the reviewed content. Best-effort: the assembled set is already complete
  //    and valid, so a review failure (API error after retries, truncation, malformed output) is
  //    logged and skipped rather than sinking an otherwise-good generation.
  let reviewOutcome: ReviewOutcome = { changed: false };
  let reviewText = '';
  try {
    const reviewStart = Date.now();
    reviewText = await llm.complete({
      systemPrompt,
      userPrompt: buildReviewPrompt({ base, locale: body.locale, instructions: body.instructions, files }),
      maxTokens: REVIEW_MAX_TOKENS,
    });
    console.log(`[cv/generate] review call took ${Date.now() - reviewStart}ms`);
    const review = parseReviewResponse(reviewText);
    if (review.changed) {
      const revised = new Map(review.files.map((f) => [f.relativePath, f]));
      files = files.map((f) => revised.get(f.relativePath) ?? f);
      const known = new Set(files.map((f) => f.relativePath));
      for (const rf of review.files) if (!known.has(rf.relativePath)) files.push(rf);
      reviewOutcome = { changed: true, filesChanged: review.files.map((f) => f.relativePath), notes: review.notes };
    }
  } catch (err) {
    console.error(`[cv/generate] review pass failed, shipping un-reviewed content:`, err);
  }

  const sections = deriveSections(files, base);
  const slug = slugify(core.name);

  // Aggregate the per-call ## NOTES fragments (the editorial review's own notes live separately
  // in report.review.notes so the front can distinguish generation remarks from review remarks).
  const noteFragments: string[] = [];
  if (core.notes) noteFragments.push(`**core**: ${core.notes}`);
  for (const r of experienceResults) if (r.notes) noteFragments.push(`**${r.file.relativePath}**: ${r.notes}`);

  const report: GenerationReport = {
    callSummary: { experiencesRewritten: toRewrite, experiencesReused: toReuse },
    notes: noteFragments.length ? noteFragments.join('\n\n') : undefined,
    review: reviewOutcome,
  };

  // Append this attempt to the session's trail (preserved across regenerations of the same
  // sessionId). getDraft returns the previous attempt's draft when regenerating; a fresh session
  // starts from []. Capped so an endlessly-tweaked session can't grow the draft unbounded.
  const history = [...(getDraft(sessionId)?.history ?? []), { instructions: body.instructions, name: core.name, timestamp: Date.now(), report }].slice(-HISTORY_CAP);

  console.log(
    `[cv/generate] name=${core.name} rewritten=[${toRewrite.join(', ')}] reused=${toReuse.length} reviewChanged=${reviewOutcome.changed} files=${files.map((f) => f.relativePath).join(', ')}`
  );
  await logGeneration({
    base,
    locale: body.locale,
    name: body.name,
    instructions: body.instructions,
    hasAttachment,
    coreResponse: coreText,
    reviewResponse: reviewText,
    parsedName: core.name,
    parsedFiles: files.map((f) => f.relativePath),
  });

  setPhase(sessionId, 'writing_files');
  await writeTailoredFiles({ slug, name: core.name, base, locale: body.locale, instructions: body.instructions }, files, sections, report, history);

  setPhase(sessionId, 'rendering_pdf');
  const pdfPath = await renderTailoredPdf(slug, base, sessionId);

  const draft = upsertDraft(sessionId, {
    slug,
    name: core.name,
    base,
    locale: body.locale,
    instructions: body.instructions,
    files,
    sections,
    report,
    history,
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

  // instructions/report/history are absent on sessions committed before those fields existed —
  // the extension treats them as optional (undefined → no prefill / no report / no history panel).
  return c.json({
    slug,
    name: committed.name,
    sections: committed.sections,
    instructions: committed.instructions,
    report: committed.report,
    history: committed.history,
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
