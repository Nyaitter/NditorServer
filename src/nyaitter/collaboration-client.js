/* eslint-disable arrow-parens, brace-style, max-len, no-empty, no-negated-condition, no-undefined */
import {getCollaborationTicket, getCollaborationWebSocketUrl} from './collaboration-api.js';

const DATA_TYPES = new Set([
    'project_request',
    'project_snapshot',
    'operation_request',
    'operation_commit',
    'runtime_command',
    'runtime_input',
    'runtime_state',
    'runtime_report',
    'runtime_sound',
    'runtime_sound_stop',
    'runtime_sound_stop_all',
    'runtime_question',
    'runtime_question_input',
    'chat',
    'chat_typing',
    'presence',
    'block_input_preview',
    'paint_preview'
]);
const RELAY_TYPES = new Set(['chat', 'chat_typing', 'presence', 'block_input_preview', 'paint_preview']);
const GUEST_MESSAGE_TYPES = new Set([
    'project_request',
    'operation_request',
    'runtime_command',
    'runtime_input',
    'chat',
    'chat_typing',
    'presence',
    'block_input_preview',
    'paint_preview'
]);
const HOST_MESSAGE_TYPES = new Set([
    'project_snapshot',
    'operation_commit',
    'runtime_state',
    'runtime_report',
    'runtime_sound',
    'runtime_sound_stop',
    'runtime_sound_stop_all',
    'runtime_question',
    'runtime_question_input',
    'chat',
    'chat_typing',
    'presence',
    'block_input_preview',
    'paint_preview'
]);
const SIGNAL_TYPES = new Set(['offer', 'answer', 'ice']);
const CHUNK_BYTES = 12000;
const MAX_TRANSFER_CHARS = 64 * 1024 * 1024;
const MAX_INCOMING_TRANSFERS = 64;
const BUFFER_HIGH_WATER = 512 * 1024;
const BUFFER_LOW_WATER = 128 * 1024;
const MAX_PAINT_FRAME_CHARS = 320000;
const createMessageId = () => `${Date.now()}-${Math.random().toString(36)
    .slice(2, 10)}`;

class CollaborationClient {
    constructor ({token, hostTicket = null, guestName = '', onEvent = () => {}}) {
        this.token = token;
        this.host = false;
        this.hostTicket = hostTicket;
        this.guestName = String(guestName || '').trim()
            .slice(0, 40);
        this.onEvent = onEvent;
        this.socket = null;
        this.participantId = null;
        this.room = null;
        this.peers = new Map();
        this.incomingChunks = new Map();
        this.closed = false;
        this.isServerHosted = false;
        this.reconnectTimer = null;
        this.reconnectAttempts = 0;
        this.seenMessageIds = new Set();
        this.pendingSignals = [];
        this.pendingIceByPeer = new Map();
        this.localStream = null;
    }

    connect () {
        void this.openSocket();
        return this;
    }

    async openSocket () {
        try {
            const url = new URL(getCollaborationWebSocketUrl(this.token));
            let ticket = this.hostTicket;
            if (!ticket) {
                try {
                    ticket = await getCollaborationTicket(this.token);
                } catch (error) {
                    this.onEvent({type: 'access_error', message: error.message, code: error.code});
                    return;
                }
            }
            if (!ticket) throw new Error('共同作業の接続券を取得できませんでした。');
            url.searchParams.set('ticket', ticket);
            this.hostTicket = null;

            const socket = new WebSocket(url.href);
            this.socket = socket;
            socket.addEventListener('open', () => {
                const reconnected = this.reconnectAttempts > 0;
                this.reconnectAttempts = 0;
                this.sendSocket({type: 'collaboration_join', guest_name: this.guestName});
                if (reconnected) this.onEvent({type: 'reconnected'});
            });
            socket.addEventListener('message', event => {
                try {
                    void this.handlePacket(JSON.parse(event.data));
                } catch (_) {
                    this.onEvent({type: 'error', message: '共同作業の情報を読み込めませんでした。'});
                }
            });
            socket.addEventListener('close', event => {
                if (this.socket !== socket) return;
                this.socket = null;
                if (this.closed || event?.code === 1000) {
                    this.closed = true;
                    this.onEvent({type: 'closed', reason: event?.reason});
                    return;
                }
                this.scheduleReconnect();
            });
            socket.addEventListener('error', () => {});
        } catch (error) {
            this.onEvent({type: 'error', message: error.message || '共同作業に接続できませんでした。'});
            this.scheduleReconnect();
        }
    }

