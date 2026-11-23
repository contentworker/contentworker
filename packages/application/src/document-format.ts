import type { DocumentPageRequest } from '@contentworker/ports';

export const documentMimeTypes = {
  pdf: 'application/pdf',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  key: 'application/vnd.apple.keynote',
} satisfies Record<DocumentPageRequest['format'], string>;

export function documentFileFormat(fileName: string): DocumentPageRequest['format'] | undefined {
  const ext = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase();
  if (ext === 'pdf' || ext === 'pptx' || ext === 'key') return ext;
}

/** Browsers send octet-stream for unknown extensions. Infer a type only for enrichment. */
export function enrichmentContentType(file: { fileName: string; contentType: string }) {
  const mime = file.contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (mime && mime !== 'application/octet-stream') return mime;
  const format = documentFileFormat(file.fileName);
  return format ? documentMimeTypes[format] : mime;
}
