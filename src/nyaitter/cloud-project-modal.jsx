/* eslint-disable arrow-parens, max-len, no-alert, react/jsx-max-props-per-line, react/jsx-no-bind, react/jsx-no-literals, react/prop-types */
import React from 'react';
import NyaitterIdBadge from './nyaitter-id-badge.jsx';
import {
    cloudShareUrl,
    createCloudProject,
    decideCloudAccessRequest,
    deleteCloudProject,
    emitNotice,
    getAccessManagement,
    getAuthSession,
    getCloudProject,
    getCloudProjectId,
    getStorageUsage,
    inviteCloudUser,
    listCloudProjects,
    loadCloudProject,
    removeCloudUser,
    restartCloudProjectVm,
    setCloudProject,
    updateCloudProject
} from './cloud-project-api.js';
import styles from './cloud-project-modal.css';

const accessLabels = {
    invite: 'Invite',
    private: 'Private'
};

const formatBytes = value => {
    const bytes = Math.max(0, Number(value) || 0);
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

const CloudProjectModal = ({isOpen, onClose, vm, initialTab = 'list'}) => {
    const [tab, setTab] = React.useState(initialTab);
    const [projects, setProjects] = React.useState([]);
    const [selectedId, setSelectedId] = React.useState(getCloudProjectId());
    const [project, setProject] = React.useState(null);
    const [access, setAccess] = React.useState(null);
    const [storage, setStorage] = React.useState(null);
    const [busy, setBusy] = React.useState(false);
    const [name, setName] = React.useState('');
    const [accessMode, setAccessMode] = React.useState('private');
    const [allowAnonymous, setAllowAnonymous] = React.useState(true);
    const [inviteIdentifier, setInviteIdentifier] = React.useState('');
    const [authenticated, setAuthenticated] = React.useState(Boolean(getAuthSession()?.user));

    React.useEffect(() => {
        const update = () => setAuthenticated(Boolean(getAuthSession()?.user));
        window.addEventListener('nyaitter-editor-auth-changed', update);
        return () => window.removeEventListener('nyaitter-editor-auth-changed', update);
    }, []);

    const refreshList = React.useCallback(async () => {
        if (!authenticated) return;
        const [items, usage] = await Promise.all([listCloudProjects(), getStorageUsage()]);
        setProjects(items);
        setStorage(usage);
    }, [authenticated]);

    const refreshSelected = React.useCallback(async id => {
        if (!id) return;
        const result = await getCloudProject(id);
        const next = result.project;
        setProject(next);
        setName(next.name || '');
        setAccessMode(next.access_mode || 'invite');
        setAllowAnonymous(next.allow_anonymous === true);
        if (next.is_owner) setAccess(await getAccessManagement(id));
        else setAccess(null);
    }, []);

    React.useEffect(() => {
        if (!isOpen) return;
        setTab(initialTab);
        setSelectedId(getCloudProjectId());
        setBusy(true);
        refreshList().catch(error => emitNotice(error.message, 'error'))
            .finally(() => setBusy(false));
    }, [isOpen, initialTab, refreshList]);

    React.useEffect(() => {
        if (!isOpen || tab !== 'settings' || !selectedId) return;
        setBusy(true);
        refreshSelected(selectedId).catch(error => emitNotice(error.message, 'error'))
            .finally(() => setBusy(false));
    }, [isOpen, tab, selectedId, refreshSelected]);

    if (!isOpen) return null;

    const run = async action => {
        setBusy(true);
        try {
            await action();
        } catch (error) {
            emitNotice(error.message || '操作に失敗しました。', 'error');
        } finally {
            setBusy(false);
        }
    };

    const openProject = item => run(async () => {
        await loadCloudProject(vm, item.id, item.share_token || '');
        emitNotice('クラウドプロジェクトを読み込みました。', 'success');
        onClose();
    });

    const createProject = event => {
        event.preventDefault();
        run(async () => {
            const result = await createCloudProject(vm, {name, accessMode, allowAnonymous});
            setSelectedId(result.project.id);
            setProject(result.project);
            setTab('settings');
            await refreshList();
            emitNotice('クラウドに保存しました。', 'success');
        });
    };

    const saveSettings = event => {
        event.preventDefault();
        run(async () => {
            const result = await updateCloudProject(selectedId, {
                name,
                access_mode: accessMode,
                allow_anonymous: allowAnonymous
            });
            setProject(result.project);
            await refreshList();
            emitNotice('共有設定を保存しました。', 'success');
        });
    };

    const invite = event => {
        event.preventDefault();
        if (!inviteIdentifier.trim()) return;
        run(async () => {
            await inviteCloudUser(selectedId, inviteIdentifier.trim());
            setInviteIdentifier('');
            setAccess(await getAccessManagement(selectedId));
            emitNotice('ユーザーを招待しました。', 'success');
        });
    };

    const decide = (requestId, decision) => run(async () => {
        await decideCloudAccessRequest(selectedId, requestId, decision);
        setAccess(await getAccessManagement(selectedId));
    });

    const removeUser = userId => run(async () => {
        await removeCloudUser(selectedId, userId);
        setAccess(await getAccessManagement(selectedId));
    });

    const removeProject = () => {
        if (!window.confirm('このクラウドプロジェクトを削除しますか？')) return;
        run(async () => {
            await deleteCloudProject(selectedId);
            if (getCloudProjectId() === selectedId) setCloudProject(null);
            setSelectedId(null);
            setProject(null);
            setTab('list');
            await refreshList();
            emitNotice('クラウドプロジェクトを削除しました。', 'success');
        });
    };

    const copyShareUrl = () => run(async () => {
        await navigator.clipboard.writeText(cloudShareUrl(project));
        emitNotice('共有URLをコピーしました。', 'success');
    });

    const restartVm = () => {
        if (!window.confirm('サーバーVMを再起動しますか？\n（現在のプロジェクト状態が初期化され再読み込みされます）')) return;
        run(async () => {
            await restartCloudProjectVm(selectedId);
        });
    };

    const showSettings = item => {
        setSelectedId(item.id);
        setProject(item);
        setTab('settings');
    };

    return (
        <div className={styles.overlay} onClick={onClose} role="dialog" aria-modal="true">
            <section className={styles.modal} onClick={event => event.stopPropagation()}>
                <div className={styles.header}>
                    <div className={styles.title}>
                        <strong>クラウドプロジェクト</strong>
                        <span>Nyaitterアカウントで作品を保存・管理</span>
                    </div>
                    <button type="button" className={styles.close} onClick={onClose} aria-label="閉じる">&times;</button>
                </div>
                <nav className={styles.tabs}>
                    <button type="button" className={tab === 'list' ? styles.activeTab : ''} onClick={() => setTab('list')}>プロジェクト一覧</button>
                    {authenticated && <button
                        type="button" className={tab === 'create' ? styles.activeTab : ''} onClick={() => {
                            setName('');
                            setAccessMode('private');
                            setAllowAnonymous(true);
                            setTab('create');
                        }}
                    >現在の作品を保存</button>}
                    {selectedId && <button type="button" className={tab === 'settings' ? styles.activeTab : ''} onClick={() => setTab('settings')}>設定</button>}
                </nav>
                <div className={styles.body}>
                    {!authenticated && <div className={styles.empty}>
                        <strong>クラウドプロジェクトにはログインが必要です</strong>
                        <span>編集メニューの「NyaitterIDでログイン」からログインできます。</span>
                    </div>}

                    {authenticated && tab === 'list' && <React.Fragment>
                        {storage && <div className={styles.usage}>
                            使用量 {formatBytes(storage.used_bytes)} / {formatBytes(storage.limit_bytes)}
                        </div>}
                        {!busy && projects.length === 0 && <div className={styles.empty}>保存されたプロジェクトはありません。</div>}
                        <div className={styles.projectList}>
                            {projects.map(item => (<article key={item.id} className={styles.projectRow}>
                                <div>
                                    <strong>{item.name}</strong>
                                    <span>{accessLabels[item.access_mode]} · {formatBytes(item.size_bytes)}</span>
                                </div>
                                <div className={styles.rowActions}>
                                    <button type="button" onClick={() => openProject(item)}>開く</button>
                                    <button type="button" onClick={() => showSettings(item)}>設定</button>
                                </div>
                            </article>))}
                        </div>
                    </React.Fragment>}

                    {authenticated && tab === 'create' && <form className={styles.form} onSubmit={createProject}>
                        <label>プロジェクト名<input autoFocus required maxLength={100} value={name} onChange={event => setName(event.target.value)} /></label>
                        <label>権限<select value={accessMode} onChange={event => setAccessMode(event.target.value)}>
                            <option value="invite">Invite</option>
                            <option value="private">Private</option>
                        </select></label>
                        <p className={styles.help}>{accessMode === 'invite' ?
                            '招待済みのユーザーと、参加申請を承認したユーザーだけが参加できます。' :
                            '共有URLを知っているユーザーが参加できます。'}</p>
                        <label className={styles.checkbox}><input type="checkbox" checked={allowAnonymous} onChange={event => setAllowAnonymous(event.target.checked)} />ゲストユーザーの参加を許可</label>
                        <div className={styles.actions}><button disabled={busy} type="submit">クラウドに保存</button></div>
                    </form>}

                    {authenticated && tab === 'settings' && project && <React.Fragment>
                        <form className={styles.form} onSubmit={saveSettings}>
                            <label>プロジェクト名<input required disabled={!project.is_owner} maxLength={100} value={name} onChange={event => setName(event.target.value)} /></label>
                            <label>権限<select disabled={!project.is_owner} value={accessMode} onChange={event => setAccessMode(event.target.value)}>
                                <option value="invite">Invite</option>
                                <option value="private">Private</option>
                            </select></label>
                            <p className={styles.help}>{accessMode === 'invite' ?
                                '招待済みのユーザーと、参加申請を承認したユーザーだけが参加できます。' :
                                '共有URLを知っているユーザーが参加できます。'}</p>
                            <label className={styles.checkbox}><input disabled={!project.is_owner} type="checkbox" checked={allowAnonymous} onChange={event => setAllowAnonymous(event.target.checked)} />ゲストユーザーの参加を許可</label>
                            {project.is_owner && <div className={styles.actions}>
                                <button type="button" className={styles.secondary} onClick={copyShareUrl}>共有URLをコピー</button>
                                <button disabled={busy} type="submit">設定を保存</button>
                            </div>}
                        </form>

                        {project.is_owner && accessMode === 'invite' && <section className={styles.accessSection}>
                            <h3>招待</h3>
                            <form className={styles.inlineForm} onSubmit={invite}>
                                <input placeholder="NyaitterIDまたはユーザー名" value={inviteIdentifier} onChange={event => setInviteIdentifier(event.target.value)} />
                                <button disabled={busy} type="submit">招待</button>
                            </form>
                            {[...(access?.invited_users || []), ...(access?.approved_users || [])]
                                .filter((item, index, values) => values.findIndex(value => value.id === item.id) === index)
                                .map(user => (<div key={user.id} className={styles.accessRow}>
                                    <span>{user.name} <small>#{user.id}</small></span>
                                    <button type="button" onClick={() => removeUser(user.id)}>削除</button>
                                </div>))}
                            <h3>参加申請</h3>
                            {(access?.requests || []).filter(request => request.status === 'pending').length === 0 && <p className={styles.help}>承認待ちの申請はありません。</p>}
                            {(access?.requests || []).filter(request => request.status === 'pending').map(request => (<div key={request.id} className={styles.accessRow}>
                                <span>{request.name}{request.user_id ? <NyaitterIdBadge /> : ' (非ログイン)'}</span>
                                <span className={styles.requestActions}>
                                    <button type="button" onClick={() => decide(request.id, 'approve')}>承認</button>
                                    <button type="button" onClick={() => decide(request.id, 'reject')}>拒否</button>
                                </span>
                            </div>))}
                        </section>}

                        {project.is_owner && <section className={styles.accessSection}>
                            <h3>サーバーVM</h3>
                            <p className={styles.help}>クラウドプロジェクトを実行しているサーバーVMを再起動します。</p>
                            <button type="button" className={styles.secondary} disabled={busy} onClick={restartVm}>サーバーVMを再起動</button>
                        </section>}

                        {project.is_owner && <div className={styles.danger}><button type="button" onClick={removeProject}>クラウドから削除</button></div>}
                    </React.Fragment>}

                    {busy && <div className={styles.loading}>処理中…</div>}
                </div>
            </section>
        </div>
    );
};

export default CloudProjectModal;