    scheduleReconnect () {
        if (this.closed) return;
        this.onEvent({type: 'reconnecting', attempt: this.reconnectAttempts + 1});
        const delay = Math.min(1000 * Math.pow(1.5, this.reconnectAttempts), 10000);
        this.reconnectAttempts += 1;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => void this.openSocket(), delay);
    }

    sendSocket (value) {
        if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(value));
    }

    async handlePacket (packet) {
        if (packet?.type === 'collaboration_closed') {
            this.closed = true;
            this.onEvent({
                type: 'collaboration_closed',
                reason: packet.reason,
                message: packet.message || '共同作業セッションが終了しました。'
            });
            this.close();
            return;
        }
        if (packet?.type === 'collaboration_error') {
            this.onEvent({type: 'error', message: packet.error});
            return;
        }
        if (packet?.type === 'collaboration_message') {
            const msg = packet.message;
            if (msg) {
                this.handleDataMessage(msg, msg.senderId || 'server-vm');
            }
            return;
        }
        if (packet?.type === 'collaboration_joined') {
            for (const id of [...this.peers.keys()]) this.closePeer(id);
            this.incomingChunks.clear();
            this.pendingSignals = [];
            this.pendingIceByPeer.clear();
            this.participantId = packet.participant?.id || null;
            this.host = packet.participant?.role === 'host';
            this.room = packet.room || null;
            this.isServerHosted = Boolean(packet.room?.is_server_vm || packet.is_server_vm || packet.room?.current_host_id === 'server-vm');
            this.onEvent({...packet, host: this.host, participantId: this.participantId});
            if (this.host) {
                for (const participant of packet.participants || []) {
                    if (participant.id !== this.participantId && participant.id !== 'server-vm') await this.offerTo(participant.id);
                }
            }
            return;
        }
        if (packet?.type === 'collaboration_participant_joined') {
            if (this.room && packet.participant) {
                this.room.participants = [
                    ...(this.room.participants || []).filter(participant => participant.id !== packet.participant.id),
                    packet.participant
                ];
            }
            this.onEvent(packet);
            if (this.host && packet.participant?.id !== this.participantId && packet.participant?.id !== 'server-vm') await this.offerTo(packet.participant.id);
            return;
        }
        if (packet?.type === 'collaboration_participant_left') {
            if (this.room) {
                this.room.participants = (this.room.participants || [])
                    .filter(participant => participant.id !== packet.participant_id);
            }
            this.closePeer(packet.participant_id);
            this.onEvent(packet);
            return;
        }
        if (packet?.type === 'collaboration_participant_renamed') {
            if (this.room) {
                this.room.participants = (this.room.participants || []).map(participant => (
                    participant.id === packet.participant_id ? {...participant, name: packet.name} : participant
                ));
            }
            this.onEvent({type: 'participant_renamed', participantId: packet.participant_id, name: packet.name});
            return;
        }
        if (packet?.type === 'collaboration_host_changed') {
            this.host = packet.new_host_id === this.participantId;
            if (this.room) {
                this.room.current_host_id = packet.new_host_id || null;
                this.room.participants = (this.room.participants || []).map(participant => ({
                    ...participant,
                    role: participant.id === packet.new_host_id ? 'host' : 'guest'
                }));
            }
            this.onEvent({type: 'host_reassigned', isHost: this.host, newHostId: packet.new_host_id, newHostName: packet.new_host_name});
            if (this.host) {
                for (const participant of this.room?.participants || []) {
                    if (participant.id !== this.participantId) await this.offerTo(participant.id);
                }
            }
            return;
        }
        if (packet?.type !== 'collaboration_signal') {
            this.onEvent(packet);
            return;
        }
        const message = packet.message || {};
        if (!SIGNAL_TYPES.has(message.type)) return;
        if (message.type === 'offer') await this.acceptOffer(packet.from, message);
        else if (message.type === 'answer') await this.acceptAnswer(packet.from, message);
        else if (message.type === 'ice') await this.acceptIce(packet.from, message);
    }

    handleDataMessage (message, fromId) {
        if (message?.type === '__nyaitter_chunk__') {
            this.receiveChunk(message, fromId);
            return;
        }
        if (!message || !DATA_TYPES.has(message.type)) return;
        if (this.host && !GUEST_MESSAGE_TYPES.has(message.type)) return;
        if (!this.host && !HOST_MESSAGE_TYPES.has(message.type)) return;
        if (message.to && message.to !== this.participantId) return;
        if (message.id && this.seenMessageIds.has(message.id)) return;
        if (message.id) {
            this.seenMessageIds.add(message.id);
            if (this.seenMessageIds.size > 2000) this.seenMessageIds.delete(this.seenMessageIds.values().next().value);
        }
        const senderId = this.host ? fromId : (message.senderId || fromId);
        if (senderId === this.participantId) return;
        const normalizedMessage = {...message, senderId};
        this.onEvent({...normalizedMessage, from: senderId});
        if (this.host && RELAY_TYPES.has(message.type) && !message.to) {
            this.broadcast(normalizedMessage, fromId);
        }
    }

    receiveChunk (chunk, fromId) {
        const now = Date.now();
        for (const [key, value] of this.incomingChunks) {
            if (value.expiresAt < now) this.incomingChunks.delete(key);
        }
        const maximumChunks = Math.ceil(MAX_TRANSFER_CHARS / CHUNK_BYTES);
        if (!chunk.transferId || !Number.isInteger(chunk.index) || !Number.isInteger(chunk.total) ||
            chunk.total < 1 || chunk.total > maximumChunks || typeof chunk.payload !== 'string' ||
            chunk.payload.length > CHUNK_BYTES) return;
        const key = `${fromId}:${chunk.transferId}`;
        if (!this.incomingChunks.has(key) && this.incomingChunks.size >= MAX_INCOMING_TRANSFERS) {
            this.incomingChunks.delete(this.incomingChunks.keys().next().value);
        }
        const entry = this.incomingChunks.get(key) || {parts: new Array(chunk.total), received: 0, expiresAt: now + 60000};
        if (entry.parts.length !== chunk.total || chunk.index < 0 || chunk.index >= chunk.total) return;
        if (entry.parts[chunk.index] === undefined) {
            entry.parts[chunk.index] = chunk.payload;
            entry.received += 1;
        }
        this.incomingChunks.set(key, entry);
        if (entry.received !== chunk.total) return;
        this.incomingChunks.delete(key);
        let message;
        try {
            message = JSON.parse(entry.parts.join(''));
        } catch (_) {
            this.onEvent({type: 'error', message: '共同作業の分割データを復元できませんでした。'});
            return;
        }
        this.handleDataMessage(message, fromId);
    }

    peer (id) {
        const existing = this.peers.get(id);
        if (existing && existing.signalingState !== 'closed') return existing;
        if (existing) this.closePeer(id);
        const connection = new RTCPeerConnection({
            iceServers: [
                {urls: 'stun:stun.l.google.com:19302'},
                {urls: 'stun:global.stun.twilio.com:3478'}
            ]
        });
        connection.iceCandidateQueue = this.pendingIceByPeer.get(id) || [];
        this.pendingIceByPeer.delete(id);
        connection.onicecandidate = event => {
            if (event.candidate) this.signal(id, {type: 'ice', candidate: event.candidate});
        };
        connection.ontrack = event => {
            const stream = event.streams?.[0] || new MediaStream([event.track]);
            connection.nyaitterRemoteStream = stream;
            this.onEvent({type: 'runtime_stream', stream, from: id});
            const clearEndedStream = () => {
                if (stream.getTracks().some(track => track.readyState !== 'ended')) return;
                if (connection.nyaitterRemoteStream === stream) {
                    connection.nyaitterRemoteStream = null;
                    this.onEvent({type: 'runtime_stream', stream: null, from: id});
                }
            };
            event.track.addEventListener('ended', clearEndedStream);
            stream.addEventListener('removetrack', clearEndedStream);
        };
        connection.onconnectionstatechange = () => {
            if (!['failed', 'closed'].includes(connection.connectionState)) return;
            this.closePeer(id);
            if (this.host && !this.closed && this.room?.participants?.some(participant => participant.id === id)) {
                setTimeout(() => void this.offerTo(id), 500);
            }
        };
        this.peers.set(id, connection);
        this.syncLocalStream(connection);
        return connection;
    }

    syncLocalStream (connection) {
        const desiredTracks = this.localStream?.getTracks() || [];
        const desiredTrackIds = new Set(desiredTracks.map(track => track.id));
        let changed = false;
        connection.getSenders().forEach(sender => {
            if (sender.track && !desiredTrackIds.has(sender.track.id)) {
                connection.removeTrack(sender);
                changed = true;
            }
        });
        const senderTrackIds = new Set(connection.getSenders().map(sender => sender.track?.id));
        desiredTracks.forEach(track => {
            if (!senderTrackIds.has(track.id)) {
                connection.addTrack(track, this.localStream);
                changed = true;
            }
        });
        return changed;
    }

    setLocalStream (stream) {
        this.localStream = stream || null;
        for (const [id, connection] of this.peers) {
            if (this.syncLocalStream(connection) && this.host && connection.signalingState === 'stable') {
                void this.offerTo(id, true);
            }
        }
    }

    signal (to, message) {
        const signal = {type: 'collaboration_signal', message: {...message, to}};
        if (this.socket?.readyState === WebSocket.OPEN) this.sendSocket(signal);
        else this.pendingSignals.push(signal);
    }

    bindChannel (id, channel) {
        const connection = this.peers.get(id);
        if (connection) connection.nyaitterChannel = channel;
        channel.nyaitterQueue = [];
        channel.nyaitterQueueHead = 0;
        channel.bufferedAmountLowThreshold = BUFFER_LOW_WATER;
        channel.onbufferedamountlow = () => this.flushChannel(channel);
        channel.onopen = () => {
            this.flushChannel(channel);
            this.onEvent({type: 'peer_connected', participant_id: id});
        };
        channel.onmessage = event => {
            try {
                this.handleDataMessage(JSON.parse(event.data), id);
            } catch (_) {}
        };
        channel.onerror = () => {};
        channel.onclose = () => {
            clearTimeout(channel.nyaitterFlushTimer);
            channel.nyaitterQueue = [];
            channel.nyaitterQueueHead = 0;
        };
    }

    async offerTo (id, renegotiate = false) {
        try {
            const connection = this.peer(id);
            if (!connection.nyaitterChannel) {
                this.bindChannel(id, connection.createDataChannel('nyaitter-authoritative-session-v1', {ordered: true}));
            } else if (!renegotiate) {
                return;
            }
            if (connection.signalingState !== 'stable') return;
            const offer = await connection.createOffer();
            await connection.setLocalDescription(offer);
            this.signal(id, {type: 'offer', sdp: connection.localDescription});
        } catch (_) {}
    }

    async acceptOffer (id, message) {
        try {
            const connection = this.peer(id);
            connection.ondatachannel = event => this.bindChannel(id, event.channel);
            await connection.setRemoteDescription(message.sdp);
            await this.flushIceCandidates(connection);
            const answer = await connection.createAnswer();
            await connection.setLocalDescription(answer);
            this.signal(id, {type: 'answer', sdp: connection.localDescription});
        } catch (_) {}
    }

    async acceptAnswer (id, message) {
        try {
            const connection = this.peers.get(id);
            if (!connection) return;
            await connection.setRemoteDescription(message.sdp);
            await this.flushIceCandidates(connection);
        } catch (_) {}
    }

    async acceptIce (id, message) {
        const connection = this.peers.get(id);
        if (!message.candidate) return;
        if (!connection) {
            const pending = this.pendingIceByPeer.get(id) || [];
            if (pending.length < 256) pending.push(message.candidate);
            this.pendingIceByPeer.set(id, pending);
            return;
        }
        try {
            if (!connection.remoteDescription?.type) {
                connection.iceCandidateQueue.push(message.candidate);
            } else {
                await connection.addIceCandidate(message.candidate);
            }
        } catch (_) {}
    }

    async flushIceCandidates (connection) {
        const candidates = connection.iceCandidateQueue.splice(0);
        for (const candidate of candidates) {
            try {
                await connection.addIceCandidate(candidate);
            } catch (_) {}
        }
    }

    queueChannelMessage (channel, message, serialized = JSON.stringify(message)) {
        if (serialized.length > MAX_TRANSFER_CHARS) {
            this.onEvent({type: 'error', message: '共同作業で送信する変更が大きすぎます。'});
            return false;
        }
        if (serialized.length <= CHUNK_BYTES) {
            channel.nyaitterQueue.push(serialized);
        } else {
            const total = Math.ceil(serialized.length / CHUNK_BYTES);
            for (let index = 0; index < total; index++) {
                channel.nyaitterQueue.push(JSON.stringify({
                    type: '__nyaitter_chunk__',
                    transferId: message.id,
                    index,
                    total,
                    payload: serialized.slice(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES)
                }));
            }
        }
        this.flushChannel(channel);
        return true;
    }

    flushChannel (channel) {
        clearTimeout(channel.nyaitterFlushTimer);
        if (channel.readyState !== 'open') return;
        let head = channel.nyaitterQueueHead || 0;
        while (head < channel.nyaitterQueue.length && channel.bufferedAmount < BUFFER_HIGH_WATER) {
            try {
                channel.send(channel.nyaitterQueue[head]);
                channel.nyaitterQueue[head++] = null;
            } catch (_) {
                break;
            }
        }
        if (head === channel.nyaitterQueue.length) {
            channel.nyaitterQueue.length = 0;
            head = 0;
        } else if (head >= 1024 && head >= channel.nyaitterQueue.length / 2) {
            channel.nyaitterQueue.splice(0, head);
            head = 0;
        }
        channel.nyaitterQueueHead = head;
        if (head < channel.nyaitterQueue.length) {
            channel.nyaitterFlushTimer = setTimeout(() => this.flushChannel(channel), 25);
        }
    }

    broadcast (message, excludedParticipantId = null) {
        if (!message || !DATA_TYPES.has(message.type)) return false;
        const packet = {
            ...message,
            id: message.id || createMessageId(),
            senderId: message.senderId || this.participantId || undefined,
            timestamp: message.timestamp || Date.now()
        };
        if (this.isServerHosted) {
            this.sendSocket({type: 'collaboration_message', message: packet});
            return true;
        }
        let delivered = 0;
        let serialized = null;
        for (const [id, connection] of this.peers) {
            const channel = connection.nyaitterChannel;
            if (channel?.readyState !== 'open' || id === excludedParticipantId || (packet.to && packet.to !== id)) continue;
            try {
                if (serialized === null) serialized = JSON.stringify(packet);
                if (this.queueChannelMessage(channel, packet, serialized)) delivered += 1;
            } catch (_) {}
        }
        return delivered > 0;
    }

    hostParticipantId () {
        if (this.isServerHosted) return 'server-vm';
        return this.room?.current_host_id || this.room?.participants?.find(participant => participant.role === 'host')?.id || null;
    }

    requestProject () {
        return this.broadcast({type: 'project_request', to: this.hostParticipantId()});
    }

    sendProjectSnapshot (snapshot, sequence, to) {
        return this.broadcast({type: 'project_snapshot', snapshot, sequence, to});
    }

    sendOperationRequest (operation, operationId = createMessageId()) {
        const delivered = this.broadcast({
            type: 'operation_request',
            operation,
            operationId,
            to: this.hostParticipantId()
        });
        return delivered ? operationId : null;
    }

    sendOperationCommit (operation, sequence, operationId, originParticipantId) {
        return this.broadcast({
            operation,
            type: 'operation_commit',
            sequence,
            operationId,
            originParticipantId
        });
    }

    sendRuntimeCommand (command, args = {}) {
        return this.broadcast({type: 'runtime_command', command, args, to: this.hostParticipantId()});
    }

    sendRuntimeInput (device, data) {
        return this.broadcast({type: 'runtime_input', device, data, to: this.hostParticipantId()});
    }

    sendRuntimeState (state, to = null) {
        return this.broadcast({type: 'runtime_state', state, to});
    }

    sendRuntimeReport (report, to) {
        return this.broadcast({type: 'runtime_report', report, to});
    }

    sendRuntimeSound (targetId, soundId) {
        return this.broadcast({type: 'runtime_sound', targetId, soundId});
    }

    sendRuntimeSoundStop (targetId, soundId) {
        return this.broadcast({type: 'runtime_sound_stop', targetId, soundId});
    }

    sendRuntimeSoundStopAll () {
        return this.broadcast({type: 'runtime_sound_stop_all'});
    }

    sendRuntimeQuestion (question) {
        return this.broadcast({type: 'runtime_question', question});
    }

    sendRuntimeQuestionInput (text) {
        return this.broadcast({type: 'runtime_question_input', text});
    }

    sendChat (text, senderName, presence = null) {
        const packet = {
            type: 'chat',
            id: createMessageId(),
            timestamp: Date.now(),
            text: String(text || '').trim()
                .slice(0, 1000),
            sender: String(senderName || this.guestName || 'ゲスト'),
            presence: presence && typeof presence === 'object' ? presence : null
        };
        if (!packet.text || !this.participantId || this.socket?.readyState !== WebSocket.OPEN) return null;
        this.sendSocket({type: 'collaboration_message', message: {...packet, senderId: this.participantId}});
        return packet;
    }

    sendChatTyping (typing) {
        return this.broadcast({
            type: 'chat_typing',
            typing: Boolean(typing)
        });
    }

    sendPresence (presence) {
        return this.broadcast({type: 'presence', ...presence});
    }

    sendBlockInputPreview (preview) {
        if (!preview || typeof preview !== 'object') return false;
        return this.broadcast({type: 'block_input_preview', ...preview});
    }

    sendPaintPreview (preview) {
        if (!preview || typeof preview !== 'object') return false;
        const items = Array.isArray(preview.items) ? preview.items
            .slice(0, 24)
            .map(item => {
                if (!item || typeof item !== 'object') return null;
                const type = item.type === 'paper-json' ? item.type : null;
                const data = typeof item.data === 'string' && item.data.length <= MAX_PAINT_FRAME_CHARS ?
                    item.data : null;
                if (!type || !data) return null;
                return {type, data};
            })
            .filter(Boolean) : [];
        const draw = preview.draw && ['bitmap-brush', 'bitmap-line'].includes(preview.draw.kind) ? {
            kind: preview.draw.kind,
            from: {
                x: Number(preview.draw.from?.x) || 0,
                y: Number(preview.draw.from?.y) || 0
            },
            to: {
                x: Number(preview.draw.to?.x) || 0,
                y: Number(preview.draw.to?.y) || 0
            },
            color: typeof preview.draw.color === 'string' ? preview.draw.color.slice(0, 120) : null,
            size: Math.max(1, Math.min(512, Number(preview.draw.size) || 1)),
            eraser: preview.draw.eraser === true
        } : null;
        const hiddenItems = Array.isArray(preview.hiddenItems) ? preview.hiddenItems
            .map(path => (Array.isArray(path) && path.length > 0 && path.length <= 16 ? path
                .map(index => (Number.isInteger(Number(index)) && Number(index) >= 0 && Number(index) < 4096 ?
                    Number(index) : null)) : null))
            .filter(path => path && path.every(index => index !== null)) : [];
        const selectionItems = Array.isArray(preview.selectionItems) ? preview.selectionItems
            .map(path => (Array.isArray(path) && path.length > 0 && path.length <= 16 ? path
                .map(index => (Number.isInteger(Number(index)) && Number(index) >= 0 && Number(index) < 4096 ?
                    Number(index) : null)) : null))
            .filter(path => path && path.every(index => index !== null)) : null;
        const payload = {
            targetId: String(preview.targetId || '').slice(0, 160),
            costumeIndex: Number.isInteger(Number(preview.costumeIndex)) ? Number(preview.costumeIndex) : null,
            imageId: String(preview.imageId || '').slice(0, 200),
            imageFormat: String(preview.imageFormat || '').slice(0, 16),
            phase: String(preview.phase || 'update').slice(0, 16),
            gestureId: Number.isInteger(Number(preview.gestureId)) ? Number(preview.gestureId) : 0,
            sequence: Number.isInteger(Number(preview.sequence)) ? Number(preview.sequence) : 0,
            items,
            draw,
            hiddenItems,
            ...(selectionItems ? {selectionItems} : {}),
            operation: String(preview.operation || 'paper-item-preview').slice(0, 48),
            transport: 'webrtc'
        };
        return this.broadcast({type: 'paint_preview', paint: payload});
    }

    updateGuestName (name) {
        const trimmed = String(name || '').trim()
            .slice(0, 40);
        if (!trimmed) return;
        this.guestName = trimmed;
        this.sendSocket({type: 'collaboration_rename', name: trimmed});
    }

    closePeer (id) {
        const connection = this.peers.get(id);
        this.pendingIceByPeer.delete(id);
        if (connection) {
            this.peers.delete(id);
            clearTimeout(connection.nyaitterChannel?.nyaitterFlushTimer);
            if (connection.nyaitterChannel) {
                connection.nyaitterChannel.nyaitterQueue.length = 0;
                connection.nyaitterChannel.nyaitterQueueHead = 0;
            }
            if (connection.nyaitterRemoteStream) {
                connection.nyaitterRemoteStream = null;
                this.onEvent({type: 'runtime_stream', stream: null, from: id});
            }
            try {
                connection.close();
            } catch (_) {}
            this.onEvent({type: 'peer_disconnected', participant_id: id});
        }
    }

    close () {
        this.closed = true;
        clearTimeout(this.reconnectTimer);
        for (const id of [...this.peers.keys()]) this.closePeer(id);
        this.pendingIceByPeer.clear();
        this.incomingChunks.clear();
        this.seenMessageIds.clear();
        this.pendingSignals.length = 0;
        this.localStream?.getTracks().forEach(track => track.stop());
        this.localStream = null;
        this.socket?.close();
        this.socket = null;
    }
}

export default CollaborationClient;
