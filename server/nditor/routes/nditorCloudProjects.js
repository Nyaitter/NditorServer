'use strict';

const express = require('express');
const busboy = require('busboy');
const api = require('../utils/ApiRegistry');
const {
  requireNditorNyaitterAuth: requireAuth,
  optionalNditorNyaitterAuth: optionalAuth,
} = require('../middleware/nditorNyaitterAuth');

const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;

const router = api.createRouter({
  tag: 'nditor-cloud-projects',
  basePath: '/nditor/cloud-projects',
  description: 'Nditorの単一スナップショット型クラウドプロジェクトAPI',
});

function service(req) {
  return req.app.locals.cloudProjectService;
}

function errorResponse(res, error) {
  const status = error.code === 'STORAGE_QUOTA_EXCEEDED'
    ? 413
    : Number(error.statusCode || error.status) || 400;
  const payload = {error: error.message || 'クラウドプロジェクトの操作に失敗しました。'};
  if (error.code) payload.code = error.code;
  if (error.limitBytes) payload.limit_bytes = error.limitBytes;
  if (error.usedBytes) payload.used_bytes = error.usedBytes;
  return res.status(status).json(payload);
}

async function parseMultipart(req) {
  if (req._nditorMultipart) return req._nditorMultipart;
  const contentType = String(req.headers['content-type'] || '');
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    req._nditorMultipart = {fields: req.body && typeof req.body === 'object' ? req.body : {}, file: null};
    return req._nditorMultipart;
  }
  if (!Buffer.isBuffer(req.body)) throw new Error('multipart/form-dataの形式が正しくありません。');
  req._nditorMultipart = await new Promise((resolve, reject) => {
    const parser = busboy({headers: req.headers, limits: {fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 20}});
    const fields = {};
    let file = null;
    let tooLarge = false;
    parser.on('field', (name, value) => { fields[name] = value; });
    parser.on('file', (_name, stream, info) => {
      const chunks = [];
      stream.on('limit', () => { tooLarge = true; });
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', () => {
        file = {name: info.filename, buffer: Buffer.concat(chunks)};
      });
    });
    parser.on('close', () => {
      if (tooLarge) return reject(Object.assign(new Error('.sb3ファイルが大きすぎます。'), {statusCode: 413}));
      resolve({fields, file});
    });
    parser.on('error', reject);
    parser.end(req.body);
  });
  return req._nditorMultipart;
}

function boolValue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function credentials(req, fields = null) {
  const body = fields || (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : {});
  return {
    shareToken: req.query?.cloud_key || body.cloud_key || req.headers['x-nditor-cloud-key'] || '',
    requestId: req.query?.request_id || body.request_id || req.headers['x-nditor-request-id'] || '',
    requestKey: req.query?.request_key || body.request_key || req.headers['x-nditor-request-key'] || '',
  };
}

function context(projectId) {
  return `cloud:${String(projectId || '')}`;
}

function activeRoom(req, projectId) {
  const room = req.app.locals.collaborationRooms?.getRoomByContext(context(projectId));
  if (!room || !room.currentHostParticipantId) return null;
  return {token: room.token, participant_count: room.participants.size, host_connected: true};
}

const multipartBody = express.raw({
  type: (req) => /^multipart\/form-data/i.test(String(req.headers['content-type'] || '')),
  limit: MAX_UPLOAD_BYTES,
});

router.get({path: '/', summary: '自分が利用できるクラウドプロジェクトを取得', auth: 'required'}, requireAuth, async (req, res) => {
  try {
    const projects = await service(req).listProjects(req.user);
    res.json({projects: projects.map((project) => ({...project, active_collaboration: activeRoom(req, project.id)}))});
  } catch (error) { return errorResponse(res, error); }
});

router.get({path: '/storage', summary: 'ユーザーストレージの使用量を取得', auth: 'required'}, requireAuth, async (req, res) => {
  try { res.json(await service(req).storageUsage(req.user.id)); } catch (error) { return errorResponse(res, error); }
});

router.post({path: '/', summary: '現在の編集内容をクラウドに保存', auth: 'required'}, requireAuth, multipartBody, async (req, res) => {
  try {
    const parsed = await parseMultipart(req);
    if (!parsed.file?.buffer?.length) return res.status(400).json({error: '.sb3ファイルが必要です。'});
    const project = await service(req).createProject(req.user, {
      name: parsed.fields.name,
      accessMode: parsed.fields.access_mode,
      allowAnonymous: parsed.fields.allow_anonymous === undefined ? true : boolValue(parsed.fields.allow_anonymous),
      snapshot: parsed.file.buffer,
    });
    res.status(201).json({project});
  } catch (error) { return errorResponse(res, error); }
});

