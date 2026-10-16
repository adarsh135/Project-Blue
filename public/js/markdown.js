/**
 * Tiny, dependency-free, XSS-safe markdown renderer.
 * Everything is escaped first, so model output can never inject markup.
 */

export const escapeHtml = (value) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const CODE_SLOT = '\u0001';
const LINK_SLOT = '\u0002';

function inline(text) {
  const links = [];
  let out = text;

  // markdown links first, so autolinking can't double-wrap them
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, href) => {
    links.push(`<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`);
    return `${LINK_SLOT}${links.length - 1}${LINK_SLOT}`;
  });
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, pre, href) => {
    links.push(`<a href="${href}" target="_blank" rel="noopener noreferrer">${href}</a>`);
    return `${pre}${LINK_SLOT}${links.length - 1}${LINK_SLOT}`;
  });

  out = out
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');

  out = out.replace(new RegExp(`${LINK_SLOT}(\\d+)${LINK_SLOT}`, 'g'), (_, i) => links[Number(i)]);
  return out;
}

export function renderMarkdown(source) {
  const text = String(source ?? '').replace(/\r\n/g, '\n');
  const codeBlocks = [];

  // 1. pull out fenced code
  const withSlots = text.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const language = (lang || '').toLowerCase();
    const preview = ['html', 'htm', 'html5'].includes(language)
      ? `<button class="preview-btn" type="button" data-preview="${escapeHtml(code)}">Preview</button>`
      : '';
    codeBlocks.push(
      `<div class="code-wrap"><div class="code-actions">${preview}<button class="copy-btn" type="button" data-copy="${escapeHtml(code)}">copy</button></div>` +
        `<pre><code data-lang="${escapeHtml(language)}">${escapeHtml(code.replace(/\n$/, ''))}</code></pre></div>`,
    );
    return `\n${CODE_SLOT}${codeBlocks.length - 1}${CODE_SLOT}\n`;
  });

  const lines = withSlots.split('\n');
  const html = [];
  let listType = null;
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      html.push(`<p>${inline(escapeHtml(paragraph.join(' ')))}</p>`);
      paragraph = [];
    }
  };
  const closeList = () => {
    if (listType) {
      html.push(`</${listType}>`);
      listType = null;
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = raw.trim();

    const codeMatch = new RegExp(`^${CODE_SLOT}(\\d+)${CODE_SLOT}$`).exec(line);
    if (codeMatch) {
      flushParagraph();
      closeList();
      html.push(codeBlocks[Number(codeMatch[1])]);
      continue;
    }

    if (!line) {
      flushParagraph();
      closeList();
      continue;
    }

    // table
    if (/^\|.*\|$/.test(line) && /^\|[\s:|-]+\|$/.test((lines[i + 1] || '').trim())) {
      flushParagraph();
      closeList();
      const header = line.split('|').slice(1, -1).map((c) => c.trim());
      const rows = [];
      i += 2;
      while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) {
        rows.push(lines[i].trim().split('|').slice(1, -1).map((c) => c.trim()));
        i += 1;
      }
      i -= 1;
      html.push(
        `<table><thead><tr>${header.map((h) => `<th>${inline(escapeHtml(h))}</th>`).join('')}</tr></thead>` +
          `<tbody>${rows
            .map((r) => `<tr>${r.map((c) => `<td>${inline(escapeHtml(c))}</td>`).join('')}</tr>`)
            .join('')}</tbody></table>`,
      );
      continue;
    }

    // headings
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      closeList();
      const level = Math.min(heading[1].length, 4);
      html.push(`<h${level}>${inline(escapeHtml(heading[2]))}</h${level}>`);
      continue;
    }

    // hr
    if (/^(\*\*\*|---|___)$/.test(line)) {
      flushParagraph();
      closeList();
      html.push('<hr />');
      continue;
    }

    // blockquote
    if (line.startsWith('>')) {
      flushParagraph();
      closeList();
      const quote = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quote.push(lines[i].trim().replace(/^>\s?/, ''));
        i += 1;
      }
      i -= 1;
      html.push(`<blockquote>${inline(escapeHtml(quote.join(' ')))}</blockquote>`);
      continue;
    }

    // lists
    const ul = /^[-*+]\s+(.*)$/.exec(line);
    const ol = /^\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushParagraph();
      const wanted = ul ? 'ul' : 'ol';
      if (listType !== wanted) {
        closeList();
        html.push(`<${wanted}>`);
        listType = wanted;
      }
      html.push(`<li>${inline(escapeHtml((ul ? ul[1] : ol[1]).trim()))}</li>`);
      continue;
    }

    closeList();
    paragraph.push(line);
  }

  flushParagraph();
  closeList();
  return html.join('\n');
}

/** Render into a container and wire up copy buttons. */
export function renderInto(element, markdown) {
  element.innerHTML = renderMarkdown(markdown);
  for (const button of element.querySelectorAll('.copy-btn')) {
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(button.dataset.copy || '');
        button.textContent = 'copied';
        setTimeout(() => (button.textContent = 'copy'), 1200);
      } catch {
        button.textContent = 'failed';
      }
    });
  }
  for (const button of element.querySelectorAll('.preview-btn')) {
    button.addEventListener('click', () => {
      const wrapper = button.closest('.code-wrap');
      let preview = wrapper.querySelector('.artifact-preview');
      if (preview) {
        preview.remove();
        button.textContent = 'Preview';
        return;
      }
      preview = element.ownerDocument.createElement('div');
      preview.className = 'artifact-preview';
      const frame = element.ownerDocument.createElement('iframe');
      frame.setAttribute('sandbox', '');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.setAttribute('title', 'Sandboxed HTML artifact preview');
      frame.setAttribute('loading', 'lazy');
      const policy = "default-src 'none'; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline' data:; script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; navigate-to 'none'";
      const artifact = String(button.dataset.preview || '')
        .replace(/<meta\b(?=[^>]*\bhttp-equiv\s*=\s*(?:\"refresh\"|'refresh'|refresh\b))[^>]*>/gi, '')
        .replace(/<base\b[^>]*>/gi, '')
        .replace(/\s(?:href|xlink:href|ping)\s*=\s*(?:\"[^\"]*\"|'[^']*'|[^\s>]+)/gi, '');
      frame.srcdoc = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}">${artifact}`;
      preview.append(frame);
      wrapper.append(preview);
      button.textContent = 'Hide preview';
    });
  }
  return element;
}
