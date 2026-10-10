/* eslint-disable arrow-parens, max-len, no-undefined */
import paper from '@turbowarp/paper';

const SURFACE_ATTRIBUTE = 'data-nyaitter-presence-surface';
const ANCHOR_ATTRIBUTE = 'data-nyaitter-presence-anchor';
const TAB_ATTRIBUTE = 'data-nyaitter-presence-tab';
const TARGET_ATTRIBUTE = 'data-nyaitter-presence-target-id';
const TARGET_NAME_ATTRIBUTE = 'data-nyaitter-presence-target-name';
const TARGET_TYPE_ATTRIBUTE = 'data-nyaitter-presence-target-type';
const ITEM_ATTRIBUTE = 'data-nyaitter-presence-item';
const REMOTE_HELD_BLOCK_ATTRIBUTE = 'data-nyaitter-remote-held-block';

// Reject the entire held subtree, including a parent socket already occupied
// by a held block. Programmatic connections for received operations stay valid.
const isRemoteHeldBlock = block => {
    for (let current = block; current; current = current.getParent?.()) {
        if (current.getSvgRoot?.()?.getAttribute?.(REMOTE_HELD_BLOCK_ATTRIBUTE) === 'true') return true;
    }
    return false;
};
const heldConnection = connection => Boolean(connection &&
    (isRemoteHeldBlock(connection.getSourceBlock?.() || connection.sourceBlock_) ||
        isRemoteHeldBlock(connection.targetBlock?.())));

const installRemoteHeldConnectionGuard = () => {
    const Blockly = window.ScratchBlocks;
    const connection = Blockly?.Connection?.prototype;
    if (!connection || connection.nditorHeldGuardInstalled) return;
    connection.nditorHeldGuardInstalled = true;
    const allowed = connection.isConnectionAllowed;
    connection.isConnectionAllowed = function (candidate, ...args) {
        if (heldConnection(this) || heldConnection(candidate)) return false;
        return allowed.call(this, candidate, ...args);
    };
    const marker = Blockly.InsertionMarkerManager?.prototype;
    if (marker) {
        const apply = marker.applyConnections;
        marker.applyConnections = function (...args) {
            // Presence can arrive after the last drag update but before drop.
            if (heldConnection(this.closestConnection_) || heldConnection(this.localConnection_)) {
                Blockly.Events.disable();
                try {
                    this.hidePreview_();
                    this.closestConnection_ = null;
                    this.localConnection_ = null;
                } finally {
                    Blockly.Events.enable();
                }
                return;
            }
            return apply.apply(this, args);
        };
    }
};

const TAB_SURFACES = new Set(['blocks', 'costumes', 'sounds', 'variables']);
const COORDINATE_SPACE_ATTRIBUTE = 'data-nyaitter-presence-coordinate-space';
const BLOCKLY_COORDINATE_SPACE = 'blockly';
const PAINT_COORDINATE_SPACE = 'paint';

const clamp = (value, minimum = 0, maximum = 1) => Math.max(minimum, Math.min(maximum, value));

const finiteNumber = (value, fallback = null) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
};

const rectData = rect => (rect ? {
    left: finiteNumber(rect.left, 0),
    top: finiteNumber(rect.top, 0),
    width: Math.max(0, finiteNumber(rect.width, 0)),
    height: Math.max(0, finiteNumber(rect.height, 0))
} : null);

const numberAttribute = (element, name, fallback = null) => (
    element?.getAttribute ? finiteNumber(element.getAttribute(name), fallback) : fallback
);

const elementForCoordinateSpace = (surface, space) => {
    if (!surface?.querySelector) return null;
    return surface.querySelector(`[${COORDINATE_SPACE_ATTRIBUTE}="${space}"]`);
};

// The paint wrapper is deliberately marked for lifecycle and collaboration
// metadata, but Paper coordinates belong to the actual canvas. Selecting the
// wrapper here loses the view matrix and makes remote cursors disappear.
const paintCoordinateElement = surface => {
    if (!surface?.querySelector) return null;
    return surface.querySelector([
        `canvas[${COORDINATE_SPACE_ATTRIBUTE}="${PAINT_COORDINATE_SPACE}"]`,
        'canvas[data-nyaitter-paint-canvas="true"]',
        '[data-nyaitter-paint-surface="true"] canvas[resize]',
        '[data-nyaitter-paint-surface="true"] canvas'
    ].join(','));
};

const isVisible = element => {
    if (!element?.isConnected) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
};

const stageCoordinateElement = (surface, eventTarget = null) => {
    if (!surface?.querySelectorAll) return surface;
    const direct = eventTarget instanceof Element ? eventTarget.closest('canvas,video') : null;
    if (direct && surface.contains(direct) && isVisible(direct)) return direct;
    return [...surface.querySelectorAll('video,canvas')].find(isVisible) || surface;
};

