/* eslint-disable react/jsx-no-bind, react/jsx-no-literals, react/prop-types */
import React from 'react';
import NyaitterIdBadge from './nyaitter-id-badge.jsx';
import styles from './collaboration-settings-modal.css';

const CollaborationSettingsModal = ({room, url, management, onClose, onSave, onDecision, onOpenCloudSettings}) => {
    const [accessMode, setAccessMode] = React.useState(room.access_mode || 'private');
    const [allowAnonymous, setAllowAnonymous] = React.useState(room.allow_anonymous !== false);
    const [invitedUsers, setInvitedUsers] = React.useState((management?.invited_user_ids || []).join(', '));
    const [copyState, setCopyState] = React.useState('');
    const cloud = room.storage_type === 'cloud';
    const pending = (management?.requests || []).filter(request => request.status === 'pending');

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(url);
            setCopyState('コピーしました');
        } catch (_) {
            setCopyState('コピーできませんでした');
        }
    };

    return (<div
        className={styles.overlay}
        onClick={onClose}
        role="dialog"
        aria-modal="true"
    >
        <section
            className={styles.modal}
            onClick={event => event.stopPropagation()}
        >
            <header><strong>共同作業</strong><button
                type="button"
                onClick={onClose}
            >×</button></header>
            <div className={styles.body}>
                <label>招待URL<div className={styles.urlRow}><input
                    readOnly
                    value={url}
                    onClick={event => event.target.select()}
                /><button
                    type="button"
                    onClick={copy}
                >{copyState === 'コピーしました' ? 'コピー済み' : 'コピー'}</button></div>
                    {copyState && <span
                        className={styles.copyState}
                        role="status"
                    >{copyState}</span>}</label>
                {cloud ? <React.Fragment>
                    <p>この共同作業では、クラウドプロジェクトの権限設定を使用します。</p>
                    <div className={styles.actions}><button
                        type="button"
                        onClick={onOpenCloudSettings}
                    >クラウドプロジェクトの設定を開く</button></div>
                </React.Fragment> : <form
                    onSubmit={event => {
                        event.preventDefault();
                        onSave({access_mode: accessMode, allow_anonymous: allowAnonymous, invited_users: invitedUsers});
                    }}
                >
                    <label>権限<select
                        value={accessMode}
                        onChange={event => setAccessMode(event.target.value)}
                    >
                        <option value="invite">Invite</option>
                        <option value="private">Private</option>
                    </select></label>
                    <p>{accessMode === 'invite' ?
                        '招待済みのユーザーと、参加申請を承認したユーザーだけが参加できます。' :
                        '招待URLを知っているユーザーが参加できます。'}</p>
                    <label className={styles.checkbox}><input
                        type="checkbox"
                        checked={allowAnonymous}
                        onChange={event => setAllowAnonymous(event.target.checked)}
                    />NyaitterIDにログインしていないユーザーも参加可能</label>
                    {accessMode === 'invite' && <label>招待するユーザー<input
                        value={invitedUsers}
                        placeholder="NyaitterIDをカンマ区切りで入力"
                        onChange={event => setInvitedUsers(event.target.value)}
                    /></label>}
                    <div className={styles.actions}><button type="submit">設定を保存</button></div>
                </form>}
                {!cloud && room.access_mode === 'invite' && <section className={styles.requests}>
                    <strong>参加申請</strong>
                    {pending.length === 0 && <p>承認待ちの申請はありません。</p>}
                    {pending.map(request => (<div key={request.id}>
                        <span>{request.name}{request.user_id ? <NyaitterIdBadge /> : ' (非ログイン)'}</span>
                        <span><button
                            type="button"
                            onClick={() => onDecision(request.id, 'approve')}
                        >承認</button><button
                            type="button"
                            onClick={() => onDecision(request.id, 'reject')}
                        >拒否</button></span>
                    </div>))}
                </section>}
            </div>
        </section>
    </div>);
};

export default CollaborationSettingsModal;
