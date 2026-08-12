const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export function createGoogleAccessTokenProvider(env = process.env) {
  let cached = null;
  let expiresAt = 0;

  async function refresh() {
    if (env.GOOGLE_DRIVE_ACCESS_TOKEN) return env.GOOGLE_DRIVE_ACCESS_TOKEN;

    const clientId = env.GOOGLE_OAUTH_CLIENT_ID;
    const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET;
    const refreshToken = env.GOOGLE_OAUTH_REFRESH_TOKEN;
    if (!clientId || !clientSecret || !refreshToken) {
      throw Object.assign(new Error('Credenziali Google Drive non configurate'), { code: 'GOOGLE_AUTH_NOT_CONFIGURED' });
    }

    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    });
    let response;
    try {
      response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(Number(env.GOOGLE_HTTP_TIMEOUT_MS || 15_000))
      });
    } catch (error) {
      throw Object.assign(new Error('Timeout o rete non disponibile durante autenticazione Google'), {
        code: 'GOOGLE_AUTH_NETWORK_ERROR',
        cause: error
      });
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) {
      throw Object.assign(new Error('Impossibile ottenere token Google'), {
        code: 'GOOGLE_AUTH_FAILED',
        status: response.status
      });
    }
    cached = data.access_token;
    expiresAt = Date.now() + Math.max(60, Number(data.expires_in || 3600) - 120) * 1000;
    return cached;
  }

  return async function getAccessToken({ forceRefresh = false } = {}) {
    if (env.GOOGLE_DRIVE_ACCESS_TOKEN) return env.GOOGLE_DRIVE_ACCESS_TOKEN;
    if (!forceRefresh && cached && Date.now() < expiresAt) return cached;
    return refresh();
  };
}
