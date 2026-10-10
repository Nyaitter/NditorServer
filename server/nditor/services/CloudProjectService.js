'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs').promises;
const path = require('node:path');

const MAX_PROJECTS = 10000;
const MAX_REQUESTS_PER_PROJECT = 500;
const ACCESS_MODES = new Set(['invite', 'private']);

function now() {
  return new Date().toISOString();
}

function projectError(message, statusCode = 400, code = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}

function userIdOf(user) {
  const id = Number(user?.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function isAdministrator(user) {
  return user?.admin === true;
}

function normalizeProjectId(value) {
  const id = String(value || '').trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ? id : null;
}

function normalizeAccessMode(value, fallback = null) {
  const mode = String(value || '').trim().toLowerCase();
  return ACCESS_MODES.has(mode) ? mode : fallback;
}

function cleanName(value, fallback = '無題のプロジェクト') {
  const name = String(value || '').trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 100);
  return name || fallback;
}

function hashSecret(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function uniqueUserIds(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(Number)
    .filter((id) => Number.isInteger(id) && id > 0))];
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: Number(user.id),
    name: String(user.name || user.display_name || user.scid || `#${user.id}`),
    scid: user.scid || null,
  };
}

class CloudProjectService {
  constructor({userDirectory, storageAdapter, dataRoot = null} = {}) {
    this.users = userDirectory;
    this.storage = storageAdapter;
    this.dataRoot = dataRoot || path.resolve(__dirname, '../../../data/nditor');
    this.metadataPath = path.join(this.dataRoot, 'cloud-projects.json');
    this.metadataLock = Promise.resolve();
    this.projectLocks = new Map();
  }

  async initialize() {
    await fs.mkdir(this.dataRoot, {recursive: true, mode: 0o700});
    try {
      const projects = JSON.parse(await fs.readFile(this.metadataPath, 'utf8'));
      if (!Array.isArray(projects)) throw new Error('クラウドプロジェクトの情報を読み込めません。');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.writeProjects([]);
    }
  }

