import React from 'react';
import Spinner from '../components/spinner/spinner.jsx';

const PaintEditor = React.lazy(() => import(/* webpackChunkName: "paint-editor" */ './tw-scratch-paint-editor.jsx'));
const CollaborationPaintEditor = props => React.createElement(React.Suspense,
    {fallback: React.createElement(Spinner)}, React.createElement(PaintEditor, props));

const emptyState = Object.freeze({});
let realReducer;
const ScratchPaintReducer = (state, action) => {
    if (!realReducer && action.type === 'scratch-gui/navigation/ACTIVATE_TAB' && action.activeTabIndex === 1) {
        realReducer = require('scratch-paint/src/reducers/scratch-paint-reducer').default;
    }
    if (realReducer) return realReducer(state, action);
    return typeof state === 'undefined' ? emptyState : state;
};

export {CollaborationPaintEditor as default, ScratchPaintReducer};