const svgPointFromClient = (element, x, y) => {
    const svg = element?.ownerSVGElement;
    const screenCtm = element?.getScreenCTM?.();
    if (!svg?.createSVGPoint || !screenCtm?.inverse) return null;
    try {
        const point = svg.createSVGPoint();
        point.x = x;
        point.y = y;
        return point.matrixTransform(screenCtm.inverse());
    } catch (_) {
        return null;
    }
};

const blocklyWorkspace = () => {
    if (typeof window === 'undefined') return null;
    return window.AddonHooks?.blocklyWorkspace ||
        window.ScratchBlocks?.getMainWorkspace?.() ||
        window.ScratchBlocks?.mainWorkspace || null;
};

const blocklyCoordinateElement = surface => {
    const workspace = blocklyWorkspace();
    const canvas = workspace?.getCanvas?.();
    const svg = workspace?.getParentSvg?.() || canvas?.ownerSVGElement || null;
    if (svg && (!surface?.contains || surface.contains(svg))) return svg;
    return elementForCoordinateSpace(surface, BLOCKLY_COORDINATE_SPACE);
};

const blocklyCoordinateAt = (surface, x, y, eventTarget) => {
    const coordinateMarker = eventTarget?.closest?.(
        `[${COORDINATE_SPACE_ATTRIBUTE}="${BLOCKLY_COORDINATE_SPACE}"]`
    ) || elementForCoordinateSpace(surface, BLOCKLY_COORDINATE_SPACE);
    const coordinateElement = blocklyCoordinateElement(surface);
    if (!coordinateMarker || !coordinateElement || !isVisible(coordinateElement)) return null;
    const workspace = blocklyWorkspace();
    const canvas = workspace?.getCanvas?.();
    const point = svgPointFromClient(canvas, x, y);
    if (!point) return null;
    const metrics = workspace?.getMetrics?.() || {};
    return {
        model: BLOCKLY_COORDINATE_SPACE,
        x: finiteNumber(point.x, 0),
        y: finiteNumber(point.y, 0),
        scale: finiteNumber(workspace?.scale, 1),
        contentLeft: finiteNumber(metrics.contentLeft, 0),
        contentTop: finiteNumber(metrics.contentTop, 0),
        contentWidth: Math.max(1, finiteNumber(metrics.contentWidth, 1)),
        contentHeight: Math.max(1, finiteNumber(metrics.contentHeight, 1)),
        viewLeft: finiteNumber(metrics.viewLeft, 0),
        viewTop: finiteNumber(metrics.viewTop, 0),
        viewWidth: Math.max(1, finiteNumber(metrics.viewWidth, coordinateElement.clientWidth || 1)),
        viewHeight: Math.max(1, finiteNumber(metrics.viewHeight, coordinateElement.clientHeight || 1)),
        scrollLeft: finiteNumber(workspace?.scrollX, 0),
        scrollTop: finiteNumber(workspace?.scrollY, 0)
    };
};

const paintMatrix = canvas => {
    const liveMatrix = paper.view?.element === canvas ? paper.view.matrix : null;
    if (liveMatrix) {
        const {a, b, c, d, tx, ty} = liveMatrix;
        if ([a, b, c, d, tx, ty].every(Number.isFinite) && Math.abs((a * d) - (b * c)) > 1e-8) {
            return {a, b, c, d, tx, ty};
        }
    }
    const values = ['a', 'b', 'c', 'd', 'tx', 'ty'].map(name => (
        numberAttribute(canvas, `data-nyaitter-presence-matrix-${name}`)
    ));
    if (values.some(value => value === null)) return null;
    const [a, b, c, d, tx, ty] = values;
    const determinant = (a * d) - (b * c);
    return Math.abs(determinant) > 1e-8 ? {a, b, c, d, tx, ty} : null;
};

const paintViewSize = (canvas, rect) => {
    const view = paper.view?.element === canvas ? paper.view : null;
    return {
        width: Math.max(1, finiteNumber(view?.viewSize?.width,
            numberAttribute(canvas, 'data-nyaitter-presence-view-width', canvas.width || rect.width))),
        height: Math.max(1, finiteNumber(view?.viewSize?.height,
            numberAttribute(canvas, 'data-nyaitter-presence-view-height', canvas.height || rect.height)))
    };
};

const invertMatrixPoint = (matrix, x, y) => {
    if (!matrix) return null;
    const determinant = (matrix.a * matrix.d) - (matrix.b * matrix.c);
    if (Math.abs(determinant) <= 1e-8) return null;
    const dx = x - matrix.tx;
    const dy = y - matrix.ty;
    return {
        x: ((matrix.d * dx) - (matrix.c * dy)) / determinant,
        y: ((matrix.a * dy) - (matrix.b * dx)) / determinant
    };
};

const transformMatrixPoint = (matrix, x, y) => (matrix ? {
    x: (matrix.a * x) + (matrix.c * y) + matrix.tx,
    y: (matrix.b * x) + (matrix.d * y) + matrix.ty
} : null);

