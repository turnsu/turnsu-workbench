import assert from "node:assert/strict";
import test from "node:test";
import { deflateRawSync } from "node:zlib";

import {
  extractAttachmentBytes,
} from "../../src/attachments/attachment-extractor-worker.mjs";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const MAX_ENTRIES = 5_000;
const MAX_UNCOMPRESSED_BYTES = 32 * 1024 * 1024;
const MAX_SHEETS = 64;
const MAX_CELLS = 200_000;

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return crc >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const input of entries) {
    const entry = Array.isArray(input)
      ? { name: input[0], value: input[1] }
      : input;
    const nameBytes = Buffer.from(entry.name, "utf8");
    const localNameBytes = Buffer.from(entry.localName ?? entry.name, "utf8");
    const data = Buffer.from(entry.value);
    const method = entry.method ?? 0;
    const flags = entry.flags ?? 0;
    const compressed = method === 8 ? deflateRawSync(data) : Buffer.from(data);
    const checksum = entry.crc ?? crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(entry.localFlags ?? flags, 6);
    localHeader.writeUInt16LE(entry.localMethod ?? method, 8);
    localHeader.writeUInt32LE(entry.localCrc ?? checksum, 14);
    localHeader.writeUInt32LE(entry.localCompressedSize ?? compressed.length, 18);
    localHeader.writeUInt32LE(entry.localUncompressedSize ?? data.length, 22);
    localHeader.writeUInt16LE(localNameBytes.length, 26);
    local.push(localHeader, localNameBytes, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(flags, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(entry.compressedSize ?? compressed.length, 20);
    centralHeader.writeUInt32LE(entry.uncompressedSize ?? data.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, nameBytes);
    offset += localHeader.length + localNameBytes.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

function centralOffset(bytes) {
  return bytes.readUInt32LE(bytes.length - 6);
}

function firstLocalDataOffset(bytes) {
  return 30 + bytes.readUInt16LE(26) + bytes.readUInt16LE(28);
}

function code(expected) {
  return (error) => error?.code === expected;
}

function workbookEntries(sheetCount, cellsPerSheet = 1) {
  const cells = Array.from(
    { length: cellsPerSheet },
    (_, index) => `<c r="A${index + 1}"><v>1</v></c>`,
  ).join("");
  return [
    ["xl/workbook.xml", "<workbook/>"],
    ...Array.from({ length: sheetCount }, (_, index) => [
      `xl/worksheets/sheet${index + 1}.xml`,
      `<worksheet><sheetData><row r="1">${cells}</row></sheetData></worksheet>`,
    ]),
  ];
}

test("attachment extractor normalizes UTF-8 text, Markdown, CSV, and text-layer PDF", () => {
  for (const mediaType of ["text/plain", "text/markdown", "text/csv"]) {
    const result = extractAttachmentBytes({
      bytes: Buffer.from("Title\r\nvalue", "utf8"),
      mediaType,
    });
    assert.equal(result.kind, "utf8_text");
    assert.equal(result.text, "Title\nvalue");
  }
  const pdf = extractAttachmentBytes({
    bytes: Buffer.from("%PDF-1.4\n1 0 obj << /Type /Page >>\nBT (Readable PDF) Tj ET\n%%EOF", "latin1"),
    mediaType: "application/pdf",
  });
  assert.equal(pdf.kind, "document_text");
  assert.match(pdf.text, /Readable PDF/);
  assert.deepEqual(pdf.evidence, [{ page: 1 }]);
});

test("attachment extractor reads DOCX paragraphs and XLSX cells without executing formulas", () => {
  const docx = extractAttachmentBytes({
    bytes: storedZip([
      ["[Content_Types].xml", "<Types/>"],
      ["word/document.xml", "<w:document><w:p><w:r><w:t>Hello DOCX</w:t></w:r></w:p></w:document>"],
    ]),
    mediaType: DOCX,
  });
  assert.equal(docx.kind, "document_text");
  assert.match(docx.text, /Hello DOCX/);

  const xlsx = extractAttachmentBytes({
    bytes: storedZip([
      ["xl/workbook.xml", "<workbook/>"],
      ["xl/sharedStrings.xml", "<sst><si><t>Header</t></si><si><t>Value</t></si></sst>"],
      ["xl/worksheets/sheet1.xml", [
        "<worksheet><sheetData><row r=\"1\">",
        "<c r=\"A1\" t=\"s\"><v>0</v></c>",
        "<c r=\"B1\"><f>UNSAFE()</f><v>1</v></c>",
        "</row></sheetData></worksheet>",
      ].join("")],
    ]),
    mediaType: XLSX,
  });
  assert.equal(xlsx.kind, "spreadsheet_tables");
  assert.match(xlsx.text, /Header\t1/);
  assert.doesNotMatch(xlsx.text, /UNSAFE/);
});

test("attachment extractor fail-closes unsupported, OCR, macro, traversal, and bound violations", () => {
  assert.throws(
    () => extractAttachmentBytes({
      bytes: Buffer.from("legacy"),
      mediaType: "application/msword",
    }),
    (error) => error.code === "attachment_format_unsupported",
  );
  assert.throws(
    () => extractAttachmentBytes({
      bytes: Buffer.from("%PDF-1.4\n1 0 obj << /Type /Page >>\n%%EOF", "latin1"),
      mediaType: "application/pdf",
    }),
    (error) => error.code === "attachment_ocr_required",
  );
  assert.throws(
    () => extractAttachmentBytes({
      bytes: storedZip([
        ["word/document.xml", "<w:p>safe</w:p>"],
        ["word/vbaProject.bin", "macro"],
      ]),
      mediaType: DOCX,
    }),
    (error) => error.code === "attachment_macro_forbidden",
  );
  assert.throws(
    () => extractAttachmentBytes({
      bytes: storedZip([["../word/document.xml", "unsafe"]]),
      mediaType: DOCX,
    }),
    (error) => error.code === "attachment_path_traversal",
  );
  assert.throws(
    () => extractAttachmentBytes({
      bytes: Buffer.from(`%PDF-1.4\n${"/Type /Page\n".repeat(201)}(too many) Tj`, "latin1"),
      mediaType: "application/pdf",
    }),
    (error) => error.code === "attachment_limit_exceeded",
  );
});

test("ZIP directory and entry structure fail closed on malformed or ambiguous packages", async (t) => {
  const document = "<w:document><w:p><w:r><w:t>safe</w:t></w:r></w:p></w:document>";

  await t.test("invalid central directory signature", () => {
    const zip = storedZip([["word/document.xml", document]]);
    zip.writeUInt32LE(0, centralOffset(zip));
    assert.throws(() => extractAttachmentBytes({ bytes: zip, mediaType: DOCX }), code("attachment_malicious_package"));
  });

  await t.test("invalid central directory extent", () => {
    const zip = storedZip([["word/document.xml", document]]);
    zip.writeUInt32LE(zip.readUInt32LE(zip.length - 10) - 1, zip.length - 10);
    assert.throws(() => extractAttachmentBytes({ bytes: zip, mediaType: DOCX }), code("attachment_malicious_package"));
  });

  await t.test("encrypted entry", () => {
    const zip = storedZip([{ name: "word/document.xml", value: document, flags: 1 }]);
    assert.throws(() => extractAttachmentBytes({ bytes: zip, mediaType: DOCX }), code("attachment_malicious_package"));
  });

  await t.test("truncated entry data", () => {
    const size = Buffer.byteLength(document);
    const zip = storedZip([{
      name: "word/document.xml",
      value: document,
      compressedSize: size + 10,
      localCompressedSize: size + 10,
    }]);
    assert.throws(() => extractAttachmentBytes({ bytes: zip, mediaType: DOCX }), code("attachment_malicious_package"));
  });

  await t.test("expanded size mismatch", () => {
    const size = Buffer.byteLength(document);
    const zip = storedZip([{
      name: "word/document.xml",
      value: document,
      uncompressedSize: size + 1,
      localUncompressedSize: size + 1,
    }]);
    assert.throws(() => extractAttachmentBytes({ bytes: zip, mediaType: DOCX }), code("attachment_malicious_package"));
  });

  await t.test("duplicate entry name", () => {
    const zip = storedZip([
      ["word/document.xml", document],
      ["word/document.xml", document],
    ]);
    assert.throws(() => extractAttachmentBytes({ bytes: zip, mediaType: DOCX }), code("attachment_malicious_package"));
  });
});

test("ZIP local headers must match the signed central-directory interpretation", async (t) => {
  const document = "<w:document><w:p>safe</w:p></w:document>";
  const checksum = crc32(Buffer.from(document));
  const size = Buffer.byteLength(document);
  const mismatches = [
    { name: "name", localName: "word/document.xMl" },
    { name: "flags", localFlags: 0x800 },
    { name: "method", localMethod: 8 },
    { name: "CRC", localCrc: (checksum ^ 1) >>> 0 },
    { name: "compressed size", localCompressedSize: size + 1 },
    { name: "uncompressed size", localUncompressedSize: size + 1 },
  ];
  for (const mismatch of mismatches) {
    await t.test(mismatch.name, () => {
      const { name: _name, ...override } = mismatch;
      const zip = storedZip([{ name: "word/document.xml", value: document, ...override }]);
      assert.throws(() => extractAttachmentBytes({ bytes: zip, mediaType: DOCX }), code("attachment_malicious_package"));
    });
  }
});

test("ZIP entries validate CRC after bounded expansion", () => {
  const zip = storedZip([[
    "word/document.xml",
    "<w:document><w:p>CRC protected</w:p></w:document>",
  ]]);
  zip[firstLocalDataOffset(zip) + 20] ^= 1;

  assert.throws(
    () => extractAttachmentBytes({ bytes: zip, mediaType: DOCX }),
    code("attachment_integrity_failed"),
  );
});

test("ZIP compression ratio and expanded-byte limits fail closed", () => {
  assert.throws(
    () => extractAttachmentBytes({
      bytes: storedZip([{
        name: "word/document.xml",
        value: Buffer.alloc(1024 * 1024 + 1, 0x61),
        method: 8,
      }]),
      mediaType: DOCX,
    }),
    code("attachment_malicious_package"),
  );
  assert.throws(
    () => extractAttachmentBytes({
      bytes: storedZip([{
        name: "word/document.xml",
        value: "<w:p>small</w:p>",
        uncompressedSize: MAX_UNCOMPRESSED_BYTES + 1,
      }]),
      mediaType: DOCX,
    }),
    code("attachment_limit_exceeded"),
  );
});

test("ZIP accepts exactly 5000 entries and rejects the 5001st", () => {
  const document = ["word/document.xml", "<w:document><w:p>entry boundary</w:p></w:document>"];
  const padding = Array.from(
    { length: MAX_ENTRIES - 1 },
    (_, index) => [`docProps/padding-${index}.xml`, ""],
  );
  assert.match(
    extractAttachmentBytes({ bytes: storedZip([document, ...padding]), mediaType: DOCX }).text,
    /entry boundary/,
  );
  assert.throws(
    () => extractAttachmentBytes({
      bytes: storedZip([document, ...padding, ["docProps/overflow.xml", ""]]),
      mediaType: DOCX,
    }),
    code("attachment_limit_exceeded"),
  );
});

test("ZIP accepts exactly 32 MiB expanded and rejects one byte more", () => {
  const document = Buffer.from("<w:document><w:p>expanded boundary</w:p></w:document>");
  const padding = Buffer.alloc(MAX_UNCOMPRESSED_BYTES - document.byteLength);
  assert.match(
    extractAttachmentBytes({
      bytes: storedZip([
        ["word/document.xml", document],
        ["docProps/padding.bin", padding],
      ]),
      mediaType: DOCX,
    }).text,
    /expanded boundary/,
  );
  assert.throws(
    () => extractAttachmentBytes({
      bytes: storedZip([{
        name: "word/document.xml",
        value: document,
        uncompressedSize: MAX_UNCOMPRESSED_BYTES + 1,
      }]),
      mediaType: DOCX,
    }),
    code("attachment_limit_exceeded"),
  );
});

test("XLSX accepts exactly 64 sheets and rejects the 65th", () => {
  assert.equal(
    extractAttachmentBytes({ bytes: storedZip(workbookEntries(MAX_SHEETS)), mediaType: XLSX }).kind,
    "spreadsheet_tables",
  );
  assert.throws(
    () => extractAttachmentBytes({ bytes: storedZip(workbookEntries(MAX_SHEETS + 1)), mediaType: XLSX }),
    code("attachment_limit_exceeded"),
  );
});

test("XLSX accepts exactly 200000 cells and rejects the 200001st", () => {
  assert.equal(
    extractAttachmentBytes({ bytes: storedZip(workbookEntries(1, MAX_CELLS)), mediaType: XLSX }).kind,
    "spreadsheet_tables",
  );
  assert.throws(
    () => extractAttachmentBytes({ bytes: storedZip(workbookEntries(1, MAX_CELLS + 1)), mediaType: XLSX }),
    code("attachment_limit_exceeded"),
  );
});
