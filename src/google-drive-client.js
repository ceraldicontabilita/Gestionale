const API = 'https://www.googleapis.com/drive/v3';

export function extractDriveId(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const match = raw.match(/\/folders\/([A-Za-z0-9_-]+)/) || raw.match(/\/d\/([A-Za-z0-9_-]+)/);
  return match ? match[1] : raw;
}

export function createGoogleDriveClient({ getAccessToken }) {
  if (typeof getAccessToken !== 'function') throw new Error('Token provider Google richiesto');

  async function request(url, options = {}, retry = true) {
    const token = await getAccessToken();
    const response = await fetch(url, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) }
    });
    if (response.status === 401 && retry) {
      const refreshed = await getAccessToken({ forceRefresh: true });
      return fetch(url, {
        ...options,
        headers: { Authorization: `Bearer ${refreshed}`, ...(options.headers || {}) }
      });
    }
    return response;
  }

  async function listChildren(folderId) {
    const files = [];
    let pageToken = null;
    do {
      const params = new URLSearchParams({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,createdTime,md5Checksum,size,webViewLink,parents)',
        pageSize: '1000',
        orderBy: 'name'
      });
      if (pageToken) params.set('pageToken', pageToken);
      const response = await request(`${API}/files?${params}`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(new Error('Errore lettura Google Drive'), { code: 'DRIVE_LIST_FAILED', status: response.status });
      files.push(...(data.files || []));
      pageToken = data.nextPageToken || null;
    } while (pageToken);
    return files;
  }

  async function downloadText(fileId) {
    const response = await request(`${API}/files/${encodeURIComponent(fileId)}?alt=media`);
    if (!response.ok) throw Object.assign(new Error('Errore download file Google Drive'), { code: 'DRIVE_DOWNLOAD_FAILED', status: response.status });
    return response.text();
  }

  return { listChildren, downloadText };
}
