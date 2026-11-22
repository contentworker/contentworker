import { DurableObject } from 'cloudflare:workers';
import type { DocumentPageRequest, DocumentPageResult } from '@contentworker/ports';
import type { EdgeEnv } from '../env';

const BLOCK = 256 * 1024;
const MAX_CONTROL_LINE = 1024 * 1024;
const MAX_PAGE_BYTES = 512 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;

/** New instance per page attempt. The offline process can read only ranges of the pinned object. */
export class DocumentParserDO extends DurableObject<EdgeEnv> {
  async render(input: DocumentPageRequest): Promise<DocumentPageResult> {
    const container = this.ctx.container;
    const bucket = this.env.MEDIA_BUCKET;
    if (!container || !bucket) throw new Error('Document parser is not configured');
    const image = container.images.parser;
    if (!image) throw new Error('Document parser image missing');
    container.start({
      image,
      instance: 'standard-1',
      enableInternet: false,
      entrypoint: ['sleep', 'infinity'],
    });
    try {
      await container.setInactivityTimeout(300_000);
      const process = await container.exec(
        [
          '/usr/bin/python3',
          '/opt/parser/page_worker.py',
          input.format,
          String(input.size),
          String(input.page),
        ],
        { stdin: 'pipe', stderr: 'ignore' },
      );
      if (!process.stdout || !process.stdin) throw new Error('Document parser pipes unavailable');
      const writer = process.stdin.getWriter();
      const decoder = new TextDecoder();
      let pending = '';
      let bytesRead = 0;
      let result: DocumentPageResult | undefined;
      let artifacts: Record<string, number> | undefined;
      for await (const chunk of process.stdout) {
        pending += decoder.decode(chunk, { stream: true });
        if (pending.length > MAX_CONTROL_LINE)
          throw new Error('Document parser response too large');
        let newline = pending.indexOf('\n');
        while (newline >= 0) {
          const msg = JSON.parse(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
          if (result) throw new Error('Unexpected message after parser result');
          if ('offset' in msg) {
            const { offset, length } = msg;
            bytesRead += length;
            if (
              !Number.isSafeInteger(offset) ||
              !Number.isSafeInteger(length) ||
              offset < 0 ||
              length < 1 ||
              length > BLOCK ||
              offset + length > input.size ||
              bytesRead > 4 * MAX_PAGE_BYTES
            )
              throw new Error('Document range outside page budget');
            const object = await bucket.get(input.sourceKey, { range: { offset, length } });
            if (!object || object.httpEtag !== input.etag) {
              await object?.body.cancel();
              throw new Error('Document source changed during parsing');
            }
            let received = 0;
            for await (const part of object.body) {
              received += part.byteLength;
              if (received > length) throw new Error('Unexpected document range length');
              await writer.write(part);
            }
            if (received !== length) throw new Error('Incomplete document range');
          } else {
            if (
              !Number.isSafeInteger(msg.pages) ||
              msg.pages < input.page ||
              typeof msg.partial !== 'boolean' ||
              !msg.artifacts ||
              typeof msg.artifacts !== 'object' ||
              Array.isArray(msg.artifacts)
            )
              throw new Error('Invalid document page result');
            artifacts = msg.artifacts;
            result = { pages: msg.pages, partial: msg.partial };
          }
          newline = pending.indexOf('\n');
        }
      }
      await writer.close();
      if ((await process.exitCode) || !result || !artifacts || pending)
        throw new Error('Document parser failed');
      let total = 0;
      const files = Object.entries(artifacts);
      if (!('manifest.json' in artifacts) || files.length > 4096)
        throw new Error('Invalid document artifacts');
      // The page manifest becomes readable only after every artifact it references is stored.
      for (const [name, size] of files.sort(
        ([a], [b]) => Number(a === 'manifest.json') - Number(b === 'manifest.json'),
      )) {
        total += size;
        if (
          !Number.isSafeInteger(size) ||
          size < 0 ||
          total > MAX_PAGE_BYTES ||
          (name === 'manifest.json' && size > MAX_CONTROL_LINE) ||
          !(name === 'manifest.json' || name === 'preview.png' || SHA256.test(name))
        ) {
          throw new Error('Invalid document artifact');
        }
        const key = SHA256.test(name)
          ? `${input.outputPrefix}media/${name}`
          : `${input.outputPrefix}pages/${input.page}/${name}`;
        const file = await container.exec(['cat', `/tmp/document-output/${name}`], {
          stderr: 'ignore',
        });
        if (!file.stdout) throw new Error('Document artifact missing');
        const stream = new FixedLengthStream(size);
        await Promise.all([
          file.stdout.pipeTo(stream.writable),
          bucket.put(key, stream.readable, {
            httpMetadata: {
              contentType:
                name === 'manifest.json'
                  ? 'application/json'
                  : name === 'preview.png'
                    ? 'image/png'
                    : 'application/octet-stream',
            },
          }),
        ]);
        if (await file.exitCode) throw new Error('Document artifact transfer failed');
      }
      return result;
    } finally {
      await container.destroy();
    }
  }
}
