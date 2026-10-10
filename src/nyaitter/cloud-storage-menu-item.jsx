/* eslint-disable react/jsx-no-bind, react/jsx-no-literals, react/prop-types */
import React from 'react';
import {MenuItem} from '../components/menu/menu.jsx';
import {emitNotice, getAuthSession, getCloudProjectId, isCurrentProjectOwner, restartCloudProjectVm} from './cloud-project-api.js';

const CloudStorageMenuItem = ({onRequestClose}) => {
    const [projectId, setProjectId] = React.useState(getCloudProjectId());
    const [authenticated, setAuthenticated] = React.useState(Boolean(getAuthSession()?.user));
    const [isOwner, setIsOwner] = React.useState(isCurrentProjectOwner());

    React.useEffect(() => {
        const updateProject = () => {
            setProjectId(getCloudProjectId());
            setIsOwner(isCurrentProjectOwner());
        };
        const updateAuth = () => setAuthenticated(Boolean(getAuthSession()?.user));
        window.addEventListener('nditor-cloud-project-changed', updateProject);
        window.addEventListener('nditor-cloud-project-loaded', updateProject);
        window.addEventListener('nyaitter-editor-auth-changed', updateAuth);
        return () => {
            window.removeEventListener('nditor-cloud-project-changed', updateProject);
            window.removeEventListener('nditor-cloud-project-loaded', updateProject);
            window.removeEventListener('nyaitter-editor-auth-changed', updateAuth);
        };
    }, []);

    const open = tab => {
        onRequestClose();
        window.dispatchEvent(new CustomEvent('nditor-open-cloud-modal', {detail: {tab}}));
    };

    const handleRestartVm = async () => {
        onRequestClose();
        if (!window.confirm('サーバーVMを再起動しますか？\n（現在のプロジェクト状態が初期化され再読み込みされます）')) return;
        try {
            await restartCloudProjectVm(projectId);
        } catch (error) {
            emitNotice(error.message || 'サーバーVMの再起動に失敗しました。', 'error');
        }
    };

    return (<React.Fragment>
        <MenuItem onClick={() => open('list')}>クラウドプロジェクト</MenuItem>
        {authenticated && !projectId && <MenuItem onClick={() => open('create')}>現在の作品をクラウドに保存</MenuItem>}
        {projectId && <MenuItem onClick={() => open('settings')}>クラウドプロジェクトの設定</MenuItem>}
        {projectId && isOwner && <MenuItem onClick={handleRestartVm}>サーバーVMを再起動</MenuItem>}
    </React.Fragment>);
};

export default CloudStorageMenuItem;
