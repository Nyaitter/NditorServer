import React from 'react';
import Loader from '../components/loader/loader.jsx';
import {isProjectLoading, setProjectLoading} from './project-loading-state.js';

const ProjectLoadingOverlay = ({turboWarpLoading = false}) => {
    const [active, setActive] = React.useState(isProjectLoading());

    React.useEffect(() => {
        setProjectLoading('turbowarp', turboWarpLoading);
        setActive(isProjectLoading());
    }, [turboWarpLoading]);

    React.useEffect(() => {
        const update = event => setActive(Boolean(event.detail?.active));
        window.addEventListener('nditor-project-loading-changed', update);
        return () => window.removeEventListener('nditor-project-loading-changed', update);
    }, []);

    // GUI already renders this loader for TurboWarp's own project loads.
    return active && !turboWarpLoading ? <Loader isFullScreen /> : null;
};

export default ProjectLoadingOverlay;
