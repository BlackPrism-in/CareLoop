import mammoth from 'mammoth';
import { getDocument, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
export const MAX_EXTRACTED_CHARACTERS = 20_000;
const MAX_PDF_PAGES = 40;

export class DocumentExtractionError extends Error {
  constructor(
    message: string,
    readonly code:
      'UNSUPPORTED_FILE_TYPE' | 'INVALID_DOCUMENT' | 'DOCUMENT_NO_TEXT' | 'DOCUMENT_TOO_LARGE',
  ) {
    super(message);
    this.name = 'DocumentExtractionError';
  }
}

export type ExtractedDocument = {
  text: string;
  filename: string;
  mediaType:
    | 'text/plain'
    | 'application/pdf'
    | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
};

function cleanText(value: string): string {
  return value
    .replace(/^\uFEFF/, '')
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .trim();
}

export async function extractDocumentText(file: {
  filename: string;
  buffer: Buffer;
}): Promise<ExtractedDocument> {
  const filename = file.filename.replace(/\\/g, '/').split('/').pop() || 'upload';
  const extension = filename.toLowerCase().split('.').pop();
  let text = '';
  let mediaType: ExtractedDocument['mediaType'];

  if (extension === 'txt') {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(file.buffer);
    } catch {
      throw new DocumentExtractionError('TXT files must use UTF-8 encoding.', 'INVALID_DOCUMENT');
    }
    mediaType = 'text/plain';
  } else if (extension === 'docx') {
    const isZip = file.buffer.length >= 4 && file.buffer[0] === 0x50 && file.buffer[1] === 0x4b;
    const hasWordDocument = file.buffer.includes(Buffer.from('word/document.xml'));
    if (!isZip || !hasWordDocument) {
      throw new DocumentExtractionError(
        'The upload is not a valid DOCX document.',
        'INVALID_DOCUMENT',
      );
    }
    try {
      const result = await mammoth.extractRawText({ buffer: file.buffer });
      text = result.value;
    } catch {
      throw new DocumentExtractionError(
        'Could not read text from this DOCX document.',
        'INVALID_DOCUMENT',
      );
    }
    mediaType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  } else if (extension === 'pdf') {
    const header = file.buffer.subarray(0, 1024).toString('latin1');
    if (!header.includes('%PDF-')) {
      throw new DocumentExtractionError(
        'The upload is not a valid PDF document.',
        'INVALID_DOCUMENT',
      );
    }
    let pdf: PDFDocumentProxy | undefined;
    let destroyLoadingTask: (() => Promise<void>) | undefined;
    try {
      const loadingTask = getDocument({ data: Uint8Array.from(file.buffer), verbosity: 0 });
      destroyLoadingTask = () => loadingTask.destroy();
      pdf = await loadingTask.promise;
      if (pdf.numPages > MAX_PDF_PAGES) {
        throw new DocumentExtractionError(
          `PDFs may contain at most ${MAX_PDF_PAGES} pages.`,
          'DOCUMENT_TOO_LARGE',
        );
      }
      const pages: string[] = [];
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();
        pages.push(
          content.items
            .map((item) => ('str' in item && typeof item.str === 'string' ? item.str : ''))
            .join(' '),
        );
        page.cleanup();
      }
      text = pages.join('\n');
    } catch (error) {
      if (error instanceof DocumentExtractionError) throw error;
      throw new DocumentExtractionError(
        'Could not read text from this PDF document.',
        'INVALID_DOCUMENT',
      );
    } finally {
      if (destroyLoadingTask) await destroyLoadingTask();
    }
    mediaType = 'application/pdf';
  } else {
    throw new DocumentExtractionError(
      'Supported uploads are .pdf, .docx, and .txt.',
      'UNSUPPORTED_FILE_TYPE',
    );
  }

  text = cleanText(text);
  if (!text) {
    throw new DocumentExtractionError(
      'No selectable text was found. Scanned PDFs need OCR, which is not enabled.',
      'DOCUMENT_NO_TEXT',
    );
  }
  if (text.length > MAX_EXTRACTED_CHARACTERS) {
    throw new DocumentExtractionError(
      `Extracted text exceeds ${MAX_EXTRACTED_CHARACTERS} characters.`,
      'DOCUMENT_TOO_LARGE',
    );
  }
  return { text, filename, mediaType };
}