const paintCoordinateAt = (surface, x, y) => {
    const canvas = paintCoordinateElement(surface);
    if (!canvas || !isVisible(canvas)) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return null;
    const {width: viewWidth, height: viewHeight} = paintViewSize(canvas, rect);
    const viewX = (x - rect.left) / rect.width * viewWidth;
    const viewY = (y - rect.top) / rect.height * viewHeight;
    const matrix = paintMatrix(canvas);
    const projectPoint = invertMatrixPoint(matrix, viewX, viewY) || {
        x: numberAttribute(canvas, 'data-nyaitter-presence-view-left', 0) +
            (viewX / Math.max(0.0001, numberAttribute(canvas, 'data-nyaitter-presence-zoom', 1))),
        y: numberAttribute(canvas, 'data-nyaitter-presence-view-top', 0) +
            (viewY / Math.max(0.0001, numberAttribute(canvas, 'data-nyaitter-presence-zoom', 1)))
    };
    return {
        model: PAINT_COORDINATE_SPACE,
        x: finiteNumber(projectPoint.x, 0),
        y: finiteNumber(projectPoint.y, 0),
        viewWidth,
        viewHeight,
        matrix,
        zoom: numberAttribute(canvas, 'data-nyaitter-presence-zoom', 1)
    };
};

const surfaceLayout = surface => {
    if (!surface) return null;
    const rect = surface.getBoundingClientRect();
    return {
        rect: rectData(rect),
        scrollLeft: finiteNumber(surface.scrollLeft, 0),
        scrollTop: finiteNumber(surface.scrollTop, 0),
        contentWidth: Math.max(rect.width || 0, finiteNumber(surface.scrollWidth, 0), 1),
        contentHeight: Math.max(rect.height || 0, finiteNumber(surface.scrollHeight, 0), 1)
    };
};

const surfaceCoordinateAt = (surface, x, y, eventTarget) => (
    blocklyCoordinateAt(surface, x, y, eventTarget) || paintCoordinateAt(surface, x, y)
);

const findMarkedElement = (attribute, value, visibleOnly = true) => (
    [...document.querySelectorAll(`[${attribute}]`)].find(element => (
        element.getAttribute(attribute) === String(value) && (!visibleOnly || isVisible(element))
    )) || null
);

const visibleModalSurface = () => {
    const modals = [...document.querySelectorAll(`[${SURFACE_ATTRIBUTE}^="modal:"]`)].filter(isVisible);
    return modals.length > 0 ? modals[modals.length - 1] : null;
};

const currentTab = () => {
    // The visible panel is the editor's source of truth. React Tabs can keep
    // an old button state around while its panel is already switched, which
    // made a costume-editor cursor advertise the wrong tab.
    const visibleSurface = [...document.querySelectorAll(`[${SURFACE_ATTRIBUTE}]`)].find(surface => (
        TAB_SURFACES.has(surface.getAttribute(SURFACE_ATTRIBUTE)) && isVisible(surface)
    ));
    if (visibleSurface) return visibleSurface.getAttribute(SURFACE_ATTRIBUTE);

    const tabs = [...document.querySelectorAll(`[${TAB_ATTRIBUTE}]`)].filter(isVisible);
    const selected = tabs.find(tab => (
        tab.getAttribute('aria-selected') === 'true' ||
        tab.getAttribute('data-nyaitter-presence-selected') === 'true' ||
        /(^|\s)([^\s]*is-selected|[^\s]*tab--selected)(\s|$)/.test(tab.className || '')
    ));
    return selected?.getAttribute(TAB_ATTRIBUTE) || null;
};

const currentSelectedItem = surface => {
    if (!surface) return null;
    return [...surface.querySelectorAll(`[${ITEM_ATTRIBUTE}]`)].find(item => (
        item.getAttribute('data-nyaitter-presence-selected') === 'true' && isVisible(item)
    )) || null;
};

const targetElementAt = target => {
    if (!(target instanceof Element)) return null;
    return target.closest(`[${TARGET_ATTRIBUTE}]`);
};

const targetFromVm = (vm, targetId) => {
    if (!targetId) return null;
    return vm?.runtime?.getTargetById?.(targetId) || null;
};

const targetNameOf = target => target?.getName?.() || target?.name || target?.sprite?.name || null;

const targetDescriptor = (target, vm, markedElement = null) => {
    const markedTargetId = markedElement?.getAttribute(TARGET_ATTRIBUTE) || null;
    const targetId = target?.id || markedTargetId || null;
    const resolvedTarget = target || targetFromVm(vm, targetId);
    const targetType = resolvedTarget?.isStage ? 'stage' :
        markedElement?.getAttribute(TARGET_TYPE_ATTRIBUTE) || (targetId ? 'sprite' : null);
    const targetName = targetNameOf(resolvedTarget) ||
        markedElement?.getAttribute(TARGET_NAME_ATTRIBUTE) ||
        (targetType === 'stage' ? 'Stage' : null);
    return {targetId, targetName, targetType};
};

