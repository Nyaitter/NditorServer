let authSession = null;
let refreshPromise = null;
let initializePromise = null;

const getAuthSession = () => authSession;

const setAuthSession = session => {
    authSession = session || null;
    window.dispatchEvent(new CustomEvent('nyaitter-editor-auth-changed'));
};

const getAuthBase = () => {
    const configured = window.NditorConfig?.nyaitterAuthBase;
    return (configured || '/api/nditor/nyaitter-auth').replace(/\/$/, '');
};

const completeAuthSession = async (code, state) => {
    const response = await fetch(`${getAuthBase()}/token`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        credentials: 'include',
        body: JSON.stringify({code, state})
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.user) {
        throw new Error(result.error || 'ログイン情報を受け取れませんでした。');
    }
    const session = {user: result.user, expiresAt: result.expires_at || null};
    setAuthSession(session);
    return session;
};

const refreshAuthSession = () => {
    if (refreshPromise) return refreshPromise;
    refreshPromise = fetch(`${getAuthBase()}/me`, {credentials: 'include'})
        .then(async response => {
            if (!response.ok) throw new Error('認証情報を取得できません。');
            const result = await response.json();
            const session = {user: result.user || null, tokenType: result.tokenType || 'session'};
            setAuthSession(session);
            return session;
        })
        .catch(() => {
            setAuthSession(null);
            return null;
        })
        .finally(() => {
            refreshPromise = null;
        });
    return refreshPromise;
};

/*
 * OAuth callbacks return to the editor route. They cannot live only in the
 * Edit menu because that menu is mounted lazily when the user opens it.
 */
const initializeAuthSession = () => {
    if (initializePromise) return initializePromise;
    initializePromise = (async () => {
        const url = new URL(window.location.href);
        const code = url.searchParams.get('code') || url.searchParams.get('token');
        const expectedState = window.sessionStorage.getItem('nditor:nyaitter-auth-state');
        const isCallback = url.searchParams.get('nyaitter_auth_callback') === '1';
        const validCallback = isCallback && code && expectedState &&
            url.searchParams.get('state') === expectedState;

        if (!validCallback) {
            if (isCallback && code) {
                window.dispatchEvent(new CustomEvent('nyaitter-editor-notice', {
                    detail: {
                        message: 'ログインの確認情報が一致しませんでした。もう一度ログインしてください。',
                        kind: 'error'
                    }
                }));
            }
            return refreshAuthSession();
        }

        try {
            const session = await completeAuthSession(code, expectedState);
            ['code', 'token', 'state', 'nyaitter_auth_callback'].forEach(name => url.searchParams.delete(name));
            window.sessionStorage.removeItem('nditor:nyaitter-auth-state');
            window.history.replaceState(null, '', url);
            return session;
        } catch (error) {
            window.dispatchEvent(new CustomEvent('nyaitter-editor-notice', {
                detail: {message: error.message || 'ログインできませんでした。', kind: 'error'}
            }));
            return refreshAuthSession();
        }
    })().finally(() => {
        initializePromise = null;
    });
    return initializePromise;
};

export {
    completeAuthSession,
    getAuthSession,
    initializeAuthSession,
    setAuthSession,
    refreshAuthSession
};
