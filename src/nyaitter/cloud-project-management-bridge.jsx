/* eslint-disable no-undefined, react/jsx-no-bind, react/prop-types */
import React from 'react';
import CloudProjectModal from './cloud-project-modal.jsx';
import FormModal from './form-modal.jsx';
import {
    canWriteCurrentProject,
    describeProjectError,
    emitNotice,
    getAuthSession,
    getCloudAccessRequestStatus,
    getCloudKey,
    getCloudProjectAccess,
    getCloudProjectId,
    loadCloudProject,
    requestCloudAccess,
    saveCloudProject,
    startAuth
} from './cloud-project-api.js';
import {isProjectLoading} from './project-loading-state.js';

const authDisplayName = user => user?.display_name || user?.name || user?.scid || '';

const CloudProjectManagementBridge = ({vm}) => {
    const [isOpen, setIsOpen] = React.useState(false);
    const [initialTab, setInitialTab] = React.useState('list');
    const [accessGate, setAccessGate] = React.useState(null);
    const collaborationRoleRef = React.useRef(null);

    React.useEffect(() => {
        const open = event => {
            setInitialTab(event.detail?.tab || 'list');
            setIsOpen(true);
        };
        window.addEventListener('nditor-open-cloud-modal', open);
        return () => window.removeEventListener('nditor-open-cloud-modal', open);
    }, []);

    const attemptLoad = React.useCallback(async () => {
        const projectId = getCloudProjectId();
        if (!vm || !projectId) return;
        try {
            await loadCloudProject(vm, projectId, getCloudKey());
            setAccessGate(null);
        } catch (error) {
            if (!['ACCESS_REQUEST_REQUIRED', 'ACCESS_REQUEST_PENDING', 'AUTH_REQUIRED'].includes(error.code)) {
                emitNotice(error.message || 'クラウドプロジェクトを読み込めませんでした。', 'error');
                return;
            }
            try {
                const status = await getCloudProjectAccess(projectId, getCloudKey());
                setAccessGate({projectId, project: status.project, access: status.access});
            } catch (statusError) {
                emitNotice(statusError.message || error.message, 'error');
            }
        }
    }, [vm]);

    React.useEffect(() => {
        void attemptLoad();
    }, [attemptLoad]);

    React.useEffect(() => {
        if (accessGate?.access?.status !== 'pending') return undefined;
        let disposed = false;
        const check = async () => {
            try {
                const result = await getCloudAccessRequestStatus(
                    accessGate.projectId,
                    accessGate.access.request_id
                );
                if (disposed) return;
                if (result.granted) await attemptLoad();
                else if (result.status === 'rejected') {
                    setAccessGate(current => ({
                        ...current,
                        access: {...current.access, status: 'rejected'}
                    }));
                }
            } catch (_) {
                return;
            }
        };
        const timer = setInterval(check, 3000);
        void check();
        return () => {
            disposed = true;
            clearInterval(timer);
        };
    }, [accessGate, attemptLoad]);

    React.useEffect(() => {
        if (!vm) return undefined;
        let timer = null;
        let disposed = false;
        const save = () => {
            timer = null;
            if (
                disposed ||
                isProjectLoading() ||
                collaborationRoleRef.current === 'guest' ||
                !getCloudProjectId() ||
                !canWriteCurrentProject()
            ) return;
            saveCloudProject(vm).catch(error => {
                if (!disposed) emitNotice(describeProjectError(error, '自動保存できませんでした。'), 'error');
            });
        };
        const schedule = () => {
            if (isProjectLoading() || collaborationRoleRef.current === 'guest' || !getCloudProjectId() || !canWriteCurrentProject()) return;
            clearTimeout(timer);
            timer = setTimeout(save, 1800);
        };
        const updateRole = event => {
            collaborationRoleRef.current = event.detail?.role || null;
            if (collaborationRoleRef.current === 'guest') clearTimeout(timer);
        };
        vm.on('PROJECT_CHANGED', schedule);
        window.addEventListener('nyaitter-collaboration-host-change', schedule);
        window.addEventListener('nditor-collaboration-active', updateRole);
        return () => {
            disposed = true;
            clearTimeout(timer);
            vm.off('PROJECT_CHANGED', schedule);
            window.removeEventListener('nyaitter-collaboration-host-change', schedule);
            window.removeEventListener('nditor-collaboration-active', updateRole);
        };
    }, [vm]);

    const submitAccessGate = async values => {
        try {
            if (accessGate.access.requires_auth) {
                const result = await startAuth();
                window.sessionStorage.setItem('nditor:nyaitter-auth-state', result.state);
                window.location.assign(result.auth_url);
                return;
            }
            const result = await requestCloudAccess(
                accessGate.projectId,
                getCloudKey(),
                authDisplayName(getAuthSession()?.user) || values?.guestName || ''
            );
            setAccessGate(current => ({
                ...current,
                access: {...current.access, status: result.status, request_id: result.request_id}
            }));
        } catch (error) {
            emitNotice(error.message || '参加申請を送れませんでした。', 'error');
        }
    };

    const gatePending = accessGate?.access?.status === 'pending';
    const gateRejected = accessGate?.access?.status === 'rejected';
    const gateNeedsAuth = accessGate?.access?.requires_auth;
    const gateFields = !gateNeedsAuth && !getAuthSession()?.user && !gatePending ? [
        {name: 'guestName', label: '表示名', value: '', maxLength: 40}
    ] : [];
    let gateStatusLabel = '参加申請';
    let gateSubmitLabel = '参加申請を送る';
    if (gatePending) {
        gateStatusLabel = '承認待ち';
        gateSubmitLabel = '状態を確認';
    } else if (gateRejected) {
        gateStatusLabel = '申請が拒否されました';
        gateSubmitLabel = 'もう一度申請';
    } else if (gateNeedsAuth) {
        gateStatusLabel = 'ログインが必要です';
        gateSubmitLabel = 'NyaitterIDでログイン';
    }

    return (<React.Fragment>
        <CloudProjectModal
            isOpen={isOpen}
            initialTab={initialTab}
            onClose={() => setIsOpen(false)}
            vm={vm}
        />
        {accessGate && <FormModal
            title={`${accessGate.project?.name || 'クラウドプロジェクト'} — ${gateStatusLabel}`}
            fields={gateFields}
            submitLabel={gateSubmitLabel}
            onCancel={() => setAccessGate(null)}
            onSubmit={gatePending ? attemptLoad : submitAccessGate}
        />}
    </React.Fragment>);
};

export default CloudProjectManagementBridge;