const findSurfaceAt = (target, x, y) => {
    let element = target instanceof Element ? target : null;
    if (!element && Number.isFinite(x) && Number.isFinite(y)) element = document.elementFromPoint(x, y);
    const surface = element?.closest?.(`[${SURFACE_ATTRIBUTE}]`);
    // The editor wrapper covers the entire page. It is not a coordinate
    // surface itself, so pointers in its gaps need document/viewport
    // coordinates rather than being normalized against an arbitrary layout.
    if (surface && isVisible(surface) && surface.getAttribute(SURFACE_ATTRIBUTE) !== 'editor') return surface;
    const modal = visibleModalSurface();
    if (modal) return modal;
    return null;
};

const viewportLayout = () => {
    const root = document.documentElement;
    return {
        rect: {left: 0, top: 0, width: window.innerWidth, height: window.innerHeight},
        scrollLeft: window.scrollX || root.scrollLeft || 0,
        scrollTop: window.scrollY || root.scrollTop || 0,
        contentWidth: Math.max(window.innerWidth, root.scrollWidth || 0, document.body?.scrollWidth || 0, 1),
        contentHeight: Math.max(window.innerHeight, root.scrollHeight || 0, document.body?.scrollHeight || 0, 1)
    };
};

const capturePresence = ({event = null, point = null, vm = null} = {}) => {
    const x = Number(event?.clientX ?? point?.x);
    const y = Number(event?.clientY ?? point?.y);
    const safeX = Number.isFinite(x) ? x : window.innerWidth / 2;
    const safeY = Number.isFinite(y) ? y : window.innerHeight / 2;
    const surface = findSurfaceAt(event?.target, safeX, safeY);
    const isViewport = !surface;
    const viewport = isViewport ? viewportLayout() : null;
    const surfaceId = isViewport ? 'viewport' : surface.getAttribute(SURFACE_ATTRIBUTE);
    const stageElement = surfaceId === 'stage' ? stageCoordinateElement(surface, event?.target) : null;
    const rect = isViewport ? viewport.rect : (stageElement || surface).getBoundingClientRect();
    const contentWidth = isViewport ? viewport.contentWidth : stageElement ? Math.max(rect.width, 1) :
        Math.max(rect.width, surface.scrollWidth || 0, 1);
    const contentHeight = isViewport ? viewport.contentHeight : stageElement ? Math.max(rect.height, 1) :
        Math.max(rect.height, surface.scrollHeight || 0, 1);
    const coordinate = isViewport ? null : surfaceCoordinateAt(surface, safeX, safeY, event?.target);
    const selectedItem = currentSelectedItem(surface);
    const editingTarget = vm?.editingTarget || vm?.runtime?.getEditingTarget?.();
    const markedTarget = targetElementAt(event?.target);
    const markedTargetId = markedTarget?.getAttribute(TARGET_ATTRIBUTE) || null;
    const target = markedTargetId ? targetFromVm(vm, markedTargetId) || {
        id: markedTargetId,
        isStage: markedTarget?.getAttribute(TARGET_TYPE_ATTRIBUTE) === 'stage',
        getName: () => markedTarget?.getAttribute(TARGET_NAME_ATTRIBUTE) || null
    } : editingTarget;
    const descriptor = targetDescriptor(target, vm, markedTarget);
    return {
        surface: surfaceId,
        x: surfaceId === 'viewport' ?
            clamp((safeX + viewport.scrollLeft) / contentWidth) :
            surfaceId === 'stage' ? clamp((safeX - rect.left) / contentWidth) :
                surfaceId === 'editor' ? clamp(safeX / Math.max(1, window.innerWidth)) :
                    clamp((safeX - rect.left + (surface.scrollLeft || 0)) / contentWidth),
        y: surfaceId === 'viewport' ?
            clamp((safeY + viewport.scrollTop) / contentHeight) :
            surfaceId === 'stage' ? clamp((safeY - rect.top) / contentHeight) :
                surfaceId === 'editor' ? clamp(safeY / Math.max(1, window.innerHeight)) :
                    clamp((safeY - rect.top + (surface.scrollTop || 0)) / contentHeight),
        layout: viewport || surfaceLayout(surface),
        ...(coordinate ? {coordinate} : {}),
        tab: currentTab(),
        targetId: descriptor.targetId || editingTarget?.id || null,
        targetName: descriptor.targetName || targetNameOf(editingTarget),
        targetType: descriptor.targetType || (editingTarget?.isStage ? 'stage' : null),
        item: selectedItem?.getAttribute(ITEM_ATTRIBUTE) || null
    };
};

