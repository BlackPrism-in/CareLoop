import { loadConfig } from '@careloop/contracts';
import { createGenAIClient, GenAiJsonModel, ModelError, runIntake } from '@careloop/ai';
import { createLogger } from '@careloop/observability';
import { extractText, getDocumentProxy } from 'unpdf';
import { HttpError } from '@/server/errors';
import { jsonBody, staffRoute } from '@/server/handler';
import { PdfIntakeBody } from '@/server/schemas';

export const dynamic = 'force-dynamic';
const log = createLogger('careloop-web-api');
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_PAGES = 10;

/**
 * PDF intake (P1). Accepts only a real PDF (magic bytes) up to 5 MB and 10
 * pages, extracts text in memory, and runs the span-verified intake agent on
 * it. The file itself is never stored (data minimisation); only the proposal
 * is returned for staff to check.
 */
export const POST = staffRoute(async ({ req, session }) => {
  if (!session.ctx.roles.some((r) => r === 'COORDINATOR' || r === 'REVIEWER'))
    throw new HttpError('FORBIDDEN', 'Not permitted');
  const { pdfBase64 } = PdfIntakeBody.parse(await jsonBody(req));
  const bytes = Buffer.from(pdfBase64, 'base64');
  if (bytes.length > MAX_BYTES) throw new HttpError('VALIDATION_FAILED', 'PDF is larger than 5 MB');
  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-')
    throw new HttpError('VALIDATION_FAILED', 'Not a PDF file');
  let text: string;
  try {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    if (pdf.numPages > MAX_PAGES)
      throw new HttpError('VALIDATION_FAILED', `PDF has more than ${MAX_PAGES} pages`);
    text = (await extractText(pdf, { mergePages: true })).text.trim();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError('VALIDATION_FAILED', 'The PDF could not be read');
  }
  if (text.length < 20)
    throw new HttpError(
      'VALIDATION_FAILED',
      'No readable text in the PDF (scanned image?). Enter the details by hand.',
    );
  const cfg = loadConfig();
  try {
    const result = await runIntake(
      new GenAiJsonModel(createGenAIClient(cfg)),
      cfg.INTAKE_MODEL_ID,
      text,
    );
    log.info('pdf intake extracted', {
      correlationId: session.ctx.correlationId,
      pages: 'ok',
      fields: Object.keys(result.fields).length,
    });
    return Response.json({ ...result, sourceText: text.slice(0, 8000) });
  } catch (e) {
    log.warn('intake model unavailable', {
      correlationId: session.ctx.correlationId,
      reason: e instanceof ModelError ? e.reason : 'PROVIDER_ERROR',
    });
    throw new HttpError('THROTTLED', 'MODEL_UNAVAILABLE');
  }
});
