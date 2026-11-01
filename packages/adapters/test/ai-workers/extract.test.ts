import { describe, expect, it } from 'vitest';
import {
  createWorkersAITextExtractor,
  NO_LOG_PAYLOAD,
  WORKERS_AI_TRANSCRIBE_MODEL,
  WorkersAIError,
  type WorkersAiRun,
  type WorkersAiToMarkdown,
} from '../../src/ai-workers/index';

const bytes = (text: string) => new TextEncoder().encode(text);

function fakes(markdown: unknown = { format: 'markdown', data: '# Report\n\nBody' }) {
  const converted: { name: string; type: string; text: string }[] = [];
  const runs: { model: string; input: Record<string, unknown>; opts?: unknown }[] = [];
  const toMarkdown: WorkersAiToMarkdown = async ({ name, blob }) => {
    converted.push({ name, type: blob.type, text: await blob.text() });
    return markdown;
  };
  const run: WorkersAiRun = async (model, input, opts) => {
    runs.push({ model, input, opts });
    return { text: 'spoken words' };
  };
  return { toMarkdown, run, converted, runs };
}

describe('workers-ai text extractor', () => {
  it('converts documents to Markdown and says which types it reads', async () => {
    const f = fakes();
    const x = createWorkersAITextExtractor({ toMarkdown: f.toMarkdown, run: f.run });
    expect(x.supports('application/pdf')).toBe(true);
    expect(
      x.supports('application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    ).toBe(true);
    expect(x.supports('audio/mpeg')).toBe(true);
    expect(x.supports('image/png')).toBe(false);
    expect(x.supports('application/zip')).toBe(false);
    const text = await x.extract({
      fileName: 'report.pdf',
      contentType: 'application/pdf; charset=binary',
      bytes: bytes('%PDF-1.7'),
    });
    expect(text).toBe('# Report\n\nBody');
    expect(f.converted).toEqual([
      { name: 'report.pdf', type: 'application/pdf', text: '%PDF-1.7' },
    ]);
  });

  it('reads plain text itself, without a model', async () => {
    const f = fakes();
    const x = createWorkersAITextExtractor({ toMarkdown: f.toMarkdown, run: f.run });
    expect(
      await x.extract({ fileName: 'a.txt', contentType: 'text/plain', bytes: bytes('héllo') }),
    ).toBe('héllo');
    expect(f.converted).toEqual([]);
    expect(f.runs).toEqual([]);
  });

  it('transcribes audio with Whisper through the gateway, payload logging off', async () => {
    const f = fakes();
    const x = createWorkersAITextExtractor({
      toMarkdown: f.toMarkdown,
      run: f.run,
      gatewayId: 'gw',
    });
    const text = await x.extract({
      fileName: 'talk.mp3',
      contentType: 'audio/mpeg',
      bytes: bytes('ID3'),
    });
    expect(text).toBe('spoken words');
    expect(f.runs[0]?.model).toBe(WORKERS_AI_TRANSCRIBE_MODEL);
    expect(f.runs[0]?.input).toEqual({ audio: btoa('ID3') });
    expect(f.runs[0]?.opts).toMatchObject({ gateway: { id: 'gw' }, extraHeaders: NO_LOG_PAYLOAD });
  });

  it('throws a typed error when conversion reports one, so the step retries or records it', async () => {
    const f = fakes([{ format: 'error', error: 'encrypted PDF' }]);
    const x = createWorkersAITextExtractor({ toMarkdown: f.toMarkdown, run: f.run });
    await expect(
      x.extract({ fileName: 'x.pdf', contentType: 'application/pdf', bytes: bytes('x') }),
    ).rejects.toBeInstanceOf(WorkersAIError);
  });
});
