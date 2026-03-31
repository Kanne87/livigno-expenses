const AUTH_CONFIG = {
  authority: 'https://auth.kailohmann.de/application/o/livigno-expenses-spa/',
  authorizeUrl: 'https://auth.kailohmann.de/application/o/authorize/',
  clientId: 'sTY3Kd81JE0QnOCVdUmPof4ydUsFUryNRftrYuOi',
  redirectUri: window.location.origin + '/popup-callback.html',
  scope: 'openid email profile',
  tokenKey: 'livigno_token'
};

function generateRandomString(length) {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array)).replace(/[+/=]/g, c => ({'+':'-','/':'_','=':''}[c]));
}

async function generatePKCE() {
  const verifier = generateRandomString(32);
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(hash))).replace(/[+/=]/g, c => ({'+':'-','/':'_','=':''}[c]));
  return { verifier, challenge };
}

function getToken() { return localStorage.getItem(AUTH_CONFIG.tokenKey); }
function setToken(token) { localStorage.setItem(AUTH_CONFIG.tokenKey, token); }
function clearToken() { localStorage.removeItem(AUTH_CONFIG.tokenKey); }

function parseJwt(token) {
  try { return JSON.parse(atob(token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))); }
  catch { return null; }
}

function isTokenValid() {
  const token = getToken();
  if (!token) return false;
  const payload = parseJwt(token);
  if (!payload || !payload.exp) return false;
  return payload.exp * 1000 > Date.now() + 30000;
}

async function login() {
  const pkce = await generatePKCE();
  sessionStorage.setItem('pkce_verifier', pkce.verifier);
  const params = new URLSearchParams({
    client_id: AUTH_CONFIG.clientId,
    response_type: 'code',
    redirect_uri: AUTH_CONFIG.redirectUri,
    scope: AUTH_CONFIG.scope,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    state: crypto.randomUUID(),
    prompt: 'login'
  });
  const url = AUTH_CONFIG.authorizeUrl + '?' + params;
  const popup = window.open(url, 'auth-popup', 'width=500,height=700,popup=true');
  if (!popup) window.location.href = url;
}

function logout() {
  clearToken();
  window.location.reload();
}

// Override fetch for /api paths
const _originalFetch = window.fetch;
window.fetch = function(url, opts = {}) {
  if (typeof url === 'string' && url.startsWith('/api')) {
    const token = getToken();
    if (token) {
      opts = { ...opts, headers: { ...opts.headers, 'Authorization': 'Bearer ' + token } };
    }
  }
  return _originalFetch.call(this, url, opts);
};

// Listen for popup auth success
window.addEventListener('message', (e) => {
  if (e.origin === location.origin && e.data?.type === 'auth-success' && e.data.token) {
    setToken(e.data.token);
    window.location.reload();
  }
});

function showLoginScreen() {
  document.getElementById('loginScreen').style.display = 'flex';
  document.querySelector('.wrap').style.display = 'none';
}
