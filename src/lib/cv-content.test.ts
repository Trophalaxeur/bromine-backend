import { describe, it, expect } from 'vitest';
import { rewritePriorityOf } from './cv-content.ts';

describe('rewritePriorityOf', () => {
  it('reads high from the frontmatter', () => {
    expect(rewritePriorityOf('---\nrewritePriority: high\ncompany: X\n---\nbody')).toBe('high');
  });

  it('lowercases the value so High/HIGH count', () => {
    expect(rewritePriorityOf('---\nrewritePriority: High\n---\n')).toBe('high');
    expect(rewritePriorityOf('---\nrewritePriority: "HIGH"\n---\n')).toBe('high');
  });

  it('returns undefined when the flag is absent', () => {
    expect(rewritePriorityOf('---\ncompany: X\n---\nbody')).toBeUndefined();
  });

  it('returns undefined without a frontmatter block', () => {
    expect(rewritePriorityOf('no frontmatter here')).toBeUndefined();
  });

  it('ignores a rewritePriority line that lives in the body, not the frontmatter', () => {
    expect(rewritePriorityOf('---\ncompany: X\n---\nrewritePriority: high')).toBeUndefined();
  });
});
