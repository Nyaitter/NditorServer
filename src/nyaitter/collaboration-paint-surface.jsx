/* eslint-disable arrow-parens, brace-style, max-len, no-undefined, react/prop-types */
import PropTypes from 'prop-types';
import React from 'react';
import paper from '@turbowarp/paper';
import captureVectorBase, {captureBitmapBase} from './capture-paint-base.js';
import {isCollaborationActive} from './collaboration-session-state.js';

const OPERATION_INTERVAL_MS = 55;
const MAX_OPERATION_CHARS = 280000;

const dispatchPaintEvent = detail => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('nditor-collaboration-paint', {detail}));
};

const dispatchSurfaceEvent = detail => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('nditor-collaboration-paint-surface', {detail}));
};

const boundedString = value => {
    const text = typeof value === 'string' ? value : '';
    return text.length > 0 && text.length <= MAX_OPERATION_CHARS ? text : null;
};

const isPreviewItem = item => item &&
    item._parent &&
    !item._nyaitterRemotePreview &&
    item._class !== 'Raster' &&
    !item.guide &&
    !item.data?.isHelperItem &&
    ['Path', 'CompoundPath', 'Shape', 'Group', 'PointText'].includes(item._class);

const previewRoots = items => {
    const candidates = (items || []).filter(isPreviewItem);
    return candidates.filter(item => !item._parent || !candidates.some(parent => (
        parent && parent !== item && typeof item.isDescendant === 'function' && item.isDescendant(parent)
    )));
};

const serializeItem = item => {
    if (!isPreviewItem(item)) return null;
    try {
        const data = boundedString(item.exportJSON?.({asString: true}));
        return data ? {type: 'paper-json', data} : null;
    } catch (_) {
        return null;
    }
};

const serializeItems = items => previewRoots(items)
    .map(serializeItem)
    .filter(Boolean);

const serializePoint = point => (
    point && Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y)) ? {
        x: Number(point.x),
        y: Number(point.y)
    } : null
);

const serializeDrawOperation = operation => {
    if (!operation || !['bitmap-brush', 'bitmap-line'].includes(operation.kind)) return null;
    const from = serializePoint(operation.from);
    const to = serializePoint(operation.to);
    if (!from || !to) return null;
    return {
        kind: operation.kind,
        from,
        to,
        color: typeof operation.color === 'string' ? operation.color.slice(0, 120) : null,
        size: Math.max(1, Math.min(512, Number(operation.size) || 1)),
        eraser: operation.eraser === true
    };
};

const serializeHiddenItems = items => (Array.isArray(items) ? items : [])
    .map(path => (Array.isArray(path) && path.length > 0 && path.length <= 16 ?
        path.map(index => (Number.isInteger(Number(index)) && Number(index) >= 0 && Number(index) < 4096 ?
            Number(index) : null)) : null))
    .filter(path => path && path.every(index => index !== null));

const serializeSelectionItems = items => (Array.isArray(items) ? items : [])
    .map(path => (Array.isArray(path) && path.length > 0 && path.length <= 16 ?
        path.map(index => (Number.isInteger(Number(index)) && Number(index) >= 0 && Number(index) < 4096 ?
            Number(index) : null)) : null))
    .filter(path => path && path.every(index => index !== null));

