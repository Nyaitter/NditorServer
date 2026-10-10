const activeSources = new Set();

const emit = () => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('nditor-project-loading-changed', {
        detail: {active: activeSources.size > 0, sources: [...activeSources]}
    }));
};

const setProjectLoading = (source, active) => {
    const key = String(source || 'project');
    const changed = active ? !activeSources.has(key) : activeSources.has(key);
    if (!changed) return;
    if (active) activeSources.add(key);
    else activeSources.delete(key);
    emit();
};

const beginProjectLoading = source => {
    const key = String(source || 'project');
    setProjectLoading(key, true);
    let finished = false;
    return () => {
        if (finished) return;
        finished = true;
        setProjectLoading(key, false);
    };
};

const isProjectLoading = () => activeSources.size > 0;

export {beginProjectLoading, isProjectLoading, setProjectLoading};
