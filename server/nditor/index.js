'use strict';

const express = require('express');
const {WebSocketServer} = require('ws');
const NditorStorageAdapter = require('./storage');
const NyaitterApiClient = require('./NyaitterApiClient');
const {CloudProjectService} = require('./services/CloudProjectService');
const {ServerProjectVmManager} = require('./services/ServerProjectVmManager');
const {CollaborationRoomManager} = require('./services/realtime/CollaborationRoomManager');

const MAX_WEBSOCKET_MESSAGE_BYTES = 64 * 1024 * 1024;

function rejectUpgrade(socket, statusCode, reason) {
  try {
    socket.write(`HTTP/1.1 ${statusCode} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } finally {
    socket.destroy();
  }
}

function requestOrigin(request) {
  const protocol = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https'
    ? 'https'
    : (request.socket.encrypted ? 'https' : 'http');
  const host = String(request.headers['x-forwarded-host'] || request.headers.host || '')
    .split(',')[0]
    .trim();
  return host ? `${protocol}://${host}` : '';
}

function allowedOrigin(request) {
  const origin = String(request.headers.origin || '').trim();
  if (!origin) return true;
  try {
    return new URL(origin).origin === requestOrigin(request);
  } catch (_) {
    return false;
  }
}

function createNditorApi({nyaitterApiClient = new NyaitterApiClient()} = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.locals.nyaitterApiClient = nyaitterApiClient;
  app.locals.storageAdapter = new NditorStorageAdapter();
  app.locals.userDirectory = nyaitterApiClient;
  app.locals.cloudProjectService = new CloudProjectService({
    userDirectory: app.locals.userDirectory,
    storageAdapter: app.locals.storageAdapter,
  });
  app.locals.collaborationRooms = new CollaborationRoomManager();
  app.locals.serverVmManager = new ServerProjectVmManager({
    cloudProjectService: app.locals.cloudProjectService,
    collaborationRooms: app.locals.collaborationRooms,
  });

  app.use(express.json({limit: '2mb'}));
  app.use(express.urlencoded({extended: false, limit: '2mb', parameterLimit: 100}));
  app.use('/api/nditor/cloud-projects', require('./routes/nditorCloudProjects'));
  app.use('/api/nditor/collaboration', require('./routes/nditorCollaboration'));
  app.use((request, response) => response.status(404).json({error: 'APIエンドポイントが見つかりません。'}));

  const rooms = app.locals.collaborationRooms;
  const vmManager = app.locals.serverVmManager;
  rooms.onCloudRoomShouldClose = async (room) => {
    try {
      if (room.cloudProjectId) await vmManager.saveAndStop(room.cloudProjectId);
    } catch (error) {
      console.warn('[nditor-vm] Cloud session close failed:', error.message);
    } finally {
      rooms.closeRoom(room.id);
    }
  };

  const websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WEBSOCKET_MESSAGE_BYTES,
    perMessageDeflate: false,
  });
  const upgradeAttempts = new Map();
  const heartbeat = setInterval(() => {
    for (const socket of websocketServer.clients) {
      if (socket.isAlive === false || socket.readyState !== 1) {
        try { socket.terminate(); } catch (_) {}
        continue;
      }
      socket.isAlive = false;
      try { socket.ping(); } catch (_) { try { socket.terminate(); } catch (_) {} }
    }
  }, 30000);
  heartbeat.unref();

  websocketServer.on('connection', (socket, connection) => {
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });
    let membership = null;
    const leave = () => {
      if (!membership) return;
      rooms.leave(membership.room.id, membership.participant.id, socket);
      membership = null;
    };
    socket.on('message', (rawMessage, isBinary) => {
      if (isBinary) return socket.close(1003, 'Binary messages are not supported');
      try {
        const message = JSON.parse(rawMessage.toString());
        if (!membership && message?.type === 'collaboration_join') {
          membership = rooms.join(connection.token, {
            userId: connection.principal?.id,
            guestName: message.guest_name,
            authenticated: Boolean(connection.principal?.id),
            authorized: Boolean(connection.principal?.collaborationAuthorized),
            isHost: Boolean(connection.principal?.isHost),
            hasAccess: Boolean(connection.principal?.hasAccess || connection.principal?.isHost),
            accessReason: connection.principal?.accessReason || null,
            socket,
          });
          socket.send(JSON.stringify({
            type: 'collaboration_joined',
            participant: {...membership.participant, socket: undefined},
            participants: rooms.participantList(membership.room),
            room: rooms.describe(membership.room.token),
          }));
          rooms.broadcast(membership.room.id, membership.participant.id, {
            type: 'collaboration_participant_joined',
            participant: {...membership.participant, socket: undefined},
          });
          return;
        }
        if (!membership) return socket.close(4001, 'Join required');
        if (message?.type === 'collaboration_message' && message.message) {
          vmManager.handleClientMessage(membership.room.id, membership.participant.id, message.message, rawMessage.length);
        } else if (message?.type === 'collaboration_signal' && message.message) {
          rooms.signal(membership.room.id, membership.participant.id, message.message);
        } else if (message?.type === 'collaboration_rename' && message.name) {
          const updatedName = rooms.renameParticipant(membership.room.id, membership.participant.id, message.name);
          if (updatedName) {
            membership.participant.name = updatedName;
            rooms.broadcast(membership.room.id, null, {
              type: 'collaboration_participant_renamed',
              participant_id: membership.participant.id,
              name: updatedName,
            });
          }
        } else if (message?.type === 'collaboration_close' && membership.participant.role === 'host') {
          rooms.closeRoom(membership.room.id);
        }
      } catch (error) {
        try { socket.send(JSON.stringify({type: 'collaboration_error', error: error.message})); } catch (_) {}
      }
    });
    socket.on('close', leave);
    socket.on('error', leave);
  });

  async function handleUpgrade(request, socket, head) {
    let parsedUrl;
    try {
      parsedUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    } catch (_) {
      return rejectUpgrade(socket, 400, 'Bad Request');
    }
    if (parsedUrl.pathname !== '/api/nditor/collaboration') return socket.destroy();
    if (!allowedOrigin(request)) return rejectUpgrade(socket, 403, 'Forbidden');

    const ip = request.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    const attempt = upgradeAttempts.get(ip) || {count: 0, resetAt: now + 60000};
    if (now >= attempt.resetAt) {
      attempt.count = 0;
      attempt.resetAt = now + 60000;
    }
    attempt.count += 1;
    upgradeAttempts.set(ip, attempt);
    if (upgradeAttempts.size > 10000) upgradeAttempts.delete(upgradeAttempts.keys().next().value);
    if (attempt.count > 60) return rejectUpgrade(socket, 429, 'Too Many Requests');

    const token = parsedUrl.searchParams.get('token');
    if (!token) return rejectUpgrade(socket, 401, 'Unauthorized');
    const principal = rooms.consumeAuthTicket(token, parsedUrl.searchParams.get('ticket'));
    const room = rooms.getRoomByToken(token);
    if (!room) return rejectUpgrade(socket, 404, 'Not Found');
    if (!principal?.collaborationAuthorized) return rejectUpgrade(socket, 403, 'Forbidden');
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      websocketServer.emit('connection', websocket, {token, principal});
    });
  }

  return {
    app,
    async initialize() {
      await app.locals.cloudProjectService.initialize();
    },
    handleUpgrade,
    async stop() {
      clearInterval(heartbeat);
      for (const socket of websocketServer.clients) {
        try { socket.terminate(); } catch (_) {}
      }
      await app.locals.serverVmManager.stopAll();
      await new Promise((resolve) => websocketServer.close(() => resolve()));
    },
  };
}

module.exports = {createNditorApi};
