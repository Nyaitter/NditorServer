'use strict';

const api = require('../utils/ApiRegistry');
const {optionalNditorNyaitterAuth: optionalAuth} = require('../middleware/nditorNyaitterAuth');

const router = api.createRouter({
  tag: 'nditor-collaboration',
  basePath: '/nditor/collaboration',
  description: 'NditorのWebRTC共同作業用シグナリングAPI',
});

function errorResponse(res, error) {
  const status = Number(error.statusCode || error.status) || 400;
  const payload = {error: error.message || '共同作業の操作に失敗しました。'};
  if (error.code) payload.code = error.code;
  return res.status(status).json(payload);
}

function accessCredentials(req) {
  return {
    requestId: req.body?.request_id || req.query?.request_id || req.headers['x-nditor-request-id'] || '',
    requestKey: req.body?.request_key || req.query?.request_key || req.headers['x-nditor-request-key'] || '',
    controlToken: req.body?.control_token || req.query?.control_token || req.headers['x-nditor-control-token'] || '',
  };
}

async function resolveInvitedUsers(req, values) {
  const source = Array.isArray(values) ? values : String(values || '').split(/[\s,]+/);
  const result = [];
  for (const value of source.map((entry) => String(entry).trim()).filter(Boolean).slice(0, 50)) {
    const user = await req.app.locals.cloudProjectService.resolveUser(value, req.user);
    result.push(Number(user.id));
  }
  return [...new Set(result)];
}

async function roomAccess(req, room) {
  const credentials = accessCredentials(req);
  if (room.storageType === 'cloud') {
    const project = await req.app.locals.cloudProjectService.getProject(room.cloudProjectId);
    if (!project) return {granted: false, reason: 'missing'};
    req.app.locals.collaborationRooms.updatePolicy(room.token, {
      accessMode: project.accessMode,
      allowAnonymous: project.allowAnonymous !== false,
      invitedUserIds: project.memberUserIds || [],
    });
    return req.app.locals.cloudProjectService.collaborationAccess(project, req.user, credentials);
  }
  return req.app.locals.collaborationRooms.localAccess(room, req.user, credentials);
}

router.post({path: '/rooms', summary: 'ローカルプロジェクトの共同作業を開始', auth: 'optional'}, optionalAuth, async (req, res) => {
  try {
    const invitedUserIds = await resolveInvitedUsers(req, req.body?.invited_users || []);
    if (!req.user && req.body?.allow_anonymous === false) {
      return res.status(401).json({error: '非ログイン参加を無効にするにはNyaitterIDでログインしてください。', code: 'AUTH_REQUIRED'});
    }
    res.status(201).json(req.app.locals.collaborationRooms.createRoom({
      hostId: req.user?.id || null,
      title: req.body?.title || '',
      accessMode: req.body?.access_mode || 'private',
      allowAnonymous: req.body?.allow_anonymous !== false,
      invitedUserIds,
      storageType: 'local',
    }));
  } catch (error) { return errorResponse(res, error); }
});

router.get({path: '/rooms/:token', summary: '共同作業ルーム情報を取得', auth: 'optional'}, optionalAuth, async (req, res) => {
  try {
    const rooms = req.app.locals.collaborationRooms;
    const room = rooms.getRoomByToken(req.params.token);
    if (!room) return res.status(404).json({error: '共同作業ルームが見つかりません。'});
    const access = await roomAccess(req, room);
    res.json({
      ...rooms.describe(room.token),
      access: {
        granted: Boolean(access.granted),
        status: access.reason,
        can_request: Boolean(access.canRequest),
        requires_auth: Boolean(access.requiresAuth),
        request_id: access.request?.id || null,
      },
    });
  } catch (error) { return errorResponse(res, error); }
});

router.post({path: '/rooms/:token/ticket', summary: '共同作業の接続券を発行', auth: 'optional'}, optionalAuth, async (req, res) => {
  try {
    const rooms = req.app.locals.collaborationRooms;
    const room = rooms.getRoomByToken(req.params.token);
    if (!room) return res.status(404).json({error: '共同作業ルームが見つかりません。'});
    const access = await roomAccess(req, room);
    if (!access.granted) {
      if (access.requiresAuth) return res.status(401).json({error: '参加するにはNyaitterIDでログインしてください。', code: 'AUTH_REQUIRED'});
      const code = access.reason === 'pending' ? 'ACCESS_REQUEST_PENDING' : 'ACCESS_REQUEST_REQUIRED';
      return res.status(403).json({error: access.reason === 'pending' ? '参加申請は承認待ちです。' : '参加申請が必要です。', code});
    }
    const empty = room.participants.size === 0;
    const isHost = Boolean(access.isHost || (empty && req.user?.id && Number(room.hostId) === Number(req.user.id)));
    const hasAccess = ['owner', 'member', 'approved'].includes(access.reason) || Boolean(access.canWrite) || Boolean(isHost);
    const ticket = rooms.issueAuthTicket(room.token, {
      ...(req.user || {}),
      id: req.user?.id || null,
      isHost,
      hasAccess,
      accessReason: access.reason,
    });
    res.json({ticket});
  } catch (error) { return errorResponse(res, error); }
});

