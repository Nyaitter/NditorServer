'use strict';

const crypto = require('node:crypto');

const ROOM_TOKEN_BYTES = 24;
const MAX_ROOMS = 1000;
const MAX_PARTICIPANTS = 50;
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const TICKET_TTL_MS = 60 * 1000;
const EMPTY_ROOM_TTL_MS = 10 * 60 * 1000;
const ALLOWED_SIGNAL_TYPES = new Set([
  'offer',
  'answer',
  'ice'
]);
const ACCESS_MODES = new Set(['invite', 'private']);

function cleanName(value) {
  const name = String(value || '').trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 40);
  return name || null;
}

function cleanContext(value) {
  const context = String(value || '').trim();
  if (!context) return null;
  if (context.length > 200 || !/^[a-z0-9][a-z0-9:_-]*$/i.test(context)) {
    throw new Error('共同作業ルームの関連情報が正しくありません。');
  }
  return context;
}

function hashSecret(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function userIds(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
}

class CollaborationRoomManager {
  constructor({ maxRooms = MAX_ROOMS, maxParticipants = MAX_PARTICIPANTS } = {}) {
    this.maxRooms = maxRooms;
    this.maxParticipants = maxParticipants;
    this.rooms = new Map();
    this.roomsByToken = new Map();
    this.roomsByContext = new Map();
    this.authTickets = new Map();
    this.emptyRoomTimers = new Map();
  }

  scheduleEmptyCleanup(roomId, delayMs = EMPTY_ROOM_TTL_MS) {
    this.clearEmptyCleanup(roomId);
    const timer = setTimeout(() => {
      const room = this.rooms.get(roomId);
      if (room && room.participants.size === 0) {
        this.closeRoom(roomId);
      }
    }, delayMs);
    if (typeof timer.unref === 'function') timer.unref();
    this.emptyRoomTimers.set(roomId, timer);
  }

  clearEmptyCleanup(roomId) {
    const timer = this.emptyRoomTimers.get(roomId);
    if (timer) {
      clearTimeout(timer);
      this.emptyRoomTimers.delete(roomId);
    }
  }

  issueAuthTicket(token, principal) {
    if (!this.getRoomByToken(token)) throw new Error('共同作業ルームが見つかりません。');
    for (const [storedTicket, entry] of this.authTickets) {
      if (entry.expiresAt < Date.now()) this.authTickets.delete(storedTicket);
    }
    const ticket = crypto.randomBytes(24).toString('base64url');
    this.authTickets.set(ticket, {
      token: String(token),
      principal: {...principal, collaborationAuthorized: true},
      expiresAt: Date.now() + TICKET_TTL_MS,
    });
    return ticket;
  }

  issueHostTicket(token, userId = null, {allowAnyAuthorized = false} = {}) {
    const room = this.getRoomByToken(token);
    if (!room || room.participants.size > 0) return null;
    if (!allowAnyAuthorized && room.hostId && Number(userId) !== room.hostId) return null;
    const ticket = crypto.randomBytes(24).toString('base64url');
    this.authTickets.set(ticket, {
      token: room.token,
      principal: {
        id: userId ? Number(userId) : null,
        isHost: true,
        collaborationAuthorized: true,
      },
      expiresAt: Date.now() + TICKET_TTL_MS,
    });
    return ticket;
  }

  consumeAuthTicket(token, ticket) {
    const entry = this.authTickets.get(String(ticket || ''));
    if (!entry) return null;
    this.authTickets.delete(String(ticket));
    if (entry.token !== String(token) || entry.expiresAt < Date.now()) {
      return null;
    }
    return entry.principal;
  }

  createRoom({
    hostId = null,
    title = '',
    context = null,
    accessMode = 'private',
    allowAnonymous = true,
    invitedUserIds = [],
    storageType = 'local',
    cloudProjectId = null,
  } = {}) {
    if (this.rooms.size >= this.maxRooms) throw new Error('共同作業ルームを作成できません。時間を置いて、もう一度お試しください。');
    const normalizedMode = ACCESS_MODES.has(String(accessMode).toLowerCase()) ? String(accessMode).toLowerCase() : null;
    if (!normalizedMode) throw new Error('共同作業の公開範囲が正しくありません。');
    if (!['local', 'cloud'].includes(storageType)) throw new Error('共同作業の保存場所が正しくありません。');
    const roomId = crypto.randomUUID();
    const token = crypto.randomBytes(ROOM_TOKEN_BYTES).toString('base64url');
    const hostTicket = crypto.randomBytes(24).toString('base64url');
    const controlToken = crypto.randomBytes(24).toString('base64url');
    const room = {
      id: roomId,
      token,
      title: String(title || ''),
      hostId: hostId ? Number(hostId) : null,
      currentHostParticipantId: null,
      accessMode: normalizedMode,
      allowAnonymous: Boolean(allowAnonymous),
      invitedUserIds: userIds(invitedUserIds),
      accessRequests: [],
      controlTokenHash: hashSecret(controlToken),
      storageType,
      cloudProjectId: cloudProjectId ? String(cloudProjectId) : null,
      context: cleanContext(context),
      createdAt: new Date().toISOString(),
      participants: new Map(),
    };
    this.rooms.set(roomId, room);
    this.roomsByToken.set(token, room);
    if (room.context) this.roomsByContext.set(room.context, room);
    this.scheduleEmptyCleanup(roomId);
    this.authTickets.set(hostTicket, {
      token,
      principal: {id: room.hostId, isHost: true, collaborationAuthorized: true},
      expiresAt: Date.now() + TICKET_TTL_MS,
    });
    return {
      room_id: room.id,
      token: room.token,
      host_ticket: hostTicket,
      control_token: controlToken,
      access_mode: room.accessMode,
      allow_anonymous: room.allowAnonymous,
      storage_type: room.storageType,
      cloud_project_id: room.cloudProjectId,
    };
  }

  updatePolicy(token, {accessMode, allowAnonymous, invitedUserIds} = {}) {
    const room = this.getRoomByToken(token);
    if (!room) throw new Error('共同作業ルームが見つかりません。');
    if (accessMode !== undefined) {
      const mode = String(accessMode || '').toLowerCase();
      if (!ACCESS_MODES.has(mode)) throw new Error('共同作業の公開範囲が正しくありません。');
      room.accessMode = mode;
    }
    if (allowAnonymous !== undefined) room.allowAnonymous = Boolean(allowAnonymous);
    if (invitedUserIds !== undefined) room.invitedUserIds = userIds(invitedUserIds);
    return this.describe(room.token);
  }

  verifyControlToken(room, controlToken) {
    return Boolean(room?.controlTokenHash && controlToken && safeEqual(room.controlTokenHash, hashSecret(controlToken)));
  }

  localAccess(room, principal, {requestId = '', requestKey = '', controlToken = ''} = {}) {
    if (!room || room.storageType !== 'local') return {granted: false, reason: 'missing'};
    if (this.verifyControlToken(room, controlToken)) return {granted: true, reason: 'owner', isHost: true};
    const id = Number(principal?.id);
    const authenticated = Number.isInteger(id) && id > 0;
    if (authenticated && (Number(room.hostId) === id || room.invitedUserIds.includes(id))) {
      return {granted: true, reason: Number(room.hostId) === id ? 'owner' : 'invited'};
    }
    const request = room.accessRequests.find((candidate) => {
      if (candidate.status !== 'approved') return false;
      if (authenticated) return Number(candidate.userId) === id;
      return candidate.id === String(requestId || '') && candidate.secretHash && safeEqual(candidate.secretHash, hashSecret(requestKey));
    });
    if (request && (authenticated || room.allowAnonymous)) return {granted: true, reason: 'approved'};
    if (!authenticated && !room.allowAnonymous) return {granted: false, reason: 'auth-required', requiresAuth: true};
    if (room.accessMode === 'private') return {granted: true, reason: 'link'};
    const pending = room.accessRequests.find((candidate) => (
      candidate.status === 'pending' && (authenticated
        ? Number(candidate.userId) === id
        : candidate.id === String(requestId || '') && candidate.secretHash && safeEqual(candidate.secretHash, hashSecret(requestKey)))
    ));
    return {granted: false, reason: pending ? 'pending' : 'request-required', canRequest: true, request: pending || null};
  }

  createLocalAccessRequest(token, principal, {name = ''} = {}) {
    const room = this.getRoomByToken(token);
    if (!room || room.storageType !== 'local') throw new Error('共同作業ルームが見つかりません。');
    if (room.accessMode !== 'invite') throw new Error('この共同作業に参加申請は必要ありません。');
    const userId = Number(principal?.id) || null;
    if (!userId && !room.allowAnonymous) {
      const error = new Error('参加申請にはNyaitterIDでログインしてください。');
      error.statusCode = 401;
      error.code = 'AUTH_REQUIRED';
      throw error;
    }
    const existing = userId ? room.accessRequests.find((request) => (
      Number(request.userId) === userId && ['pending', 'approved'].includes(request.status)
    )) : null;
    if (existing) return {request_id: existing.id, status: existing.status, granted: existing.status === 'approved'};
    const requestKey = userId ? null : crypto.randomBytes(24).toString('base64url');
    const request = {
      id: crypto.randomUUID(),
      userId,
      name: cleanName(name) || (userId ? `#${userId}` : '匿名ユーザー'),
      secretHash: requestKey ? hashSecret(requestKey) : null,
      status: 'pending',
      createdAt: new Date().toISOString(),
      decidedAt: null,
    };
    room.accessRequests.push(request);
    return {request_id: request.id, request_key: requestKey, status: request.status, granted: false, created: true};
  }

  localAccessRequestStatus(token, principal, {requestId, requestKey} = {}) {
    const room = this.getRoomByToken(token);
    if (!room || room.storageType !== 'local') throw new Error('共同作業ルームが見つかりません。');
    const request = room.accessRequests.find((candidate) => candidate.id === String(requestId || ''));
    const userId = Number(principal?.id) || null;
    const owned = request && (userId
      ? Number(request.userId) === userId
      : request.secretHash && safeEqual(request.secretHash, hashSecret(requestKey)));
    if (!owned) throw new Error('参加申請が見つかりません。');
    return {request_id: request.id, status: request.status, granted: request.status === 'approved'};
  }

  localAccessManagement(token, principal, controlToken) {
    const room = this.getRoomByToken(token);
    if (!room || room.storageType !== 'local') throw new Error('共同作業ルームが見つかりません。');
    const userId = Number(principal?.id) || null;
    if (!this.verifyControlToken(room, controlToken) && (!userId || Number(room.hostId) !== userId)) {
      const error = new Error('共同作業の設定を変更できるのはホストだけです。');
      error.statusCode = 403;
      throw error;
    }
    return {
      access_mode: room.accessMode,
      allow_anonymous: room.allowAnonymous,
      invited_user_ids: [...room.invitedUserIds],
      requests: room.accessRequests.map((request) => ({
        id: request.id,
        user_id: request.userId,
        name: request.name,
        status: request.status,
        created_at: request.createdAt,
      })),
    };
  }

  decideLocalAccessRequest(token, principal, controlToken, requestId, decision) {
    const room = this.getRoomByToken(token);
    this.localAccessManagement(token, principal, controlToken);
    const request = room.accessRequests.find((candidate) => candidate.id === String(requestId || ''));
    if (!request) throw new Error('参加申請が見つかりません。');
    const status = decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : null;
    if (!status) throw new Error('参加申請の操作が正しくありません。');
    request.status = status;
    request.decidedAt = new Date().toISOString();
    if (request.status === 'approved' && request.userId) {
      room.invitedUserIds = userIds([...room.invitedUserIds, request.userId]);
    }
    return {request_id: request.id, status: request.status};
  }

  getRoomByToken(token) {
    const value = String(token || '');
    return this.roomsByToken.get(value) || null;
  }

  getRoom(roomId) {
    return this.rooms.get(String(roomId)) || null;
  }

  join(token, { userId = null, guestName = null, authenticated = false, authorized = false, isHost: principalIsHost = false, hasAccess: principalHasAccess = false, accessReason = null, socket = null } = {}) {
    const room = this.getRoomByToken(token);
    if (!room) throw new Error('共同作業の招待URLが無効か期限切れです。新しいURLを作成してください。');
    if (!authorized) throw new Error('共同作業への参加が許可されていません。');
    if (room.participants.size >= this.maxParticipants) throw new Error('共同作業の参加人数が上限に達しています。');

    this.clearEmptyCleanup(room.id);

    const hasHost = room.currentHostParticipantId && room.participants.has(room.currentHostParticipantId);
    let isHost = Boolean(principalIsHost);
    if (room.isServerVm || room.currentHostParticipantId === 'server-vm') {
      isHost = false;
    } else {
      if (!hasHost && authenticated && room.hostId && Number(userId) === room.hostId) isHost = true;
      if (!hasHost && room.participants.size === 0 && (!room.hostId || (authenticated && Number(userId) === room.hostId))) {
        isHost = true;
      }
    }

    const participantId = isHost
      ? (userId ? `user-${userId}` : `host-${crypto.randomBytes(4).toString('hex')}`)
      : crypto.randomUUID();

    const hasAccess = Boolean(principalHasAccess || isHost || (authenticated && room.hostId && Number(userId) === Number(room.hostId)) || (authenticated && room.invitedUserIds && room.invitedUserIds.includes(Number(userId))));

    const participant = {
      id: participantId,
      user_id: authenticated && userId ? Number(userId) : null,
      name: cleanName(guestName) || (isHost ? (userId ? `#${userId}` : 'ホスト') : 'ゲスト'),
      role: isHost ? 'host' : 'guest',
      hasAccess,
      accessReason: accessReason || (isHost ? 'host' : null),
      socket,
      joinedAt: new Date().toISOString(),
    };

    if (isHost) {
      // Split-brain防止: 既存の他ホスト（代理昇格されていた参加者等）をゲストに降格し、部屋に唯一のホストのみを保証
      for (const p of room.participants.values()) {
        if (p.id !== participantId && p.role === 'host') {
          p.role = 'guest';
        }
      }
      const previousHostId = room.currentHostParticipantId;
      room.currentHostParticipantId = participantId;
      if (previousHostId && previousHostId !== participantId) {
        this.broadcast(room.id, null, {
          type: 'collaboration_host_changed',
          new_host_id: participantId,
          new_host_name: participant.name,
        });
      }
    }

    const previous = room.participants.get(participantId);
    if (previous?.socket && previous.socket !== socket) {
      try { previous.socket.close(4009, '同じ参加者が再接続しました'); } catch (_) {}
    }
    room.participants.set(participantId, participant);
    return { room, participant, replaced: Boolean(previous) };
  }

  leave(roomId, participantId) {
    const room = this.getRoom(roomId);
    if (!room) return false;
    const participant = room.participants.get(String(participantId));
    if (!participant) return false;

    const wasHost = participant.role === 'host' || room.currentHostParticipantId === String(participantId);
    room.participants.delete(String(participantId));

    if (room.participants.size === 0) {
      this.closeRoom(room.id);
      return true;
    }

    // 非クラウドプロジェクトでホストが退出した場合、セッションを終了する
    if (room.storageType === 'local' && wasHost) {
      this.broadcast(room.id, null, {
        type: 'collaboration_closed',
        reason: 'host_left',
        message: 'ホストが退出したため、共同作業セッションが終了しました。',
      });
      this.closeRoom(room.id);
      return true;
    }

    // クラウドプロジェクトですべてのアクセス権のあるユーザーが退出した場合、セッションを終了する
    if (room.storageType === 'cloud') {
      const remainingParticipants = [...room.participants.values()];
      const hasPermittedUser = remainingParticipants.some((p) => {
        if (p.isServerVm || p.id === 'server-vm') return false;
        if (p.hasAccess) return true;
        if (p.role === 'host') return true;
        if (room.hostId && p.user_id && Number(p.user_id) === Number(room.hostId)) return true;
        if (room.invitedUserIds && p.user_id && room.invitedUserIds.includes(Number(p.user_id))) return true;
        return false;
      });

      if (!hasPermittedUser) {
        this.broadcast(room.id, null, {
          type: 'collaboration_closed',
          reason: 'permitted_users_left',
          message: 'アクセス権のあるユーザーが全員退出したため、共同作業セッションが終了しました。',
        });
        if (typeof this.onCloudRoomShouldClose === 'function') {
          this.onCloudRoomShouldClose(room, 'permitted_users_left');
        } else {
          this.closeRoom(room.id);
        }
        return true;
      }
    }

    // ホストが退出した場合の処理（クラウドプロジェクトで権限保持者が残っている場合）
    if (wasHost && !room.isServerVm) {
      const nextHost = [...room.participants.values()].find((p) => {
        if (p.hasAccess) return true;
        if (room.hostId && p.user_id && Number(p.user_id) === Number(room.hostId)) return true;
        if (room.invitedUserIds && p.user_id && room.invitedUserIds.includes(Number(p.user_id))) return true;
        return false;
      }) || [...room.participants.values()][0];

      if (nextHost) {
        nextHost.role = 'host';
        room.currentHostParticipantId = nextHost.id;
        this.broadcast(room.id, null, {
          type: 'collaboration_host_changed',
          new_host_id: nextHost.id,
          new_host_name: nextHost.name,
        });
      } else {
        room.currentHostParticipantId = null;
        this.broadcast(room.id, null, {
          type: 'collaboration_host_changed',
          new_host_id: null,
          new_host_name: null,
        });
      }
    }

    this.broadcast(room.id, null, {
      type: 'collaboration_participant_left',
      participant_id: String(participantId),
    });

    return true;
  }

  renameParticipant(roomId, participantId, name) {
    const room = this.getRoom(roomId);
    if (!room) return null;
    const participant = room.participants.get(String(participantId));
    if (!participant || participant.user_id) return null;
    const cleaned = cleanName(name);
    if (!cleaned) return null;
    participant.name = cleaned;
    return cleaned;
  }

  closeRoom(roomId) {
    this.clearEmptyCleanup(roomId);
    const room = this.getRoom(roomId);
    if (!room) return false;
    for (const participant of room.participants.values()) {
      try { participant.socket?.close(1000, '共同作業ルームが終了しました'); } catch (_) {}
    }
    this.rooms.delete(room.id);
    this.roomsByToken.delete(room.token);
    if (room.context && this.roomsByContext.get(room.context) === room) this.roomsByContext.delete(room.context);
    for (const [ticket, entry] of this.authTickets) {
      if (entry.token === room.token) this.authTickets.delete(ticket);
    }
    return true;
  }

  participantList(room) {
    return [...room.participants.values()].map(({ socket, ...participant }) => participant);
  }

  getRoomByContext(context) {
    const normalized = cleanContext(context);
    if (!normalized) return null;
    return this.roomsByContext.get(normalized) || null;
  }

  stats() {
    let activeRoomsCount = 0;
    let activeEditorsCount = 0;
    for (const room of this.rooms.values()) {
      if (room.participants.size === 0) continue;
      activeRoomsCount += 1;
      activeEditorsCount += room.participants.size;
    }
    return {activeRoomsCount, activeEditorsCount};
  }

  broadcast(roomId, senderId, packet) {
    const room = this.getRoom(roomId);
    if (!room) return 0;
    const excludedId = senderId ? String(senderId) : null;
    const recipients = [];
    for (const participant of room.participants.values()) {
      if (participant.id !== excludedId && participant.socket?.readyState === 1) recipients.push(participant.socket);
    }
    if (!recipients.length) return 0;
    const serialized = JSON.stringify(packet);
    if (Buffer.byteLength(serialized) > MAX_MESSAGE_BYTES) throw new Error('共同作業で送信できる情報のサイズを超えています。');
    let delivered = 0;
    for (const socket of recipients) {
      try { socket.send(serialized); delivered += 1; } catch (_) {}
    }
    return delivered;
  }

  notifyAccessRequest(room, ownerId = null) {
    if (!room) return;
    const packet = JSON.stringify({type: 'collaboration_access_requested'});
    for (const participant of room.participants.values()) {
      const isOwner = participant.user_id && Number(participant.user_id) === Number(ownerId || room.hostId);
      if ((participant.role === 'host' || isOwner) && participant.socket?.readyState === 1) {
        try { participant.socket.send(packet); } catch (_) {}
      }
    }
  }

  signal(roomId, senderId, message) {
    const room = this.getRoom(roomId);
    if (!room || !ALLOWED_SIGNAL_TYPES.has(message?.type)) return 0;
    const sender = room.participants.get(String(senderId));
    if (!sender) return 0;
    const targetId = String(message.to || '');
    const target = room.participants.get(targetId);
    if (!target || target.id === sender.id || target.socket?.readyState !== 1) return 0;

    // WebSocketはWebRTCの接続確立に必要なSDP/ICEだけを運ぶ。
    // VMスナップショット・編集・チャットなどのデータはここへ渡さない。
    const signal = {type: message.type, to: targetId};
    if (message.type === 'ice') signal.candidate = message.candidate;
    else signal.sdp = message.sdp;
    const serialized = JSON.stringify({
      type: 'collaboration_signal',
      from: String(senderId),
      message: signal,
    });
    if (Buffer.byteLength(serialized) > MAX_MESSAGE_BYTES) throw new Error('共同作業で送信できる情報のサイズを超えています。');
    try {
      target.socket.send(serialized);
      return 1;
    } catch (_) {
      return 0;
    }
  }

  describe(token) {
    const room = this.getRoomByToken(token);
    if (!room) return null;
    return {
      room_id: room.id,
      token: room.token,
      title: room.title,
      access_mode: room.accessMode,
      allow_anonymous: room.allowAnonymous,
      storage_type: room.storageType,
      cloud_project_id: room.cloudProjectId,
      is_server_vm: Boolean(room.isServerVm),
      host_id: room.hostId,
      current_host_id: room.currentHostParticipantId,
      participants: this.participantList(room),
      created_at: room.createdAt,
    };
  }
}

module.exports = { CollaborationRoomManager, MAX_MESSAGE_BYTES };
