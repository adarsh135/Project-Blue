import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.BLUE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'blue-capabilities-test-'));

const { normalizeAttachments, publicAttachmentMeta } = await import('../server/agent/attachments.js');
const { toOpenAIMessages, toAnthropicMessages, toGeminiContents, toOllamaMessages } = await import('../server/agent/providers.js');
const { ASSISTANT_MODES, buildSystemPrompt } = await import('../server/agent/prompt.js');
const { executeTool, parseCsv } = await import('../server/agent/tools.js');

test('attachment normalization accepts inline text and supported binary formats, rejects unsafe input', () => {
  const [text, image, pdf] = normalizeAttachments([
    { name: 'notes.md', mimeType: 'text/markdown', text: '# hello' },
    { name: 'photo.png', mimeType: 'image/png', data: 'aGVsbG8=' },
    { name: 'paper.pdf', mimeType: 'application/pdf', data: 'aGVsbG8=' },
  ]);
  assert.deepEqual([text.kind, image.kind, pdf.kind], ['text', 'image', 'media']);
  assert.equal(image.size, 5);
  assert.deepEqual(publicAttachmentMeta([text]), [{ name: 'notes.md', mimeType: 'text/markdown', kind: 'text', size: 7 }]);
  assert.throws(() => normalizeAttachments([{ name: 'payload.exe', mimeType: 'application/octet-stream', data: 'aGVsbG8=' }]), /Unsupported file type/);
  assert.throws(() => normalizeAttachments([{ name: 'scan.pdf', mimeType: 'application/pdf', data: 'not base64!' }]), /invalid base64/i);
  assert.throws(() => normalizeAttachments([{}, {}, {}, {}]), /at most 3 files/i);
});

test('provider serializers preserve attachment content only for supported modalities', () => {
  const image = { name: 'photo.png', mimeType: 'image/png', kind: 'image', data: 'aGVsbG8=', size: 5 };
  const pdf = { name: 'paper.pdf', mimeType: 'application/pdf', kind: 'media', data: 'aGVsbG8=', size: 5 };
  const audio = { name: 'voice.webm', mimeType: 'audio/webm', kind: 'media', data: 'aGVsbG8=', size: 5 };

  const openAi = toOpenAIMessages({ system: 'Be useful.', messages: [{ role: 'user', content: 'Describe this', attachments: [image] }] });
  assert.equal(openAi[0].role, 'system');
  assert.equal(openAi[1].content[1].type, 'image_url');
  assert.match(openAi[1].content[1].image_url.url, /^data:image\/png;base64,/);
  assert.throws(() => toOpenAIMessages({ messages: [{ role: 'user', content: 'Read this', attachments: [pdf] }] }), /needs Gemini/);

  const anthropic = toAnthropicMessages({ messages: [{ role: 'user', content: 'Read this', attachments: [pdf, image] }] });
  assert.deepEqual(anthropic[0].content.slice(1).map((block) => block.type), ['document', 'image']);

  const gemini = toGeminiContents({ messages: [{ role: 'user', content: 'Transcribe this', attachments: [audio] }] });
  assert.deepEqual(gemini[0].parts[1].inlineData, { mimeType: 'audio/webm', data: 'aGVsbG8=' });

  assert.throws(() => toOllamaMessages({ messages: [{ role: 'user', content: 'Read this', attachments: [pdf] }] }), /accepts text and images/);
});

test('CSV parser handles quoted fields and deterministic analysis returns grouped statistics', async () => {
  const csv = 'region,revenue,note\r\nEast,10,"first, row"\r\nWest,20,\r\nEast,30,ok';
  const parsed = parseCsv(csv);
  assert.deepEqual(parsed.headers, ['region', 'revenue', 'note']);
  assert.equal(parsed.rows[0].note, 'first, row');

  const result = await executeTool('data_analysis', {
    group_by: 'region',
    value_column: 'revenue',
    operation: 'sum',
  }, { attachments: [{ name: 'sales.csv', kind: 'text', text: csv }] });
  assert.equal(result.ok, true);
  assert.equal(result.row_count, 3);
  assert.equal(result.columns.find((column) => column.name === 'revenue').mean, 20);
  assert.deepEqual(result.chart.series, [{ label: 'East', value: 40 }, { label: 'West', value: 20 }]);
});

test('work modes prescribe useful grounded behavior without exposing chain-of-thought', () => {
  assert.deepEqual(Object.keys(ASSISTANT_MODES), ['auto', 'reasoning', 'research', 'coding', 'planning', 'writing']);
  const prompt = buildSystemPrompt({ mode: 'research', memories: [{ key: 'timezone', value: 'Asia/Kolkata' }] });
  assert.match(prompt, /cite claims with clickable links/i);
  assert.match(prompt, /Never reveal private chain-of-thought/i);
  assert.match(prompt, /timezone: Asia\/Kolkata/);
});
