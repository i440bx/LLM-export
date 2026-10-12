window.addEventListener('message', async (event) => {
  if (event.origin !== 'https://chatgpt.com') return;
  if (event.data?.source !== 'chatgpt-export-ext') return;
  if (event.data?.type !== 'fetch_conversation') return;

  const { convId, token, requestId, includeImages } = event.data;

  try {
    const res = await fetch(`https://chatgpt.com/backend-api/conversation/${convId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (res.status === 401) throw new Error('Your ChatGPT session has expired. Reload the page and try again.');
    if (!res.ok) throw new Error(`API returned ${res.status}`);
    const data = await res.json();

    let images = {};
    if (includeImages) {
      const fileIds = new Set();
      for (const node of Object.values(data.mapping)) {
        for (const part of node.message?.content?.parts ?? []) {
          if (part?.content_type === 'image_asset_pointer' && part?.asset_pointer) {
            fileIds.add(part.asset_pointer.split('://')[1]);
          }
        }
      }

      const entries = await Promise.all(
        [...fileIds].map(async (id) => [id, await fetchImageAsBase64(id, token)])
      );
      images = Object.fromEntries(entries.filter(([, b64]) => b64 !== null));
    }

    window.postMessage({ source: 'chatgpt-export-page', requestId, data, images }, 'https://chatgpt.com');
  } catch (err) {
    window.postMessage({ source: 'chatgpt-export-page', requestId, error: err.message }, 'https://chatgpt.com');
  }
});

async function fetchImageAsBase64(fileId, token) {
  try {
    const dlRes = await fetch(`https://chatgpt.com/backend-api/files/download/${fileId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!dlRes.ok) return null;
    const { download_url } = await dlRes.json();
    if (!download_url) return null;

    const imgRes = await fetch(download_url);
    if (!imgRes.ok) return null;

    const blob = await imgRes.blob();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload  = () => resolve(reader.result);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}


// Robust/paginated backend path for very large conversations.
// This deliberately lives next to the legacy single-request path so normal
// exports remain unchanged.
window.addEventListener('message', async (event) => {
  if (event.origin !== 'https://chatgpt.com') return;
  if (event.data?.source !== 'chatgpt-export-ext') return;
  if (event.data?.type !== 'fetch_conversation_paginated') return;

  const { convId, token, requestId, includeImages } = event.data;
  const headers = { Authorization: `Bearer ${token}` };

  try {
    const firstRes = await fetch(
      `https://chatgpt.com/backend-api/conversations/${convId}?num_turns=10&include_has_versions=true`,
      { headers }
    );

    if (firstRes.status === 401) {
      throw new Error('Your ChatGPT session has expired. Reload the page and try again.');
    }
    if (!firstRes.ok) throw new Error(`Paged API returned ${firstRes.status}`);

    const first = await firstRes.json();
    const blocks = [first.messages || []];
    let before = first.page_info?.start_cursor || null;

    while (before) {
      const res = await fetch(
        `https://chatgpt.com/backend-api/conversations/${convId}/messages` +
          `?before=${encodeURIComponent(before)}` +
          `&num_turns=10&include_has_versions=true`,
        { headers }
      );

      if (res.status === 401) {
        throw new Error('Your ChatGPT session has expired. Reload the page and try again.');
      }
      if (!res.ok) throw new Error(`Paged API returned ${res.status}`);

      const page = await res.json();
      const messages = page.messages || [];
      if (!messages.length) break;

      blocks.unshift(messages);

      const nextBefore = page.page_info?.start_cursor || messages[0]?.id || null;
      if (!nextBefore || nextBefore === before) break;
      before = nextBefore;

      // Give the backend a little breathing room on monster conversations.
      await new Promise(resolve => setTimeout(resolve, 250));
    }

    const seen = new Set();
    const messages = blocks.flat().filter(msg => {
      if (!msg?.id) return true;
      if (seen.has(msg.id)) return false;
      seen.add(msg.id);
      return true;
    });

    let images = {};
    if (includeImages) {
      const fileIds = new Set();
      for (const msg of messages) {
        for (const part of (msg.content?.parts ?? [])) {
          if (part?.content_type === 'image_asset_pointer' && part?.asset_pointer) {
            fileIds.add(part.asset_pointer.split('://')[1]);
          }
        }
      }

      const entries = await Promise.all(
        [...fileIds].map(async (id) => [id, await fetchImageAsBase64(id, token)])
      );
      images = Object.fromEntries(entries.filter(([, b64]) => b64 !== null));
    }

    const data = {
      conversation_id: convId,
      title: first.title || null,
      create_time: first.create_time ?? null,
      update_time: first.update_time ?? null,
      export_method: 'paginated-backend-api',
      message_count: messages.length,
      messages
    };

    window.postMessage(
      { source: 'chatgpt-export-page', requestId, data, images },
      'https://chatgpt.com'
    );
  } catch (err) {
    window.postMessage(
      { source: 'chatgpt-export-page', requestId, error: err.message },
      'https://chatgpt.com'
    );
  }
});
