import { describe, it, expect } from 'vitest';
import { buildCorePrompt, buildExperiencePrompt, buildReviewPrompt, buildCondensePrompt } from './prompt.ts';
import type { CvBase } from './josiane.ts';

const base: CvBase = 'short';
const common = { base, locale: 'fr' as const, instructions: 'Target a Lead Dev role.' };

describe('buildCorePrompt', () => {
  const coreCommon = { ...common, priorityFiles: ['2025-x.md'], otherFiles: ['2011-inria.md'] };

  it('emits the ATTACHMENT_CONTEXT block only when an image is attached', () => {
    expect(buildCorePrompt({ ...coreCommon, hasAttachment: true })).toContain('## ATTACHMENT_CONTEXT');
    expect(buildCorePrompt({ ...coreCommon, hasAttachment: false })).not.toContain('## ATTACHMENT_CONTEXT');
  });

  it('keeps ATTACHMENT_CONTEXT as the trailing block (after ## NOTES)', () => {
    const prompt = buildCorePrompt({ ...coreCommon, hasAttachment: true });
    expect(prompt.indexOf('## NOTES')).toBeLessThan(prompt.indexOf('## ATTACHMENT_CONTEXT'));
  });
});

describe('buildExperiencePrompt', () => {
  it('injects the transcribed attachment context when present', () => {
    const prompt = buildExperiencePrompt({ ...common, experienceFile: '2025-x.md', attachmentContext: 'Senior TS role, remote.' });
    expect(prompt).toContain('Senior TS role, remote.');
  });

  it('omits the attachment note when there is no context', () => {
    const prompt = buildExperiencePrompt({ ...common, experienceFile: '2025-x.md' });
    expect(prompt).not.toContain('attached');
  });
});

describe('buildReviewPrompt', () => {
  const files = [{ relativePath: 'fr/profile.md', content: 'body' }];

  it('feeds the attachment context to the reviewer when present', () => {
    const prompt = buildReviewPrompt({ ...common, files, attachmentContext: 'Senior TS role, remote.' });
    expect(prompt).toContain('Senior TS role, remote.');
  });

  it('omits the attachment note when there is no context', () => {
    const prompt = buildReviewPrompt({ ...common, files });
    expect(prompt).not.toContain('transcribed by the core call');
  });
});

describe('buildCondensePrompt', () => {
  const files = [{ relativePath: 'fr/skills.md', content: 'a long skills section' }];

  it('states the current and target page counts and includes the files to shorten', () => {
    const prompt = buildCondensePrompt({ ...common, files, currentPageCount: 3, targetPageCount: 2 });
    expect(prompt).toContain('3 pages');
    expect(prompt).toContain('fit 2');
    expect(prompt).toContain('fr/skills.md');
    expect(prompt).toContain('a long skills section');
  });
});