const modalAnchor = surfaceId => {
    const id = String(surfaceId || '').replace(/^modal:/, '');
    const direct = findMarkedElement(ANCHOR_ATTRIBUTE, `modal:${id}`);
    if (direct) return direct;
    if (/costume|backdrop/i.test(id)) return findMarkedElement(ANCHOR_ATTRIBUTE, 'tab:costumes');
    if (/sound/i.test(id)) return findMarkedElement(ANCHOR_ATTRIBUTE, 'tab:sounds');
    if (/extension/i.test(id)) return findMarkedElement(ANCHOR_ATTRIBUTE, 'modal:extensionLibrary');
    return findMarkedElement(ANCHOR_ATTRIBUTE, 'modal:back') || findMarkedElement(SURFACE_ATTRIBUTE, 'editor');
};

const tabLabel = tab => ({
    blocks: 'ブロック',
    costumes: 'コスチューム',
    sounds: 'サウンド',
    variables: '変数'
}[tab] || '別画面');

const anchorResult = (element, key, label) => {
    const fallback = element || findMarkedElement(SURFACE_ATTRIBUTE, 'editor');
    if (!fallback) return null;
    const rect = fallback.getBoundingClientRect();
    return {
        mode: 'anchor',
        anchorKey: key,
        x: clamp(rect.right - 8, 8, window.innerWidth - 8),
        y: clamp(rect.top + 8, 8, window.innerHeight - 8),
        contextLabel: label
    };
};

const isInsideViewport = (element, clippingElement = null) => {
    if (!element || !isVisible(element)) return false;
    const rect = element.getBoundingClientRect();
    const clippingRect = clippingElement?.getBoundingClientRect?.();
    const left = Math.max(0, clippingRect?.left ?? 0);
    const top = Math.max(0, clippingRect?.top ?? 0);
    const right = Math.min(window.innerWidth, clippingRect?.right ?? window.innerWidth);
    const bottom = Math.min(window.innerHeight, clippingRect?.bottom ?? window.innerHeight);
    return rect.right > left && rect.left < right && rect.bottom > top && rect.top < bottom;
};

const findTargetElement = targetId => {
    if (!targetId) return null;
    const candidates = [...document.querySelectorAll(`[${TARGET_ATTRIBUTE}]`)]
        .filter(element => element.getAttribute(TARGET_ATTRIBUTE) === String(targetId));
    return candidates.find(element => {
        const targetPane = element.closest(`[${SURFACE_ATTRIBUTE}="targets"]`);
        return isInsideViewport(element, targetPane);
    }) || null;
};

const targetPaneAnchor = (targetId, label) => {
    const targetElement = findTargetElement(targetId);
    if (targetElement) return anchorResult(targetElement, `target:${targetId}`, label);
    const targetPane = findMarkedElement(SURFACE_ATTRIBUTE, 'targets') ||
        findMarkedElement(ANCHOR_ATTRIBUTE, 'targetPane');
    if (!targetPane) return null;
    return anchorResult(targetPane, `target-pane:${targetId || 'unknown'}`, label);
};

const editingSurfaceClip = (surface, coordinateElement = null) => {
    if (!surface || !isVisible(surface)) return null;
    const surfaceRect = surface.getBoundingClientRect();
    const coordinateRect = coordinateElement?.getBoundingClientRect?.();
    const left = Math.max(0, surfaceRect.left, coordinateRect?.left ?? surfaceRect.left);
    const top = Math.max(0, surfaceRect.top, coordinateRect?.top ?? surfaceRect.top);
    const right = Math.min(
        window.innerWidth,
        surfaceRect.right,
        coordinateRect?.right ?? surfaceRect.right
    );
    const bottom = Math.min(
        window.innerHeight,
        surfaceRect.bottom,
        coordinateRect?.bottom ?? surfaceRect.bottom
    );
    return right > left && bottom > top ? {left, top, right, bottom} : null;
};

const pointInClip = (point, clip) => Boolean(
    point && clip && point.x >= clip.left && point.x <= clip.right &&
    point.y >= clip.top && point.y <= clip.bottom
);

const screenPointForBlockly = (coordinate, surface) => {
    const coordinateElement = blocklyCoordinateElement(surface);
    const workspace = blocklyWorkspace();
    const canvas = workspace?.getCanvas?.();
    if (!coordinateElement || !isVisible(coordinateElement) || !canvas) return null;
    const screenCtm = canvas.getScreenCTM?.();
    const svg = canvas.ownerSVGElement || coordinateElement.ownerSVGElement || coordinateElement;
    if (screenCtm && svg?.createSVGPoint) {
        try {
            const point = svg.createSVGPoint();
            point.x = Number(coordinate.x);
            point.y = Number(coordinate.y);
            const screenPoint = point.matrixTransform(screenCtm);
            return {x: screenPoint.x, y: screenPoint.y, coordinateElement};
        } catch (_) {
            // Fall through to a metrics-based conversion for test DOMs and old SVG implementations.
        }
    }
    const rect = coordinateElement.getBoundingClientRect();
    const scale = finiteNumber(workspace.scale, finiteNumber(coordinate.scale, 1));
    const scrollLeft = finiteNumber(workspace.scrollX, finiteNumber(coordinate.scrollLeft, 0));
    const scrollTop = finiteNumber(workspace.scrollY, finiteNumber(coordinate.scrollTop, 0));
    return {
        x: rect.left + (Number(coordinate.x) * scale) + scrollLeft,
        y: rect.top + (Number(coordinate.y) * scale) + scrollTop,
        coordinateElement
    };
};

