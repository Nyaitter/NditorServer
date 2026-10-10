/* eslint-disable require-atomic-updates */
import {
    completeAuthSession,
    getAuthSession,
    refreshAuthSession,
    setAuthSession
} from './auth-session.js';
import {beginProjectLoading, isProjectLoading} from './project-loading-state.js';

const params = new URLSearchParams(window.location.search);
let cloudProjectId = params.get('cloud_project');
let cloudKey = params.get('cloud_key') || '';
let currentProjectWritable = false;
let currentProjectOwner = false;

const configuredApiBase = window.NditorConfig?.cloudApiBase;
const apiBase = configuredApiBase || '/api/nditor/cloud-projects';
const nyaitterAuthBase = window.NditorConfig?.nyaitterAuthBase || '/api/nditor/nyaitter-auth';

const requestStorageKey = id => `nditor:cloud-access:${id}`;

const getStoredRequest = id => {
    if (!id) return null;
    try {
        const value = JSON.parse(window.localStorage.getItem(requestStorageKey(id)) || 'null');
        return value?.requestId ? value : null;
    } catch (_) {
        return null;
    }
};

const storeRequest = (id, result) => {
    if (!id || !result?.request_id) return;
    window.localStorage.setItem(requestStorageKey(id), JSON.stringify({
        requestId: result.request_id,
        requestKey: result.request_key || ''
    }));
};

const getCloudProjectId = () => cloudProjectId;
const getCloudKey = () => cloudKey;
const canWriteCurrentProject = () => currentProjectWritable;
const isCurrentProjectOwner = () => currentProjectOwner;

const setCloudProject = (id, key = '') => {
    const nextId = id || null;
    const changed = cloudProjectId !== nextId || cloudKey !== (key || '');
    cloudProjectId = nextId;
    cloudKey = key || '';
    if (changed) {
        currentProjectWritable = false;
        currentProjectOwner = false;
    }
    const url = new URL(window.location.href);
    ['project_id', 'invite_token', 'ref'].forEach(name => url.searchParams.delete(name));
    if (cloudProjectId) url.searchParams.set('cloud_project', cloudProjectId);
    else url.searchParams.delete('cloud_project');
    if (cloudProjectId && cloudKey) url.searchParams.set('cloud_key', cloudKey);
    else url.searchParams.delete('cloud_key');
    window.history.replaceState(null, '', url);
    window.dispatchEvent(new CustomEvent('nditor-cloud-project-changed', {
        detail: {projectId: cloudProjectId, cloudKey}
    }));
};

const accessParameters = (id = cloudProjectId, key = cloudKey) => {
    const query = new URLSearchParams();
    if (key) query.set('cloud_key', key);
    const saved = getStoredRequest(id);
    if (saved?.requestId) query.set('request_id', saved.requestId);
    if (saved?.requestKey) query.set('request_key', saved.requestKey);
    return query;
};

const projectPath = id => {
    const value = id || cloudProjectId;
    if (!value) throw new Error('クラウドプロジェクトが指定されていません。');
    return `${apiBase.replace(/\/$/, '')}/${encodeURIComponent(value)}`;
};

const request = async (path, options = {}) => {
    const response = await fetch(path, {...options, credentials: 'include'});
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(payload.error || payload.message || 'サーバー要求に失敗しました。');
        error.status = response.status;
        error.code = payload.code || null;
        throw error;
    }
    return payload;
};

const emitNotice = (message, kind = 'info') => window.dispatchEvent(new CustomEvent('nyaitter-editor-notice', {
    detail: {message: String(message || ''), kind}
}));

const describeProjectError = (error, fallback = 'クラウドプロジェクトの保存に失敗しました。') => error?.message || fallback;

const startAuth = () => request(`${nyaitterAuthBase}/start`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({return_url: window.location.href})
});

const completeAuth = completeAuthSession;

const refreshAuth = () => refreshAuthSession();

const logout = async () => {
    await request(`${nyaitterAuthBase}/logout`, {method: 'POST'});
    setAuthSession(null);
};

const listCloudProjects = async () => {
    const result = await request(apiBase);
    return result.projects || [];
};

const getStorageUsage = () => request(`${apiBase}/storage`);

const withAccessQuery = (path, id = cloudProjectId, key = cloudKey) => {
    const query = accessParameters(id, key).toString();
    return query ? `${path}${path.includes('?') ? '&' : '?'}${query}` : path;
};

const getCloudProjectAccess = (id = cloudProjectId, key = cloudKey) => request(
    withAccessQuery(`${projectPath(id)}/access`, id, key)
);

const getCloudProject = (id = cloudProjectId, key = cloudKey) => request(
    withAccessQuery(projectPath(id), id, key)
);

const loadCloudProject = async (vm, id = cloudProjectId, key = cloudKey) => {
    if (!vm?.loadProject) throw new Error('エディターでプロジェクトを読み込めません。');
    const finishLoading = beginProjectLoading('cloud-project');
    try {
        const response = await fetch(
            withAccessQuery(`${projectPath(id)}/snapshot`, id, key),
            {credentials: 'include'}
        );
        const payload = response.ok ? null : await response.json().catch(() => ({}));
        if (!response.ok) {
            const error = new Error(payload?.error || 'プロジェクトデータを取得できませんでした。');
            error.status = response.status;
            error.code = payload?.code || null;
            throw error;
        }
        await vm.loadProject(await response.arrayBuffer());
        setCloudProject(id, key);
        const detail = await getCloudProject(id, key);
        currentProjectWritable = detail.project?.can_write === true;
        currentProjectOwner = detail.project?.is_owner === true;
        window.dispatchEvent(new CustomEvent('nditor-cloud-project-loaded', {
            detail: {projectId: id, canWrite: currentProjectWritable, isOwner: currentProjectOwner}
        }));
        return detail;
    } finally {
        finishLoading();
    }
};

