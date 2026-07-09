import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { countPdfPages } from './pdf.ts';

const dirs: string[] = [];
async function pdfFixture(body: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'bromine-pdf-test-'));
  dirs.push(dir);
  const p = path.join(dir, 'sample.pdf');
  await writeFile(p, body, 'latin1');
  return p;
}

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe('countPdfPages', () => {
  it('reads a single /Count', async () => {
    expect(await countPdfPages(await pdfFixture('%PDF-1.4\n<< /Type /Pages /Count 2 >>\n'))).toBe(2);
  });

  it('takes the max /Count when the page tree is split (root = total)', async () => {
    expect(await countPdfPages(await pdfFixture('/Count 8 ... /Count 5 ... /Count 13'))).toBe(13);
  });

  it('defaults to 1 when no /Count is present', async () => {
    expect(await countPdfPages(await pdfFixture('%PDF-1.4 no page tree here'))).toBe(1);
  });
});