const screenPointForPaint = (coordinate, surface) => {
    const canvas = paintCoordinateElement(surface);
    if (!canvas || !isVisible(canvas)) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const {width: viewWidth, height: viewHeight} = paintViewSize(canvas, rect);
    const matrix = paintMatrix(canvas);
    const viewPoint = transformMatrixPoint(matrix, Number(coordinate.x), Number(coordinate.y)) || {
        x: (Number(coordinate.x) - numberAttribute(canvas, 'data-nyaitter-presence-view-left', 0)) *
            Math.max(0.0001, numberAttribute(canvas, 'data-nyaitter-presence-zoom', coordinate.zoom || 1)),
        y: (Number(coordinate.y) - numberAttribute(canvas, 'data-nyaitter-presence-view-top', 0)) *
            Math.max(0.0001, numberAttribute(canvas, 'data-nyaitter-presence-zoom', coordinate.zoom || 1))
    };
    return {
        x: rect.left + ((viewPoint.x / viewWidth) * rect.width),
        y: rect.top + ((viewPoint.y / viewHeight) * rect.height),
        coordinateElement: canvas
    };
};

const screenPointForCoordinate = (coordinate, surface) => {
    if (coordinate?.model === BLOCKLY_COORDINATE_SPACE) {
        return screenPointForBlockly(coordinate, surface);
    }
    if (coordinate?.model === PAINT_COORDINATE_SPACE) {
        return screenPointForPaint(coordinate, surface);
    }
    return null;
};

