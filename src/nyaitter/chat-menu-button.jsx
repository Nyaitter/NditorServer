/* eslint-disable react/jsx-no-bind */
import React from 'react';
import {getAuthSession} from './auth-session.js';
import NyaitterIdBadge from './nyaitter-id-badge.jsx';

const ChatMenuButton = () => {
    const [unread, setUnread] = React.useState(0);
    const [active, setActive] = React.useState(false);
    const [participants, setParticipants] = React.useState([]);
    const [myParticipantId, setMyParticipantId] = React.useState(null);
    const [showPopover, setShowPopover] = React.useState(false);
    const [editName, setEditName] = React.useState('');
    const [authSession, setAuthSession] = React.useState(() => getAuthSession());
    const popoverRef = React.useRef(null);

    React.useEffect(() => {
        const handleUnread = e => {
            if (e.detail && typeof e.detail.unread === 'number') {
                setUnread(e.detail.unread);
            }
        };
        const handleActive = e => {
            setActive(Boolean(e.detail?.active));
        };
        const handleParticipants = e => {
            if (Array.isArray(e.detail?.participants)) {
                setParticipants(e.detail.participants.filter(participant => participant.id !== 'server-vm'));
            }
            if (e.detail?.myParticipantId) {
                setMyParticipantId(e.detail.myParticipantId);
            }
        };
        const handleAuth = () => {
            setAuthSession(getAuthSession());
        };

        window.addEventListener('nditor-chat-unread', handleUnread);
        window.addEventListener('nditor-collaboration-active', handleActive);
        window.addEventListener('nditor-collaboration-participants', handleParticipants);
        window.addEventListener('nyaitter-editor-auth-changed', handleAuth);

        const handleClickOutside = e => {
            if (popoverRef.current && !popoverRef.current.contains(e.target)) {
                setShowPopover(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);

        return () => {
            window.removeEventListener('nditor-chat-unread', handleUnread);
            window.removeEventListener('nditor-collaboration-active', handleActive);
            window.removeEventListener('nditor-collaboration-participants', handleParticipants);
            window.removeEventListener('nyaitter-editor-auth-changed', handleAuth);
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, []);

    const myParticipant = participants.find(p => p.id === myParticipantId);
    const isSignedIn = Boolean(authSession?.user) || Boolean(myParticipant?.user_id);

    if (!active) return null;

    const handleChatClick = () => {
        setUnread(0);
        window.dispatchEvent(new CustomEvent('nditor-toggle-chat'));
    };

    const handleSaveName = () => {
        if (isSignedIn) return;
        const trimmed = editName.trim();
        if (trimmed) {
            window.dispatchEvent(new CustomEvent('nditor-update-participant-name', {detail: {name: trimmed}}));
            setEditName('');
        }
    };

    const participantCount = Math.max(1, participants.length);

    return (
        <div style={{display: 'flex', alignItems: 'center', gap: '6px', margin: '0 8px', position: 'relative'}} ref={popoverRef}>
            <button
                type="button"
                style={{
                    background: 'rgba(255, 255, 255, 0.15)',
                    color: '#ffffff',
                    border: '1px solid rgba(255, 255, 255, 0.25)',
                    borderRadius: '4px',
                    padding: '5px 10px',
                    fontSize: '12px',
                    fontWeight: '600',
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                    lineHeight: '1.2'
                }}
                onClick={() => setShowPopover(prev => !prev)}
                title="参加者一覧を表示"
            >
                <span>参加者 {participantCount}</span>
            </button>

            {showPopover && (
                <div
                    style={{
                        position: 'absolute',
                        top: 'calc(100% + 6px)',
                        right: '0',
                        left: 'auto',
                        background: '#ffffff',
                        borderRadius: '6px',
                        boxShadow: '0 4px 16px rgba(0, 0, 0, 0.2)',
                        border: '1px solid #d0d7de',
                        width: '200px',
                        maxWidth: 'calc(100vw - 24px)',
                        maxHeight: 'calc(100vh - 60px)',
                        boxSizing: 'border-box',
                        display: 'flex',
                        flexDirection: 'column',
                        zIndex: 6000,
                        padding: '6px 0',
                        color: '#24292f',
                        fontSize: '12px'
                    }}
                >
                    <div style={{padding: '4px 12px 6px', fontWeight: '600', borderBottom: '1px solid #e1e4e8', fontSize: '11px', color: '#57606a'}}>
                        参加者リスト
                    </div>
                    <div style={{maxHeight: 'min(240px, calc(100vh - 140px))', overflowY: 'auto', padding: '4px 0'}}>
                        {participants.length === 0 ? (
                            <div style={{padding: '6px 12px', color: '#57606a'}}>接続中</div>
                        ) : (
                            participants.map(p => (
                                <div
                                    key={p.id}
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'space-between',
                                        padding: '5px 12px',
                                        gap: '6px'
                                    }}
                                >
                                    <span style={{fontWeight: '500', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1}}>
                                        {p.name || 'ゲスト'}{p.user_id && <NyaitterIdBadge />}
                                    </span>
                                    {p.role === 'host' && !p.isServerVm && (
                                        <span
                                            style={{
                                                fontSize: '10px',
                                                padding: '1px 5px',
                                                borderRadius: '3px',
                                                background: '#0969da',
                                                color: '#ffffff',
                                                fontWeight: '600',
                                                flexShrink: 0
                                            }}
                                        >
                                            ホスト
                                        </span>
                                    )}
                                </div>
                            ))
                        )}
                    </div>
                    {!isSignedIn && (
                        <div style={{padding: '6px 10px', borderTop: '1px solid #e1e4e8', display: 'flex', gap: '4px'}}>
                            <input
                                type="text"
                                value={editName}
                                placeholder="表示名を変更"
                                onChange={e => setEditName(e.target.value)}
                                onKeyDown={e => {
                                    if (e.key === 'Enter') handleSaveName();
                                }}
                                maxLength={40}
                                style={{
                                    flex: 1,
                                    minWidth: 0,
                                    padding: '3px 6px',
                                    border: '1px solid #d0d7de',
                                    borderRadius: '3px',
                                    fontSize: '11px',
                                    outline: 'none'
                                }}
                            />
                            <button
                                type="button"
                                onClick={handleSaveName}
                                style={{
                                    background: '#0969da',
                                    color: '#ffffff',
                                    border: 'none',
                                    borderRadius: '3px',
                                    padding: '3px 8px',
                                    fontSize: '11px',
                                    cursor: 'pointer',
                                    fontWeight: '600',
                                    flexShrink: 0
                                }}
                            >
                                保存
                            </button>
                        </div>
                    )}
                </div>
            )}

            <button
                type="button"
                style={{
                    background: '#0969da',
                    color: '#ffffff',
                    border: 'none',
                    borderRadius: '4px',
                    padding: '5px 12px',
                    fontSize: '12px',
                    fontWeight: '600',
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                    lineHeight: '1.2'
                }}
                onClick={handleChatClick}
            >
                <span>チャット</span>
                {unread > 0 && (
                    <span
                        style={{
                            background: '#cf222e',
                            color: '#ffffff',
                            borderRadius: '10px',
                            padding: '1px 6px',
                            fontSize: '10px',
                            fontWeight: 'bold'
                        }}
                    >
                        {unread}
                    </span>
                )}
            </button>
        </div>
    );
};

export default ChatMenuButton;
