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