  async readProjects() {
    try {
      const projects = JSON.parse(await fs.readFile(this.metadataPath, 'utf8'));
      return Array.isArray(projects) ? projects : [];
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async writeProjects(projects) {
    await fs.mkdir(this.dataRoot, {recursive: true, mode: 0o700});
    const temporary = `${this.metadataPath}.tmp-${process.pid}-${crypto.randomBytes(5).toString('hex')}`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(projects, null, 2)}\n`, {mode: 0o600});
      await fs.rename(temporary, this.metadataPath);
    } finally {
      await fs.rm(temporary, {force: true}).catch(() => {});
    }
  }

  async mutateProjects(mutator) {
    const previous = this.metadataLock;
    let release;
    this.metadataLock = new Promise((resolve) => { release = resolve; });
    await previous.catch(() => {});
    try {
      const projects = await this.readProjects();
      const result = await mutator(projects);
      await this.writeProjects(projects);
      return result;
    } finally {
      release();
    }
  }

  async withProjectLock(projectId, operation) {
    const previous = this.projectLocks.get(projectId) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    this.projectLocks.set(projectId, current);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this.projectLocks.get(projectId) === current) this.projectLocks.delete(projectId);
    }
  }

  storageFolder(ownerId) {
    return `attachments/${Number(ownerId)}`;
  }

  storageKey(ownerId, projectId) {
    return `${this.storageFolder(ownerId)}/nditor/${projectId}.zip`;
  }

  quotaBytes() {
    return this.storage.quotaBytes;
  }

  async storageUsage(userId) {
    const ownerId = Number(userId);
    const used = Number(await this.storage.getUsage(this.storageFolder(ownerId))) || 0;
    return {used_bytes: used, limit_bytes: this.quotaBytes(), available_bytes: Math.max(0, this.quotaBytes() - used)};
  }

  async getProject(projectId) {
    const id = normalizeProjectId(projectId);
    if (!id) return null;
    const projects = await this.readProjects();
    return projects.find((project) => project.id === id) || null;
  }

  isOwner(project, user) {
    const userId = userIdOf(user);
    return Boolean(project && userId && (Number(project.ownerId) === userId || isAdministrator(user)));
  }

  isMember(project, user) {
    const userId = userIdOf(user);
    if (!userId) return false;
    return uniqueUserIds([...(project.invitedUserIds || []), ...(project.memberUserIds || [])]).includes(userId);
  }

  requestCredentialMatches(request, requestId, requestKey) {
    if (!request || request.id !== String(requestId || '') || !request.secretHash || !requestKey) return false;
    return safeEqual(request.secretHash, hashSecret(requestKey));
  }

  hasValidShareToken(project, shareToken) {
    return Boolean(project?.shareToken && safeEqual(shareToken, project.shareToken));
  }

  accessFor(project, user, credentials = {}, {linkAuthorized = false} = {}) {
    if (!project) return {granted: false, reason: 'missing'};
    if (credentials?.internal === true) return {granted: true, reason: 'internal', canWrite: true};
    if (this.isOwner(project, user)) return {granted: true, reason: 'owner', canWrite: true};
    if (this.isMember(project, user)) return {granted: true, reason: 'member', canWrite: true};

    const userId = userIdOf(user);
    const requests = Array.isArray(project.accessRequests) ? project.accessRequests : [];
    const approvedUserRequest = userId ? requests.find((request) => (
      request.status === 'approved' && Number(request.userId) === userId
    )) : null;
    if (approvedUserRequest) return {granted: true, reason: 'approved', canWrite: true};

    const approvedAnonymousRequest = !userId ? requests.find((request) => (
      request.status === 'approved' && !request.userId &&
      this.requestCredentialMatches(request, credentials.requestId, credentials.requestKey)
    )) : null;
    if (approvedAnonymousRequest && project.allowAnonymous !== false) {
      return {granted: true, reason: 'approved', canWrite: false};
    }

    if (project.allowAnonymous === false && !userId) {
      return {granted: false, reason: 'auth-required', requiresAuth: true};
    }

    if (project.accessMode === 'private') {
      const validLink = linkAuthorized || safeEqual(credentials.shareToken, project.shareToken);
      return validLink
        ? {granted: true, reason: 'link', canWrite: false}
        : {granted: false, reason: 'missing-link'};
    }

    const pending = userId
      ? requests.find((request) => Number(request.userId) === userId && request.status === 'pending')
      : requests.find((request) => request.status === 'pending' && this.requestCredentialMatches(
        request,
        credentials.requestId,
        credentials.requestKey,
      ));
    return {
      granted: false,
      reason: pending ? 'pending' : 'request-required',
      canRequest: linkAuthorized || safeEqual(credentials.shareToken, project.shareToken),
      request: pending || null,
    };
  }

  requireAccess(project, user, credentials = {}, options = {}) {
    if (!project) throw projectError('クラウドプロジェクトが見つかりません。', 404, 'PROJECT_NOT_FOUND');
    const access = this.accessFor(project, user, credentials, options);
    if (access.granted) return access;
    if (access.requiresAuth) throw projectError('参加するにはNyaitterIDでログインしてください。', 401, 'AUTH_REQUIRED');
    if (access.reason === 'pending') throw projectError('参加申請は承認待ちです。', 403, 'ACCESS_REQUEST_PENDING');
    if (project.accessMode === 'invite' && access.canRequest) {
      throw projectError('このプロジェクトには参加申請が必要です。', 403, 'ACCESS_REQUEST_REQUIRED');
    }
    throw projectError('クラウドプロジェクトが見つかりません。', 404, 'PROJECT_NOT_FOUND');
  }

  requireOwner(project, user) {
    if (!project) throw projectError('クラウドプロジェクトが見つかりません。', 404, 'PROJECT_NOT_FOUND');
    if (!this.isOwner(project, user)) throw projectError('設定を変更できるのは所有者だけです。', 403, 'OWNER_REQUIRED');
  }

  serialize(project, user, credentials = {}, options = {}) {
    const access = this.accessFor(project, user, credentials, options);
    const owner = this.isOwner(project, user);
    return {
      id: project.id,
      name: project.name,
      owner_id: Number(project.ownerId),
      access_mode: project.accessMode,
      allow_anonymous: project.allowAnonymous !== false,
      size_bytes: Math.max(0, Number(project.sizeBytes) || 0),
      created_at: project.createdAt,
      updated_at: project.updatedAt,
      can_write: Boolean(access.canWrite),
      is_owner: owner,
      ...(owner ? {share_token: project.shareToken} : {}),
    };
  }

  async listProjects(user) {
    const userId = userIdOf(user);
    if (!userId) throw projectError('ログインが必要です。', 401, 'AUTH_REQUIRED');
    const projects = await this.readProjects();
    return projects
      .filter((project) => this.isOwner(project, user) || this.isMember(project, user))
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
      .map((project) => this.serialize(project, user));
  }

  async uploadSnapshot(project, buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw projectError('.sb3ファイルが空です。');
    if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
      throw projectError('.sb3ファイルの形式が正しくありません。');
    }
    const key = project.storageKey || this.storageKey(project.ownerId, project.id);
    await this.storage.uploadToId({
      file: buffer,
      id: key,
      key,
      folder: this.storageFolder(project.ownerId),
      fileName: `${project.id}.sb3`,
      originalFileName: `${project.id}.sb3`,
      contentType: 'application/zip',
    });
    return key;
  }

  async createProject(user, {name, accessMode = 'invite', allowAnonymous = false, snapshot}) {
    const ownerId = userIdOf(user);
    if (!ownerId) throw projectError('ログインが必要です。', 401, 'AUTH_REQUIRED');
    const projects = await this.readProjects();
    if (projects.length >= MAX_PROJECTS) throw projectError('クラウドプロジェクトをこれ以上作成できません。', 503);
    const mode = normalizeAccessMode(accessMode);
    if (!mode) throw projectError('公開範囲が正しくありません。');
    const id = crypto.randomUUID();
    const project = {
      id,
      name: cleanName(name),
      ownerId,
      accessMode: mode,
      allowAnonymous: Boolean(allowAnonymous),
      shareToken: crypto.randomBytes(24).toString('base64url'),
      invitedUserIds: [],
      memberUserIds: [],
      accessRequests: [],
      storageKey: this.storageKey(ownerId, id),
      sizeBytes: snapshot.length,
      createdAt: now(),
      updatedAt: now(),
    };
    await this.uploadSnapshot(project, snapshot);
    try {
      await this.mutateProjects((current) => current.push(project));
    } catch (error) {
      await this.storage.delete(project.storageKey).catch(() => {});
      throw error;
    }
    return this.serialize(project, user);
  }

  async readSnapshot(projectId, user, credentials = {}) {
    const project = await this.getProject(projectId);
    this.requireAccess(project, user, credentials);
    try {
      const result = await this.storage.read(project.storageKey);
      return {project, buffer: result.buffer};
    } catch (error) {
      if (error.code === 'ENOENT' || error.name === 'NoSuchKey') {
        throw projectError('プロジェクトデータが見つかりません。', 404, 'SNAPSHOT_NOT_FOUND');
      }
      throw error;
    }
  }

  async saveProject(projectId, user, snapshot) {
    return this.withProjectLock(String(projectId), async () => {
      const project = await this.getProject(projectId);
      const access = this.requireAccess(project, user);
      if (!access.canWrite) throw projectError('このクラウドプロジェクトは保存できません。', 403, 'WRITE_FORBIDDEN');
      await this.uploadSnapshot(project, snapshot);
      project.sizeBytes = snapshot.length;
      project.updatedAt = now();
      await this.mutateProjects((projects) => {
        const index = projects.findIndex((candidate) => candidate.id === project.id);
        if (index < 0) throw projectError('クラウドプロジェクトが見つかりません。', 404);
        projects[index] = project;
      });
      return this.serialize(project, user);
    });
  }

  async persistVmSnapshot(projectId, snapshotBuffer) {
    return this.withProjectLock(String(projectId), async () => {
      const project = await this.getProject(projectId);
      if (!project) return null;
      await this.uploadSnapshot(project, snapshotBuffer);
      project.sizeBytes = snapshotBuffer.length;
      project.updatedAt = now();
      await this.mutateProjects((projects) => {
        const index = projects.findIndex((candidate) => candidate.id === project.id);
        if (index >= 0) projects[index] = project;
      });
      return this.serialize(project, null, {internal: true});
    });
  }

  async updateProject(projectId, user, {name, accessMode, allowAnonymous} = {}) {
    return this.withProjectLock(String(projectId), async () => {
      const project = await this.getProject(projectId);
      this.requireOwner(project, user);
      if (name !== undefined) project.name = cleanName(name, project.name);
      if (accessMode !== undefined) {
        const mode = normalizeAccessMode(accessMode);
        if (!mode) throw projectError('公開範囲が正しくありません。');
        project.accessMode = mode;
      }
      if (allowAnonymous !== undefined) project.allowAnonymous = Boolean(allowAnonymous);
      project.updatedAt = now();
      await this.mutateProjects((projects) => {
        const index = projects.findIndex((candidate) => candidate.id === project.id);
        if (index >= 0) projects[index] = project;
      });
      return this.serialize(project, user);
    });
  }

  async deleteProject(projectId, user) {
    return this.withProjectLock(String(projectId), async () => {
      const project = await this.getProject(projectId);
      this.requireOwner(project, user);
      await this.storage.delete(project.storageKey);
      await this.mutateProjects((projects) => {
        const index = projects.findIndex((candidate) => candidate.id === project.id);
        if (index >= 0) projects.splice(index, 1);
      });
      return {success: true};
    });
  }

  async resolveUser(identifier, requester = null) {
    const value = String(identifier || '').trim();
    if (!value) throw projectError('招待するユーザーを入力してください。');
    const numeric = Number(value.replace(/^#/, ''));
    if (Number.isInteger(numeric) && numeric > 0) {
      const user = await this.users.getUserById(numeric, requester?.accessToken);
      if (user) return user;
    }
    const candidates = await this.users.searchUsers(value, 20, 0, requester?.accessToken);
    const normalized = value.toLowerCase().replace(/^@/, '');
    const exact = candidates.find((candidate) => [
      String(candidate.id),
      String(candidate.scid || '').toLowerCase(),
      String(candidate.name || '').toLowerCase(),
    ].includes(normalized.replace(/^#/, '')));
    if (!exact) throw projectError('招待するユーザーが見つかりません。', 404, 'USER_NOT_FOUND');
    return exact;
  }

  async accessManagement(projectId, user) {
    const project = await this.getProject(projectId);
    this.requireOwner(project, user);
    const invitedIds = uniqueUserIds(project.invitedUserIds);
    const memberIds = uniqueUserIds(project.memberUserIds);
    const users = await this.users.getUsersByIds([...new Set([...invitedIds, ...memberIds])], user?.accessToken);
    const userById = new Map((users || []).map((entry) => [Number(entry.id), publicUser(entry)]));
    return {
      invited_users: invitedIds.map((id) => userById.get(id) || {id, name: `#${id}`, scid: null}),
      approved_users: memberIds.map((id) => userById.get(id) || {id, name: `#${id}`, scid: null}),
      requests: (project.accessRequests || []).map((request) => ({
        id: request.id,
        user_id: request.userId || null,
        name: request.name,
        status: request.status,
        created_at: request.createdAt,
        decided_at: request.decidedAt || null,
      })),
    };
  }

