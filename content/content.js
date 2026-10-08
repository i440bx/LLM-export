const _s = document.createElement('script');
_s.src = chrome.runtime.getURL('content/helper.js');
document.documentElement.appendChild(_s);
_s.remove();

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'ping') {
    sendResponse({ status: 'ok' });
    return;
  }
  if (request.action === 'convert_to_html') {
    const run = request.format === 'markdown'
      ? exportMarkdown()
      : convertToHTML(request.format, request.theme, request.includeImages, request.latexSupport, request.askTitle);
    run.then((result) => sendResponse({ status: result ?? 'done' }))
      .catch(() => sendResponse({ status: 'done' }));
    return true;
  }
  if (request.action === 'check_dom_fallback') {
    sendResponse({ usesDom: !(getAccessToken() && getConversationId()) });
    return;
  }
});

function getAccessToken() {
  try {
    return JSON.parse(document.getElementById('client-bootstrap').textContent)
      .session.accessToken;
  } catch { return null; }
}

function getConversationId() {
  return window.location.pathname.match(/\/c\/([^/?#]+)/)?.[1] ?? null;
}

function fetchConversation(convId, token, includeImages) {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();

    const handler = (event) => {
      if (event.data?.source !== 'chatgpt-export-page') return;
      if (event.data?.requestId !== requestId) return;
      window.removeEventListener('message', handler);
      clearTimeout(timer);
      if (event.data.error) {
        reject(new Error(event.data.error));
      } else {
        resolve({ data: event.data.data, images: event.data.images ?? {} });
      }
    };

    const timer = setTimeout(() => {
      window.removeEventListener('message', handler);
      reject(new Error('Request timed out'));
    }, 60000);

    window.addEventListener('message', handler);
    window.postMessage(
      { source: 'chatgpt-export-ext', type: 'fetch_conversation', convId, token, requestId, includeImages },
      'https://chatgpt.com'
    );
  });
}

function linearize(mapping, includeImages, currentNode) {
  const root = Object.values(mapping).find(n => !n.parent || !mapping[n.parent]);

  const activePath = new Set();
  let cursor = mapping[currentNode] ? currentNode : null;
  while (cursor && !activePath.has(cursor)) {
    activePath.add(cursor);
    cursor = mapping[cursor]?.parent;
  }

  const subtreeSize = {};
  function size(id) {
    if (id in subtreeSize) return subtreeSize[id];
    const node = mapping[id];
    if (!node) return (subtreeSize[id] = 0);
    const childSizes = (node.children ?? []).map(cid => size(cid));
    return (subtreeSize[id] = 1 + (childSizes.length ? Math.max(...childSizes) : 0));
  }
  for (const id of Object.keys(mapping)) size(id);

  const messages = [];
  let node = root;

  while (node) {
    const msg = node.message;
    const role = msg?.author?.role;
    if (role === 'user' || role === 'assistant' || role === 'tool') {
      const segments = [];
      for (const part of (msg.content?.parts ?? [])) {
        if (typeof part === 'string' && role !== 'tool') {
          const text = part
            .replace(/\u{E0000}[\u{E0000}-\u{E007F}]*/gu, '')
            .replace(/citeturn\d+\w*/g, '')
            .trim();
          if (text) segments.push({ type: 'text', content: text });
        } else if (includeImages && part?.content_type === 'image_asset_pointer' && part?.asset_pointer) {
          segments.push({ type: 'image', fileId: part.asset_pointer.split('://')[1] });
        }
      }
      const displayRole = role === 'tool' ? 'assistant' : role;
      if (segments.length) {
        const citeMap = {};
        for (const ref of (msg.metadata?.content_references ?? [])) {
          if (!ref.matched_text) continue;
          // Most web citations expose an items array. File citations may instead
          // carry their filename/title directly on the reference object.
          citeMap[ref.matched_text] = ref.items?.length ? ref.items : [ref];
        }
        messages.push({ role: displayRole, segments, citeMap });
      }
    }
    const validChildren = (node.children ?? []).filter(cid => cid in mapping);
    const activeChild   = validChildren.find(cid => activePath.has(cid));
    node = validChildren.length
      ? mapping[activeChild ?? validChildren.reduce((best, cid) => subtreeSize[cid] > subtreeSize[best] ? cid : best)]
      : null;
  }

  return messages;
}

function mdResolveSpans(text, citeMap) {
  text = text.replace(/\uE200url\uE202([^\uE202\uE201]+)\uE202([^\uE201]+)\uE201/g,
    (_, label, href) => `[${label.trim()}](${href.trim()})`);

  text = text.replace(/\uE200entity\uE202([^\uE201]+)\uE201/g, (_, json) => {
    try {
      const arr = JSON.parse(json.replace(/\\"/g, '"'));
      return Array.isArray(arr) && arr[1] ? arr[1] : json;
    } catch { return json; }
  });

  text = text.replace(/\uE200(filecite|cite)(?:\uE202[^\uE202\uE201]+)+\uE201/g, (match, kind) => {
    const items = citeMap[match] ?? [];
    const tokenRef = match.match(/turn\d+file\d+/)?.[0] || 'file';

    if (kind === 'filecite') {
      if (!items.length) return ` [File: ${tokenRef}]`;
      const labels = items.map(item =>
        item.title || item.filename || item.file_name || item.name || item.attribution || tokenRef
      );
      return ` [File: ${[...new Set(labels)].join(', ')}]`;
    }

    if (!items.length) return '';
    const links = items.map(item => {
      const label = item.attribution || item.title || item.url || 'Source';
      return item.url ? `[${label}](${item.url})` : label;
    });
    return ` (${links.join(', ')})`;
  });

  return text
    .replace(/\u{E0000}[\u{E0000}-\u{E007F}]*/gu, '')
    .replace(/citeturn\d+\w*/g, '');
}

async function exportMarkdown() {
  const token = getAccessToken();
  const convId = getConversationId();
  if (!token || !convId) {
    alert('Markdown export requires you to be signed in to ChatGPT.');
    return;
  }

  const result = await fetchConversation(convId, token, false);
  const messages = linearize(result.data.mapping, false, result.data.current_node);
  if (!messages.length) throw new Error('No messages found.');

  const label = { user: 'User', assistant: 'Assistant' };
  const md = messages
    .map(({ role, segments, citeMap }) => {
      const text = segments
        .filter(s => s.type === 'text')
        .map(s => mdResolveSpans(s.content, citeMap ?? {}))
        .join('\n\n');
      return `## ${label[role] || role}\n\n${text}`;
    })
    .join('\n\n');

  const blob = new Blob([md], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const date = new Date().toISOString().slice(0, 10);
  const filename = sanitizeFilename(document.title);
  a.href = url;
  a.download = `${filename}-${date}.md`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function sanitizeFilename(title) {
  const cleaned = title
    .replace(/[\\/:*?"<>|\x00-\x1F]/g, '')
    .trim()
    .replace(/\.+$/, '')
    .trim()
    .replace(/\s+/g, '-');
  return cleaned.slice(0, 150) || 'LLM';
}

function savePrintDocument(html) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ printDocument: { html } }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

let _refMap = {}, _fnDefs = {};
let _citeMap = {};

function inline(text) {
  const escapedChars = [];
  const mathInline = [];

  text = text.replace(/\\\((.+?)\\\)/g, (_, math) => {
    mathInline.push(math);
    return `\x00MI${mathInline.length - 1}\x00`;
  });

  text = text.replace(/\\([*_`~\[\]\\#>!|(). -])/g, (_, ch) => {
    escapedChars.push(ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch);
    return `\x00EC${escapedChars.length - 1}\x00`;
  });

  text = text.replace(/\$([^$\n]+?)\$/g, (_, math) => {
    mathInline.push(math);
    return `\x00MI${mathInline.length - 1}\x00`;
  });

  text = esc(text);

  text = text.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  text = text.replace(/~~(.+?)~~/g, '<del>$1</del>');
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');

  text = text.replace(/\uE200url\uE202([^\uE202\uE201]+)\uE202([^\uE201]+)\uE201/g,
    (_, label, href) => `<a href="${href.trim()}" target="_blank" rel="noopener">${label.trim()}</a>`);

  text = text.replace(/\uE200entity\uE202([^\uE201]+)\uE201/g, (_, json) => {
    try {
      const arr = JSON.parse(json.replace(/\\"/g, '"'));
      const name = Array.isArray(arr) && arr[1] ? arr[1] : json;
      return `<span class="entity">${name}</span>`;
    } catch { return json; }
  });

  text = text.replace(/\uE200(filecite|cite)(?:\uE202[^\uE202\uE201]+)+\uE201/g, (match, kind) => {
    const items = _citeMap[match] ?? [];
    const tokenRef = match.match(/turn\d+file\d+/)?.[0] || 'file';

    if (kind === 'filecite') {
      const labels = (items.length ? items : [{ title: tokenRef }]).map(item =>
        item.title || item.filename || item.file_name || item.name || item.attribution || tokenRef
      );
      const uniqueLabels = [...new Set(labels)].map(label => esc(String(label)));
      return `<span class="file-cite">[File: ${uniqueLabels.join(', ')}]</span>`;
    }

    if (!items.length) return '';
    const nums = items.map(item => {
      const label = esc(String(item.attribution || item.title || item.url || 'Source'));
      const title = esc(String(item.title || '')).replace(/"/g, '&quot;');
      if (!item.url) return label;
      const href = String(item.url).replace(/"/g, '&quot;');
      return `<a href="${href}" target="_blank" rel="noopener" class="cite-num" title="${title}">${label}</a>`;
    });
    return `<sup class="cite">[${nums.join(', ')}]</sup>`;
  });

  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>');

  text = text.replace(/\[([^\]]+)\]\[([^\]]*)\]/g, (_, txt, id) => {
    const url = _refMap[(id || txt).toLowerCase()];
    return url ? `<a href="${url}" target="_blank" rel="noopener">${txt}</a>` : txt;
  });

  text = text.replace(/\[\^([^\]]+)\]/g, (_, id) => {
    const n = (_fnDefs[id] || {}).n || '?';
    return `<sup><a href="#fn-${id}" id="fnref-${id}">[${n}]</a></sup>`;
  });

  text = text.replace(/\x00MI(\d+)\x00/g, (_, i) => `\\(${mathInline[+i]}\\)`);
  text = text.replace(/\x00EC(\d+)\x00/g, (_, i) => escapedChars[+i]);

  return text;
}

function renderTable(lines) {
  const rows = lines
    .filter(l => !/^[\s|:\-]+$/.test(l))
    .map(l => l.replace(/^\||\|$/g, '').split('|').map(c => c.trim()));
  if (!rows.length) return '';
  const [head, ...body] = rows;
  const th = head.map(c => `<th>${inline(c)}</th>`).join('');
  const tb = body.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('');
  return `<table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table>`;
}

function buildList(lines, i, baseIndent) {
  const tag = /^\s*\d+\.\s/.test(lines[i]) ? 'ol' : 'ul';
  const items = [];

  while (i < lines.length) {
    const m = lines[i].match(/^(\s*)([*\-]|\d+\.) (.*)/);
    if (!m) break;
    const indent = m[1].length;
    if (indent < baseIndent) break;
    if (indent > baseIndent) break;

    let content = m[3];
    let checkbox = '';
    const taskM = content.match(/^\[([xX ])\] /);
    if (taskM) {
      const checked = taskM[1].toLowerCase() === 'x' ? ' checked' : '';
      checkbox = `<input type="checkbox"${checked} disabled> `;
      content = content.slice(taskM[0].length);
    }

    i++;

    let subHtml = '';
    if (i < lines.length) {
      const nextM = lines[i].match(/^(\s*)([*\-]|\d+\.) /);
      if (nextM && nextM[1].length > indent) {
        const [sub, newI] = buildList(lines, i, nextM[1].length);
        subHtml = sub;
        i = newI;
      }
    }

    items.push(`<li>${checkbox}${inline(content)}${subHtml}</li>`);
  }

  return [`<${tag}>${items.join('')}</${tag}>`, i];
}

function _render(raw) {
  const mathBlocks = [], codeBlocks = [];

  let text = raw.replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g, (_, m1, m2) => {
    mathBlocks.push((m1 ?? m2).trim());
    return `\n%%MB${mathBlocks.length - 1}%%\n`;
  });

  text = text.replace(/(`{3,})(\w*)\n?([\s\S]*?)\1/g, (_, fence, lang, code) => {
    lang = lang.trim().toLowerCase();
    let highlighted;
    try {
      highlighted = lang && hljs.getLanguage(lang)
        ? hljs.highlight(code.trim(), { language: lang }).value
        : hljs.highlightAuto(code.trim()).value;
    } catch {
      highlighted = esc(code.trim());
    }
    const label = lang || 'plaintext';
    codeBlocks.push(`<div class="code-wrapper"><div class="code-header"><span class="code-lang">${label}</span></div><pre class="code-block hljs">${highlighted}</pre></div>`);
    return `\n%%CB${codeBlocks.length - 1}%%\n`;
  });

  const lines = text.split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    const cbM = line.trim().match(/^%%CB(\d+)%%$/);
    if (cbM) { out.push(codeBlocks[+cbM[1]]); i++; continue; }

    const mbM = line.trim().match(/^%%MB(\d+)%%$/);
    if (mbM) { out.push(`<div class="math-block">\\[${mathBlocks[+mbM[1]]}\\]</div>`); i++; continue; }

    const hM = line.match(/^(#{1,6}) (.*)/);
    if (hM) { out.push(`<h${hM[1].length}>${inline(hM[2])}</h${hM[1].length}>`); i++; continue; }

    if (/^>/.test(line)) {
      const qLines = [];
      while (i < lines.length && /^>/.test(lines[i])) {
        qLines.push(lines[i].replace(/^> ?/, '')); i++;
      }
      out.push(`<blockquote>${_render(qLines.join('\n'))}</blockquote>`);
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) { out.push('<hr>'); i++; continue; }

    if (/^(\s*)([*\-]|\d+\.) /.test(line)) {
      const baseIndent = line.match(/^(\s*)/)[1].length;
      const [listHtml, newI] = buildList(lines, i, baseIndent);
      out.push(listHtml); i = newI; continue;
    }

    if (line.includes('|') && i + 1 < lines.length && /^[\s|:\-]+$/.test(lines[i + 1])) {
      const tLines = [];
      while (i < lines.length && lines[i].includes('|')) { tLines.push(lines[i]); i++; }
      out.push(renderTable(tLines)); continue;
    }

    if (line.trim() === '') { out.push(''); i++; continue; }

    out.push(`<p>${inline(line)}</p>`);
    i++;
  }

  return out.join('\n');
}

function renderMarkdown(raw) {
  _refMap = {}; _fnDefs = {};
  let fnCounter = 0;

  raw = raw.replace(/^\[([^\]]+)\]:\s*(https?:\/\/\S+)\s*$/gm, (_, id, url) => {
    _refMap[id.toLowerCase()] = url; return '';
  });

  raw = raw.replace(/^\[\^([^\]]+)\]:\s*(.+?)\s*$/gm, (_, id, text) => {
    _fnDefs[id] = { n: ++fnCounter, text }; return '';
  });

  let result = _render(raw);

  if (Object.keys(_fnDefs).length) {
    const fnItems = Object.entries(_fnDefs)
      .sort(([, a], [, b]) => a.n - b.n)
      .map(([id, { n, text }]) =>
        `<li id="fn-${id}"><sup>${n}</sup> ${inline(text)} <a href="#fnref-${id}" class="fn-back">↩</a></li>`
      );
    result += `\n<hr><ol class="footnotes">${fnItems.join('')}</ol>`;
  }

  return result;
}

function waitForDOMSettle(container, { quietMs = 120, timeoutMs = 1500 } = {}) {
  return new Promise(resolve => {
    let quietTimer;
    const done = () => { obs.disconnect(); clearTimeout(quietTimer); clearTimeout(hardTimer); resolve(); };
    const obs = new MutationObserver(() => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(done, quietMs);
    });
    obs.observe(container, { childList: true, subtree: true, attributes: true });
    quietTimer = setTimeout(done, quietMs);
    const hardTimer = setTimeout(done, timeoutMs);
  });
}

const TURN_SELECTOR = '[data-message-author-role], [data-message-role]';

async function collectAllTurns() {
  const container = document.querySelector('[data-scroll-root]');
  if (!container) return [...document.querySelectorAll(TURN_SELECTOR)];

  const originalScrollTop = container.scrollTop;
  const seen = new Map();
  const capture = () => {
    const containerRect = container.getBoundingClientRect();
    container.querySelectorAll(TURN_SELECTOR).forEach(turn => {
      const id = turn.getAttribute('data-message-id') || turn.id;
      if (!id) return;
      const y = turn.getBoundingClientRect().top - containerRect.top + container.scrollTop;
      seen.set(id, { turn, y });
    });
  };

  const MAX_STEPS = 200;

  let guard = 0;
  while (container.hasAttribute('data-scroll-from-top') && guard++ < MAX_STEPS) {
    container.scrollTop -= container.clientHeight * 0.8;
    await waitForDOMSettle(container);
  }

  capture();
  guard = 0;
  while (container.hasAttribute('data-scroll-from-end') && guard++ < MAX_STEPS) {
    container.scrollTop += container.clientHeight * 0.7;
    await waitForDOMSettle(container);
    capture();
  }
  capture();

  container.scrollTop = originalScrollTop;
  return [...seen.values()].sort((a, b) => a.y - b.y).map(v => v.turn);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function extractTurn(turn, includeImages = false) {
  const role = turn.getAttribute('data-message-author-role') || turn.getAttribute('data-message-role');
  if (role !== 'user' && role !== 'assistant') return null;

  // Mobile web UI wraps the actual message text in a dedicated element;
  // using it directly sidesteps its <button>-wrapped user bubble and
  // hashed CSS-module class names instead of trying to strip UI chrome
  // out of the whole turn.
  const contentRoot = turn.querySelector('[data-user-message-copy], [data-assistant-markdown]') || turn;
  const isNewFormat = contentRoot !== turn;

  const codeBlocks = [];
  contentRoot.querySelectorAll('pre').forEach(pre => {
    const langEl = pre.querySelector('.justify-self-start');
    const language = langEl ? langEl.textContent.trim().toLowerCase() : '';
    const cmContent = pre.querySelector('.cm-content');
    const rawCode = cmContent ? cmContent.innerText : pre.innerText;
    codeBlocks.push({ language, rawCode });
  });

  const clone = contentRoot.cloneNode(true);

  const stripSelector = includeImages
    ? 'button, input, select, textarea, [role="button"], svg, form'
    : 'button, input, select, textarea, [role="button"], img, svg, form';
  clone.querySelectorAll(stripSelector).forEach(el => el.remove());
  clone.querySelectorAll('.sr-only, [class*="srOnly" i], [data-testid="products-widget"]').forEach(el => el.remove());
  clone.querySelectorAll('span[data-state="closed"]').forEach(el => el.remove());
  clone.querySelectorAll('[data-testid="collapsible-user-message-toggle"]').forEach(el => el.remove());

  if (includeImages) {
    await Promise.all([...clone.querySelectorAll('img')].map(async img => {
      const src = img.currentSrc || img.getAttribute('src') || '';
      if (!src || src.startsWith('data:')) { if (!src) img.remove(); return; }
      try {
        const blob = await fetch(src).then(r => r.blob());
        img.setAttribute('src', await blobToDataUrl(blob));
      } catch {
        img.remove();
      }
    }));
  }

  clone.querySelectorAll('pre').forEach((pre, i) => {
    const cb = codeBlocks[i];
    if (!cb) return;
    pre.innerHTML = '';
    pre.textContent = cb.rawCode;
    pre.className = cb.language ? `language-${cb.language}` : '';
  });

  const keepAttrs = includeImages ? ['class', 'id', 'src', 'alt'] : ['class', 'id'];
  [clone, ...clone.querySelectorAll('*')].forEach(el => {
    Array.from(el.attributes).forEach(attr => {
      if (!keepAttrs.includes(attr.name)) el.removeAttribute(attr.name);
    });
  });

  const tmp = document.createElement('div');
  tmp.innerHTML = DOMPurify.sanitize(isNewFormat ? clone.outerHTML : clone.innerHTML, {
    ALLOWED_TAGS: ['div','p','code','pre','h1','h2','h3','h4','h5','h6','ul','ol','li','strong','em','blockquote','table','thead','tbody','tr','td','th','hr','span','br', ...(includeImages ? ['img'] : [])],
    ALLOWED_ATTR: keepAttrs,
    ALLOW_DATA_ATTR: false
  });

  tmp.querySelectorAll('pre').forEach(pre => {
    const langClass = Array.from(pre.classList).find(c => c.startsWith('language-'));
    const language = langClass ? langClass.replace('language-', '') : '';
    const rawCode = pre.textContent || '';
    let result;
    try {
      result = language && hljs.getLanguage(language)
        ? hljs.highlight(rawCode, { language })
        : hljs.highlightAuto(rawCode);
    } catch { result = { value: rawCode.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') }; }
    const wrapper = document.createElement('div');
    wrapper.className = 'code-wrapper';
    const header = document.createElement('div');
    header.className = 'code-header';
    const langSpan = document.createElement('span');
    langSpan.className = 'code-lang';
    langSpan.textContent = language || 'plaintext';
    header.appendChild(langSpan);
    pre.innerHTML = result.value;
    pre.className = 'code-block hljs';
    pre.parentNode.insertBefore(wrapper, pre);
    wrapper.appendChild(header);
    wrapper.appendChild(pre);
  });

  const html = tmp.innerHTML.trim();
  return html ? { role, segments: [{ type: 'html', content: html }] } : null;
}

async function collectFromDOM(includeImages = false) {
  const turns = await collectAllTurns();
  const messages = [];
  for (const turn of turns) {
    const msg = await extractTurn(turn, includeImages);
    if (msg) messages.push(msg);
  }
  return messages;
}

async function convertToHTML(format = 'html', selectedTheme = 'auto', includeImages = false, latexSupport = false, askTitle = false) {
  try {
    let mathJaxScript = '';
    if (latexSupport && format !== 'pdf') {
      const url = chrome.runtime.getURL('lib/tex-chtml.js');
      const src = await fetch(url).then(r => r.text());
      mathJaxScript = `<script>MathJax = { tex: { inlineMath: [['\\\\(','\\\\)']] } };</script>\n<script>${src}</script>`;
    }

    const token = getAccessToken();
    const convId = getConversationId();
    const usesDom = !(token && convId);

    let resolvedTitle;
    if (usesDom) {
      // The tab title isn't the real conversation title when signed out, so
      // don't use it here; either ask the user or fall back to a fixed name.
      if (askTitle) {
        const input = window.prompt('Enter a title for the file:', 'LLM');
        resolvedTitle = (input && input.trim()) || 'LLM';
      } else {
        resolvedTitle = 'LLM';
      }
    } else {
      resolvedTitle = document.title;
    }

    let messages, images = {};
    if (!usesDom) {
      const result = await fetchConversation(convId, token, includeImages);
      images = result.images;
      messages = linearize(result.data.mapping, includeImages, result.data.current_node);
    } else {
      messages = await collectFromDOM(includeImages);
    }
    if (!messages.length) throw new Error('No messages found.');

    let theme;
    if (selectedTheme === 'auto') {
      theme = document.documentElement.className.includes('dark') ? 'dark' : 'light';
    } else {
      theme = selectedTheme;
    }

    const bg       = theme === 'dark' ? '#212121' : '#FFF';
    const fg       = theme === 'dark' ? '#FFF'    : '#000';
    const userBg   = theme === 'dark' ? '#303030' : '#f4f4f4';
    const codeBg   = theme === 'dark' ? '#303030' : '#ececec';
    const tableBdr = theme === 'dark' ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)';
    const bqBdr    = theme === 'dark' ? 'rgba(255,255,255,0.3)'  : 'rgba(0,0,0,0.2)';
    const cbBorder = theme === 'dark' ? 'transparent' : fg;
    const cbBg     = theme === 'dark' ? '#111' : '#2a2a2a';
    const navDash     = theme === 'dark' ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.3)';
    const navDashHov  = theme === 'dark' ? 'rgba(255,255,255,0.6)'  : 'rgba(0,0,0,0.5)';
    const navDashAct  = theme === 'dark' ? '#fff' : '#000';
    const navPopupBg  = theme === 'dark' ? 'rgba(52,53,54,0.92)' : 'rgba(255,255,255,0.96)';
    const navItemFg   = theme === 'dark' ? '#eee' : '#111';
    const navItemHov  = theme === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
    const navItemAct  = theme === 'dark' ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)';
    const navShadow   = theme === 'dark' ? '0 8px 30px rgba(0,0,0,0.35)' : '0 8px 30px rgba(0,0,0,0.18)';
    const navBorder   = theme === 'dark' ? 'transparent' : 'rgba(0,0,0,0.08)';

    const title = resolvedTitle.replace(/</g, '&lt;').replace(/>/g, '&gt;');

    let html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    :root {
      --bg: ${bg}; --fg: ${fg}; --user-bg: ${userBg};
      --code-bg: ${codeBg}; --table-bdr: ${tableBdr};
      --bq-bdr: ${bqBdr}; --cb-bg: ${cbBg}; --cb-bdr: ${cbBorder};
      --nav-dash: ${navDash}; --nav-dash-hov: ${navDashHov}; --nav-dash-act: ${navDashAct};
      --nav-popup-bg: ${navPopupBg}; --nav-item-fg: ${navItemFg};
      --nav-item-hov: ${navItemHov}; --nav-item-act: ${navItemAct};
      --nav-shadow: ${navShadow}; --nav-border: ${navBorder};
    }
    * { box-sizing: border-box; }
    body {
      font-family: ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,Arial,sans-serif;
      font-size: 16px; background: var(--bg); color: var(--fg);
      padding: 20px; margin: 0 auto; line-height: 1.6;
    }
    .header {
      display: flex; align-items: center; gap: 14px;
      max-width: 900px; margin: 0 auto 28px;
      padding: 4px 20px 22px; border-bottom: 1px solid var(--table-bdr);
    }
    .header-icon {
      flex-shrink: 0; width: 34px; height: 34px;
      display: flex; align-items: center; justify-content: center;
    }
    .header-icon img { width: 34px; height: 34px; display: block; border-radius: 50%; }
    .title { font-size: 18px; font-weight: 600; margin: 0; line-height: 1.3; }
    .timestamp { font-size: 13px; margin-top: 3px; opacity: 0.55; }
    .conversation { max-width: 900px; margin: 0 auto; padding: 20px; }
    .message { margin-bottom: 20px; padding: 10px 20px; border-radius: 18px; width: fit-content; clear: both; overflow: hidden; }
    .user-message { float: right; max-width: 80%; background: var(--user-bg); }
    .assistant-message { float: left; max-width: 95%; }
    .content { user-select: text; overflow-wrap: break-word; }
    .content img { max-height: 220px; width: auto; border-radius: 8px; margin: 8px 0; display: block; cursor: zoom-in; transition: opacity 0.15s; }
    .content img:hover { opacity: 0.85; }
    #lb { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.88); z-index: 9999; justify-content: center; align-items: center; cursor: zoom-out; }
    #lb.open { display: flex; }
    #lb img { max-width: 90vw; max-height: 90vh; border-radius: 10px; object-fit: contain; cursor: default; box-shadow: 0 8px 40px rgba(0,0,0,0.6); }
    .content h1 { font-size: 24px; margin: .67em 0; }
    .content h2 { font-size: 20px; margin: .75em 0; }
    .content h3 { font-size: 18px; margin: .83em 0; }
    .content h4 { font-size: 16px; margin: 1.12em 0; }
    .content h5 { font-size: 14px; margin: 1.5em 0; }
    .content h6 { font-size: 12px; margin: 1.67em 0; }
    table { border-collapse: collapse; font-size: 14px; width: 100%; margin: 16px 0; }
    th, td { padding: 8px 16px; text-align: left; vertical-align: top; font-size: 14px; }
    th { font-weight: 600; border-bottom: 2px solid var(--table-bdr); }
    td { border-bottom: 1px solid var(--table-bdr); }
    tr:last-child td { border-bottom: none; }
    hr { border: none; border-top: 1px solid var(--table-bdr); margin: 28px 0; clear: both; }
    blockquote { border-left: 4px solid var(--bq-bdr); margin: 8px 0; padding: 8px 0 8px 24px; font-weight: 500; }
    li { margin: 10px 0; }
    code { background: var(--code-bg); color: var(--fg); padding: 2px 5px; border-radius: 4px; font-size: .9em; }
    .code-wrapper { border-radius: 8px; overflow: hidden; margin: 12px 0; }
    .code-header {
      background: #1a1a1a; padding: 8px 16px;
      display: flex; align-items: center; gap: 8px;
      border-bottom: 1px solid rgba(255,255,255,0.08);
    }
    .code-header::before {
      content: "</>"; font-size: 11px; color: #10a37f; font-weight: 700;
    }
    .code-lang { font-size: 13px; font-weight: 500; color: #ccc; font-family: inherit; }
    .code-block {
      background: var(--cb-bg) !important; color: #fff !important;
      padding: 16px !important; margin: 0 !important; border-radius: 0 !important;
      border: none !important;
      font-family: "SFMono-Regular",Consolas,"Liberation Mono",Menlo,monospace !important;
      font-size: 14px !important; line-height: 1.5 !important;
      overflow-x: auto !important; white-space: pre !important;
    }
    .code-block code { background: transparent; color: inherit; padding: 0; border-radius: 0; font-size: inherit; }
    .hljs { background: transparent; color: #f8f8f2; }
    .hljs-keyword,.hljs-selector-tag { color: #ff79c6; }
    .hljs-string,.hljs-attr { color: #f1fa8c; }
    .hljs-number,.hljs-literal { color: #bd93f9; }
    .hljs-title,.hljs-function,.hljs-section { color: #50fa7b; }
    .hljs-comment,.hljs-quote { color: #6272a4; font-style: italic; }
    .hljs-params { color: #f8f8f2; }
    .hljs-built_in,.hljs-type { color: #8be9fd; }
    .hljs-variable,.hljs-template-variable { color: #ffb86c; }
    .hljs-attribute,.hljs-tag { color: #ff79c6; }
    .hljs-name { color: #50fa7b; }
    .hljs-regexp,.hljs-link { color: #f1fa8c; }
    .hljs-symbol,.hljs-bullet { color: #bd93f9; }
    .hljs-meta { color: #6272a4; }
    .hljs-deletion { color: #ff5555; }
    .hljs-addition { color: #50fa7b; }
    .hljs-emphasis { font-style: italic; }
    .hljs-strong { font-weight: bold; }
    .entity { text-decoration: underline; text-underline-offset: 3px; }
    sup.cite { font-size: 10px; line-height: 1; }
    a.cite-num { text-decoration: none; color: #10a37f; font-weight: 600; margin: 0 1px; }

    del { text-decoration: line-through; opacity: 0.7; }
    .math-block { margin: 16px 0; text-align: center; overflow-x: auto; }
    .footnotes { font-size: 13px; padding-left: 20px; margin-top: 4px; }
    .footnotes li { margin: 4px 0; opacity: 0.75; }
    .fn-back { text-decoration: none; margin-left: 4px; }
    sup a { text-decoration: none; color: #10a37f; }
    li input[type="checkbox"] { margin-right: 5px; pointer-events: none; vertical-align: middle; }
        @media print {
      .message { float: none !important; max-width: 100% !important; }
      .code-block { white-space: pre-wrap !important; }
    }

    .msg-nav {
      position: fixed; top: 50%; right: 20px; transform: translateY(-50%);
      max-height: calc(100vh - 40px); overflow-y: auto; overflow-x: visible;
      display: flex; flex-direction: column; align-items: flex-end;
      gap: 5px; z-index: 500; padding: 20px 6px;
      cursor: pointer; user-select: none;
      scrollbar-width: none; -ms-overflow-style: none;
    }
    .msg-nav::-webkit-scrollbar { display: none; }
    .msg-nav-dash {
      flex-shrink: 0; width: 14px; height: 2px; border-radius: 2px;
      background: var(--nav-dash); cursor: pointer;
      transition: background 0.15s, width 0.15s;
    }
    .msg-nav-dash:hover { background: var(--nav-dash-hov); }
    .msg-nav-dash.active { background: var(--nav-dash-act); width: 18px; }
    .msg-nav-popup {
      position: fixed; top: 50%; right: 20px; transform: translateY(-50%);
      max-width: 280px; max-height: 70vh; overflow-y: auto;
      background: var(--nav-popup-bg); backdrop-filter: blur(6px);
      border: 1px solid var(--nav-border);
      border-radius: 22px; padding: 10px 8px;
      display: none; flex-direction: column; z-index: 501;
      box-shadow: var(--nav-shadow);
      cursor: pointer; user-select: none;
    }
    .msg-nav-popup.open { display: flex; }
    .msg-nav-item {
      flex-shrink: 0;
      color: var(--nav-item-fg); font-size: 14px; line-height: 1.4; padding: 10px 14px; border-radius: 16px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      cursor: pointer; user-select: none;
      font-family: ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,Arial,sans-serif;
    }
    .msg-nav-item:hover { background: var(--nav-item-hov); }
    .msg-nav-item.active { background: var(--nav-item-act); }
    @media print {
      .msg-nav, .msg-nav-popup { display: none !important; }
    }
  </style>
  ${mathJaxScript}
</head>
<body>
  <div class="header">
    <div class="header-icon">
      <img src="data:image/png;base64,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" alt="" />
    </div>
    <div>
      <h1 class="title" dir="auto">${title}</h1>
      <div class="timestamp">${new Date().toLocaleString()}</div>
    </div>
  </div>
  <div class="conversation">
`;

    let userIdx = 0;
    for (const { role, segments, citeMap } of messages) {
      _citeMap = citeMap ?? {};

      const isUser = role === 'user';
      const cls = isUser ? 'user-message' : 'assistant-message';
      let content = '';
      for (const seg of segments) {
        if (seg.type === 'text') {
          content += renderMarkdown(seg.content);
        } else if (seg.type === 'html') {
          content += seg.content;
        } else if (seg.type === 'image') {
          const src = images[seg.fileId];
          if (src) content += `<img src="${src}" alt="image">`;
        }
      }

      const idAttr = isUser ? ` id="user-msg-${userIdx++}"` : '';
      html += `    <div class="message ${cls}"${idAttr}><div class="content" dir="auto">${content}</div></div>\n`;
    }

    const viewerScript = format === 'pdf' ? '' : `  <script>
    const lb = document.getElementById('lb');
    const lbImg = document.getElementById('lb-img');
    document.querySelectorAll('.content img').forEach(img => {
      img.addEventListener('click', () => { lbImg.src = img.src; lb.classList.add('open'); });
    });
    lb.addEventListener('click', e => { if (e.target === lb) lb.classList.remove('open'); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') lb.classList.remove('open'); });

    (function () {
      const userMsgs = [...document.querySelectorAll('.user-message[id^="user-msg-"]')];
      const n = userMsgs.length;
      if (!n) return;

      const nav = document.getElementById('msgNav');
      const popup = document.getElementById('msgNavPopup');

      // Popup: one row per message.
      const items = userMsgs.map((el) => {
        const item = document.createElement('div');
        item.className = 'msg-nav-item';
        let text = el.textContent.trim().replace(/\\s+/g, ' ');
        if (!text) text = el.querySelector('img') ? 'Photo' : '…';
        item.textContent = text.length > 60 ? text.slice(0, 60) + '…' : text;
        item.addEventListener('click', () => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
        popup.appendChild(item);
        return item;
      });

      // Dash bar: capped at 20 marks, each covering an even slice of
      // messages; clicking one jumps to the first message in its slice.
      const numGroups = Math.min(n, 20);
      const groupStarts = Array.from({ length: numGroups }, (_, g) => Math.floor(g * n / numGroups));
      const dashes = groupStarts.map((startIdx) => {
        const dash = document.createElement('div');
        dash.className = 'msg-nav-dash';
        dash.addEventListener('click', () => userMsgs[startIdx].scrollIntoView({ behavior: 'smooth', block: 'center' }));
        nav.appendChild(dash);
        return dash;
      });

      const groupOf = (idx) => {
        let g = 0;
        for (let i = 1; i < groupStarts.length; i++) if (groupStarts[i] <= idx) g = i;
        return g;
      };

      let openTimer = null;
      const openPopup = () => { clearTimeout(openTimer); popup.classList.add('open'); };
      const closePopup = () => { openTimer = setTimeout(() => popup.classList.remove('open'), 120); };
      nav.addEventListener('mouseenter', openPopup);
      nav.addEventListener('mouseleave', closePopup);
      popup.addEventListener('mouseenter', openPopup);
      popup.addEventListener('mouseleave', closePopup);

      const setActive = (idx) => {
        items.forEach((item, i) => item.classList.toggle('active', i === idx));
        const activeGroup = groupOf(idx);
        dashes.forEach((dash, i) => dash.classList.toggle('active', i === activeGroup));
        dashes[activeGroup]?.scrollIntoView({ block: 'nearest' });
      };

      let ticking = false;
      const updateActive = () => {
        ticking = false;
        let idx = 0;
        for (let i = 0; i < userMsgs.length; i++) {
          if (userMsgs[i].getBoundingClientRect().top <= window.innerHeight * 0.5) idx = i;
        }
        setActive(idx);
      };
      window.addEventListener('scroll', () => {
        if (!ticking) { ticking = true; requestAnimationFrame(updateActive); }
      });
      updateActive();
    })();
  </script>
`;

    html += `  </div>
  <div id="lb"><img id="lb-img"></div>
  <div class="msg-nav" id="msgNav"></div>
  <div class="msg-nav-popup" id="msgNavPopup"></div>
${viewerScript}</body>
</html>`;

    if (format === 'pdf') {
      await savePrintDocument(html);
      return 'print';
    }

    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const date = new Date().toISOString().slice(0, 10);
    const filename = sanitizeFilename(resolvedTitle);
    a.href = url;
    a.download = `${filename}-${date}.html`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);

  } catch (error) {
    console.error('Export error:', error);
    alert('Export failed: ' + error.message);
  }
}
