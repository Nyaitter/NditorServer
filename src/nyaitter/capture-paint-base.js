import paper from '@turbowarp/paper';
import {getRaster, hideGuideLayers, showGuideLayers} from 'scratch-paint/src/helper/layer';
import {scaleWithStrokes} from 'scratch-paint/src/helper/math';
import {ART_BOARD_WIDTH, ART_BOARD_HEIGHT, SVG_ART_BOARD_WIDTH, SVG_ART_BOARD_HEIGHT}
    from 'scratch-paint/src/helper/view';

export const captureBitmapBase = () => {
    const raster = getRaster();
    if (!raster?.canvas || !raster.bounds.width) return null;
    const scale = raster.canvas.width / raster.bounds.width;
    return {data: raster.canvas.toDataURL('image/png').split(',')[1],
        dataFormat: 'png',
        bitmapResolution: 2 * scale,
        rotationCenterX: ((ART_BOARD_WIDTH / 2) - raster.bounds.x) * scale,
        rotationCenterY: ((ART_BOARD_HEIGHT / 2) - raster.bounds.y) * scale};
};

// Capture the same representation as the paint editor, before the edit.
const captureVectorBase = () => {
    const layer = paper.project?.activeLayer;
    if (!layer) return null;
    const project = paper.project;
    const applying = project._nyaitterApplyingCollaborationPreview;
    project._nyaitterApplyingCollaborationPreview = true;
    const hidden = project.getItems({match: item => Boolean(item._nyaitterRemoteHiddenOwners)})
        .map(item => [item, item.visible]);
    hidden.forEach(([item]) => {
        item.visible = item._nyaitterRemoteHiddenOwners._originalVisible;
    });
    const mask = layer.clipped ? layer.children.find(item => item.isClipMask()) : null;
    if (mask) {
        layer.clipped = false; mask.remove();
    }
    const guides = hideGuideLayers(true);
    let scaled = false;
    try {
        scaleWithStrokes(layer, 0.5, new paper.Point());
        scaled = true;
        const bounds = layer.drawnBounds;
        return {
            svg: project.exportSVG({asString: true,
                bounds: 'content',
                matrix: new paper.Matrix().translate(-bounds.x, -bounds.y)}),
            rotationCenterX: bounds.width === 0 ? 0 : (SVG_ART_BOARD_WIDTH / 2) - bounds.x,
            rotationCenterY: bounds.height === 0 ? 0 : (SVG_ART_BOARD_HEIGHT / 2) - bounds.y
        };
    } finally {
        if (scaled) scaleWithStrokes(layer, 2, new paper.Point());
        layer.applyMatrix = true;
        showGuideLayers(guides);
        if (mask) {
            layer.addChild(mask); mask.clipMask = true;
        }
        hidden.forEach(([item, visible]) => {
            item.visible = visible;
        });
        project._nyaitterApplyingCollaborationPreview = applying;
    }
};

export default captureVectorBase;