class CollaborationPaintSurface extends React.Component {
    constructor (props) {
        super(props);
        this.container = null;
        this.canvas = null;
        this.paperView = null;
        this.active = false;
        this.collaborationActive = isCollaborationActive();
        this.gestureEditorProps = null;
        this.editBase = null;
        this.handleSessionChange = event => { this.collaborationActive = Boolean(event.detail?.active); };
        this.gestureId = 0;
        this.sequence = 0;
        this.lastSentAt = 0;
        this.lastSignature = '';
        this.pendingOperation = null;
        this.operationTimer = null;
        this.gestureItems = [];
        this.gestureDraw = null;
        this.gestureHiddenItems = [];
        this.gestureSelectionItems = null;
        this.presenceMetricsFrame = null;
        this.setContainer = this.setContainer.bind(this);
        this.handlePaperEditGesture = this.handlePaperEditGesture.bind(this);
        this.handlePaperSelectionChange = this.handlePaperSelectionChange.bind(this);
        this.handleUpdateImage = this.handleUpdateImage.bind(this);
        this.handleExternalCancel = this.handleExternalCancel.bind(this);
        this.handleRemotePaint = this.handleRemotePaint.bind(this);
        this.syncPresenceMetrics = this.syncPresenceMetrics.bind(this);
        this.schedulePresenceMetrics = this.schedulePresenceMetrics.bind(this);
    }
    componentDidMount () {
        window.addEventListener('nditor-collaboration-paint-cancel', this.handleExternalCancel);
        window.addEventListener('nditor-collaboration-active', this.handleSessionChange);
        window.addEventListener('nditor-collaboration-remote-paint', this.handleRemotePaint);
        window.addEventListener('resize', this.schedulePresenceMetrics);
        window.addEventListener('scroll', this.schedulePresenceMetrics, true);
        window.addEventListener('mousemove', this.schedulePresenceMetrics, true);
        window.addEventListener('wheel', this.schedulePresenceMetrics, true);
        window.addEventListener('touchmove', this.schedulePresenceMetrics, true);
        this.attachCanvas();
        if (typeof MutationObserver !== 'undefined' && this.container) {
            this.surfaceObserver = new MutationObserver(() => this.attachCanvas());
            this.surfaceObserver.observe(this.container, {childList: true, subtree: true});
        }
    }
    componentDidUpdate (previousProps) {
        if (this.active && this.gestureEditorProps &&
            previousProps.collaborationTargetId === this.props.collaborationTargetId &&
            previousProps.collaborationCostumeIndex === this.props.collaborationCostumeIndex) return;
        if (previousProps.imageId !== this.props.imageId ||
            previousProps.collaborationTargetId !== this.props.collaborationTargetId ||
            previousProps.collaborationCostumeIndex !== this.props.collaborationCostumeIndex) {
            this.cancelOperation();
            this.clearRemotePreviews();
            this.attachCanvas();
            dispatchSurfaceEvent({...this.getMetadata(), phase: 'changed'});
        } else if (!this.canvas || !this.canvas.isConnected) {
            this.attachCanvas();
        }
    }
    componentWillUnmount () {
        this.cancelOperation();
        this.clearRemotePreviews();
        window.removeEventListener('nditor-collaboration-paint-cancel', this.handleExternalCancel);
        window.removeEventListener('nditor-collaboration-active', this.handleSessionChange);
        window.removeEventListener('nditor-collaboration-remote-paint', this.handleRemotePaint);
        window.removeEventListener('resize', this.schedulePresenceMetrics);
        window.removeEventListener('scroll', this.schedulePresenceMetrics, true);
        window.removeEventListener('mousemove', this.schedulePresenceMetrics, true);
        window.removeEventListener('wheel', this.schedulePresenceMetrics, true);
        window.removeEventListener('touchmove', this.schedulePresenceMetrics, true);
        if (this.presenceMetricsFrame) cancelAnimationFrame(this.presenceMetricsFrame);
        this.surfaceObserver?.disconnect();
        this.surfaceObserver = null;
        this.detachCanvas();
        dispatchSurfaceEvent({phase: 'unmounted'});
    }
    setContainer (element) {
        this.container = element;
    }
    syncPresenceMetrics () {
        this.presenceMetricsFrame = null;
        if (!this.canvas || !this.canvas.isConnected || !this.paperView) return;
        const view = this.paperView;
        const matrix = view.matrix;
        const viewSize = view.viewSize;
        if (!matrix || !viewSize) return;
        this.canvas.setAttribute('data-nyaitter-presence-view-width', String(viewSize.width));
        this.canvas.setAttribute('data-nyaitter-presence-view-height', String(viewSize.height));
        this.canvas.setAttribute('data-nyaitter-presence-zoom', String(view.zoom));
        ['a', 'b', 'c', 'd', 'tx', 'ty'].forEach(key => {
            this.canvas.setAttribute(`data-nyaitter-presence-matrix-${key}`, String(matrix[key]));
        });
        const bounds = view.bounds;
        if (bounds) {
            this.canvas.setAttribute('data-nyaitter-presence-view-left', String(bounds.left));
            this.canvas.setAttribute('data-nyaitter-presence-view-top', String(bounds.top));
        }
    }
    schedulePresenceMetrics () {
        if (this.presenceMetricsFrame || typeof requestAnimationFrame !== 'function') return;
        this.presenceMetricsFrame = requestAnimationFrame(this.syncPresenceMetrics);
    }
    getMetadata () {
        return {
            targetId: String(this.props.collaborationTargetId || '').slice(0, 160),
            costumeIndex: Number.isInteger(Number(this.props.collaborationCostumeIndex)) ?
                Number(this.props.collaborationCostumeIndex) : null,
            imageId: String(this.props.imageId || '').slice(0, 200),
            imageFormat: String(this.props.imageFormat || '').slice(0, 16)
        };
    }
    attachCanvas () {
        const viewCanvas = paper.view?.element;
        const canvas = viewCanvas && this.container?.contains(viewCanvas) ? viewCanvas :
            this.container?.querySelector('canvas[resize], canvas');
        const paperView = paper.view?.element === canvas ? paper.view : null;
        if (!canvas || (canvas === this.canvas && paperView === this.paperView)) return;
        this.detachCanvas();
        this.canvas = canvas;
        this.canvas.setAttribute('data-nyaitter-paint-canvas', 'true');
        this.canvas.setAttribute('data-nyaitter-presence-coordinate-space', 'paint');
        this.paperView = paperView;
        this.paperView?.beginCollaborationPaintChangeCapture?.();
        this.canvas.addEventListener('nditor-paper-editgesture', this.handlePaperEditGesture);
        this.canvas.addEventListener('nditor-paper-selectionchange', this.handlePaperSelectionChange);
        this.syncPresenceMetrics();
        dispatchSurfaceEvent({...this.getMetadata(), phase: 'mounted'});
    }
    detachCanvas () {
        if (!this.canvas) return;
        this.canvas.removeEventListener('nditor-paper-editgesture', this.handlePaperEditGesture);
        this.canvas.removeEventListener('nditor-paper-selectionchange', this.handlePaperSelectionChange);
        this.paperView?.clearCollaborationPaintPreviews?.();
        this.paperView = null;
        this.canvas.removeAttribute('data-nyaitter-paint-canvas');
        this.canvas.removeAttribute('data-nyaitter-presence-coordinate-space');
        [
            'view-width', 'view-height', 'zoom', 'view-left', 'view-top',
            'matrix-a', 'matrix-b', 'matrix-c', 'matrix-d', 'matrix-tx', 'matrix-ty'
        ].forEach(name => this.canvas.removeAttribute(`data-nyaitter-presence-${name}`));
        this.canvas = null;
    }
    queueOperation (phase, items, draw, force = false, hiddenItems = this.gestureHiddenItems,
        selectionItems = this.gestureSelectionItems) {
        const operation = {
            phase,
            items: serializeItems(items),
            draw: serializeDrawOperation(draw),
            hiddenItems: serializeHiddenItems(hiddenItems),
            selectionItems: Array.isArray(selectionItems) ? serializeSelectionItems(selectionItems) : null
        };
        if (this.operationTimer) {
            this.pendingOperation = operation;
            if (!force) return;
            clearTimeout(this.operationTimer);
            this.operationTimer = null;
        }
        const wait = force ? 0 : Math.max(0, OPERATION_INTERVAL_MS - (Date.now() - this.lastSentAt));
        this.operationTimer = setTimeout(() => {
            this.operationTimer = null;
            const next = this.pendingOperation || operation;
            this.pendingOperation = null;
            this.emitOperation(next.phase, next.items, next.draw, next.hiddenItems, next.selectionItems);
        }, wait);
    }
    emitOperation (phase, items, draw = null, hiddenItems = [], selectionItems = null) {
        const isTerminal = phase === 'end' || phase === 'cancel';
        const signature = JSON.stringify({items: items || [], draw, hiddenItems: hiddenItems || [], selectionItems});
        if (!isTerminal && phase === 'update' && signature === this.lastSignature) return;
        this.lastSignature = signature;
        this.lastSentAt = Date.now();
        this.sequence += 1;
        dispatchPaintEvent({
            ...this.getMetadata(),
            phase,
            gestureId: this.gestureId,
            sequence: this.sequence,
            items: items || [],
            draw,
            hiddenItems: hiddenItems || [],
            ...(Array.isArray(selectionItems) ? {selectionItems} : {}),
            operation: 'paint-operation',
            transport: 'webrtc'
        });
    }
    rememberGesture (gesture) {
        if (Array.isArray(gesture?.items) && gesture.items.length > 0) this.gestureItems = gesture.items;
        if (gesture?.operation) this.gestureDraw = gesture.operation;
        if (Array.isArray(gesture?.hiddenItems) && gesture.hiddenItems.length > 0) {
            this.gestureHiddenItems = gesture.hiddenItems;
        }
        if (Array.isArray(gesture?.selectionItems)) this.gestureSelectionItems = gesture.selectionItems;
    }
    beginOperation (items, draw, hiddenItems, selectionItems) {
        if (this.active) return;
        if (this.collaborationActive) {
            this.gestureEditorProps = {
                image: this.props.image,
                imageId: this.props.imageId,
                imageFormat: this.props.imageFormat,
                rotationCenterX: this.props.rotationCenterX,
                rotationCenterY: this.props.rotationCenterY
            };
            this.captureEditBase();
        }
        this.active = true;
        this.gestureId += 1;
        this.sequence = 0;
        this.lastSignature = '';
        this.lastSentAt = 0;
        this.gestureItems = items || [];
        this.gestureDraw = draw || null;
        this.gestureHiddenItems = (Array.isArray(hiddenItems) && hiddenItems.length > 0) ? hiddenItems : [];
        this.gestureSelectionItems = Array.isArray(selectionItems) ? selectionItems : [];
        // A start packet only establishes the selection. Actual artwork is
        // sent when it changes, and completion is a small end packet.
        this.queueOperation('start', [], null, true, [], this.gestureSelectionItems);
    }
    finishOperation (phase, items, draw, hiddenItems, selectionItems) {
        if (!this.active && phase !== 'cancel') return;
        this.rememberGesture({
            items,
            operation: draw,
            hiddenItems: (Array.isArray(hiddenItems) && hiddenItems.length > 0) ? hiddenItems : this.gestureHiddenItems,
            selectionItems
        });
        this.active = false;
        if (this.operationTimer) clearTimeout(this.operationTimer);
        this.operationTimer = null;
        this.pendingOperation = null;
        if (phase !== 'cancel') {
            this.emitOperation(
                'update',
                serializeItems(this.gestureItems),
                serializeDrawOperation(this.gestureDraw),
                serializeHiddenItems(this.gestureHiddenItems),
                this.gestureSelectionItems ? serializeSelectionItems(this.gestureSelectionItems) : null
            );
        }
        this.emitOperation(
            phase,
            [],
            null,
            [],
            phase === 'end' && !this.gestureHiddenItems.length ? this.gestureSelectionItems : null
        );
        this.gestureEditorProps = null;
        this.forceUpdate();
    }
    cancelOperation () {
        this.gestureEditorProps = null;
        this.editBase = null;
        if (this.operationTimer) clearTimeout(this.operationTimer);
        this.operationTimer = null;
        this.pendingOperation = null;
        if (this.active) {
            this.active = false;
            this.emitOperation('cancel', [], null, []);
        }
        this.gestureItems = [];
        this.gestureDraw = null;
        this.gestureHiddenItems = [];
        this.gestureSelectionItems = null;
        this.lastSignature = '';
    }
    handlePaperEditGesture (event) {
        const gesture = event?.detail || event;
        this.schedulePresenceMetrics();
        if (gesture?.phase === 'start') {
            this.beginOperation(gesture.items, gesture.operation, gesture.hiddenItems, gesture.selectionItems);
        } else if (gesture?.phase === 'end' || gesture?.phase === 'cancel') {
            this.finishOperation(
                gesture.phase,
                gesture.items,
                gesture.operation,
                gesture.hiddenItems,
                gesture.selectionItems
            );
        } else if (this.active) {
            this.rememberGesture(gesture);
            this.queueOperation('update', this.gestureItems, this.gestureDraw, false, this.gestureHiddenItems);
        }
    }
    handlePaperSelectionChange (event) {
        if (this.collaborationActive && !this.active) this.captureEditBase();
        const paths = serializeSelectionItems(
            event?.detail?.selectionItems || this.paperView?.getCollaborationPaintSelectionItemPaths?.() || []
        );
        this.gestureSelectionItems = paths;
        if (this.active || this.paperView?.isCollaborationPaintPointerGestureActive?.()) {
            if (this.active) {
                this.queueOperation('update', this.gestureItems, this.gestureDraw, false,
                    this.gestureHiddenItems, paths);
            }
            return;
        }
        this.gestureId += 1;
        this.sequence = 0;
        this.emitOperation('update', [], null, [], paths);
    }
    handleExternalCancel () {
        this.cancelOperation();
    }
    clearRemotePreviews () {
        this.paperView?.clearCollaborationPaintPreviews?.();
    }
    handleRemotePaint (event) {
        const paint = event?.detail;
        if (!paint || !this.paperView) return;
        if (paint.cancelAll) {
            this.paperView.clearCollaborationPaintPreviews?.(paint.participantId);
            return;
        }
        if (paint.targetId !== this.getMetadata().targetId ||
            Number(paint.costumeIndex) !== this.getMetadata().costumeIndex) return;
        this.paperView.applyCollaborationPaintPreview?.(paint);
    }
    emitCommittedPaperChange () {
        if (!this.paperView?.takeCollaborationPaintChanges) return;
        const items = this.paperView.takeCollaborationPaintChanges();
        if (!items.length || this.active || this.paperView.isCollaborationPaintPointerGestureActive?.()) return;
        const selectionItems = this.paperView.getCollaborationPaintSelectionItemPaths?.() || [];
        this.beginOperation(items, null, selectionItems, selectionItems);
        this.finishOperation('end', items, null, selectionItems, selectionItems);
    }
    captureEditBase () {
        const props = this.gestureEditorProps || this.props;
        const assetId = String(props.imageId || '').slice(String(this.props.collaborationTargetId || '').length + 1);
        const base = this.props.imageFormat === 'svg' ? captureVectorBase() : captureBitmapBase() || {
            data: String(props.image || '').split(',')[1],
            dataFormat: this.props.imageFormat,
            rotationCenterX: props.rotationCenterX,
            rotationCenterY: props.rotationCenterY
        };
        if (base) this.editBase = {...base, assetId};
    }
    handleUpdateImage (...args) {
        const base = this.collaborationActive ? this.editBase : null;
        this.emitCommittedPaperChange();
        if (args[0] && typeof args[1] === 'string') {
            const dom = new DOMParser().parseFromString(args[1], 'image/svg+xml');
            const box = dom.documentElement.getAttribute('viewBox')?.trim()
                .split(/[\s,]+/)
                .map(Number);
            if (box?.length === 4) { args[2] -= box[0]; args[3] -= box[1]; }
        }
        const result = this.props.onUpdateImage(...args, base);
        this.editBase = null;
        return result;
    }
    render () {
        const {
            Editor,
            collaborationCostumeIndex,
            collaborationTargetId,
            ...editorProps
        } = this.props;
        const collaborationCostumeId = `${collaborationTargetId || ''}:${collaborationCostumeIndex ?? ''}`;
        return (
            <div
                ref={this.setContainer}
                data-nyaitter-paint-surface="true"
                data-nyaitter-paint-target-id={collaborationTargetId || ''}
                data-nyaitter-paint-costume-index={collaborationCostumeIndex ?? ''}
                data-nyaitter-paint-image-id={editorProps.imageId || ''}
                style={{display: 'flex', flexGrow: 1, flexDirection: 'column', minWidth: 0}}
            >
                <Editor
                    {...editorProps}
                    {...((this.active && this.gestureEditorProps) || {})}
                    collaborationCostumeId={collaborationCostumeId}
                    onUpdateImage={this.handleUpdateImage}
                />
            </div>
        );
    }
}

CollaborationPaintSurface.propTypes = {
    Editor: PropTypes.func.isRequired,
    collaborationCostumeIndex: PropTypes.number,
    collaborationTargetId: PropTypes.string,
    imageFormat: PropTypes.string,
    imageId: PropTypes.string,
    onUpdateImage: PropTypes.func.isRequired
};

export default CollaborationPaintSurface;