router.get({path: '/:projectId/access', summary: '共有URLの参加状態を確認', auth: 'optional'}, optionalAuth, async (req, res) => {
  try {
    const project = await service(req).getProject(req.params.projectId);
    if (!project) return res.status(404).json({error: 'クラウドプロジェクトが見つかりません。'});
    const accessCredentials = credentials(req);
    const validLink = service(req).hasValidShareToken(project, accessCredentials.shareToken);
    const ownerOrMember = service(req).isOwner(project, req.user) || service(req).isMember(project, req.user);
    if (!validLink && !ownerOrMember) return res.status(404).json({error: 'クラウドプロジェクトが見つかりません。'});
    const access = service(req).accessFor(project, req.user, accessCredentials);
    res.json({
      project: {
        id: project.id,
        name: project.name,
        access_mode: project.accessMode,
        allow_anonymous: project.allowAnonymous !== false,
      },
      access: {
        granted: access.granted,
        can_write: Boolean(access.canWrite),
        status: access.reason,
        can_request: Boolean(access.canRequest),
        requires_auth: Boolean(access.requiresAuth),
        request_id: access.request?.id || null,
      },
    });
  } catch (error) { return errorResponse(res, error); }
});

router.get({path: '/:projectId', summary: 'クラウドプロジェクトの情報を取得', auth: 'optional'}, optionalAuth, async (req, res) => {
  try {
    const project = await service(req).getProject(req.params.projectId);
    service(req).requireAccess(project, req.user, credentials(req));
    res.json({
      project: service(req).serialize(project, req.user, credentials(req)),
      active_collaboration: activeRoom(req, project.id),
    });
  } catch (error) { return errorResponse(res, error); }
});

router.get({path: '/:projectId/snapshot', summary: 'クラウドプロジェクトを読み込む', auth: 'optional'}, optionalAuth, async (req, res) => {
  try {
    const result = await service(req).readSnapshot(req.params.projectId, req.user, credentials(req));
    res.type('application/zip')
      .set('Content-Disposition', `attachment; filename="${result.project.id}.sb3"`)
      .set('Cache-Control', 'private, no-store')
      .send(result.buffer);
  } catch (error) { return errorResponse(res, error); }
});

router.put({path: '/:projectId/snapshot', summary: 'クラウドプロジェクトを上書き保存', auth: 'required'}, requireAuth, multipartBody, async (req, res) => {
  try {
    const parsed = await parseMultipart(req);
    if (!parsed.file?.buffer?.length) return res.status(400).json({error: '.sb3ファイルが必要です。'});
    const project = await service(req).saveProject(req.params.projectId, req.user, parsed.file.buffer);
    const serverVmManager = req.app.locals.serverVmManager;
    if (serverVmManager) {
      await serverVmManager.reloadSnapshot(req.params.projectId, parsed.file.buffer).catch((err) => {
        console.warn('[server-vm] Failed to reload snapshot on save:', err.message);
      });
    }
    res.json({project});
  } catch (error) { return errorResponse(res, error); }
});

router.patch({path: '/:projectId', summary: 'クラウドプロジェクトの設定を変更', auth: 'required'}, requireAuth, async (req, res) => {
  try {
    res.json({project: await service(req).updateProject(req.params.projectId, req.user, {
      name: req.body?.name,
      accessMode: req.body?.access_mode,
      allowAnonymous: req.body?.allow_anonymous,
    })});
  } catch (error) { return errorResponse(res, error); }
});

router.delete({path: '/:projectId', summary: 'クラウドプロジェクトを削除', auth: 'required'}, requireAuth, async (req, res) => {
  try {
    const result = await service(req).deleteProject(req.params.projectId, req.user);
    const room = req.app.locals.collaborationRooms?.getRoomByContext(context(req.params.projectId));
    if (room) req.app.locals.collaborationRooms.closeRoom(room.id);
    res.json(result);
  } catch (error) { return errorResponse(res, error); }
});

router.get({path: '/:projectId/access-management', summary: '招待と参加申請を取得', auth: 'required'}, requireAuth, async (req, res) => {
  try { res.json(await service(req).accessManagement(req.params.projectId, req.user)); } catch (error) { return errorResponse(res, error); }
});

