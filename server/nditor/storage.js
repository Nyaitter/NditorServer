'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs').promises;
const path = require('node:path');
const https = require('node:https');

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CONTENT_TYPES_BY_EXTENSION = new Map([
  ['.zip', 'application/zip'],
  ['.sb3', 'application/zip'],
]);

function normalizePathParts(value, label, {minimumParts = 1} = {}) {
  const source = String(value || '').replace(/\\/g, '/');
  const parts = source.split('/');
  if (
    !source ||
    source.startsWith('/') ||
    parts.length < minimumParts ||
    parts.some((part) => !SAFE_SEGMENT.test(part) || part === '.' || part === '..')
  ) {
    throw new Error(`Invalid storage ${label}`);
  }
  return parts.join('/');
}

function normalizeFolder(folder) {
  return normalizePathParts(folder, 'folder');
}

function normalizeStorageKey(key) {
  return normalizePathParts(key, 'key', {minimumParts: 2});
}

function encodeRfc3986(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function encodeKeyPath(key) {
  return key.split('/').map(encodeRfc3986).join('/');
}

function hmac(key, value, encoding) {
  return crypto.createHmac('sha256', key).update(value, 'utf8').digest(encoding);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function amzDateParts(date = new Date()) {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return {amzDate: iso, dateStamp: iso.slice(0, 8)};
}

function decodeXml(value) {
  return String(value || '').replace(/&(amp|lt|gt|quot|apos);/g, (entity, name) => ({
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
  }[name]));
}

function xmlTag(xml, tag) {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(String(xml || ''));
  return match ? decodeXml(match[1]) : '';
}

function encodeQuery(pairs) {
  return pairs
    .map(([key, value]) => [encodeRfc3986(key), encodeRfc3986(value)])
    .sort((left, right) => {
      if (left[0] !== right[0]) return left[0] < right[0] ? -1 : 1;
      if (left[1] !== right[1]) return left[1] < right[1] ? -1 : 1;
      return 0;
    })
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

function makeError(message, {statusCode, code, name} = {}) {
  const error = new Error(message);
  if (statusCode) error.statusCode = statusCode;
  if (code) error.code = code;
  if (name) error.name = name;
  return error;
}

function errorFromS3Response(statusCode, body) {
  const code = xmlTag(body, 'Code') || `R2_${statusCode}`;
  const message = xmlTag(body, 'Message') || `R2 request failed with HTTP ${statusCode}`;
  const error = makeError(message, {statusCode, code, name: code});
  return error;
}

async function toBuffer(file) {
  if (Buffer.isBuffer(file)) return file;
  if (file instanceof Uint8Array) return Buffer.from(file);
  if (!file || typeof file[Symbol.asyncIterator] !== 'function') {
    throw new Error('Storage file must be a Buffer, Uint8Array, or readable stream');
  }
  const chunks = [];
  for await (const chunk of file) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

class NditorStorageAdapter {
  constructor({rootDir, quotaBytes} = {}) {
    this.mode = String(process.env.NDITOR_STORAGE_ADAPTER || 'local')
      .trim()
      .toLowerCase();
    if (!['local', 'filesystem', 'r2', 'cloudflare-r2'].includes(this.mode)) {
      throw new Error(`Unsupported Nditor storage adapter: ${this.mode}`);
    }
    this.isR2 = this.mode === 'r2' || this.mode === 'cloudflare-r2';

    const quotaMb = Number(process.env.NDITOR_STORAGE_QUOTA_MB || 1024);
    this.quotaBytes = Math.max(
      1,
      Math.floor(Number(quotaBytes ?? process.env.NDITOR_STORAGE_QUOTA_BYTES ?? quotaMb * 1024 * 1024) || 0),
    );
    this.uploadLocks = new Map();

    if (!this.isR2) {
      const projectRoot = path.resolve(__dirname, '../..');
      const configuredRoot = rootDir || process.env.NDITOR_STORAGE_ROOT || path.join(projectRoot, 'data', 'storage');
      this.rootDir = path.isAbsolute(configuredRoot)
        ? path.resolve(configuredRoot)
        : path.resolve(projectRoot, configuredRoot);
      return;
    }

    this.bucket = String(process.env.NDITOR_R2_BUCKET || '').trim();
    this.accountId = String(process.env.NDITOR_R2_ACCOUNT_ID || '').trim();
    this.accessKeyId = String(process.env.NDITOR_R2_ACCESS_KEY_ID || '').trim();
    this.secretAccessKey = String(process.env.NDITOR_R2_SECRET_ACCESS_KEY || '').trim();
    this.r2Prefix = normalizeFolder(process.env.NDITOR_R2_PREFIX || 'nditor-private');
    this.cacheControl = String(process.env.NDITOR_R2_CACHE_CONTROL || 'private, no-store').trim();
    this.retryAttempts = Math.max(0, Math.floor(Number(process.env.NDITOR_R2_RETRY_ATTEMPTS ?? 2) || 0));
    this.retryBaseDelayMs = Math.max(0, Number(process.env.NDITOR_R2_RETRY_BASE_DELAY_MS ?? 120) || 0);

    const configuredEndpoint = String(process.env.NDITOR_R2_ENDPOINT || '').trim();
    const endpointValue = configuredEndpoint || (this.accountId
      ? `https://${this.accountId}.r2.cloudflarestorage.com`
      : '');
    if (!this.bucket || !this.accessKeyId || !this.secretAccessKey || !endpointValue) {
      throw new Error('Nditor R2 requires a private bucket, account ID or endpoint, access key ID, and secret access key');
    }
    try {
      this.r2Endpoint = new URL(endpointValue);
    } catch (_) {
      throw new Error('NDITOR_R2_ENDPOINT must be a valid HTTP(S) URL');
    }
    if (this.r2Endpoint.protocol !== 'https:') {
      throw new Error('NDITOR_R2_ENDPOINT must use HTTPS');
    }
    if (this.r2Endpoint.search || this.r2Endpoint.hash) {
      throw new Error('NDITOR_R2_ENDPOINT must not include a query or fragment');
    }
    this.endpointPath = this.r2Endpoint.pathname.replace(/\/+$/, '');
    this.r2Endpoint.pathname = '/';
  }

  _resolveLocalPath(key) {
    const normalizedKey = normalizeStorageKey(key);
    const resolvedPath = path.resolve(this.rootDir, ...normalizedKey.split('/'));
    if (!resolvedPath.startsWith(`${this.rootDir}${path.sep}`)) {
      throw new Error('Storage key resolves outside Nditor storage directory');
    }
    return {normalizedKey, resolvedPath};
  }

  _resolveLocalFolder(folder) {
    const normalizedFolder = normalizeFolder(folder);
    const resolvedPath = path.resolve(this.rootDir, ...normalizedFolder.split('/'));
    if (!resolvedPath.startsWith(`${this.rootDir}${path.sep}`)) {
      throw new Error('Storage folder resolves outside Nditor storage directory');
    }
    return {normalizedFolder, resolvedPath};
  }

  _assertKeyInFolder(key, folder) {
    const normalizedFolder = normalizeFolder(folder);
    const normalizedKey = normalizeStorageKey(key);
    if (!normalizedKey.startsWith(`${normalizedFolder}/`)) {
      throw new Error('Storage key is outside the requested storage folder');
    }
    return {normalizedFolder, normalizedKey};
  }

  _r2Url(key, queryPairs = []) {
    const physicalKey = `${this.r2Prefix}/${normalizeStorageKey(key)}`;
    const url = new URL(this.r2Endpoint.origin);
    url.pathname = `${this.endpointPath}/${encodeRfc3986(this.bucket)}/${encodeKeyPath(physicalKey)}`;
    url.search = encodeQuery(queryPairs);
    return url;
  }

  _r2BucketUrl(queryPairs = []) {
    const url = new URL(this.r2Endpoint.origin);
    url.pathname = `${this.endpointPath}/${encodeRfc3986(this.bucket)}`;
    url.search = encodeQuery(queryPairs);
    return url;
  }

  _r2SigningKey(dateStamp) {
    const dateKey = hmac(`AWS4${this.secretAccessKey}`, dateStamp);
    const regionKey = hmac(dateKey, 'auto');
    const serviceKey = hmac(regionKey, 's3');
    return hmac(serviceKey, 'aws4_request');
  }

  _signedHeaders(url, method, body, contentType, cacheControl) {
    const {amzDate, dateStamp} = amzDateParts();
    const payloadHash = method === 'GET' || method === 'HEAD' || method === 'DELETE'
      ? sha256('')
      : sha256(body || Buffer.alloc(0));
    const headers = {
      host: url.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };
    if (contentType) headers['content-type'] = contentType;
    if (cacheControl) headers['cache-control'] = cacheControl;

    const signedHeaderNames = Object.keys(headers).sort();
    const canonicalHeaders = signedHeaderNames
      .map((name) => `${name}:${String(headers[name]).trim().replace(/\s+/g, ' ')}\n`)
      .join('');
    const canonicalRequest = [
      method,
      url.pathname,
      url.search.slice(1),
      canonicalHeaders,
      signedHeaderNames.join(';'),
      payloadHash,
    ].join('\n');
    const scope = `${dateStamp}/auto/s3/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256(canonicalRequest)}`;
    const signature = hmac(this._r2SigningKey(dateStamp), stringToSign, 'hex');
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope}, SignedHeaders=${signedHeaderNames.join(';')}, Signature=${signature}`;
    return headers;
  }

  _requestR2(method, key, {
    query = [],
    body = null,
    contentType = null,
    cacheControl = null,
    bucketOnly = false,
  } = {}) {
    const url = bucketOnly ? this._r2BucketUrl(query) : this._r2Url(key, query);
    const payload = body || Buffer.alloc(0);
    const headers = this._signedHeaders(url, method, payload, contentType, cacheControl);
    if (method === 'PUT') headers['content-length'] = String(payload.length);

    return new Promise((resolve, reject) => {
      const request = https.request(url, {method, headers}, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('error', reject);
        response.on('end', () => resolve({
          statusCode: Number(response.statusCode) || 0,
          headers: response.headers,
          body: Buffer.concat(chunks),
        }));
      });
      request.setTimeout(30000, () => request.destroy(new Error('R2 request timed out')));
      request.on('error', reject);
      if (method === 'PUT' && payload.length > 0) request.write(payload);
      request.end();
    });
  }

  async _sendR2(method, key, options = {}) {
    let attempt = 0;
    while (true) {
      let response;
      try {
        response = await this._requestR2(method, key, options);
      } catch (error) {
        if (attempt >= this.retryAttempts) throw error;
        const delay = this.retryBaseDelayMs * (2 ** attempt);
        attempt += 1;
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      if (response.statusCode >= 200 && response.statusCode < 300) return response;
      if (options.allowMissing && response.statusCode === 404) return null;
      if (response.statusCode === 408 || response.statusCode === 425 || response.statusCode === 429 || response.statusCode >= 500) {
        if (attempt < this.retryAttempts) {
          const delay = this.retryBaseDelayMs * (2 ** attempt);
          attempt += 1;
          if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
      }
      throw errorFromS3Response(response.statusCode, response.body.toString('utf8'));
    }
  }

  async _listR2Folder(folder) {
    const normalizedFolder = normalizeFolder(folder);
    const prefix = `${this.r2Prefix}/${normalizedFolder}/`;
    const objects = [];
    let continuationToken = '';
    do {
      const query = [['list-type', '2'], ['prefix', prefix]];
      if (continuationToken) query.push(['continuation-token', continuationToken]);
      const response = await this._sendR2('GET', '', {query, bucketOnly: true});
      const xml = response.body.toString('utf8');
      for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/gi)) {
        const size = Number(xmlTag(match[1], 'Size'));
        if (Number.isFinite(size) && size >= 0) objects.push(size);
      }
      continuationToken = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml)
        ? xmlTag(xml, 'NextContinuationToken')
        : '';
      if (/^\s*$/.test(continuationToken)) continuationToken = '';
    } while (continuationToken);
    return objects;
  }

  async _getR2ObjectSize(key) {
    const response = await this._sendR2('HEAD', key, {allowMissing: true});
    return response ? Math.max(0, Number(response.headers['content-length']) || 0) : 0;
  }

  async _getLocalObjectSize(key) {
    const {resolvedPath} = this._resolveLocalPath(key);
    try {
      const stat = await fs.stat(resolvedPath);
      return stat.isFile() ? stat.size : 0;
    } catch (error) {
      if (error.code === 'ENOENT') return 0;
      throw error;
    }
  }

  async _withFolderUploadLock(folder, operation) {
    const previous = this.uploadLocks.get(folder) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    this.uploadLocks.set(folder, current);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this.uploadLocks.get(folder) === current) this.uploadLocks.delete(folder);
    }
  }

  async _writeLocal(key, buffer) {
    const {resolvedPath} = this._resolveLocalPath(key);
    const parentDir = path.dirname(resolvedPath);
    await fs.mkdir(parentDir, {recursive: true, mode: 0o700});
    const temporaryPath = path.join(parentDir, `.nditor-${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`);
    try {
      await fs.writeFile(temporaryPath, buffer, {flag: 'wx', mode: 0o600});
      await fs.rename(temporaryPath, resolvedPath);
    } catch (error) {
      await fs.unlink(temporaryPath).catch(() => {});
      throw error;
    }
  }

  async _getLocalFolderUsage(folder) {
    const {resolvedPath} = this._resolveLocalFolder(folder);
    let total = 0;
    const visit = async (directory) => {
      let entries;
      try {
        entries = await fs.readdir(directory, {withFileTypes: true});
      } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
      }
      for (const entry of entries) {
        const filePath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(filePath);
        } else if (entry.isFile()) {
          const stat = await fs.stat(filePath);
          total += Math.max(0, Number(stat.size) || 0);
        }
      }
    };
    await visit(resolvedPath);
    return total;
  }

  async getUsage(folder) {
    if (this.isR2) {
      const sizes = await this._listR2Folder(folder);
      return sizes.reduce((total, size) => total + size, 0);
    }
    return this._getLocalFolderUsage(folder);
  }

  async uploadToId({file, id, key, folder, contentType = 'application/octet-stream'}) {
    const {normalizedFolder, normalizedKey} = this._assertKeyInFolder(key || id, folder);
    const buffer = await toBuffer(file);
    return this._withFolderUploadLock(normalizedFolder, async () => {
      const usedBytes = await this.getUsage(normalizedFolder);
      const replacedBytes = this.isR2
        ? await this._getR2ObjectSize(normalizedKey)
        : await this._getLocalObjectSize(normalizedKey);
      if (usedBytes - replacedBytes + buffer.length > this.quotaBytes) {
        const error = makeError('Storage quota exceeded', {code: 'STORAGE_QUOTA_EXCEEDED'});
        error.limitBytes = this.quotaBytes;
        error.usedBytes = Math.max(0, usedBytes - replacedBytes);
        error.requestedBytes = buffer.length;
        throw error;
      }

      if (this.isR2) {
        await this._sendR2('PUT', normalizedKey, {
          body: buffer,
          contentType: String(contentType || 'application/octet-stream'),
          cacheControl: this.cacheControl || null,
        });
      } else {
        await this._writeLocal(normalizedKey, buffer);
      }

      return {id: normalizedKey, key: normalizedKey, url: null};
    });
  }

  async delete(key) {
    const normalizedKey = normalizeStorageKey(key);
    if (this.isR2) {
      await this._sendR2('DELETE', normalizedKey);
      return;
    }
    const {resolvedPath} = this._resolveLocalPath(normalizedKey);
    try {
      await fs.unlink(resolvedPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  async read(key) {
    const normalizedKey = normalizeStorageKey(key);
    let buffer;
    let contentType = null;
    if (this.isR2) {
      const response = await this._sendR2('GET', normalizedKey);
      buffer = response.body;
      contentType = response.headers['content-type'] || null;
    } else {
      const {resolvedPath} = this._resolveLocalPath(normalizedKey);
      buffer = await fs.readFile(resolvedPath);
      contentType = CONTENT_TYPES_BY_EXTENSION.get(path.extname(normalizedKey).toLowerCase()) || null;
    }
    return {buffer, contentType};
  }
}

module.exports = NditorStorageAdapter;
