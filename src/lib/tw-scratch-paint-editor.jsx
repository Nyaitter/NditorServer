import React from 'react';
import PaintEditor from 'scratch-paint';
import CollaborationPaintSurface from '../nyaitter/collaboration-paint-surface.jsx';

const CollaborationPaintEditor = props => (
    <CollaborationPaintSurface
        Editor={PaintEditor}
        {...props}
    />
);

export default CollaborationPaintEditor;