router.post({path: '/:projectId/invitations', summary: 'ユーザーを招待', auth: 'required'}, requireAuth, async (req, res) => {
  try { res.status(201).json(await service(req).inviteUser(req.params.projectId, req.user, req.body?.identifier)); } catch (error) { return errorResponse(res, error); }
});

router.delete({path: '/:projectId/users/:userId', summary: '招待または承認を取り消す', auth: 'required'}, requireAuth, async (req, res) => {
  try { res.json(await service(req).removeUser(req.params.projectId, req.user, req.params.userId)); } catch (error) { return errorResponse(res, error); }
});

router.post({path: '/:projectId/access-requests', summary: '共有URLから参加申請を送る', auth: 'optional'}, optionalAuth, async (req, res) => {
  try {
    const result = await service(req).createAccessRequest(req.params.projectId, req.user, {
      shareToken: req.body?.cloud_key,
      name: req.body?.name,
    });
    if (result.created) {
      const rooms = req.app.locals.collaborationRooms;
      const project = await service(req).getProject(req.params.projectId);
      rooms?.notifyAccessRequest(rooms.getRoomByContext(context(req.params.projectId)), project?.ownerId);
    }
    res.status(201).json(result);
  } catch (error) { return errorResponse(res, error); }
});

router.get({path: '/:projectId/access-requests/:requestId', summary: '参加申請の状態を取得', auth: 'optional'}, optionalAuth, async (req, res) => {
  try {
    const project = await service(req).getProject(req.params.projectId);
    res.json(service(req).accessRequestStatus(project, req.user, {
      requestId: req.params.requestId,
      requestKey: req.query?.request_key || req.headers['x-nditor-request-key'],
    }));
  } catch (error) { return errorResponse(res, error); }
});

router.post({path: '/:projectId/access-requests/:requestId/:decision', summary: '参加申請を承認または拒否', auth: 'required'}, requireAuth, async (req, res) => {
  try {
    res.json(await service(req).decideAccessRequest(
      req.params.projectId,
      req.user,
      req.params.requestId,
      req.params.decision,
    ));
  } catch (error) { return errorResponse(res, error); }
});

router.post({path: '/:projectId/collaboration-session', summary: 'クラウドプロジェクトの共同作業を開始', auth: 'optional'}, optionalAuth, async (req, res) => {
  try {
    const project = await service(req).getProject(req.params.projectId);
    service(req).requireAccess(project, req.user, credentials(req));
    const rooms = req.app.locals.collaborationRooms;
    const serverVmManager = req.app.locals.serverVmManager;
    const roomContext = context(project.id);
    let room = rooms.getRoomByContext(roomContext);
    let existing = true;
    if (!room) {
      existing = false;
      const roomCreated = rooms.createRoom({
        hostId: 'server-vm',
        title: project.name,
        context: roomContext,
        accessMode: project.accessMode,
        allowAnonymous: project.allowAnonymous !== false,
        invitedUserIds: project.memberUserIds || [],
        storageType: 'cloud',
        cloudProjectId: project.id,
      });
      room = rooms.getRoom(roomCreated.room_id);
    } else {
      rooms.updatePolicy(room.token, {
        accessMode: project.accessMode,
        allowAnonymous: project.allowAnonymous !== false,
      });
    }

    room.isServerVm = true;
    room.currentHostParticipantId = 'server-vm';
    if (!serverVmManager) throw new Error('サーバーVMマネージャーが初期化されていません。');
    await serverVmManager.getOrStartVm(project.id, room);

    const description = rooms.describe(room.token);
    return res.status(existing ? 200 : 201).json({
      ...description,
      is_server_vm: true,
      existing,
    });
  } catch (error) { return errorResponse(res, error); }
});

router.post({path: '/:projectId/vm/restart', summary: 'クラウドプロジェクトのサーバーVMを再起動', auth: 'required'}, requireAuth, async (req, res) => {
  try {
    const project = await service(req).getProject(req.params.projectId);
    service(req).requireOwner(project, req.user);
    const serverVmManager = req.app.locals.serverVmManager;
    if (!serverVmManager) throw new Error('サーバーVMマネージャーが初期化されていません。');
    await serverVmManager.restartVm(project.id);
    res.json({success: true, message: 'サーバーVMを再起動しました。'});
  } catch (error) { return errorResponse(res, error); }
});

module.exports = router;