  async inviteUser(projectId, user, identifier) {
    const invited = await this.resolveUser(identifier, user);
    return this.withProjectLock(String(projectId), async () => {
      const project = await this.getProject(projectId);
      this.requireOwner(project, user);
      if (Number(invited.id) === Number(project.ownerId)) throw projectError('所有者を招待する必要はありません。');
      project.invitedUserIds = uniqueUserIds([...(project.invitedUserIds || []), invited.id]);
      project.updatedAt = now();
      await this.mutateProjects((projects) => {
        const index = projects.findIndex((candidate) => candidate.id === project.id);
        if (index < 0) throw projectError('クラウドプロジェクトが見つかりません。', 404);
        projects[index] = project;
      });
      return {user: publicUser(invited)};
    });
  }

  async removeUser(projectId, user, memberId) {
    return this.withProjectLock(String(projectId), async () => {
      const project = await this.getProject(projectId);
      this.requireOwner(project, user);
      const id = Number(memberId);
      if (!Number.isInteger(id) || id <= 0) throw projectError('ユーザーIDが正しくありません。');
      project.invitedUserIds = uniqueUserIds(project.invitedUserIds).filter((value) => value !== id);
      project.memberUserIds = uniqueUserIds(project.memberUserIds).filter((value) => value !== id);
      for (const request of project.accessRequests || []) {
        if (Number(request.userId) === id && ['pending', 'approved'].includes(request.status)) {
          request.status = 'revoked';
          request.decidedAt = now();
        }
      }
      project.updatedAt = now();
      await this.mutateProjects((projects) => {
        const index = projects.findIndex((candidate) => candidate.id === project.id);
        if (index < 0) throw projectError('クラウドプロジェクトが見つかりません。', 404);
        projects[index] = project;
      });
      return {success: true};
    });
  }

