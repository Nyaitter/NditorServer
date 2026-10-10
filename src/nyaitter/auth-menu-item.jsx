/* eslint-disable brace-style, react/jsx-no-bind, react/jsx-no-literals */
import React from 'react';
import {MenuItem} from '../components/menu/menu.jsx';
import {completeAuth, emitNotice, getAuthSession, logout, refreshAuth, startAuth} from './cloud-project-api.js';

const AuthMenuItem = () => {
    const [session, setSession] = React.useState(getAuthSession());
    const [busy, setBusy] = React.useState(false);

    React.useEffect(() => {
        let disposed = false;
        const update = () => setSession(getAuthSession());
        window.addEventListener('nyaitter-editor-auth-changed', update);
        const url = new URL(window.location.href);
        const code = url.searchParams.get('code') || url.searchParams.get('token');
        const expectedState = window.sessionStorage.getItem('nditor:nyaitter-auth-state');
        const validCallback = url.searchParams.get('nyaitter_auth_callback') === '1' &&
            code && url.searchParams.get('state') === expectedState;
        const initialize = async () => {
            if (!validCallback) {
                await refreshAuth();
                return;
            }
            if (!disposed) setBusy(true);
            try {
                await completeAuth(code, expectedState);
                url.searchParams.delete('code');
                url.searchParams.delete('token');
                url.searchParams.delete('state');
                url.searchParams.delete('nyaitter_auth_callback');
                window.sessionStorage.removeItem('nditor:nyaitter-auth-state');
                window.history.replaceState(null, '', url);
            } catch (error) {
                emitNotice(error.message || 'ログインできませんでした。', 'error');
            } finally {
                if (!disposed) setBusy(false);
            }
        };
        void initialize();
        return () => {
            disposed = true;
            window.removeEventListener('nyaitter-editor-auth-changed', update);
        };
    }, []);

    const handleClick = async () => {
        try {
            if (!session) {
                setBusy(true);
                const result = await startAuth();
                if (!result.auth_url || !result.state) throw new Error('ログイン先を取得できませんでした。');
                window.sessionStorage.setItem('nditor:nyaitter-auth-state', result.state);
                window.location.assign(result.auth_url);
                return;
            }
            await logout();
        } catch (error) {
            emitNotice(error.message || 'ログインを開始できませんでした。', 'error');
            setBusy(false);
        }
    };

    const label = busy ? 'ログイン中…' : session ? 'ログアウト' : 'NyaitterIDでログイン';
    return <MenuItem onClick={busy ? null : handleClick}>{label}</MenuItem>;
};

export default AuthMenuItem;
