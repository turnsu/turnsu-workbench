import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inflateRawSync, inflateSync } from "node:zlib";

const MAX_ENTRIES = 5_000;
const MAX_UNCOMPRESSED_BYTES = 32 * 1024 * 1024;
const MAX_CHARACTERS = 500_000;
const MAX_PDF_PAGES = 200;
const MAX_SHEETS = 64;
const MAX_CELLS = 200_000;

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return crc >>> 0;
});

class ExtractionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fail(code, message) {
  throw new ExtractionError(code, message);
}

function normalizeText(value) {
  const text = String(value)
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "")
    .normalize("NFKC")
    .slice(0, MAX_CHARACTERS);
  if (!text.trim()) fail("attachment_ocr_required", "No readable text was found.");
  return text;
}

function xmlText(value) {
  return String(value)
    .replace(/<w:tab\b[^>]*\/?>/gi, "\t")
    .replace(/<w:br\b[^>]*\/?>/gi, "\n")
    .replace(/<\/w:p>/gi, "\n")
    .replace(/<\/(?:row|si)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function readZipEntries(bytes) {
  let eocd = -1;
  const lower = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= lower; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) fail("attachment_malicious_package", "The Office package has no valid ZIP directory.");
  const commentLength = bytes.readUInt16LE(eocd + 20);
  const diskNumber = bytes.readUInt16LE(eocd + 4);
  const directoryDisk = bytes.readUInt16LE(eocd + 6);
  const diskCount = bytes.readUInt16LE(eocd + 8);
  const count = bytes.readUInt16LE(eocd + 10);
  const directorySize = bytes.readUInt32LE(eocd + 12);
  const directoryOffset = bytes.readUInt32LE(eocd + 16);
  if (
    diskNumber !== 0
    || directoryDisk !== 0
    || diskCount !== count
    || eocd + 22 + commentLength !== bytes.length
    || directoryOffset + directorySize !== eocd
  ) {
    fail("attachment_malicious_package", "The Office package directory is invalid.");
  }
  if (count > MAX_ENTRIES) fail("attachment_limit_exceeded", "The Office package contains too many entries.");
  const entries = new Map();
  const ranges = [];
  let cursor = directoryOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== 0x02014b50) {
      fail("attachment_malicious_package", "The Office package directory is invalid.");
    }
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const expectedCrc = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const nextCursor = cursor + 46 + nameLength + extraLength + commentLength;
    if (nextCursor > eocd) {
      fail("attachment_malicious_package", "The Office package directory is invalid.");
    }
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    if (
      !name ||
      name.includes("\u0000") ||
      name.includes("\\") ||
      name.startsWith("/") ||
      name.split("/").includes("..")
    ) {
      fail("attachment_path_traversal", "The Office package contains an unsafe path.");
    }
    if (entries.has(name)) {
      fail("attachment_malicious_package", "The Office package contains duplicate entries.");
    }
    if ((flags & 1) !== 0 || ![0, 8].includes(method)) {
      fail("attachment_malicious_package", "Encrypted or unsupported Office package entries are forbidden.");
    }
    if (/vbaProject\.bin$|macrosheets|xl\/externalLinks\//i.test(name)) {
      fail("attachment_macro_forbidden", "Macros and external workbook links are forbidden.");
    }
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) {
      fail("attachment_limit_exceeded", "The expanded Office package is too large.");
    }
    if (uncompressedSize > 1024 * 1024 && (compressedSize === 0 || uncompressedSize / compressedSize > 100)) {
      fail("attachment_malicious_package", "The Office package compression ratio is unsafe.");
    }
    if (localOffset + 30 > directoryOffset || bytes.readUInt32LE(localOffset) !== 0x04034b50) {
      fail("attachment_malicious_package", "The Office package entry is invalid.");
    }
    const localFlags = bytes.readUInt16LE(localOffset + 6);
    const localMethod = bytes.readUInt16LE(localOffset + 8);
    const localCrc = bytes.readUInt32LE(localOffset + 14);
    const localCompressedSize = bytes.readUInt32LE(localOffset + 18);
    const localUncompressedSize = bytes.readUInt32LE(localOffset + 22);
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const localNameEnd = localOffset + 30 + localNameLength;
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const end = start + compressedSize;
    if (localNameEnd > directoryOffset || start > directoryOffset || end > directoryOffset) {
      fail("attachment_malicious_package", "The Office package entry is truncated.");
    }
    const localName = bytes.subarray(localOffset + 30, localNameEnd).toString("utf8");
    const usesDataDescriptor = (flags & 0x8) !== 0;
    if (
      localName !== name
      || localFlags !== flags
      || localMethod !== method
      || (!usesDataDescriptor && (
        localCrc !== expectedCrc
        || localCompressedSize !== compressedSize
        || localUncompressedSize !== uncompressedSize
      ))
    ) {
      fail("attachment_malicious_package", "The Office package headers do not match.");
    }
    if (ranges.some(([rangeStart, rangeEnd]) => localOffset < rangeEnd && end > rangeStart)) {
      fail("attachment_malicious_package", "The Office package entries overlap.");
    }
    ranges.push([localOffset, end]);
    const compressed = bytes.subarray(start, end);
    let data;
    try {
      data = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, {
        maxOutputLength: Math.min(MAX_UNCOMPRESSED_BYTES, uncompressedSize + 1),
      });
    } catch {
      fail("attachment_malicious_package", "The Office package entry could not be expanded safely.");
    }
    if (data.length !== uncompressedSize) {
      fail("attachment_malicious_package", "The Office package entry size does not match its directory.");
    }
    if (crc32(data) !== expectedCrc) {
      fail("attachment_integrity_failed", "The Office package entry failed its CRC integrity check.");
    }
    entries.set(name, data);
    cursor = nextCursor;
  }
  if (cursor !== eocd) fail("attachment_malicious_package", "The Office package directory is invalid.");
  return entries;
}