const resolvePresence = (presence, vm) => {
    const context = presence?.context;
    if (!context?.surface) {
        const width = Number(presence?.viewportWidth) || window.innerWidth;
        const height = Number(presence?.viewportHeight) || window.innerHeight;
        return {
            mode: 'cursor',
            anchorKey: null,
            x: clamp(Number(presence?.x) / width * window.innerWidth, 0, window.innerWidth),
            y: clamp(Number(presence?.y) / height * window.innerHeight, 0, window.innerHeight),
            contextLabel: ''
        };
    }

    const localModal = visibleModalSurface();
    const localModalId = localModal?.getAttribute(SURFACE_ATTRIBUTE) || null;
    const remoteIsModal = context.surface.startsWith('modal:');
    if (localModalId && localModalId !== context.surface) {
        return anchorResult(
            findMarkedElement(ANCHOR_ATTRIBUTE, 'modal:back') || localModal,
            `modal-back:${localModalId}`,
            remoteIsModal ? '別の画面' : tabLabel(context.tab)
        );
    }
    if (remoteIsModal && localModalId !== context.surface) {
        return anchorResult(modalAnchor(context.surface), context.surface, '別画面');
    }

    if (context.surface === 'editor') {
        return {
            mode: 'cursor',
            anchorKey: null,
            x: clamp(Number(context.x), 0, 1) * window.innerWidth,
            y: clamp(Number(context.y), 0, 1) * window.innerHeight,
            contextLabel: ''
        };
    }

    if (context.surface === 'viewport') {
        const layout = viewportLayout();
        return {
            mode: 'cursor',
            anchorKey: null,
            x: clamp((clamp(Number(context.x)) * layout.contentWidth) - layout.scrollLeft, 0, window.innerWidth),
            y: clamp((clamp(Number(context.y)) * layout.contentHeight) - layout.scrollTop, 0, window.innerHeight),
            contextLabel: ''
        };
    }

    const surface = findMarkedElement(SURFACE_ATTRIBUTE, context.surface);
    if (!surface) {
        const tab = TAB_SURFACES.has(context.surface) ? context.surface : context.tab;
        return anchorResult(
            findMarkedElement(ANCHOR_ATTRIBUTE, tab ? `tab:${tab}` : 'modal:back'),
            `surface:${context.surface}`,
            tabLabel(tab)
        );
    }

    if (context.surface === 'stage') {
        const coordinateElement = stageCoordinateElement(surface);
        const rect = coordinateElement.getBoundingClientRect();
        const point = {
            x: rect.left + (clamp(Number(context.x)) * rect.width),
            y: rect.top + (clamp(Number(context.y)) * rect.height)
        };
        if (!pointInClip(point, editingSurfaceClip(surface, coordinateElement))) return null;
        return {
            mode: 'cursor',
            anchorKey: null,
            x: clamp(point.x, 0, window.innerWidth),
            y: clamp(point.y, 0, window.innerHeight),
            contextLabel: ''
        };
    }

    const localTarget = vm?.editingTarget || vm?.runtime?.getEditingTarget?.();
    const remoteTarget = targetFromVm(vm, context.targetId);
    const targetScopedSurface = TAB_SURFACES.has(context.surface) || context.surface === 'targets';
    // Do not turn a cursor into a target-pane badge merely because an ID map is
    // temporarily unavailable. A real, resolved target must differ first.
    if (targetScopedSurface && remoteTarget && localTarget?.id !== remoteTarget.id) {
        const targetResult = targetPaneAnchor(
            remoteTarget.id,
            context.targetName || (context.targetType === 'stage' ? 'ステージ' : '別のスプライト')
        );
        if (targetResult) return targetResult;
    }

    if (context.item && ['costumes', 'sounds'].includes(context.surface)) {
        const selected = currentSelectedItem(surface)?.getAttribute(ITEM_ATTRIBUTE) || null;
        if (selected !== context.item) {
            return anchorResult(
                findMarkedElement(ITEM_ATTRIBUTE, context.item),
                `item:${context.item}`,
                context.surface === 'costumes' ? '別のコスチューム' : '別のサウンド'
            );
        }
    }

    if (context.coordinate?.model && Number.isFinite(Number(context.coordinate.x)) &&
        Number.isFinite(Number(context.coordinate.y))) {
        const coordinateElement = context.coordinate.model === PAINT_COORDINATE_SPACE ?
            paintCoordinateElement(surface) : elementForCoordinateSpace(surface, context.coordinate.model);
        const clip = editingSurfaceClip(
            surface,
            context.coordinate.model === BLOCKLY_COORDINATE_SPACE ?
                blocklyCoordinateElement(surface) : coordinateElement
        );
        const point = screenPointForCoordinate(context.coordinate, surface);
        if (pointInClip(point, clip)) {
            return {
                mode: 'cursor',
                anchorKey: null,
                x: clamp(point.x, 0, window.innerWidth),
                y: clamp(point.y, 0, window.innerHeight),
                contextLabel: ''
            };
        }
        // A point belonging to an existing paint canvas must never fall back to
        // the broader costume surface. That fallback placed remote cursors in
        // the toolbars when the other editor had scrolled the artboard away.
        if (context.coordinate.model !== PAINT_COORDINATE_SPACE || coordinateElement) return null;
        // Paint mounts asynchronously when switching costumes. Until there is
        // a local canvas, retain the surface-relative fallback for that brief
        // transition only.
    }

    const rect = surface.getBoundingClientRect();
    const contentWidth = Math.max(rect.width, surface.scrollWidth || 0, 1);
    const contentHeight = Math.max(rect.height, surface.scrollHeight || 0, 1);
    const x = rect.left + (clamp(Number(context.x)) * contentWidth) - (surface.scrollLeft || 0);
    const y = rect.top + (clamp(Number(context.y)) * contentHeight) - (surface.scrollTop || 0);
    if (!pointInClip({x, y}, editingSurfaceClip(surface))) return null;
    return {
        mode: 'cursor',
        anchorKey: null,
        x: clamp(x, 0, window.innerWidth),
        y: clamp(y, 0, window.innerHeight),
        contextLabel: ''
    };
};

const heldItemAt = target => {
    if (!(target instanceof Element)) return null;
    const item = target.closest(`[${ITEM_ATTRIBUTE}]`);
    if (!item) return null;
    const key = item.getAttribute(ITEM_ATTRIBUTE);
    const kind = item.getAttribute('data-nyaitter-presence-item-kind') || 'asset';
    const image = item.querySelector('img');
    return {key, kind, imageElement: image || null};
};

const imageThumbnail = image => new Promise(resolve => {
    if (!image) return resolve(null);
    const render = () => {
        try {
            const width = image.naturalWidth || image.width;
            const height = image.naturalHeight || image.height;
            if (!width || !height) return resolve(null);
            const scale = Math.min(1, 128 / Math.max(width, height));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(width * scale));
            canvas.height = Math.max(1, Math.round(height * scale));
            canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL('image/png'));
        } catch (_) {
            const source = String(image.currentSrc || image.src || '');
            resolve(source.startsWith('data:image/') && source.length <= 2 * 1024 * 1024 ? source : null);
        }
    };
    if (image.complete) render();
    else {
        image.addEventListener('load', render, {once: true});
        image.addEventListener('error', () => resolve(null), {once: true});
    }
});