router.post({path: '/rooms/:token/access-requests', summary: '共同作業への参加申請を送る', auth: 'optional'}, optionalAuth, async (req, res) => {
  try {
    const rooms = req.app.locals.collaborationRooms;
    const room = rooms.getRoomByToken(req.params.token);
    if (!room) return res.status(404).json({error: '共同作業ルームが見つかりません。'});
    const result = room.storageType === 'cloud'
      ? await req.app.locals.cloudProjectService.createAccessRequest(room.cloudProjectId, req.user, {
        name: req.body?.name,
        viaRoom: true,
      })
      : rooms.createLocalAccessRequest(room.token, req.user, {name: req.body?.name});
    if (result.created) {
      const project = room.storageType === 'cloud' ?
        await req.app.locals.cloudProjectService.getProject(room.cloudProjectId) : null;
      rooms.notifyAccessRequest(room, project?.ownerId);
    }
    res.status(201).json(result);
  } catch (error) { return errorResponse(res, error); }
});

router.get({path: '/rooms/:token/access-requests/:requestId', summary: '共同作業の参加申請状態を取得', auth: 'optional'}, optionalAuth, async (req, res) => {
  try {
    const rooms = req.app.locals.collaborationRooms;
    const room = rooms.getRoomByToken(req.params.token);
    if (!room) return res.status(404).json({error: '共同作業ルームが見つかりません。'});
    const values = {requestId: req.params.requestId, requestKey: req.query?.request_key || req.headers['x-nditor-request-key']};
    const result = room.storageType === 'cloud'
      ? req.app.locals.cloudProjectService.accessRequestStatus(
        await req.app.locals.cloudProjectService.getProject(room.cloudProjectId),
        req.user,
        values,
      )
      : rooms.localAccessRequestStatus(room.token, req.user, values);
    res.json(result);
  } catch (error) { return errorResponse(res, error); }
});

router.get({path: '/rooms/:token/access-management', summary: '共同作業の招待と参加申請を取得', auth: 'optional'}, optionalAuth, async (req, res) => {
  try {
    const rooms = req.app.locals.collaborationRooms;
    const room = rooms.getRoomByToken(req.params.token);
    if (!room) return res.status(404).json({error: '共同作業ルームが見つかりません。'});
    const result = room.storageType === 'cloud'
      ? await req.app.locals.cloudProjectService.accessManagement(room.cloudProjectId, req.user)
      : rooms.localAccessManagement(room.token, req.user, accessCredentials(req).controlToken);
    res.json(result);
  } catch (error) { return errorResponse(res, error); }
});

router.patch({path: '/rooms/:token/settings', summary: 'ローカル共同作業の権限を変更', auth: 'optional'}, optionalAuth, async (req, res) => {
  try {
    const rooms = req.app.locals.collaborationRooms;
    const room = rooms.getRoomByToken(req.params.token);
    if (!room || room.storageType !== 'local') return res.status(404).json({error: 'ローカル共同作業ルームが見つかりません。'});
    rooms.localAccessManagement(room.token, req.user, accessCredentials(req).controlToken);
    const invitedUserIds = req.body?.invited_users === undefined
      ? room.invitedUserIds
      : await resolveInvitedUsers(req, req.body.invited_users);
    res.json(rooms.updatePolicy(room.token, {
      accessMode: req.body?.access_mode,
      allowAnonymous: req.body?.allow_anonymous,
      invitedUserIds,
    }));
  } catch (error) { return errorResponse(res, error); }
});

router.post({path: '/rooms/:token/access-requests/:requestId/:decision', summary: '共同作業の参加申請を承認または拒否', auth: 'optional'}, optionalAuth, async (req, res) => {
  try {
    const rooms = req.app.locals.collaborationRooms;
    const room = rooms.getRoomByToken(req.params.token);
    if (!room) return res.status(404).json({error: '共同作業ルームが見つかりません。'});
    const result = room.storageType === 'cloud'
      ? await req.app.locals.cloudProjectService.decideAccessRequest(
        room.cloudProjectId,
        req.user,
        req.params.requestId,
        req.params.decision,
      )
      : rooms.decideLocalAccessRequest(
        room.token,
        req.user,
        accessCredentials(req).controlToken,
        req.params.requestId,
        req.params.decision,
      );
    res.json(result);
  } catch (error) { return errorResponse(res, error); }
});

module.exports = router;