  async createAccessRequest(projectId, user, {shareToken = '', name = '', viaRoom = false} = {}) {
    return this.withProjectLock(String(projectId), async () => {
      const project = await this.getProject(projectId);
      if (!project) throw projectError('クラウドプロジェクトが見つかりません。', 404);
      if (project.accessMode !== 'invite') throw projectError('このプロジェクトに参加申請は必要ありません。');
      if (!viaRoom && !safeEqual(shareToken, project.shareToken)) {
        throw projectError('クラウドプロジェクトが見つかりません。', 404);
      }
      const requesterId = userIdOf(user);
      if (!requesterId && project.allowAnonymous === false) {
        throw projectError('参加申請にはNyaitterIDでログインしてください。', 401, 'AUTH_REQUIRED');
      }
      const existingAccess = this.accessFor(project, user, {}, {linkAuthorized: viaRoom});
      if (existingAccess.granted) return {status: 'approved', granted: true};
      const requests = Array.isArray(project.accessRequests) ? project.accessRequests : [];
      const existing = requesterId ? requests.find((request) => (
        Number(request.userId) === requesterId && ['pending', 'approved'].includes(request.status)
      )) : null;
      if (existing) return {request_id: existing.id, status: existing.status, granted: existing.status === 'approved'};
      if (requests.filter((request) => request.status === 'pending').length >= MAX_REQUESTS_PER_PROJECT) {
        throw projectError('参加申請が多すぎます。所有者の対応をお待ちください。', 429);
      }
      const requester = requesterId ? await this.users.getUserById(requesterId, user?.accessToken) : null;
      const requestKey = requesterId ? null : crypto.randomBytes(24).toString('base64url');
      const request = {
        id: crypto.randomUUID(),
        userId: requesterId,
        name: requester ? publicUser(requester).name : cleanName(name, '匿名ユーザー').slice(0, 40),
        secretHash: requestKey ? hashSecret(requestKey) : null,
        status: 'pending',
        createdAt: now(),
        decidedAt: null,
      };
      project.accessRequests = [...requests, request];
      project.updatedAt = now();
      await this.mutateProjects((projects) => {
        const index = projects.findIndex((candidate) => candidate.id === project.id);
        if (index >= 0) projects[index] = project;
      });
      return {request_id: request.id, request_key: requestKey, status: request.status, granted: false, created: true};
    });
  }

