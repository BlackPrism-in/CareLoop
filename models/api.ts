import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import Busboy from '@fastify/busboy';
import {
  DocumentExtractionError,
  extractDocumentText,
  MAX_EXTRACTED_CHARACTERS,
  MAX_UPLOAD_BYTES,
} from './document';
import { createGeminiIntakeModel } from './model';
import { runIntake } from './run';

const HOST = '127.0.0.1';
const PORT = Number(process.env.MODEL_API_PORT ?? 3001);
const MAX_BODY_BYTES = 64 * 1024;
const MAX_MULTIPART_BYTES = MAX_UPLOAD_BYTES + MAX_BODY_BYTES;

class UploadError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw new RangeError('Request body exceeds 64 KB');
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new SyntaxError('Request body must be valid JSON');
  }
}

type MultipartUpload = {
  file: { filename: string; buffer: Buffer };
  sourceAuthority?: string;
  languageHint?: string;
};

async function readMultipart(req: IncomingMessage): Promise<MultipartUpload> {
  return new Promise((resolve, reject) => {
    const parser = new Busboy({
      headers: { ...req.headers, 'content-type': req.headers['content-type'] ?? '' },
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 2, parts: 3, fieldSize: 8 * 1024 },
    });
    let fileCount = 0;
    let receivedBytes = 0;
    let fileName = '';
    let fileChunks: Buffer[] = [];
    let fileBuffer: Buffer | undefined;
    let uploadError: UploadError | undefined;
    const fields: Record<string, string> = {};
    let settled = false;
    const fail = (error: Error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };

    req.on('data', (chunk: Buffer | string) => {
      receivedBytes += Buffer.byteLength(chunk);
      if (receivedBytes > MAX_MULTIPART_BYTES) {
        uploadError = new UploadError(
          'Multipart request exceeds the upload limit.',
          413,
          'UPLOAD_TOO_LARGE',
        );
        req.unpipe(parser);
        parser.destroy();
        req.resume();
        fail(uploadError);
      }
    });
    req.on('error', (error) => fail(error));
    parser.on('file', (fieldName, stream, filename) => {
      fileCount++;
      if (fieldName !== 'file' || fileCount > 1) {
        uploadError ??= new UploadError(
          'Send exactly one file using the `file` field.',
          400,
          'INVALID_UPLOAD',
        );
        stream.resume();
        return;
      }
      fileName = filename;
      stream.on('limit', () => {
        uploadError = new UploadError('File exceeds the 8 MB upload limit.', 413, 'FILE_TOO_LARGE');
      });
      stream.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        fileChunks.push(buffer);
      });
      stream.on('error', (error) => fail(error));
      stream.on('end', () => {
        if (!stream.truncated) fileBuffer = Buffer.concat(fileChunks);
        fileChunks = [];
      });
    });
    parser.on('field', (name, value, nameTruncated, valueTruncated) => {
      if (nameTruncated || valueTruncated) {
        uploadError ??= new UploadError(
          'A multipart field exceeds its size limit.',
          413,
          'FIELD_TOO_LARGE',
        );
      } else if (!['sourceAuthority', 'languageHint'].includes(name) || name in fields) {
        uploadError ??= new UploadError(
          'Only sourceAuthority and languageHint fields are supported once each.',
          400,
          'INVALID_UPLOAD',
        );
      } else {
        fields[name] = value;
      }
    });
    parser.on('filesLimit', () => {
      uploadError = new UploadError('Upload only one document at a time.', 400, 'TOO_MANY_FILES');
    });
    parser.on('fieldsLimit', () => {
      uploadError = new UploadError('Upload has too many text fields.', 400, 'TOO_MANY_FIELDS');
    });
    parser.on('partsLimit', () => {
      uploadError = new UploadError('Upload has too many parts.', 400, 'TOO_MANY_PARTS');
    });
    parser.on('error', (error) =>
      fail(error instanceof Error ? error : new Error('Malformed multipart request')),
    );
    parser.on('finish', () => {
      if (settled) return;
      if (uploadError) return fail(uploadError);
      if (fileCount !== 1 || !fileName || !fileBuffer) {
        return fail(
          new UploadError('A document is required in the `file` field.', 400, 'FILE_REQUIRED'),
        );
      }
      settled = true;
      resolve({
        file: { filename: fileName, buffer: fileBuffer },
        sourceAuthority: fields.sourceAuthority,
        languageHint: fields.languageHint,
      });
    });
    req.pipe(parser);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}`);
  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, {
      ok: true,
      service: 'careloop-model-api',
      configured: Boolean(process.env.GEMINI_API_KEY && process.env.FLASH_LITE_MODEL_ID),
    });
  }

  if (req.method !== 'POST' || url.pathname !== '/v1/intake/preview') {
    return send(res, 404, { error: { code: 'NOT_FOUND', message: 'Route not found' } });
  }

  if (!process.env.GEMINI_API_KEY || !process.env.FLASH_LITE_MODEL_ID) {
    return send(res, 503, {
      error: {
        code: 'MODEL_NOT_CONFIGURED',
        message: 'Set GEMINI_API_KEY and FLASH_LITE_MODEL_ID in models/.env',
      },
    });
  }

  const contentType = req.headers['content-type']?.toLowerCase() ?? '';
  let sourceText: string;
  let sourceAuthority: string | undefined;
  let languageHint: string | undefined;
  let documentInfo: { filename: string; mediaType: string } | undefined;
  try {
    if (contentType.startsWith('application/json')) {
      const body = await readJson(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return send(res, 400, {
          error: { code: 'INVALID_REQUEST', message: 'Body must be a JSON object' },
        });
      }
      const input = body as Record<string, unknown>;
      if (typeof input.sourceText !== 'string' || !input.sourceText.trim()) {
        return send(res, 400, {
          error: { code: 'INVALID_REQUEST', message: 'sourceText must be a non-empty string' },
        });
      }
      if (input.sourceText.length > MAX_EXTRACTED_CHARACTERS) {
        return send(res, 413, {
          error: {
            code: 'SOURCE_TOO_LARGE',
            message: `sourceText must be at most ${MAX_EXTRACTED_CHARACTERS} characters`,
          },
        });
      }
      for (const key of ['sourceAuthority', 'languageHint'] as const) {
        if (input[key] !== undefined && typeof input[key] !== 'string') {
          return send(res, 400, {
            error: { code: 'INVALID_REQUEST', message: `${key} must be a string` },
          });
        }
      }
      sourceText = input.sourceText;
      sourceAuthority = input.sourceAuthority as string | undefined;
      languageHint = input.languageHint as string | undefined;
    } else if (contentType.startsWith('multipart/form-data')) {
      const contentLength = Number(req.headers['content-length'] ?? 0);
      if (contentLength > MAX_MULTIPART_BYTES) {
        return send(res, 413, {
          error: {
            code: 'UPLOAD_TOO_LARGE',
            message: 'Multipart request exceeds the upload limit.',
          },
        });
      }
      const upload = await readMultipart(req);
      const extracted = await extractDocumentText(upload.file);
      sourceText = extracted.text;
      sourceAuthority = upload.sourceAuthority;
      languageHint = upload.languageHint;
      documentInfo = { filename: extracted.filename, mediaType: extracted.mediaType };
    } else {
      return send(res, 415, {
        error: {
          code: 'UNSUPPORTED_CONTENT_TYPE',
          message: 'Use application/json or multipart/form-data with a file.',
        },
      });
    }
  } catch (error) {
    if (error instanceof UploadError) {
      return send(res, error.status, { error: { code: error.code, message: error.message } });
    }
    if (error instanceof DocumentExtractionError) {
      const status =
        error.code === 'UNSUPPORTED_FILE_TYPE'
          ? 415
          : error.code === 'DOCUMENT_TOO_LARGE'
            ? 413
            : 422;
      return send(res, status, { error: { code: error.code, message: error.message } });
    }
    if (error instanceof RangeError || error instanceof SyntaxError) {
      return send(res, error instanceof RangeError ? 413 : 400, {
        error: {
          code: error instanceof RangeError ? 'BODY_TOO_LARGE' : 'INVALID_JSON',
          message: error.message,
        },
      });
    }
    return send(res, 400, {
      error: {
        code: 'INVALID_UPLOAD',
        message: error instanceof Error ? error.message : 'Could not read request body',
      },
    });
  }

  try {
    const model = createGeminiIntakeModel({
      apiKey: process.env.GEMINI_API_KEY,
      modelId: process.env.FLASH_LITE_MODEL_ID,
    });
    const result = await runIntake(
      {
        tenantId: 'local-test',
        caseDraftId: `preview-${randomUUID()}`,
        sourceText,
        sourceAuthority,
        languageHint,
      },
      { model, synthetic: true },
    );

    if (result.status === 'manual_entry') {
      const modelError = result.reason.startsWith('model_error:');
      return send(res, modelError ? 502 : 422, {
        status: result.status,
        attempts: result.attempts,
        error: {
          code: modelError ? 'MODEL_CALL_FAILED' : 'INVALID_MODEL_OUTPUT',
          message: result.reason,
        },
      });
    }
    return send(res, 200, {
      status: result.status,
      attempts: result.attempts,
      proposal: result.proposal,
      ...(documentInfo
        ? {
            document: {
              ...documentInfo,
              extractedCharacters: sourceText.length,
              extractedText: sourceText,
            },
          }
        : {}),
    });
  } catch (error) {
    return send(res, 400, {
      error: {
        code: 'INVALID_REQUEST',
        message: error instanceof Error ? error.message : 'Invalid request',
      },
    });
  }
});

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65_535) {
  throw new Error('MODEL_API_PORT must be a valid TCP port number');
}

server.listen(PORT, HOST, () => {
  console.log(`CareLoop model API listening at http://${HOST}:${PORT}`);
  console.log(`Health:  http://${HOST}:${PORT}/health`);
  console.log(`Preview: POST http://${HOST}:${PORT}/v1/intake/preview`);
});