export function extractDocx(bytes) {
  const entries = readZipEntries(bytes);
  const document = entries.get("word/document.xml");
  if (!document) fail("attachment_mime_mismatch", "The uploaded file is not a DOCX document.");
  const text = normalizeText(xmlText(document.toString("utf8")));
  const paragraphs = text.split(/\n+/).filter(Boolean);
  return {
    kind: "document_text",
    text,
    evidence: paragraphs.slice(0, 10_000).map((_, index) => ({ paragraph: index + 1 })),
  };
}

function sharedStrings(entries) {
  const xml = entries.get("xl/sharedStrings.xml")?.toString("utf8") ?? "";
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)].map((match) => xmlText(match[1]));
}

export function extractXlsx(bytes) {
  const entries = readZipEntries(bytes);
  if (!entries.has("xl/workbook.xml")) {
    fail("attachment_mime_mismatch", "The uploaded file is not an XLSX workbook.");
  }
  const strings = sharedStrings(entries);
  const sheets = [...entries.entries()]
    .filter(([name]) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort(([left], [right]) => left.localeCompare(right, "en", { numeric: true }));
  if (sheets.length === 0 || sheets.length > MAX_SHEETS) {
    fail("attachment_limit_exceeded", "The workbook has an unsupported number of sheets.");
  }
  let cells = 0;
  const output = [];
  const evidence = [];
  for (let sheetIndex = 0; sheetIndex < sheets.length; sheetIndex += 1) {
    const [name, data] = sheets[sheetIndex];
    const label = `Sheet ${sheetIndex + 1}`;
    output.push(`# ${label}`);
    const xml = data.toString("utf8");
    for (const rowMatch of xml.matchAll(/<row\b[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/gi)) {
      const values = [];
      for (const cellMatch of rowMatch[2].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)) {
        cells += 1;
        if (cells > MAX_CELLS) fail("attachment_limit_exceeded", "The workbook contains too many cells.");
        const attrs = cellMatch[1];
        const raw = /<v>([\s\S]*?)<\/v>/i.exec(cellMatch[2])?.[1] ?? "";
        const inline = /<is>([\s\S]*?)<\/is>/i.exec(cellMatch[2])?.[1];
        const value = inline !== undefined
          ? xmlText(inline)
          : /\bt="s"/i.test(attrs)
            ? strings[Number(raw)] ?? ""
            : raw;
        values.push(value.replace(/\t|\r?\n/g, " "));
      }
      if (values.some((value) => value.length > 0)) {
        output.push(values.join("\t"));
        evidence.push({ sheet: label, rowStart: Number(rowMatch[1]), rowEnd: Number(rowMatch[1]) });
      }
    }
    if (!name) break;
  }
  return {
    kind: "spreadsheet_tables",
    text: normalizeText(output.join("\n")),
    evidence: evidence.slice(0, 10_000),
  };
}

function decodePdfLiteral(value) {
  return value
    .replace(/\\([nrtbf()\\])/g, (_, token) => ({
      n: "\n", r: "\r", t: "\t", b: "\b", f: "\f",
      "(": "(", ")": ")", "\\": "\\",
    })[token])
    .replace(/\\([0-7]{1,3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
}

function pdfTextFromStream(value) {
  const chunks = [];
  for (const match of value.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) {
    chunks.push(decodePdfLiteral(match[1]));
  }
  for (const match of value.matchAll(/\[((?:.|\n)*?)\]\s*TJ/g)) {
    for (const literal of match[1].matchAll(/\(((?:\\.|[^\\)])*)\)/g)) {
      chunks.push(decodePdfLiteral(literal[1]));
    }
  }
  return chunks.join(" ");
}

export function extractPdf(bytes) {
  if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    fail("attachment_mime_mismatch", "The uploaded file is not a PDF.");
  }
  const source = bytes.toString("latin1");
  if (/\/Encrypt\b/.test(source)) {
    fail("attachment_format_unsupported", "Encrypted PDFs are not supported.");
  }
  const pageCount = (source.match(/\/Type\s*\/Page\b/g) ?? []).length;
  if (pageCount > MAX_PDF_PAGES) fail("attachment_limit_exceeded", "The PDF contains too many pages.");
  const chunks = [pdfTextFromStream(source)];
  for (const match of source.matchAll(/<<(.*?)>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    if (!/\/FlateDecode\b/.test(match[1])) continue;
    try {
      chunks.push(pdfTextFromStream(inflateSync(Buffer.from(match[2], "latin1"), {
        maxOutputLength: MAX_UNCOMPRESSED_BYTES,
      }).toString("latin1")));
    } catch {
      // A malformed individual stream must not make host parsing unsafe. Other
      // valid text streams may still prove that the document has a text layer.
    }
  }
  const text = normalizeText(chunks.join("\n"));
  return {
    kind: "document_text",
    text,
    evidence: Array.from(
      { length: Math.max(1, Math.min(pageCount, MAX_PDF_PAGES)) },
      (_, page) => ({ page: page + 1 }),
    ),
  };
}

export function extractText(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("attachment_processing_failed", "The text file is not valid UTF-8.");
  }
  return { kind: "utf8_text", text: normalizeText(text), evidence: [] };
}

export function extractAttachmentBytes({ bytes, mediaType }) {
  const value = Buffer.from(bytes ?? []);
  if (["text/plain", "text/markdown", "text/csv"].includes(mediaType)) return extractText(value);
  if (mediaType === "application/pdf") return extractPdf(value);
  if (mediaType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return extractDocx(value);
  if (mediaType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return extractXlsx(value);
  return fail("attachment_format_unsupported", "This attachment format cannot be extracted.");
}

async function main() {
  const [inputPath, outputPath, mediaType] = process.argv.slice(2);
  if (!inputPath || !outputPath || !mediaType) fail("attachment_processing_failed", "Extractor arguments are missing.");
  const bytes = await readFile(inputPath);
  const result = extractAttachmentBytes({ bytes, mediaType });
  await writeFile(outputPath, JSON.stringify({ ok: true, ...result }), { mode: 0o600 });
}

async function reportMainFailure(error) {
  const outputPath = process.argv[3];
  const payload = {
    ok: false,
    code: error?.code ?? "attachment_processing_failed",
    message: String(error?.message ?? "Attachment extraction failed.").slice(0, 1000),
  };
  if (outputPath) await writeFile(outputPath, JSON.stringify(payload), { mode: 0o600 }).catch(() => {});
  process.exitCode = 1;
}

const mainUrl = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (mainUrl === import.meta.url) {
  main().catch(reportMainFailure);
}
