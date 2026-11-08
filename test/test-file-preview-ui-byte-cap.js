import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { handleReadFile } from '../dist/handlers/filesystem-handlers.js';
import { runIfMain } from './helpers/run-if-main.js';

const CAP = 64 * 1024;

function textOf(result) {
  return result.content?.find((item) => item.type === 'text')?.text ?? '';
}

async function runTests() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-preview-cap-'));
  try {
    const txt = path.join(dir, 'long-line.txt');
    const md = path.join(dir, 'long-line.md');
    const utf8 = path.join(dir, 'utf8.txt');
    const utf16 = path.join(dir, 'utf16.txt');
    const manyLines = path.join(dir, 'many-lines.md');
    await fs.writeFile(txt, 'x'.repeat(2_000_000));
    await fs.writeFile(md, '# Heading\n' + 'm'.repeat(2_000_000));
    await fs.writeFile(utf8, '€'.repeat(100_000));
    await fs.writeFile(utf16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('あ'.repeat(100_000), 'utf16le')]));
    await fs.writeFile(manyLines, Array.from({ length: 300 }, (_, i) => `line-${i}`).join('\n'));

    for (const file of [txt, md]) {
      const capped = await handleReadFile({ path: file, length: 200, origin: 'ui', options: { maxBytes: CAP } });
      assert.notStrictEqual(capped.isError, true);
      assert.ok(Buffer.byteLength(textOf(capped), 'utf8') <= CAP, `${path.basename(file)} RPC text must be capped`);
      assert.strictEqual(capped.structuredContent?.previewTruncated, true);

      const full = await handleReadFile({ path: file, length: 200, origin: 'ui' });
      assert.ok(Buffer.byteLength(textOf(full), 'utf8') > CAP, `${path.basename(file)} uncapped reload must remain available`);
      assert.notStrictEqual(full.structuredContent?.previewTruncated, true);
    }

    const utf8Capped = await handleReadFile({ path: utf8, length: 200, origin: 'ui', options: { maxBytes: CAP } });
    const utf8Text = textOf(utf8Capped);
    assert.ok(Buffer.byteLength(utf8Text, 'utf8') <= CAP);
    assert.ok(!utf8Text.includes('\uFFFD'), 'UTF-8 cap must not split a multibyte character');
    assert.strictEqual(utf8Capped.structuredContent?.previewTruncated, true);

    const utf16Capped = await handleReadFile({ path: utf16, length: 200, origin: 'ui', options: { maxBytes: CAP } });
    assert.ok(Buffer.byteLength(textOf(utf16Capped), 'utf8') <= CAP);
    assert.ok(!textOf(utf16Capped).includes('\uFFFD'), 'UTF-16LE cap must not split a code unit');
    assert.strictEqual(utf16Capped.structuredContent?.previewTruncated, true);

    const linesCapped = await handleReadFile({ path: manyLines, length: 200, origin: 'ui', options: { maxBytes: CAP } });
    assert.strictEqual(linesCapped.structuredContent?.previewTruncated, true, 'line-limited preview must be marked partial');
    assert.ok(textOf(linesCapped).includes('line-199'));
    assert.ok(!textOf(linesCapped).includes('line-200'));

    const llm = await handleReadFile({ path: txt, length: 200, origin: 'llm', options: { maxBytes: CAP } });
    assert.ok(Buffer.byteLength(textOf(llm), 'utf8') > CAP, 'LLM-origin reads must ignore preview maxBytes');
    assert.strictEqual(llm.structuredContent, undefined);

    console.log('PASS: UI preview byte cap, uncapped reload, UTF-8 boundary, LLM isolation');
    return true;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

runIfMain(import.meta.url, runTests);
export default runTests;