let saving = false;
const pendingSaves = [];

const saveCloudProject = async vm => {
    if (!cloudProjectId) throw new Error('クラウドプロジェクトが開かれていません。');
    if (!currentProjectWritable) throw new Error('このクラウドプロジェクトは保存できません。');
    if (!vm?.saveProjectSb3) throw new Error('プロジェクトを書き出せません。');
    if (isProjectLoading()) return null;
    if (saving) return new Promise((resolve, reject) => pendingSaves.push({vm, resolve, reject}));
    saving = true;
    try {
        const data = await vm.saveProjectSb3('arraybuffer');
        const form = new FormData();
        form.append('file', new Blob([data], {type: 'application/zip'}), `${cloudProjectId}.sb3`);
        const result = await request(`${projectPath()}/snapshot`, {method: 'PUT', body: form});
        currentProjectWritable = result.project?.can_write === true;
        return result;
    } finally {
        saving = false;
        if (pendingSaves.length) {
            const queued = pendingSaves.splice(0);
            const latest = queued[queued.length - 1];
            saveCloudProject(latest.vm).then(
                value => queued.forEach(item => item.resolve(value)),
                error => queued.forEach(item => item.reject(error))
            );
        }
    }
};

const createCloudProject = async (vm, {name, accessMode = 'private', allowAnonymous = true} = {}) => {
    if (!vm?.saveProjectSb3) throw new Error('プロジェクトを書き出せません。');
    const title = String(name || '').trim();
    if (!title) throw new Error('プロジェクト名を入力してください。');
    const data = await vm.saveProjectSb3('arraybuffer');
    const form = new FormData();
    form.append('file', new Blob([data], {type: 'application/zip'}), 'project.sb3');
    form.append('name', title);
    form.append('access_mode', accessMode);
    form.append('allow_anonymous', allowAnonymous ? 'true' : 'false');
    const result = await request(apiBase, {method: 'POST', body: form});
    const project = result.project;
    if (!project?.id) throw new Error('クラウドプロジェクトを作成できませんでした。');
    setCloudProject(project.id, project.share_token || '');
    currentProjectWritable = true;
    currentProjectOwner = true;
    window.dispatchEvent(new CustomEvent('nditor-cloud-project-loaded', {
        detail: {projectId: project.id, canWrite: true, isOwner: true}
    }));
    return result;
};

const updateCloudProject = (id, settings) => request(projectPath(id), {
    method: 'PATCH',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(settings)
});

const deleteCloudProject = id => request(projectPath(id), {method: 'DELETE'});

const getAccessManagement = id => request(`${projectPath(id)}/access-management`);

const inviteCloudUser = (id, identifier) => request(`${projectPath(id)}/invitations`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({identifier})
});

const removeCloudUser = (id, userId) => request(`${projectPath(id)}/users/${encodeURIComponent(userId)}`, {
    method: 'DELETE'
});

const decideCloudAccessRequest = (id, requestId, decision) => request(
    `${projectPath(id)}/access-requests/${encodeURIComponent(requestId)}/${decision}`,
    {method: 'POST'}
);

const requestCloudAccess = async (id, key, name = '') => {
    const result = await request(`${projectPath(id)}/access-requests`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({cloud_key: key, name})
    });
    storeRequest(id, result);
    return result;
};

const getCloudAccessRequestStatus = (id, requestId = null) => {
    const saved = getStoredRequest(id);
    const targetId = requestId || saved?.requestId;
    if (!targetId) throw new Error('参加申請がありません。');
    const query = new URLSearchParams();
    if (saved?.requestKey) query.set('request_key', saved.requestKey);
    return request(`${projectPath(id)}/access-requests/${encodeURIComponent(targetId)}?${query}`);
};

const ensureCloudCollaborationSession = (id = cloudProjectId) => request(
    withAccessQuery(`${projectPath(id)}/collaboration-session`, id),
    {method: 'POST'}
);

const cloudShareUrl = project => {
    const url = new URL(window.location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('cloud_project', project.id);
    if (project.share_token) url.searchParams.set('cloud_key', project.share_token);
    return url.href;
};

const restartCloudProjectVm = async (id = cloudProjectId) => {
    const result = await request(`${projectPath(id)}/vm/restart`, {method: 'POST'});
    emitNotice('サーバーVMを再起動しました。', 'success');
    return result;
};

export {
    apiBase,
    canWriteCurrentProject,
    cloudShareUrl,
    completeAuth,
    createCloudProject,
    decideCloudAccessRequest,
    deleteCloudProject,
    describeProjectError,
    emitNotice,
    ensureCloudCollaborationSession,
    getAccessManagement,
    getAuthSession,
    getCloudAccessRequestStatus,
    getCloudKey,
    getCloudProject,
    getCloudProjectAccess,
    getCloudProjectId,
    getStorageUsage,
    inviteCloudUser,
    isCurrentProjectOwner,
    listCloudProjects,
    loadCloudProject,
    logout,
    refreshAuth,
    removeCloudUser,
    requestCloudAccess,
    restartCloudProjectVm,
    saveCloudProject,
    setCloudProject,
    startAuth,
    updateCloudProject
};

export default {
    canWriteCurrentProject,
    cloudShareUrl,
    createCloudProject,
    ensureCloudCollaborationSession,
    getCloudKey,
    getCloudProjectId,
    listCloudProjects,
    loadCloudProject,
    saveCloudProject,
    setCloudProject
};
