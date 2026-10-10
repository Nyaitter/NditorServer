'use strict';

const fs = require('node:fs');
const path = require('node:path');

function makeError(message, statusCode = 502, code = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}

class NyaitterApiClient {
  constructor({upstream = process.env.NDITOR_UPSTREAM || 'http://127.0.0.1:3000'} = {}) {
    this.upstream = new URL(upstream);
    const apiPath = String(process.env.NDITOR_NYAITTER_API_PATH || '/server').trim();
    this.apiRoot = new URL(`${apiPath.replace(/\/+$/, '') || ''}/`, this.upstream);
    this.extensionKey = null;
  }

  getExtensionKey() {
    if (this.extensionKey) return this.extensionKey;
    const configured = String(process.env.NDITOR_EXTENSION_API_KEY || '').trim();
    if (configured) {
      this.extensionKey = configured;
      return configured;
    }
    const configuredPath = String(
      process.env.NDITOR_EXTENSION_API_KEY_FILE || 'data/secrets/nyaitter-extension-api-key',
    ).trim();
    if (!configuredPath) throw new Error('Nditor extension API key is not configured');
    const projectRoot = path.resolve(__dirname, '../..');
    const keyPath = path.isAbsolute(configuredPath)
      ? configuredPath
      : path.resolve(projectRoot, configuredPath);
    let key;
    try {
      key = fs.readFileSync(keyPath, 'utf8').trim();
    } catch (error) {
      if (error.code === 'ENOENT') throw makeError('Nyaitter連携キーが未設定です。Serverのnscli extension-key createで発行し、NDITOR_EXTENSION_API_KEY_FILEに配置してください。', 503, 'extension_key_missing');
      throw makeError('Nyaitter連携キーを読み取れません。キーの保存先とファイル権限を確認してください。', 503, 'extension_key_unreadable');
    }
    if (!key) throw new Error('Nditor extension API key is empty');
    this.extensionKey = key;
    return key;
  }

  async request(route, {method = 'GET', accessToken = null, body = null, internal = false} = {}) {
    const normalizedRoute = String(route || '').replace(/^\/+/, '');
    const url = new URL(normalizedRoute, this.apiRoot);
    const headers = {accept: 'application/json'};
    if (accessToken) headers.authorization = `Bearer ${accessToken}`;
    if (internal) headers['x-nyaitter-extension-key'] = this.getExtensionKey();
    const options = {method, headers, signal: AbortSignal.timeout(15000)};
    if (body !== null) {
      options.body = JSON.stringify(body);
      headers['content-type'] = 'application/json';
    }

    let response;
    try {
      response = await fetch(url, options);
    } catch (error) {
      throw makeError(`Nyaitter Serverへ接続できません: ${error.message}`);
    }
    let result = {};
    try {
      result = await response.json();
    } catch (_) {
      throw makeError('Nyaitter Serverから不正な応答を受信しました。');
    }
    if (!response.ok) {
      throw makeError(
        result.error || result.message || 'Nyaitter Serverの要求に失敗しました。',
        response.status,
        result.code || null,
      );
    }
    return result;
  }

  introspectUserToken(accessToken) {
    return this.request('internal/extensions/nyaitter-auth/userinfo', {
      method: 'POST',
      accessToken,
      internal: true,
      body: {},
    });
  }

  async getUserById(userId, accessToken = null) {
    const id = Number(userId);
    if (!Number.isInteger(id) || id <= 0) return null;
    try {
      const result = await this.request(`api/users/${id}`, {accessToken});
      return result.user || null;
    } catch (error) {
      if (error.statusCode === 404) return null;
      throw error;
    }
  }

  async searchUsers(query, limit = 20, offset = 0, accessToken = null) {
    const params = new URLSearchParams({q: String(query || ''), limit: String(limit), offset: String(offset)});
    const result = await this.request(`api/users/search?${params}`, {accessToken});
    return Array.isArray(result.users) ? result.users : [];
  }

  async getUsersByIds(userIds, accessToken = null) {
    const ids = [...new Set((Array.isArray(userIds) ? userIds : []).map(Number))]
      .filter((id) => Number.isInteger(id) && id > 0);
    return (await Promise.all(ids.map((id) => this.getUserById(id, accessToken))))
      .filter(Boolean);
  }
}

module.exports = NyaitterApiClient;
