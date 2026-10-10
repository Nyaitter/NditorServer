const shallowEqual = (a, b) => {
    if (a === b) return true;
    if (!a || !b) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length &&
        keys.every(key => Object.prototype.hasOwnProperty.call(b, key) && a[key] === b[key] &&
            (a[key] === null || typeof a[key] !== 'object'));
};

const UPDATE_TARGET_LIST = 'scratch-gui/targets/UPDATE_TARGET_LIST';
const HIGHLIGHT_TARGET = 'scratch-gui/targets/HIGHLIGHT_TARGET';

const initialState = {
    sprites: {},
    stage: {},
    highlightedTargetId: null,
    highlightedTargetTime: null
};

const reducer = function (state, action) {
    if (typeof state === 'undefined') state = initialState;
    switch (action.type) {
    case UPDATE_TARGET_LIST: {
        const sprites = {};
        let stage = {};
        let order = 0;
        let unchanged = true;
        for (const target of action.targets) {
            if (target.isStage) {
                stage = target;
            } else {
                const candidate = {order: order++, ...target};
                const previous = state.sprites[target.id];
                const same = shallowEqual(previous, candidate);
                sprites[target.id] = same ? previous : candidate;
                if (!same) unchanged = false;
            }
        }
        if (Object.keys(state.sprites).length !== order) unchanged = false;
        if (shallowEqual(state.stage, stage)) stage = state.stage;
        if (unchanged && stage === state.stage && state.editingTarget === action.editingTarget) return state;
        return {...state, sprites: unchanged ? state.sprites : sprites, stage, editingTarget: action.editingTarget};
    }
    case HIGHLIGHT_TARGET:
        return Object.assign({}, state, {
            highlightedTargetId: action.targetId,
            highlightedTargetTime: action.updateTime
        });
    default:
        return state;
    }
};
const updateTargets = function (targetList, editingTarget) {
    return {
        type: UPDATE_TARGET_LIST,
        targets: targetList,
        editingTarget: editingTarget
    };
};
const highlightTarget = function (targetId) {
    return {
        type: HIGHLIGHT_TARGET,
        targetId: targetId,
        updateTime: Date.now()
    };
};
export {
    reducer as default,
    initialState as targetsInitialState,
    updateTargets,
    highlightTarget
};
