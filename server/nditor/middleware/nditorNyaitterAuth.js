'use strict';

const AUTH_COOKIE_NAME = 'nditor_nyaitter_auth';

function parseCookies(request) {
  const cookies = {};
  for (const part of String(request.headers.cookie || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    const rawValue = part.slice(separator + 1).trim();
    try {
      cookies[name] = decodeURIComponent(rawValue);
    } catch (_) {
      cookies[name] = rawValue;
    }
  }
  return cookies;
}

function getAccessToken(request) {
  const authorization = String(request.headers.authorization || '');
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (match) return match[1].trim();
  return parseCookies(request)[AUTH_COOKIE_NAME] || '';
}

async function resolvePrincipal(request) {
  if (process.env.DEV_BYPASS_AUTH === 'true' && request.headers['x-nditor-dev-user-id']) {
    const id = Number(request.headers['x-nditor-dev-user-id']);
    if (!Number.isInteger(id) || id <= 0) return null;
    return {id, name: `User${id}`, admin: true, isApp: true, tokenType: 'app', appId: 'nditor'};
  }

  const token = getAccessToken(request);
  if (!token) return null;
  const result = await request.app.locals.nyaitterApiClient.introspectUserToken(token);
  const scopes = Array.isArray(result.granted_scopes) ? result.granted_scopes : [];
  if (
    typeof result.app_id !== 'string' || !/^extension:[a-f0-9]{32}$/.test(result.app_id) ||
    (!scopes.includes('profile:read') && !scopes.includes('read:profile'))
  ) {
    const error = new Error('Nditor用のNyaitterAuthトークンが必要です。');
    error.statusCode = 403;
    error.code = 'NDITOR_NYAITTER_AUTH_REQUIRED';
    throw error;
  }

  if (!scopes.includes('storage:access')) {
    const error = new Error('ストレージへのアクセスを許可してNyaitterAuthで再ログインしてください。');
    error.statusCode = 403;
    error.code = 'NDITOR_STORAGE_ACCESS_REQUIRED';
    throw error;
  }

  const user = result.user || {};
  const principal = {
    id: Number(user.id),
    name: user.name || `#${user.id}`,
    scid: user.scid || null,
    admin: false,
    isApp: true,
    tokenType: 'app',
    appId: result.app_id,
    scopes,
    frozen: Boolean(user.frozen),
    accountOperation: user.account_operation || null,
  };
  Object.defineProperty(principal, 'accessToken', {value: token, enumerable: false});
  return principal;
}

async function optionalNditorNyaitterAuth(request, response, next) {
  try {
    request.user = await resolvePrincipal(request);
  } catch (error) {
    if (error.statusCode === 403) {
      return response.status(403).json({error: error.message, code: error.code});
    }
    console.warn('[nditor-auth] NyaitterAuth token could not be validated:', error.message);
    request.user = null;
  }
  return next();
}

async function requireNditorNyaitterAuth(request, response, next) {
  try {
    const principal = await resolvePrincipal(request);
    if (!principal) {
      return response.status(401).json({
        error: 'NyaitterAuthでログインしてください。',
        code: 'NDITOR_NYAITTER_AUTH_REQUIRED',
      });
    }
    if (principal.frozen) {
      return response.status(403).json({error: '凍結中のアカウントではこの操作を実行できません。'});
    }
    if (principal.accountOperation) {
      return response.status(423).json({error: 'NyaitterIDの処理が完了するまで接続できません。'});
    }
    request.user = principal;
    return next();
  } catch (error) {
    console.error('[nditor-auth] NyaitterAuth token validation failed:', error.message);
    return response.status(error.statusCode || 500).json({
      error: error.message || 'NyaitterAuthトークンを検証できません。',
      code: error.code || undefined,
    });
  }
}

module.exports = {optionalNditorNyaitterAuth, requireNditorNyaitterAuth};