  accessRequestStatus(project, user, {requestId, requestKey} = {}) {
    if (!project) throw projectError('クラウドプロジェクトが見つかりません。', 404);
    const requesterId = userIdOf(user);
    const request = (project.accessRequests || []).find((candidate) => candidate.id === String(requestId || ''));
    if (!request) throw projectError('参加申請が見つかりません。', 404, 'REQUEST_NOT_FOUND');
    const ownsRequest = requesterId
      ? Number(request.userId) === requesterId
      : this.requestCredentialMatches(request, requestId, requestKey);
    if (!ownsRequest && !this.isOwner(project, user)) throw projectError('参加申請が見つかりません。', 404);
    return {request_id: request.id, status: request.status, granted: request.status === 'approved'};
  }

  async decideAccessRequest(projectId, user, requestId, decision) {
    return this.withProjectLock(String(projectId), async () => {
      const project = await this.getProject(projectId);
      this.requireOwner(project, user);
      const request = (project.accessRequests || []).find((candidate) => candidate.id === String(requestId || ''));
      if (!request) throw projectError('参加申請が見つかりません。', 404);
      const status = decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : null;
      if (!status) throw projectError('参加申請の操作が正しくありません。');
      request.status = status;
      request.decidedAt = now();
      if (status === 'approved' && request.userId) {
        project.memberUserIds = uniqueUserIds([...(project.memberUserIds || []), request.userId]);
      }
      project.updatedAt = now();
      await this.mutateProjects((projects) => {
        const index = projects.findIndex((candidate) => candidate.id === project.id);
        if (index >= 0) projects[index] = project;
      });
      return {request_id: request.id, status};
    });
  }

  collaborationAccess(project, user, credentials = {}) {
    return this.accessFor(project, user, credentials, {linkAuthorized: true});
  }
}

module.exports = {
  CloudProjectService,
  normalizeAccessMode,
  projectError,
};