const safeHeldItem = (incoming, previous = null) => {
    if (!incoming?.key) return null;
    const key = String(incoming.key).slice(0, 160);
    const kind = String(incoming.kind || (String(incoming.key).startsWith('block:') ? 'block' : 'asset')).slice(0, 40);
    const rawBlockId = incoming.blockId || (kind === 'block' && key.startsWith('block:') ? key.slice(6) : '');
    const blockId = rawBlockId ? String(rawBlockId).slice(0, 160) : null;
    const dragging = incoming.dragging === true;
    const rawImage = typeof incoming.image === 'string' ? incoming.image : '';
    const image = rawImage.startsWith('data:image/') && rawImage.length <= 2 * 1024 * 1024 ? rawImage : null;
    const normalized = {
        key,
        kind,
        dragging,
        ...(blockId ? {blockId} : {})
    };
    if (image) return {...normalized, image};
    if (previous?.key === key) return {...previous, ...normalized, image: previous.image || null};
    return {...normalized, image: null};
};

const findBlockElement = (blockId, root = document) => {
    const id = String(blockId || '');
    if (!id || !root?.querySelectorAll) return null;
    const elements = root.querySelectorAll('.blocklyDraggable,[data-id]');
    return [...elements].find(element => {
        if (element.classList?.contains('scratchCommentRect') ||
            element.classList?.contains('scratchCommentTopBar')) return false;
        return element.getAttribute?.('data-id') === id ||
            (element.id === id && element.classList?.contains('blocklyDraggable'));
    }) || null;
};

/*
 * Hide only the SVG root of a remotely held block.  Ownership is tracked per
 * participant so a delayed release from one peer cannot reveal a block that
 * another peer is still reporting as held.
 */
const createRemoteHeldBlockVisibilityController = ({getRoot = () => document} = {}) => {
    const blocks = new Map();
    const participantBlocks = new Map();

    const markElement = record => {
        installRemoteHeldConnectionGuard();
        const root = getRoot();
        const element = findBlockElement(record.blockId, root);
        if (record.element === element) {
            if (element && element.getAttribute?.(REMOTE_HELD_BLOCK_ATTRIBUTE) !== 'true') {
                element.setAttribute(REMOTE_HELD_BLOCK_ATTRIBUTE, 'true');
            }
            return;
        }
        if (record.element?.getAttribute?.(REMOTE_HELD_BLOCK_ATTRIBUTE) === 'true') {
            record.element.removeAttribute(REMOTE_HELD_BLOCK_ATTRIBUTE);
        }
        record.element = element;
        if (element) element.setAttribute(REMOTE_HELD_BLOCK_ATTRIBUTE, 'true');
    };

    const releaseParticipant = participantId => {
        const id = String(participantId || '');
        if (!id) return;
        const blockId = participantBlocks.get(id);
        if (!blockId) return;
        participantBlocks.delete(id);
        const record = blocks.get(blockId);
        if (!record) return;
        record.owners.delete(id);
        record.lastSeenByOwner.delete(id);
        if (record.owners.size > 0) return;
        if (record.element?.getAttribute?.(REMOTE_HELD_BLOCK_ATTRIBUTE) === 'true') {
            record.element.removeAttribute(REMOTE_HELD_BLOCK_ATTRIBUTE);
        }
        blocks.delete(blockId);
    };

    const update = (participantId, heldItem, now = Date.now()) => {
        const id = String(participantId || '');
        const blockId = heldItem?.kind === 'block' && heldItem.dragging === true ?
            String(heldItem.blockId || (heldItem.key || '').replace(/^block:/, '')) : '';
        if (!id) return;
        const previousBlockId = participantBlocks.get(id);
        if (!blockId) {
            releaseParticipant(id);
            return;
        }
        if (previousBlockId && previousBlockId !== blockId) releaseParticipant(id);
        let record = blocks.get(blockId);
        if (!record) {
            record = {blockId, owners: new Set(), lastSeenByOwner: new Map(), element: null};
            blocks.set(blockId, record);
        }
        record.owners.add(id);
        record.lastSeenByOwner.set(id, now);
        participantBlocks.set(id, blockId);
        markElement(record);
    };

    const refresh = () => {
        blocks.forEach(record => markElement(record));
    };

    const prune = (cutoff = Date.now()) => {
        const expired = [];
        blocks.forEach(record => {
            [...record.owners].forEach(participantId => {
                if ((record.lastSeenByOwner.get(participantId) || 0) >= cutoff) return;
                expired.push(participantId);
                releaseParticipant(participantId);
            });
        });
        return expired;
    };

    const clear = () => {
        blocks.forEach(record => {
            if (record.element?.getAttribute?.(REMOTE_HELD_BLOCK_ATTRIBUTE) === 'true') {
                record.element.removeAttribute(REMOTE_HELD_BLOCK_ATTRIBUTE);
            }
        });
        blocks.clear();
        participantBlocks.clear();
    };

    return {
        clear,
        prune,
        refresh,
        releaseParticipant,
        update
    };
};

export {
    capturePresence,
    createRemoteHeldBlockVisibilityController,
    findBlockElement,
    heldItemAt,
    imageThumbnail,
    resolvePresence,
    safeHeldItem
};
