const API = 'https://www.googleapis.com/drive/v3';

export function extractDriveId(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const match = raw.match(/\/folders\/([A-Za-z0-9_-]+)/) || raw.match(/\/d\/([A-Za-z0-9_-]+)/);
  return match ? match[1] : raw;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createGoogleDriveClient({ getAccessToken, timeoutMs = 30_000, maxRetries = 3 }) {
  if (typeof getAccessToken !== 'function') throw new Error('Token provider Google richiesto');

  async function request(url, options = {}, context = {}) {
    const attempt = Number(context.attempt || 0);
    const refreshed = Boolean(context.refreshed);
    const token = await getAccessToken({ forceRefresh: refreshed });
    let response;
    try {
      response = await fetch(url, {
        ...options,
        headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
        signal: options.signal || AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      if (attempt < maxRetries) {
        await sleep(250 * (2 ** attempt));
        return request(url, options, { attempt: attempt + 1, refreshed });
      }
      throw Object.assign(new Error('Timeout o rete non disponibile per Google Drive'), {
        code: 'DRIVE_NETWORK_ERROR',
        cause: error
      });
    }

    if (response.status === 401 && !refreshed) {
      return request(url, options, { attempt, refreshed: true });
    }
    if ((response.status === 429 || response.status >= 500) && attempt < maxRetries) {
      const retryAfter = Number(response.headers.get('retry-after') || 0) * 1000;
      await sleep(Math.max(retryAfter, 250 * (2 ** attempt)));
      return request(url, options, { attempt: attempt + 1, refreshed });
    }
    return response;
  }

  async function listChildren(folderId) {
    const files = [];
    let pageToken = null;
    do {
      const params = new URLSearchParams({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,createdTime,md5Checksum,sha256Checksum,size,version,webViewLink,parents)',
        pageSize: '1000',
        orderBy: 'name',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true'
      });
      if (pageToken) params.set('pageToken', pageToken);
      const response = await request(`${API}/files?${params}`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw Object.assign(new Error('Errore lettura Google Drive'), {
          code: 'DRIVE_LIST_FAILED',
          status: response.status,
          details: data?.error?.message || null
        });
      }
      files.push(...(data.files || []));
      pageToken = data.nextPageToken || null;
    } while (pageToken);
    return files;
  }

  async function downloadBuffer(fileId) {
    const params = new URLSearchParams({ alt: 'media', supportsAllDrives: 'true' });
    const response = await request(`${API}/files/${encodeURIComponent(fileId)}?${params}`);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw Object.assign(new Error('Errore download file Google Drive'), {
        code: 'DRIVE_DOWNLOAD_FAILED',
        status: response.status,
        details: data?.error?.message || null
      });
    }
    return Buffer.from(await response.arrayBuffer());
  }

  async function downloadText(fileId) {
    return (await downloadBuffer(fileId)).toString('utf8');
  }

  return { listChildren, downloadBuffer, downloadText };
}
