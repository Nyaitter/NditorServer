const collaborationBase = window.NditorConfig?.collaborationApiBase || '/api/nditor/collaboration';

const storageKey = token => `nditor:collaboration-access:${token}`;

const getStoredCollaborationAccess = token => {
    try {
        return JSON.parse(window.localStorage.getItem(storageKey(token)) || 'null') || {};
    } catch (_) {
        return {};
    }
};

const storeCollaborationAccess = (token, values = {}) => {
    const current = getStoredCollaborationAccess(token);
    const next = {...current, ...values};
    Object.keys(next).forEach(key => {
        if (!next[key]) delete next[key];
    });
    window.localStorage.setItem(storageKey(token), JSON.stringify(next));
    return next;
};

const request = async (path, options = {}) => {
    const response = await fetch(path, {...options, credentials: 'include'});
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(payload.error || payload.message || '共同作業サーバーへの要求に失敗しました。');
        error.status = response.status;
        error.code = payload.code || null;
        throw error;
    }
    return payload;
};

const createCollaborationRoom = async options => {
    const room = await request(`${collaborationBase}/rooms`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(options || {})
    });
    if (room.control_token) storeCollaborationAccess(room.token, {controlToken: room.control_token});
    return room;
};

const accessQuery = token => {
    const stored = getStoredCollaborationAccess(token);
    const query = new URLSearchParams();
    if (stored.requestId) query.set('request_id', stored.requestId);
    if (stored.requestKey) query.set('request_key', stored.requestKey);
    if (stored.controlToken) query.set('control_token', stored.controlToken);
    return query;
};

const getCollaborationRoom = token => {
    const query = accessQuery(token).toString();
    return request(`${collaborationBase}/rooms/${encodeURIComponent(token)}${query ? `?${query}` : ''}`);
};

const getCollaborationTicket = token => {
    const stored = getStoredCollaborationAccess(token);
    return request(`${collaborationBase}/rooms/${encodeURIComponent(token)}/ticket`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            request_id: stored.requestId || '',
            request_key: stored.requestKey || '',
            control_token: stored.controlToken || ''
        })
    }).then(result => result.ticket || null);
};

const requestCollaborationAccess = async (token, name = '') => {
    const result = await request(`${collaborationBase}/rooms/${encodeURIComponent(token)}/access-requests`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({name})
    });
    if (result.request_id) {
        storeCollaborationAccess(token, {
            requestId: result.request_id,
            requestKey: result.request_key || ''
        });
    }
    return result;
};

const getCollaborationAccessRequestStatus = token => {
    const stored = getStoredCollaborationAccess(token);
    if (!stored.requestId) throw new Error('参加申請がありません。');
    const query = new URLSearchParams();
    if (stored.requestKey) query.set('request_key', stored.requestKey);
    const roomPath = `${collaborationBase}/rooms/${encodeURIComponent(token)}`;
    return request(`${roomPath}/access-requests/${encodeURIComponent(stored.requestId)}?${query}`);
};

const getCollaborationAccessManagement = token => {
    const stored = getStoredCollaborationAccess(token);
    const query = new URLSearchParams();
    if (stored.controlToken) query.set('control_token', stored.controlToken);
    return request(`${collaborationBase}/rooms/${encodeURIComponent(token)}/access-management?${query}`);
};

const updateCollaborationSettings = (token, settings) => {
    const stored = getStoredCollaborationAccess(token);
    return request(`${collaborationBase}/rooms/${encodeURIComponent(token)}/settings`, {
        method: 'PATCH',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({...settings, control_token: stored.controlToken || ''})
    });
};

const decideCollaborationAccessRequest = (token, requestId, decision) => {
    const stored = getStoredCollaborationAccess(token);
    const roomPath = `${collaborationBase}/rooms/${encodeURIComponent(token)}`;
    const requestPath = `${roomPath}/access-requests/${encodeURIComponent(requestId)}/${decision}`;
    return request(requestPath, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({control_token: stored.controlToken || ''})
    });
};

const getCollaborationWebSocketUrl = token => {
    const url = new URL(collaborationBase, window.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.search = '';
    url.searchParams.set('token', token);
    return url.href;
};

export {
    createCollaborationRoom,
    decideCollaborationAccessRequest,
    getCollaborationAccessManagement,
    getCollaborationAccessRequestStatus,
    getCollaborationRoom,
    getCollaborationTicket,
    getCollaborationWebSocketUrl,
    getStoredCollaborationAccess,
    requestCollaborationAccess,
    storeCollaborationAccess,
    updateCollaborationSettings
};

export default {
    createCollaborationRoom,
    getCollaborationRoom,
    getCollaborationTicket,
    getCollaborationWebSocketUrl
};
