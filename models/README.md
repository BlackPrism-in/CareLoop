# Local intake model API

This API runs only on `127.0.0.1` and is meant for local experiments with synthetic notes. It does not save requests or write to CareLoop case data.

## Start

Set `GEMINI_API_KEY` and `FLASH_LITE_MODEL_ID` in `models/.env`, then from the repository root run:

```powershell
corepack pnpm dev:models-api
```

The server listens at `http://127.0.0.1:3001`. Set `MODEL_API_PORT` to use another port.

## Check health

```powershell
Invoke-RestMethod http://127.0.0.1:3001/health
```

## Upload a document and preview an intake

Send one PDF, DOCX, or UTF-8 TXT file as a multipart `file` field. Optional `sourceAuthority` and `languageHint` fields are also accepted. For example, with `curl.exe` in PowerShell:

```powershell
curl.exe -X POST http://127.0.0.1:3001/v1/intake/preview `
  -F "file=@C:\path\to\synthetic-note.pdf" `
  -F "sourceAuthority=synthetic test note" `
  -F "languageHint=English"
```

The response contains the extracted text in `document.extractedText` and a validated `proposal` with fields, computed `missing` fields, warnings, a tenant-scoped duplicate fingerprint when required inputs are present, and metadata. Source-span offsets refer to this extracted text. Files are limited to 8 MB, PDFs to 40 pages, and extracted text to 20,000 characters. Scanned PDFs without selectable text need OCR, which this API does not provide.

The JSON `sourceText` request is still available for notes whose text has already been extracted. Model failures and unreadable documents return non-2xx responses with an error code and message.

Run the rules and Gemini evaluator from the repository root with `corepack pnpm eval:models`. The full seed set has 22 cases. To rerun selected cases, set `EVAL_CASE_IDS` to comma-separated seed IDs, for example `EVAL_CASE_IDS=clean-001,hinglish-001`.

Because note text is sent to Gemini, use synthetic notes only in this local testing API. Do not expose this server to a network or send real patient information.
