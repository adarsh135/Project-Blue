import { config } from '../config.js';

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.log', '.js', '.mjs', '.cjs',
  '.ts', '.tsx', '.jsx', '.py', '.sql', '.html', '.htm', '.css', '.xml', '.yaml', '.yml', '.toml',
  '.sh', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.hpp', '.rb', '.php', '.env.example',
]);
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const MEDIA_TYPES = new Set([
  'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/aac', 'audio/ogg', 'audio/webm',
  'audio/mp4', 'video/mp4', 'video/webm', 'video/quicktime', 'application/pdf',
]);

const extensionOf = (name) => {
  const clean = String(name || '').toLowerCase();
  if (clean.endsWith('.env.example')) return '.env.example';
  const dot = clean.lastIndexOf('.');
  return dot < 0 ? '' : clean.slice(dot);
};

export function isTextAttachment(attachment) {
  return attachment?.kind === 'text' || TEXT_EXTENSIONS.has(extensionOf(attachment?.name));
}

/**
 * Validate the small, inline attachment format used by chat. Binary files are
 * intentionally size-limited because the payload is sent through a Vercel
 * Function and (for vision models) included in the provider request.
 */
export function normalizeAttachments(input) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new Error('attachments must be an array');
  if (input.length > 3) throw new Error('Attach at most 3 files per message.');

  let totalBinaryBytes = 0;
  let totalTextChars = 0;
  const files = input.map((raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid attachment.');
    const name = String(raw.name || 'attachment').replace(/[\\/]/g, '_').trim().slice(0, 128) || 'attachment';
    const mimeType = String(raw.mimeType || raw.mime_type || 'application/octet-stream').toLowerCase().split(';')[0].trim();

    if (typeof raw.text === 'string' && (TEXT_EXTENSIONS.has(extensionOf(name)) || mimeType.startsWith('text/') || mimeType === 'application/json')) {
      const text = raw.text;
      const bytes = Buffer.byteLength(text, 'utf8');
      if (bytes > 600_000) throw new Error(`${name} is too large; text files are limited to 600 KB.`);
      totalTextChars += text.length;
      if (totalTextChars > 800_000) throw new Error('Combined text attachments must be under 800,000 characters.');
      return { name, mimeType, kind: 'text', text };
    }

    const allowed = IMAGE_TYPES.has(mimeType) || MEDIA_TYPES.has(mimeType);
    if (!allowed) {
      if (TEXT_EXTENSIONS.has(extensionOf(name))) {
        throw new Error(`${name} must be sent as extracted text.`);
      }
      throw new Error(`Unsupported file type for ${name}. Use an image, PDF, audio/video clip, or text/CSV/code file.`);
    }
    if (typeof raw.data !== 'string' || !raw.data || raw.data.length > Math.ceil(config.maxAttachmentBytes * 4 / 3) + 128) {
      throw new Error(`${name} is too large or has no file data.`);
    }
    const data = raw.data.replace(/^data:[^,]*;base64,/, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4 !== 0) {
      throw new Error(`${name} contains invalid base64 file data.`);
    }
    const size = Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
    if (size > config.maxAttachmentBytes) throw new Error(`${name} exceeds the ${Math.round(config.maxAttachmentBytes / 1024 / 1024)} MB file limit.`);
    totalBinaryBytes += size;
    if (totalBinaryBytes > 2_600_000) throw new Error('Combined image/audio/video/PDF files must be under 2.6 MB per message.');
    return { name, mimeType, kind: IMAGE_TYPES.has(mimeType) ? 'image' : 'media', data, size };
  });

  if (Buffer.byteLength(JSON.stringify(files), 'utf8') > 3_500_000) {
    throw new Error('Combined attachment payload must be under 3.5 MB.');
  }
  return files;
}

export function publicAttachmentMeta(attachments) {
  return (Array.isArray(attachments) ? attachments : []).map((attachment) => ({
    name: attachment.name,
    mimeType: attachment.mimeType,
    kind: attachment.kind,
    size: attachment.size ?? Buffer.byteLength(attachment.text || '', 'utf8'),
  }));
}
