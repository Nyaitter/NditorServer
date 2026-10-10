/* eslint-disable arrow-parens, brace-style, max-len, no-undefined, react/jsx-no-bind, react/jsx-no-literals, react/jsx-max-props-per-line, react/jsx-wrap-multilines, react/prop-types, require-atomic-updates */
import React from 'react';
import ReactDOM from 'react-dom';
import blockToImage from '../lib/backpack/block-to-image.js';
import CollaborationClient from './collaboration-client.js';
import CollaborationSync from './collaboration-sync.js';
import {setCollaborationActive} from './collaboration-session-state.js';
import ChatModal from './chat-modal.jsx';
import NyaitterIdBadge from './nyaitter-id-badge.jsx';
import CollaborationSettingsModal from './collaboration-settings-modal.jsx';
import FormModal from './form-modal.jsx';
import {
    createCollaborationRoom,
    decideCollaborationAccessRequest,
    getCollaborationAccessManagement,
    getCollaborationAccessRequestStatus,
    getCollaborationRoom,
    requestCollaborationAccess,
    updateCollaborationSettings
} from './collaboration-api.js';
import {ensureCloudCollaborationSession, getCloudProjectId, startAuth} from './cloud-project-api.js';
import {beginProjectLoading, isProjectLoading} from './project-loading-state.js';
import {getAuthSession, initializeAuthSession, refreshAuthSession} from './auth-session.js';
import {
    capturePresence,
    createRemoteHeldBlockVisibilityController,
    heldItemAt,
    imageThumbnail,
    resolvePresence,
    safeHeldItem
} from './collaboration-presence.js';
import styles from './collaboration-bridge.css';

const invitationUrl = token => {
    const url = new URL(window.location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('collab_token', token);
    return url.href;
};

const authDisplayName = user => user?.display_name || user?.name || user?.username || user?.handle || '';

const cursorColor = participantId => {
    const colors = ['#0969da', '#8250df', '#9a6700', '#1a7f37', '#cf222e', '#6e7781'];
    let hash = 0;
    String(participantId || '')
        .split('')
        .forEach(character => {
            hash = ((hash * 31) + character.charCodeAt(0)) >>> 0;
        });
    return colors[hash % colors.length];
};

const presenceSurfaceLabel = (context, fallback = '') => {
    const surface = String(context?.surface || '').replace(/^modal:/, '');
    const labels = new Map([
        ['blocks', 'ブロック'],
        ['costumes', 'コスチューム'],
        ['sounds', 'サウンド'],
        ['variables', '変数'],
        ['editor', 'エディター'],
        ['extensionLibrary', '拡張機能']
    ]);
    return labels.get(context?.tab) || labels.get(surface) || fallback || (surface ? '別画面' : '');
};

const CHAT_BUBBLE_MAX_WIDTH = 900;
const CHAT_BUBBLE_MIN_WIDTH = 44;
const CHAT_BUBBLE_EDGE_MARGIN = 12;
const CHAT_BUBBLE_ABOVE_THRESHOLD = 180;

/*
 * Keep this calculation aligned with the CSS width. The details panel is
 * positioned relative to the presence badge, so clamping its left edge here
 * keeps a wide message inside the viewport without changing cursor tracking.
 */
const chatBubbleWidth = (text, viewportWidth) => {
    const lineWidths = String(text || '')
        .split('\n')
        .map(line => Array.from(line).reduce((width, character) => (
            width + (/^[\x20-\x7e]$/.test(character) ? 6.8 : 12)
        ), 0));
    const contentWidth = Math.max(0, ...lineWidths) + 18;
    return Math.min(
        CHAT_BUBBLE_MAX_WIDTH,
        Math.max(CHAT_BUBBLE_MIN_WIDTH, contentWidth),
        Math.max(0, viewportWidth - (CHAT_BUBBLE_EDGE_MARGIN * 2))
    );
};

const chatBubbleLayout = ({resolved, x, y, text}) => {
    const viewportWidth = Math.max(1, window.innerWidth || 1);
    const viewportHeight = Math.max(1, window.innerHeight || 1);
    const width = chatBubbleWidth(text, viewportWidth);
    /* Cursor mode has an 18px cursor and a 4px flex gap before the badge. */
    const presenceLeft = resolved.mode === 'anchor' ? x - 22 : x + 22;
    const presenceRight = resolved.mode === 'anchor' ? x : x + 44;
    const preferredLeft = x < viewportWidth / 2 ? presenceLeft : presenceRight - width;
    const maximumLeft = Math.max(
        CHAT_BUBBLE_EDGE_MARGIN,
        viewportWidth - CHAT_BUBBLE_EDGE_MARGIN - width
    );
    const left = Math.max(CHAT_BUBBLE_EDGE_MARGIN, Math.min(preferredLeft, maximumLeft));
    return {
        above: y > viewportHeight - CHAT_BUBBLE_ABOVE_THRESHOLD,
        offset: left - presenceLeft,
        width
    };
};

const cursorFrameTime = () => (
    typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()
);

const cursorMotionKey = (cursor, resolved) => [
    resolved.mode,
    resolved.anchorKey || '',
    cursor?.context?.surface || '',
    cursor?.context?.tab || '',
    cursor?.context?.targetId || '',
    cursor?.context?.item || '',
    cursor?.context?.coordinate?.model || ''
].join('\u0001');

const sameInterpolatedCursors = (previous, next) => {
    const previousIds = Object.keys(previous);
    const nextIds = Object.keys(next);
    if (previousIds.length !== nextIds.length) return false;
    return nextIds.every(id => {
        const before = previous[id];
        const after = next[id];
        return before && before.motionKey === after.motionKey &&
            Math.abs(before.x - after.x) < 0.05 && Math.abs(before.y - after.y) < 0.05;
    });
};

/*
 * Presence arrives over the network at a much lower cadence than the display.
 * Keep the latest received position as a target, then resolve and approach it
 * on animation frames. Resolving here also keeps a remote cursor attached when
 * the local editor scrolls or changes layout between presence packets.
 */
const useInterpolatedRemoteCursors = (remoteCursors, vm) => {
    const cursorSourceRef = React.useRef(remoteCursors);
    const vmRef = React.useRef(vm);
    const motionRef = React.useRef({});
    const [interpolated, setInterpolated] = React.useState({});
    cursorSourceRef.current = remoteCursors;
    vmRef.current = vm;

    React.useEffect(() => {
        const schedule = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : callback => setTimeout(
            () => callback(cursorFrameTime()), 16
        );
        const cancel = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : clearTimeout;
        let frame = null;
        let stopped = false;
        let lastTime = cursorFrameTime();

        const renderFrame = timestamp => {
            if (stopped) return;
            const now = Number.isFinite(timestamp) ? timestamp : cursorFrameTime();
            const elapsed = Math.max(0, Math.min(100, now - lastTime));
            lastTime = now;
            const amount = 1 - Math.exp(-elapsed / 70);
            const next = {};
            Object.entries(cursorSourceRef.current).forEach(([participantId, cursor]) => {
                const resolved = resolvePresence(cursor, vmRef.current);
                if (!resolved) return;
                const motionKey = cursorMotionKey(cursor, resolved);
                const previous = motionRef.current[participantId];
                const snap = !previous || previous.motionKey !== motionKey;
                next[participantId] = {
                    ...resolved,
                    motionKey,
                    x: snap ? resolved.x : previous.x + ((resolved.x - previous.x) * amount),
                    y: snap ? resolved.y : previous.y + ((resolved.y - previous.y) * amount)
                };
            });
            motionRef.current = next;
            setInterpolated(current => sameInterpolatedCursors(current, next) ? current : next);
            frame = schedule(renderFrame);
        };

        if (Object.keys(remoteCursors).length) frame = schedule(renderFrame);
        else {
            motionRef.current = {};
            setInterpolated(current => Object.keys(current).length ? {} : current);
        }
        return () => {
            stopped = true;
            if (frame !== null) cancel(frame);
        };
    }, [remoteCursors]);

    return interpolated;
};

const blockElementAt = target => {
    if (typeof Element === 'undefined' || !(target instanceof Element)) return null;
    const element = target.closest('.blocklyDraggable');
    if (!element || element.classList.contains('scratchCommentRect') || element.classList.contains('scratchCommentTopBar')) return null;
    return element;
};

const isBlockDragExcludedTarget = target => {
    if (typeof Element === 'undefined' || !(target instanceof Element)) return false;
    return Boolean(target.closest([
        'input',
        'textarea',
        'select',
        '[contenteditable="true"]',
        '.blocklyHtmlInput',
        '.blocklyWidgetDiv',
        '.blocklyDropDownDiv',
        '.blocklyContextMenu',
        '.goog-menu',
        '.blocklyEditableText',
        '.blocklyDropdownText'
    ].join(',')));
};

const blockPresence = target => {
    const element = blockElementAt(target);
    if (!element) return null;
    const id = element.getAttribute('data-id') || element.id || '';
    return id ? {
        key: `block:${String(id).slice(0, 100)}`,
        kind: 'block',
        blockId: String(id).slice(0, 160),
        dragging: false,
        image: null
    } : null;
};

const BLOCK_INPUT_PREVIEW_MAX_TEXT = 2000;
const BLOCK_INPUT_PREVIEW_TYPES = new Set(['text', 'number', 'dropdown', 'textdropdown', 'unknown']);

const finitePresenceNumber = (value, fallback = null) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
};

const normalizePresenceCoordinate = coordinate => {
    if (!coordinate || typeof coordinate !== 'object') return null;
    const x = finitePresenceNumber(coordinate.x);
    const y = finitePresenceNumber(coordinate.y);
    if (x === null || y === null) return null;
    const normalized = {
        model: String(coordinate.model || '').slice(0, 24),
        x,
        y
    };
    [
        'scale',
        'contentLeft',
        'contentTop',
        'contentWidth',
        'contentHeight',
        'viewLeft',
        'viewTop',
        'viewWidth',
        'viewHeight',
        'scrollLeft',
        'scrollTop',
        'zoom'
    ].forEach(key => {
        const value = finitePresenceNumber(coordinate[key]);
        if (value !== null) normalized[key] = value;
    });
    if (coordinate.matrix && typeof coordinate.matrix === 'object') {
        const matrix = {};
        ['a', 'b', 'c', 'd', 'tx', 'ty'].forEach(key => {
            const value = finitePresenceNumber(coordinate.matrix[key]);
            if (value !== null) matrix[key] = value;
        });
        if (Object.keys(matrix).length === 6) normalized.matrix = matrix;
    }
    return normalized.model ? normalized : null;
};

const normalizePresenceLayout = layout => {
    if (!layout || typeof layout !== 'object') return null;
    const normalized = {};
    ['scrollLeft', 'scrollTop', 'contentWidth', 'contentHeight'].forEach(key => {
        const value = finitePresenceNumber(layout[key]);
        if (value !== null) normalized[key] = value;
    });
    if (layout.rect && typeof layout.rect === 'object') {
        const rect = {};
        ['left', 'top', 'width', 'height'].forEach(key => {
            const value = finitePresenceNumber(layout.rect[key]);
            if (value !== null) rect[key] = value;
        });
        if (Object.keys(rect).length === 4) normalized.rect = rect;
    }
    return Object.keys(normalized).length ? normalized : null;
};

const clampSelection = (value, length) => {
    if (!Number.isFinite(Number(value))) return null;
    return Math.max(0, Math.min(length, Math.trunc(Number(value))));
};

const blockFieldAtIndex = (block, fieldIndex) => {
    if (!block || !Number.isInteger(fieldIndex) || fieldIndex < 0) return null;
    let index = 0;
    for (const input of block.inputList || []) {
        for (const field of input.fieldRow || []) {
            if (index === fieldIndex) return field;
            index += 1;
        }
    }
    return null;
};

const remoteBlockFieldRect = preview => {
    const ScratchBlocks = window.ScratchBlocks;
    const workspace = ScratchBlocks?.getMainWorkspace?.() || ScratchBlocks?.mainWorkspace;
    const block = workspace?.getBlockById?.(preview.blockId);
    const field = block?.getField?.(preview.fieldName) || blockFieldAtIndex(block, preview.fieldIndex);
    const element = field?.getSvgRoot?.();
    if (!element?.isConnected) return null;
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height || rect.right < 0 || rect.bottom < 0 ||
        rect.left > window.innerWidth || rect.top > window.innerHeight) return null;
    return {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height
    };
};

const normalizeBlockInputPreview = (event, previous = null) => {
    const phase = ['start', 'update', 'end'].includes(event?.phase) ? event.phase : 'update';
    const blockId = String(event?.blockId || previous?.blockId || '').slice(0, 160);
    const fieldName = String(event?.fieldName || previous?.fieldName || '').slice(0, 160);
    const rawFieldIndex = event?.fieldIndex ?? previous?.fieldIndex;
    const fieldIndex = Number.isInteger(Number(rawFieldIndex)) && Number(rawFieldIndex) >= 0 ?
        Math.min(255, Number(rawFieldIndex)) : null;
    if (!blockId || (!fieldName && fieldIndex === null)) return null;
    const value = String(event?.value ?? previous?.value ?? '')
        .slice(0, BLOCK_INPUT_PREVIEW_MAX_TEXT);
    const selectionStart = clampSelection(event?.selectionStart, value.length);
    const selectionEnd = clampSelection(event?.selectionEnd, value.length);
    const fieldType = BLOCK_INPUT_PREVIEW_TYPES.has(event?.fieldType) ? event.fieldType :
        (previous?.fieldType || 'unknown');
    const anchor = event?.anchor && typeof event.anchor === 'object' ? {
        left: Number(event.anchor.left),
        top: Number(event.anchor.top),
        width: Number(event.anchor.width),
        height: Number(event.anchor.height)
    } : (previous?.anchor || null);
    return {
        phase,
        blockId,
        fieldName,
        fieldIndex,
        fieldType,
        value,
        displayValue: String(event?.displayValue ?? previous?.displayValue ?? value)
            .slice(0, BLOCK_INPUT_PREVIEW_MAX_TEXT),
        selectionStart,
        selectionEnd,
        targetId: event?.targetId ? String(event.targetId).slice(0, 160) : (previous?.targetId || null),
        targetName: event?.targetName ? String(event.targetName).slice(0, 80) : (previous?.targetName || null),
        anchor,
        viewportWidth: Number(event?.viewportWidth) || previous?.viewportWidth || window.innerWidth,
        viewportHeight: Number(event?.viewportHeight) || previous?.viewportHeight || window.innerHeight,
        updatedAt: Date.now()
    };
};

// Keep this fallback aligned with scratch-blocks/core/constants.js.  The
// runtime value is read from ScratchBlocks when it is available.
const BLOCK_DRAG_RADIUS = 3;

let soundHooksInstalled = false;
let globalHostSoundBroadcaster = null;

function ensureSoundHooksInstalled (audioEngine) {
    if (soundHooksInstalled || !audioEngine) return;
    try {
        const sample = audioEngine.createBank?.();
        if (!sample) return;
        const proto = Object.getPrototypeOf(sample);
        sample.dispose?.();
        if (!proto || typeof proto.playSound !== 'function') return;

        soundHooksInstalled = true;
        const origPlaySound = proto.playSound;
        const origStop = proto.stop;
        const origStopAllSounds = proto.stopAllSounds;

        proto.playSound = function (target, soundId) {
            try {
                if (globalHostSoundBroadcaster) {
                    globalHostSoundBroadcaster.playSound(target, soundId);
                }
            } catch (_) {}
            return origPlaySound.call(this, target, soundId);
        };

        proto.stop = function (target, soundId) {
            try {
                if (globalHostSoundBroadcaster) {
                    globalHostSoundBroadcaster.stopSound(target, soundId);
                }
            } catch (_) {}
            return origStop.call(this, target, soundId);
        };

        proto.stopAllSounds = function (target) {
            try {
                if (globalHostSoundBroadcaster) {
                    globalHostSoundBroadcaster.stopAllSounds(target);
                }
            } catch (_) {}
            return origStopAllSounds.call(this, target);
        };
    } catch (_) {}
}

const CollaborationBridge = ({vm: propVm}) => {
    const [vm, setVm] = React.useState(propVm || window.vm || null);
    const [role, setRole] = React.useState(null);
    const [, setStatus] = React.useState('');
    const [modal, setModal] = React.useState(null);
    const [notices, setNotices] = React.useState([]);
    const noticeTimersRef = React.useRef(new Map());
    const [participants, setParticipants] = React.useState([]);
    const [myParticipantId, setMyParticipantId] = React.useState(null);
    const [authReady, setAuthReady] = React.useState(Boolean(getAuthSession()?.user));
    const [chatOpen, setChatOpen] = React.useState(false);
    const [chatMessages, setChatMessages] = React.useState([]);
    const [cursorChats, setCursorChats] = React.useState({});
    const [cursorChatTyping, setCursorChatTyping] = React.useState({});
    const [unreadChatCount, setUnreadChatCount] = React.useState(0);
    const [remoteCursors, setRemoteCursors] = React.useState({});
    const [remoteBlockInputPreviews, setRemoteBlockInputPreviews] = React.useState({});
    const [, setPresenceLayoutVersion] = React.useState(0);
    const [inlineChatOpen, setInlineChatOpen] = React.useState(false);
    const [inlineChatText, setInlineChatText] = React.useState('');
    const [inlineChatPosition, setInlineChatPosition] = React.useState({x: window.innerWidth / 2, y: window.innerHeight / 2});
    const [runtimeStream, setRuntimeStream] = React.useState(null);
    const [runtimeMuted, setRuntimeMuted] = React.useState(true);
    const [stageSurface, setStageSurface] = React.useState(null);

    const vmRef = React.useRef(vm);
    const roleRef = React.useRef(role);
    const participantsRef = React.useRef(participants);
    const remoteHeldBlockVisibilityRef = React.useRef(createRemoteHeldBlockVisibilityController());
    const remoteHeldItemsRef = React.useRef(new Map());
    const clientRef = React.useRef(null);
    const collaborationSyncRef = React.useRef(null);
    const chatOpenRef = React.useRef(false);
    const heldBlockRef = React.useRef(null);
    const pendingDragRef = React.useRef(null);
    const cancelPendingDragRef = React.useRef(() => {});
    const heldBlockStartPointRef = React.useRef(null);
    const assetDragActiveRef = React.useRef(false);
    const localCursorPointRef = React.useRef({x: window.innerWidth / 2, y: window.innerHeight / 2});
    const localPresenceRef = React.useRef(null);
    const presenceVisibleRef = React.useRef(true);
    const lastSentHeldItemRef = React.useRef({key: null, image: null, dragging: false});
    const sendPresenceRef = React.useRef(() => {});
    const sendChatRef = React.useRef(() => {});
    const inlineChatInputRef = React.useRef(null);
    const cursorChatTimersRef = React.useRef(new Map());
    const remoteChatTypingTimersRef = React.useRef(new Map());
    const localChatTypingSourcesRef = React.useRef(new Set());
    const localChatTypingActiveRef = React.useRef(false);
    const localChatTypingKeepAliveRef = React.useRef(null);
    const inlineChatTypingStopTimerRef = React.useRef(null);
    const hostStreamRef = React.useRef(null);
    const hostAudioConnectionRef = React.useRef(null);
    const hostFrameCleanupRef = React.useRef(null);
    const autoProjectRef = React.useRef(null);
    const projectLoadingRef = React.useRef(isProjectLoading());
    const videoRef = React.useRef(null);
    const eventHandlerRef = React.useRef(() => {});
    const connectRef = React.useRef(() => {});
    const startSessionRef = React.useRef(() => {});
    const startHostStreamRef = React.useRef(() => {});
    const stopHostStreamRef = React.useRef(() => {});
    const requestHostFrameRef = React.useRef(() => {});
    const answerHandlerRef = React.useRef(null);
    const hostQuestionListenerRef = React.useRef(null);
    const hostStopAllListenerRef = React.useRef(null);
    const interpolatedRemoteCursors = useInterpolatedRemoteCursors(remoteCursors, vm);

    React.useEffect(() => {
        if (propVm) setVm(propVm);
    }, [propVm]);

    React.useEffect(() => {
        const previousVm = vmRef.current;
        vmRef.current = vm;
        if (vm && previousVm && previousVm !== vm && roleRef.current) {
            startSessionRef.current(roleRef.current);
            if (roleRef.current === 'host') {
                startHostStreamRef.current();
            }
        }
    }, [vm]);

    React.useEffect(() => {
        const applyLoadingState = active => {
            projectLoadingRef.current = Boolean(active);
            collaborationSyncRef.current?.setPaused(projectLoadingRef.current);
        };
        const changed = event => applyLoadingState(event.detail?.active);
        window.addEventListener('nditor-project-loading-changed', changed);
        applyLoadingState(isProjectLoading());
        return () => window.removeEventListener('nditor-project-loading-changed', changed);
    }, []);

    React.useEffect(() => {
        if (!vm?.runtime) return undefined;
        const onQuestionInput = (text, source) => {
            const answer = String(text ?? '');
            vm.runtime._collaborationQuestionInput = answer;
            if (!roleRef.current || !clientRef.current) return;
            if (roleRef.current === 'host') {
                clientRef.current.sendRuntimeQuestionInput(answer);
            } else if (!source?.remote) {
                clientRef.current.sendRuntimeCommand('question_input', {text: answer});
            }
        };
        vm.runtime.on('QUESTION_INPUT', onQuestionInput);
        return () => vm.runtime.off('QUESTION_INPUT', onQuestionInput);
    }, [vm]);

    React.useEffect(() => {
        roleRef.current = role;
        setCollaborationActive(role);
        window.dispatchEvent(new CustomEvent('nditor-collaboration-active', {detail: {active: Boolean(role), role}}));
    }, [role]);

    React.useEffect(() => {
        participantsRef.current = participants;
        window.dispatchEvent(new CustomEvent('nditor-collaboration-participants', {
            detail: {participants, myParticipantId}
        }));
    }, [participants, myParticipantId]);

    React.useEffect(() => {
        chatOpenRef.current = chatOpen;
    }, [chatOpen]);

    React.useEffect(() => () => {
        cursorChatTimersRef.current.forEach(timer => clearTimeout(timer));
        cursorChatTimersRef.current.clear();
    }, []);

    React.useEffect(() => {
        window.dispatchEvent(new CustomEvent('nditor-chat-unread', {detail: {unread: unreadChatCount}}));
    }, [unreadChatCount]);

    React.useEffect(() => () => {
        noticeTimersRef.current.forEach(clearTimeout);
        noticeTimersRef.current.clear();
    }, []);

    React.useEffect(() => {
        const updateAuth = () => setAuthReady(Boolean(getAuthSession()?.user));
        window.addEventListener('nyaitter-editor-auth-changed', updateAuth);
        // initializeAuthSession handles OAuth callbacks in the URL (nyaitter_auth_callback=1)
        // so login works even when the user lands directly on the editor after auth redirect.
        initializeAuthSession().then(session => setAuthReady(Boolean(session?.user)));
        return () => window.removeEventListener('nyaitter-editor-auth-changed', updateAuth);
    }, []);

    const showNotice = React.useCallback((message, kind = 'info') => {
        const id = `${Date.now()}-${Math.random()}`;
        setNotices(current => [{message, kind, id}, ...current]);
        const timer = setTimeout(() => {
            setNotices(current => current.filter(notice => notice.id !== id));
            noticeTimersRef.current.delete(id);
        }, 4500);
        noticeTimersRef.current.set(id, timer);
    }, []);

    const closeNotice = id => {
        clearTimeout(noticeTimersRef.current.get(id));
        noticeTimersRef.current.delete(id);
        setNotices(current => current.filter(notice => notice.id !== id));
    };

    const stopLocalChatTyping = React.useCallback(() => {
        const wasTyping = localChatTypingActiveRef.current;
        localChatTypingSourcesRef.current.clear();
        localChatTypingActiveRef.current = false;
        clearInterval(localChatTypingKeepAliveRef.current);
        localChatTypingKeepAliveRef.current = null;
        if (wasTyping) clientRef.current?.sendChatTyping?.(false);
    }, []);

    const setLocalChatTypingSource = React.useCallback((source, active) => {
        const sourceKey = String(source || 'chat');
        if (active) localChatTypingSourcesRef.current.add(sourceKey);
        else localChatTypingSourcesRef.current.delete(sourceKey);
        const nextActive = localChatTypingSourcesRef.current.size > 0;
        const wasTyping = localChatTypingActiveRef.current;
        if (nextActive === wasTyping) return;
        localChatTypingActiveRef.current = nextActive;
        clearInterval(localChatTypingKeepAliveRef.current);
        localChatTypingKeepAliveRef.current = null;
        if (!nextActive) {
            clientRef.current?.sendChatTyping?.(false);
            return;
        }
        clientRef.current?.sendChatTyping?.(true);
        localChatTypingKeepAliveRef.current = setInterval(() => {
            if (localChatTypingActiveRef.current) clientRef.current?.sendChatTyping?.(true);
        }, 1500);
    }, []);

    const markInlineChatTyping = React.useCallback(() => {
        setLocalChatTypingSource('inline', true);
        clearTimeout(inlineChatTypingStopTimerRef.current);
        inlineChatTypingStopTimerRef.current = setTimeout(() => {
            inlineChatTypingStopTimerRef.current = null;
            setLocalChatTypingSource('inline', false);
        }, 2000);
    }, [setLocalChatTypingSource]);

    const stopInlineChatTyping = React.useCallback(() => {
        clearTimeout(inlineChatTypingStopTimerRef.current);
        inlineChatTypingStopTimerRef.current = null;
        setLocalChatTypingSource('inline', false);
    }, [setLocalChatTypingSource]);

    React.useEffect(() => () => {
        stopLocalChatTyping();
        clearTimeout(inlineChatTypingStopTimerRef.current);
        inlineChatTypingStopTimerRef.current = null;
        remoteChatTypingTimersRef.current.forEach(timer => clearTimeout(timer));
        remoteChatTypingTimersRef.current.clear();
    }, [stopLocalChatTyping]);

    stopHostStreamRef.current = () => {
        globalHostSoundBroadcaster = null;
        hostQuestionListenerRef.current?.();
        hostQuestionListenerRef.current = null;
        hostStopAllListenerRef.current?.();
        hostStopAllListenerRef.current = null;
        hostFrameCleanupRef.current?.();
        hostFrameCleanupRef.current = null;
        requestHostFrameRef.current = () => {};
        if (hostAudioConnectionRef.current) {
            const {input, destination} = hostAudioConnectionRef.current;
            try {
                input.disconnect(destination);
            } catch (_) {
                hostAudioConnectionRef.current = null;
            }
            hostAudioConnectionRef.current = null;
        }
        hostStreamRef.current?.getTracks().forEach(track => track.stop());
        hostStreamRef.current = null;
        clientRef.current?.setLocalStream(null);
    };

    startHostStreamRef.current = () => {
        stopHostStreamRef.current();
        const currentVm = vmRef.current;
        if (!currentVm?.runtime) return;

        // In state synchronization mode, do not stream canvas video via WebRTC
        clientRef.current?.setLocalStream(null);

        if (currentVm.runtime.audioEngine) {
            ensureSoundHooksInstalled(currentVm.runtime.audioEngine);
        }

        globalHostSoundBroadcaster = {
            playSound: (target, soundId) => {
                if (roleRef.current !== 'host') return;
                const canonicalTargetId = collaborationSyncRef.current?.toCanonicalTargetId(target?.id) || target?.id;
                clientRef.current?.sendRuntimeSound(canonicalTargetId, soundId);
            },
            stopSound: (target, soundId) => {
                if (roleRef.current !== 'host') return;
                const canonicalTargetId = collaborationSyncRef.current?.toCanonicalTargetId(target?.id) || target?.id;
                clientRef.current?.sendRuntimeSoundStop(canonicalTargetId, soundId);
            },
            stopAllSounds: () => {
                if (roleRef.current !== 'host') return;
                clientRef.current?.sendRuntimeSoundStopAll();
            }
        };

        const onQuestion = question => {
            if (roleRef.current !== 'host') return;
            clientRef.current?.sendRuntimeQuestion(question);
        };
        currentVm.runtime.on('QUESTION', onQuestion);
        hostQuestionListenerRef.current = () => {
            currentVm.runtime?.off('QUESTION', onQuestion);
        };

        const onStopAll = () => {
            if (roleRef.current !== 'host') return;
            clientRef.current?.sendRuntimeSoundStopAll();
        };
        currentVm.runtime.on('PROJECT_STOP_ALL', onStopAll);
        hostStopAllListenerRef.current = () => {
            currentVm.runtime?.off('PROJECT_STOP_ALL', onStopAll);
        };
    };

    startSessionRef.current = sessionRole => {
        const currentVm = vmRef.current;
        collaborationSyncRef.current?.close();
        collaborationSyncRef.current = null;
        currentVm?.setCollaborationRuntimeHandler?.(null);
        if (answerHandlerRef.current && currentVm?.runtime) {
            currentVm.runtime.off('ANSWER', answerHandlerRef.current);
            answerHandlerRef.current = null;
        }
        if (sessionRole === 'guest') {
            currentVm?.runtime?.stopAll();
            if (!currentVm?.runtime?.frameLoop?.running) currentVm?.runtime?.start?.();
            const renderer = currentVm?.runtime?.renderer || currentVm?.renderer;
            if (renderer) {
                renderer.dirty = true;
                renderer.draw();
            }
            answerHandlerRef.current = answer => {
                clientRef.current?.sendRuntimeCommand('answer', {answer});
            };
            currentVm?.runtime?.on('ANSWER', answerHandlerRef.current);
        }
        currentVm?.setCollaborationRuntimeHandler?.(sessionRole === 'guest' ? command => {
            if (command.command === 'runtime_input') {
                clientRef.current?.sendRuntimeInput(command.device, command.data || {});
            } else {
                const {command: commandName, ...args} = command;
                const targetId = collaborationSyncRef.current?.toCanonicalTargetId(args.targetId);
                const blockId = commandName === 'stack_click' && args.blockId ?
                    collaborationSyncRef.current?.toCanonicalBlockId(args.blockId) || args.blockId : null;
                clientRef.current?.sendRuntimeCommand(commandName, {
                    ...args,
                    ...(targetId ? {targetId} : {}),
                    ...(blockId ? {blockId} : {})
                });
                if (commandName === 'green_flag') {
                    if (!currentVm.runtime?.frameLoop?.running) currentVm.runtime?.start?.();
                }
            }
            return true;
        } : null);
        if (!currentVm?.createCollaborationController) {
            showNotice('共同作業に対応したVMを読み込めませんでした。', 'error');
            return;
        }
        collaborationSyncRef.current = new CollaborationSync({
            vm: currentVm,
            role: sessionRole,
            getClient: () => clientRef.current,
            beginLoading: () => beginProjectLoading('collaboration-project'),
            isLoading: () => projectLoadingRef.current,
            onStatus: setStatus,
            onError: error => showNotice(`共同作業の変更を反映できませんでした: ${error.message}`, 'error')
        });
    };

    const executeRuntimeCommand = event => {
        if (roleRef.current !== 'host') return;
        const currentVm = vmRef.current;
        if (!currentVm) return;
        if (event.command === 'green_flag') {
            if (!currentVm.runtime?._steppingInterval) currentVm.start();
            currentVm.greenFlag();
        } else if (event.command === 'stop_all') {
            currentVm.stopAll();
        } else if (event.command === 'answer') {
            currentVm.runtime?.emit('ANSWER', event.args?.answer);
        } else if (event.command === 'question_input') {
            if (currentVm.runtime?._collaborationQuestion != null) {
                currentVm.runtime.emit('QUESTION_INPUT', event.args?.text, {remote: true});
            }
        } else if (event.command === 'stack_click') {
            const targetId = collaborationSyncRef.current?.toLocalTargetId(event.args?.targetId) || event.args?.targetId;
            const target = currentVm.runtime?.getTargetById(targetId);
            const blockId = collaborationSyncRef.current?.toLocalBlockId(event.args?.blockId) || event.args?.blockId;
            if (target && blockId) {
                currentVm.installCollaborationFlyoutBlocks?.(event.args.flyoutBlocks);
                let reportTimer = null;
                const reportHandler = report => {
                    if (report?.id !== blockId || report?.targetId !== target.id) return;
                    currentVm.removeListener('COLLABORATION_VISUAL_REPORT', reportHandler);
                    clearTimeout(reportTimer);
                    clientRef.current?.sendRuntimeReport({
                        id: collaborationSyncRef.current?.toCanonicalBlockId(report.id) || report.id,
                        value: report.value,
                        targetId: collaborationSyncRef.current?.toCanonicalTargetId(report.targetId) || report.targetId
                    }, event.from);
                };
                currentVm.on('COLLABORATION_VISUAL_REPORT', reportHandler);
                reportTimer = setTimeout(() => {
                    currentVm.removeListener('COLLABORATION_VISUAL_REPORT', reportHandler);
                }, 2000);
                currentVm.runtime.toggleScript(blockId, {target, stackClick: true});
            }
        } else if (event.command === 'variable_set') {
            currentVm.setVariableValue(
                collaborationSyncRef.current?.toLocalTargetId(event.args?.targetId) || event.args?.targetId,
                event.args?.variableId,
                event.args?.value
            );
        } else if (event.command === 'monitor_update') {
            currentVm.updateMonitor(event.args?.delta);
        } else if (event.command === 'monitor_visibility') {
            const targetId = collaborationSyncRef.current?.toLocalTargetId(event.args?.targetId) || event.args?.targetId;
            currentVm.applyCollaborationMonitorVisibility?.(
                targetId,
                event.args?.event,
                event.args?.block
            );
        }
    };

    const updateRemotePresence = event => {
        if (!event.from || event.from === clientRef.current?.participantId) return;
        const participantId = String(event.from);
        if (event.visible === false) {
            remoteHeldBlockVisibilityRef.current.releaseParticipant(participantId);
            remoteHeldItemsRef.current.delete(participantId);
            setRemoteCursors(current => {
                const next = {...current};
                delete next[participantId];
                return next;
            });
            return;
        }
        const hasHeldItem = Object.prototype.hasOwnProperty.call(event, 'heldItem');
        const previousHeldItem = remoteHeldItemsRef.current.get(participantId) || null;
        const heldItem = hasHeldItem ? safeHeldItem(event.heldItem, previousHeldItem) : previousHeldItem;
        if (hasHeldItem) {
            if (heldItem) remoteHeldItemsRef.current.set(participantId, heldItem);
            else remoteHeldItemsRef.current.delete(participantId);
            const localHeldItem = heldItem?.kind === 'block' && heldItem.blockId ? {
                ...heldItem,
                blockId: collaborationSyncRef.current?.toLocalBlockId(heldItem.blockId) || heldItem.blockId
            } : heldItem;
            remoteHeldBlockVisibilityRef.current.update(participantId, localHeldItem);
        }
        const remoteTargetId = collaborationSyncRef.current?.toLocalTargetId(event.context?.targetId) || event.context?.targetId;
        const context = event.context && typeof event.context === 'object' ? {
            surface: String(event.context.surface || '').slice(0, 120),
            x: Number(event.context.x),
            y: Number(event.context.y),
            tab: event.context.tab ? String(event.context.tab).slice(0, 40) : null,
            targetId: remoteTargetId ? String(remoteTargetId).slice(0, 160) : null,
            targetName: event.context.targetName ? String(event.context.targetName).slice(0, 80) : null,
            targetType: event.context.targetType ? String(event.context.targetType).slice(0, 20) : null,
            item: event.context.item ? String(event.context.item).slice(0, 160) : null,
            coordinate: normalizePresenceCoordinate(event.context.coordinate),
            layout: normalizePresenceLayout(event.context.layout)
        } : null;
        if (context && (!context.surface || !Number.isFinite(context.x) || !Number.isFinite(context.y))) return;
        if (!context && (!Number.isFinite(Number(event.x)) || !Number.isFinite(Number(event.y)))) return;
        const participant = participantsRef.current.find(candidate => candidate.id === participantId);
        const now = Date.now();
        setRemoteCursors(current => ({
            ...current,
            [participantId]: {
                context,
                x: Number(event.x),
                y: Number(event.y),
                viewportWidth: Number(event.viewportWidth),
                viewportHeight: Number(event.viewportHeight),
                name: String(event.name || participant?.name || 'ゲスト').slice(0, 80),
                color: event.color || cursorColor(participantId),
                heldItem,
                lastSeen: now
            }
        }));
    };

    const updateRemoteBlockInputPreview = event => {
        if (!event.from || event.from === clientRef.current?.participantId) return;
        setRemoteBlockInputPreviews(current => {
            const previous = current[event.from] || null;
            const targetId = collaborationSyncRef.current?.toLocalTargetId(event.targetId) || event.targetId;
            const preview = normalizeBlockInputPreview({...event, targetId}, previous);
            const next = {...current};
            if (!preview || preview.phase === 'end') {
                delete next[event.from];
                return next;
            }
            next[event.from] = {
                ...preview,
                participantId: event.from,
                name: String(event.name || participantsRef.current.find(participant => participant.id === event.from)?.name || 'ゲスト')
                    .slice(0, 80),
                color: event.color || cursorColor(event.from)
            };
            return next;
        });
    };

    const clearRemoteBlockInputPreview = participantId => {
        if (!participantId) return;
        setRemoteBlockInputPreviews(current => {
            if (!current[participantId]) return current;
            const next = {...current};
            delete next[participantId];
            return next;
        });
    };

    const clearRemotePaintPreview = participantId => {
        if (!participantId) return;
        window.dispatchEvent(new CustomEvent('nditor-collaboration-remote-paint', {
            detail: {participantId: String(participantId), cancelAll: true}
        }));
    };

    const updateRemotePaintPreview = event => {
        if (!event.from || event.from === clientRef.current?.participantId) return;
        const paint = event.paint && typeof event.paint === 'object' ? event.paint : null;
        if (!paint || !paint.targetId || !Number.isInteger(Number(paint.costumeIndex))) return;
        const targetId = collaborationSyncRef.current?.toLocalTargetId(paint.targetId) || paint.targetId;
        window.dispatchEvent(new CustomEvent('nditor-collaboration-remote-paint', {
            detail: {...paint, targetId, participantId: String(event.from), previewColor: event.color || cursorColor(event.from)}
        }));
    };

    const clearRemoteChatTyping = participantId => {
        const id = String(participantId || '');
        if (!id) return;
        clearTimeout(remoteChatTypingTimersRef.current.get(id));
        remoteChatTypingTimersRef.current.delete(id);
        setCursorChatTyping(current => {
            if (!current[id]) return current;
            const next = {...current};
            delete next[id];
            return next;
        });
    };

    const updateRemoteChatTyping = event => {
        const participantId = String(event?.from || '');
        if (!participantId || participantId === clientRef.current?.participantId) return;
        clearTimeout(remoteChatTypingTimersRef.current.get(participantId));
        remoteChatTypingTimersRef.current.delete(participantId);
        if (event.typing !== true) {
            setCursorChatTyping(current => {
                if (!current[participantId]) return current;
                const next = {...current};
                delete next[participantId];
                return next;
            });
            return;
        }
        setCursorChatTyping(current => ({...current, [participantId]: true}));
        const timer = setTimeout(() => {
            remoteChatTypingTimersRef.current.delete(participantId);
            setCursorChatTyping(current => {
                if (!current[participantId]) return current;
                const next = {...current};
                delete next[participantId];
                return next;
            });
        }, 4000);
        remoteChatTypingTimersRef.current.set(participantId, timer);
    };

    eventHandlerRef.current = event => {
        if (event.type === 'collaboration_joined') {
            setChatMessages((event.chat_history || []).map(message => ({...message, from: message.senderId})));
            const nextRole = event.host ? 'host' : 'guest';
            roleRef.current = nextRole;
            setRole(nextRole);
            const joinedParticipants = (event.participants || []).filter(participant => participant.id !== 'server-vm');
            setParticipants(joinedParticipants);
            setMyParticipantId(event.participantId || clientRef.current?.participantId || null);
            startSessionRef.current(nextRole);
            if (nextRole === 'host') {
                setStatus('共同作業に接続中（ホスト）');
                startHostStreamRef.current();
            } else if (event.room?.is_server_vm || clientRef.current?.isServerHosted) {
                setStatus('共同作業のプロジェクトを要求中…');
                if (!projectLoadingRef.current) collaborationSyncRef.current?.requestProject();
            } else {
                setStatus('ホストへの接続を待っています…');
            }
            return;
        }
        if (event.type === 'collaboration_participant_joined' && event.participant) {
            setParticipants(current => [...current.filter(participant => participant.id !== event.participant.id), event.participant]);
            if (event.participant.id !== 'server-vm') showNotice(`${event.participant.name || 'ゲスト'}が参加しました`);
            return;
        }
        if (event.type === 'collaboration_participant_left') {
            const departed = participantsRef.current.find(participant => participant.id === event.participant_id);
            if (departed && departed.id !== 'server-vm') showNotice(`${departed.name || 'ゲスト'}が退出しました`);
            remoteHeldBlockVisibilityRef.current.releaseParticipant(event.participant_id);
            remoteHeldItemsRef.current.delete(String(event.participant_id || ''));
            clearRemotePaintPreview(String(event.participant_id || ''));
            setParticipants(current => current.filter(participant => participant.id !== event.participant_id));
            clearTimeout(cursorChatTimersRef.current.get(event.participant_id));
            cursorChatTimersRef.current.delete(event.participant_id);
            clearRemoteChatTyping(event.participant_id);
            setCursorChats(current => {
                const next = {...current};
                delete next[event.participant_id];
                return next;
            });
            setRemoteCursors(current => {
                const next = {...current};
                delete next[event.participant_id];
                return next;
            });
            clearRemoteBlockInputPreview(event.participant_id);
            return;
        }
        if (event.type === 'collaboration_access_requested') {
            showNotice(`${event.name || 'ゲスト'}から参加申請が届きました`);
            return;
        }
        if (event.type === 'peer_disconnected') {
            clearRemoteBlockInputPreview(event.participant_id);
            clearRemoteChatTyping(event.participant_id);
            return;
        }
        if (event.type === 'participant_renamed') {
            setParticipants(current => current.map(participant => (
                participant.id === event.participantId ? {...participant, name: event.name} : participant
            )));
            return;
        }
        if (event.type === 'host_reassigned') {
            const nextRole = event.isHost ? 'host' : 'guest';
            roleRef.current = nextRole;
            setRole(nextRole);
            startSessionRef.current(nextRole);
            if (event.isHost) {
                setStatus('共同作業に接続中（ホスト）');
                startHostStreamRef.current();
            } else {
                stopHostStreamRef.current();
                setStatus(clientRef.current?.isServerHosted ? '共同作業に再接続中…' :
                    event.newHostId ? '新しいホストへ接続中…' : 'ホストの再接続を待っています…');
            }
            return;
        }
        if (event.type === 'peer_connected') {
            if (roleRef.current === 'host') {
                collaborationSyncRef.current?.sendProject(event.from);
            } else {
                setStatus(clientRef.current?.isServerHosted ? '共同作業のプロジェクトを要求中…' :
                    'ホストのプロジェクトを要求中…');
                collaborationSyncRef.current?.requestProject();
            }
            return;
        }
        if (collaborationSyncRef.current?.handle(event)) return;
        if (event.type === 'runtime_stream' && roleRef.current === 'guest') {
            return;
        }
        if (event.type === 'runtime_sound' && roleRef.current === 'guest') {
            const targetId = collaborationSyncRef.current?.toLocalTargetId(event.targetId) || event.targetId;
            const target = vmRef.current?.runtime?.getTargetById(targetId);
            if (target?.sprite?.soundBank) {
                target.sprite.soundBank.playSound(target, event.soundId);
            }
            return;
        }
        if (event.type === 'runtime_sound_stop_all' && roleRef.current === 'guest') {
            vmRef.current?.runtime?.stopAllSounds?.();
            return;
        }
        if (event.type === 'runtime_sound_stop' && roleRef.current === 'guest') {
            const targetId = collaborationSyncRef.current?.toLocalTargetId(event.targetId) || event.targetId;
            const target = vmRef.current?.runtime?.getTargetById(targetId);
            if (target?.sprite?.soundBank) {
                target.sprite.soundBank.stop(target, event.soundId);
            }
            return;
        }
        if (event.type === 'runtime_question' && roleRef.current === 'guest') {
            vmRef.current?.runtime?.emit('QUESTION', event.question);
            return;
        }
        if (event.type === 'runtime_question_input' && roleRef.current === 'guest') {
            vmRef.current?.runtime?.emit('QUESTION_INPUT', event.text, {remote: true});
            return;
        }
        if (event.type === 'runtime_command') {
            executeRuntimeCommand(event);
            return;
        }
        if (event.type === 'runtime_report' && roleRef.current === 'guest') {
            const report = event.report;
            const targetId = collaborationSyncRef.current?.toLocalTargetId(report?.targetId) || report?.targetId;
            const blockId = collaborationSyncRef.current?.toLocalBlockId(report?.id) || report?.id;
            const currentVm = vmRef.current;
            const blockExists = currentVm?.editingTarget?.id === targetId && (
                currentVm.editingTarget?.blocks?.getBlock?.(blockId) ||
                currentVm.runtime?.flyoutBlocks?.getBlock?.(blockId)
            );
            if (blockExists) currentVm.emit('VISUAL_REPORT', {id: blockId, value: report.value});
            return;
        }
        if (event.type === 'runtime_input' && roleRef.current === 'host') {
            if (event.device === 'mouse' || event.device === 'keyboard') {
                vmRef.current?.postIOData(event.device, event.data || {});
            }
            return;
        }
        if (event.type === 'block_input_preview') {
            updateRemoteBlockInputPreview(event);
            return;
        }
        if (event.type === 'presence') {
            updateRemotePresence(event);
            return;
        }
        if (event.type === 'paint_preview') {
            updateRemotePaintPreview(event);
            return;
        }
        if (event.type === 'chat_typing') {
            updateRemoteChatTyping(event);
            return;
        }
        if (event.type === 'chat') {
            if (event.presence) updateRemotePresence({...event.presence, from: event.from});
            setChatMessages(current => current.some(message => message.id === event.id) ? current : [...current, event].slice(-100));
            if (!chatOpenRef.current) setUnreadChatCount(current => current + 1);
            const participantId = event.from;
            if (participantId) {
                clearRemoteChatTyping(participantId);
                clearTimeout(cursorChatTimersRef.current.get(participantId));
                setCursorChats(current => ({
                    ...current,
                    [participantId]: {
                        id: event.id,
                        sender: String(event.sender || 'ゲスト').slice(0, 80),
                        text: String(event.text || '').slice(0, 1000)
                    }
                }));
                const timer = setTimeout(() => {
                    cursorChatTimersRef.current.delete(participantId);
                    setCursorChats(current => {
                        const next = {...current};
                        delete next[participantId];
                        return next;
                    });
                }, 6000);
                cursorChatTimersRef.current.set(participantId, timer);
            }
            return;
        }
        if (event.type === 'reconnecting') {
            setStatus('共同作業の接続を復旧しています…');
            return;
        }
        if (event.type === 'reconnected') {
            setStatus(roleRef.current === 'host' ? '共同作業に接続中（ホスト）' :
                clientRef.current?.isServerHosted ? '共同作業に再接続中…' : 'ホストへ再接続中…');
            if (roleRef.current === 'guest') collaborationSyncRef.current?.requestProject();
            return;
        }
        if (event.type === 'collaboration_closed') {
            showNotice(event.message || '共同作業セッションが終了しました。', 'info');
            resetConnection();
            return;
        }
        if (event.type === 'closed') {
            if (roleRef.current) {
                showNotice('共同作業ルームが終了しました。', 'info');
                resetConnection();
            }
            return;
        }
        if (event.type === 'access_error') {
            const token = clientRef.current?.token;
            if (token) {
                void getCollaborationRoom(token)
                    .then(room => setModal({type: 'access', room, token}))
                    .catch(error => showNotice(error.message || event.message, 'error'));
            }
            return;
        }
        if (event.type === 'error') showNotice(event.message || '共同作業で問題が発生しました。', 'error');
    };

    const resetConnection = React.useCallback(() => {
        window.dispatchEvent(new CustomEvent('nditor-collaboration-paint-cancel'));
        stopLocalChatTyping();
        clearTimeout(inlineChatTypingStopTimerRef.current);
        inlineChatTypingStopTimerRef.current = null;
        collaborationSyncRef.current?.close();
        collaborationSyncRef.current = null;
        if (answerHandlerRef.current && vmRef.current?.runtime) {
            vmRef.current.runtime.off('ANSWER', answerHandlerRef.current);
            answerHandlerRef.current = null;
        }
        vmRef.current?.setCollaborationRuntimeHandler?.(null);
        clientRef.current?.close();
        clientRef.current = null;
        stopHostStreamRef.current();
        roleRef.current = null;
        setRole(null);
        setStatus('');
        setMyParticipantId(null);
        setParticipants([]);
        setRemoteCursors({});
        setRemoteBlockInputPreviews({});
        remoteHeldBlockVisibilityRef.current.clear();
        remoteHeldItemsRef.current.clear();
        cursorChatTimersRef.current.forEach(timer => clearTimeout(timer));
        cursorChatTimersRef.current.clear();
        setCursorChats({});
        remoteChatTypingTimersRef.current.forEach(timer => clearTimeout(timer));
        remoteChatTypingTimersRef.current.clear();
        setCursorChatTyping({});
        setInlineChatOpen(false);
        setInlineChatText('');
        cancelPendingDragRef.current();
        heldBlockRef.current = null;
        pendingDragRef.current = null;
        heldBlockStartPointRef.current = null;
        assetDragActiveRef.current = false;
        localPresenceRef.current = null;
        lastSentHeldItemRef.current = {key: null, image: null, dragging: false};
        setRuntimeStream(null);
        setRuntimeMuted(true);
    }, [stopLocalChatTyping]);

    const connect = React.useCallback((room, guestName = '') => {
        resetConnection();
        clientRef.current = new CollaborationClient({
            token: room.token,
            hostTicket: room.host_ticket || null,
            guestName,
            onEvent: event => eventHandlerRef.current(event)
        }).connect();
    }, [resetConnection]);
    connectRef.current = connect;

    React.useEffect(() => {
        const openCollaboration = async () => {
            if (clientRef.current && roleRef.current) {
                const room = clientRef.current.room || await getCollaborationRoom(clientRef.current.token);
                if (roleRef.current === 'host' || room?.is_server_vm) {
                    const management = room.storage_type === 'cloud' ? null :
                        await getCollaborationAccessManagement(clientRef.current.token);
                    setModal({
                        type: 'settings',
                        room,
                        management,
                        token: clientRef.current.token,
                        url: invitationUrl(clientRef.current.token)
                    });
                } else {
                    setModal({type: 'invite', url: invitationUrl(clientRef.current.token)});
                }
            } else {
                await refreshAuthSession();
                setModal({type: 'host'});
            }
        };
        const toggleChat = () => {
            setChatOpen(current => {
                if (!current) setUnreadChatCount(0);
                return !current;
            });
        };
        const rename = event => clientRef.current?.updateGuestName(event.detail?.name);
        const editorNotice = event => showNotice(event.detail?.message || '', event.detail?.kind || 'info');
        const handleOpenCollaboration = () => void openCollaboration().catch(error => showNotice(error.message, 'error'));
        window.addEventListener('nyaitter-open-collaboration', handleOpenCollaboration);
        window.addEventListener('nditor-toggle-chat', toggleChat);
        window.addEventListener('nditor-update-participant-name', rename);
        window.addEventListener('nyaitter-editor-notice', editorNotice);
        return () => {
            window.removeEventListener('nyaitter-open-collaboration', handleOpenCollaboration);
            window.removeEventListener('nditor-toggle-chat', toggleChat);
            window.removeEventListener('nditor-update-participant-name', rename);
            window.removeEventListener('nyaitter-editor-notice', editorNotice);
        };
    }, [showNotice]);

    React.useEffect(() => {
        const sendPaintPreview = event => {
            if (!roleRef.current || !clientRef.current || !event.detail) return;
            const targetId = collaborationSyncRef.current?.toCanonicalTargetId(event.detail.targetId) || event.detail.targetId;
            clientRef.current.sendPaintPreview({...event.detail, targetId});
        };
        const paintSurfaceChanged = () => {
            window.dispatchEvent(new CustomEvent('nditor-collaboration-remote-paint', {
                detail: {cancelAll: true}
            }));
        };
        window.addEventListener('nditor-collaboration-paint', sendPaintPreview);
        window.addEventListener('nditor-collaboration-paint-surface', paintSurfaceChanged);
        return () => {
            window.removeEventListener('nditor-collaboration-paint', sendPaintPreview);
            window.removeEventListener('nditor-collaboration-paint-surface', paintSurfaceChanged);
        };
    }, []);

    React.useEffect(() => {
        const token = new URLSearchParams(window.location.search).get('collab_token');
        if (!token) return undefined;
        let cancelled = false;
        Promise.all([getCollaborationRoom(token), refreshAuthSession()])
            .then(([room, session]) => {
                if (cancelled) return;
                const user = session?.user || getAuthSession()?.user;
                if (!room.access?.granted) {
                    setModal({type: 'access', room, token});
                } else if (user) {
                    connect({token, host_ticket: null}, authDisplayName(user) || 'ゲスト');
                } else {
                    setModal({type: 'join', room, token});
                }
            })
            .catch(error => !cancelled && showNotice(error.message, 'error'));
        return () => {
            cancelled = true;
        };
    }, [connect, showNotice]);

    React.useEffect(() => {
        const startProjectSession = event => {
            const projectId = event?.detail?.projectId || getCloudProjectId();
            if (!projectId || new URLSearchParams(window.location.search).get('collab_token')) return;
            if (autoProjectRef.current === projectId && clientRef.current) return;
            if (clientRef.current) {
                if (!autoProjectRef.current) return;
                resetConnection();
            }
            autoProjectRef.current = projectId;
            Promise.all([ensureCloudCollaborationSession(projectId), refreshAuthSession()])
                .then(([room, session]) => {
                    if (autoProjectRef.current !== projectId || clientRef.current) return;
                    const user = session?.user || getAuthSession()?.user;
                    connectRef.current(room, authDisplayName(user) || (room?.is_server_vm ? 'ゲスト' : 'ホスト'));
                })
                .catch(error => {
                    if (autoProjectRef.current === projectId) autoProjectRef.current = null;
                    showNotice(error.message || '共同作業セッションを開始できませんでした。', 'error');
                });
        };
        window.addEventListener('nditor-cloud-project-loaded', startProjectSession);
        if (getCloudProjectId() && !clientRef.current) {
            startProjectSession();
        }
        return () => window.removeEventListener('nditor-cloud-project-loaded', startProjectSession);
    }, [resetConnection, showNotice]);

    React.useEffect(() => () => {
        resetConnection();
    }, [resetConnection]);

    React.useEffect(() => {
        let lastSentAt = 0;
        const sendPresence = (event, force = false) => {
            const client = clientRef.current;
            if (!client || !roleRef.current || !presenceVisibleRef.current) return;
            const now = performance.now();
            if (!force && now - lastSentAt < 33) return;
            lastSentAt = now;
            if (event && Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) {
                localCursorPointRef.current = {x: event.clientX, y: event.clientY};
            }
            const capturedContext = capturePresence({
                event,
                point: localCursorPointRef.current,
                vm: vmRef.current
            });
            const context = capturedContext?.targetId ? {
                ...capturedContext,
                targetId: collaborationSyncRef.current?.toCanonicalTargetId(capturedContext.targetId) || capturedContext.targetId
            } : capturedContext;
            if (!context) return;
            const user = getAuthSession()?.user;
            const heldItem = heldBlockRef.current;
            const canonicalHeldItem = heldItem?.kind === 'block' && heldItem.blockId ? {
                ...heldItem,
                blockId: collaborationSyncRef.current?.toCanonicalBlockId(heldItem.blockId) || heldItem.blockId
            } : heldItem;
            const lastHeld = lastSentHeldItemRef.current;
            let outboundHeldItem = null;
            if (canonicalHeldItem) {
                const imageChanged = canonicalHeldItem.image && canonicalHeldItem.image !== lastHeld.image;
                const keyChanged = canonicalHeldItem.key !== lastHeld.key;
                const draggingChanged = Boolean(canonicalHeldItem.dragging) !== Boolean(lastHeld.dragging);
                outboundHeldItem = keyChanged || imageChanged || draggingChanged ? canonicalHeldItem : {
                    key: canonicalHeldItem.key,
                    kind: canonicalHeldItem.kind,
                    ...(canonicalHeldItem.blockId ? {blockId: canonicalHeldItem.blockId} : {}),
                    dragging: Boolean(canonicalHeldItem.dragging)
                };
                lastSentHeldItemRef.current = {
                    key: canonicalHeldItem.key,
                    image: canonicalHeldItem.image || null,
                    dragging: Boolean(canonicalHeldItem.dragging)
                };
            } else if (lastHeld.key) {
                lastSentHeldItemRef.current = {key: null, image: null, dragging: false};
            }
            const payload = {
                context,
                name: authDisplayName(user) || client.guestName || 'ゲスト',
                color: cursorColor(client.participantId),
                heldItem: outboundHeldItem
            };
            localPresenceRef.current = {
                ...payload,
                heldItem: canonicalHeldItem ? {
                    key: canonicalHeldItem.key,
                    kind: canonicalHeldItem.kind,
                    ...(canonicalHeldItem.blockId ? {blockId: canonicalHeldItem.blockId} : {}),
                    dragging: Boolean(canonicalHeldItem.dragging),
                    image: canonicalHeldItem.image || null
                } : null
            };
            client.sendPresence(payload);
        };
        sendPresenceRef.current = sendPresence;
        const finishHeldItemImage = (heldItem, imagePromise) => {
            Promise.resolve(imagePromise)
                .then(image => {
                    if (!image || !String(image).startsWith('data:image/') || String(image).length > 2 * 1024 * 1024 ||
                        heldBlockRef.current?.key !== heldItem.key) return;
                    heldBlockRef.current = {...heldBlockRef.current, image};
                    sendPresence(null, true);
                })
                .catch(() => {});
        };
        let activationTimer = null;
        let activationFrame = null;
        const cancelActivationCheck = () => {
            if (activationTimer !== null) {
                clearTimeout(activationTimer);
                activationTimer = null;
            }
            if (activationFrame !== null) {
                cancelAnimationFrame(activationFrame);
                activationFrame = null;
            }
            if (pendingDragRef.current) pendingDragRef.current.activationScheduled = false;
        };
        const discardPendingDrag = () => {
            cancelActivationCheck();
            pendingDragRef.current?.observer?.disconnect();
            pendingDragRef.current = null;
            heldBlockStartPointRef.current = null;
        };
        cancelPendingDragRef.current = discardPendingDrag;
        const workspacesForDrag = () => {
            const ScratchBlocks = window.ScratchBlocks;
            const workspaces = [];
            const mainWorkspace = window.AddonHooks?.blocklyWorkspace ||
                ScratchBlocks?.getMainWorkspace?.() || ScratchBlocks?.mainWorkspace;
            if (mainWorkspace) workspaces.push(mainWorkspace);
            const allWorkspaces = ScratchBlocks?.Workspace?.getAll?.();
            if (Array.isArray(allWorkspaces)) {
                allWorkspaces.forEach(workspace => {
                    if (workspace && !workspaces.includes(workspace)) workspaces.push(workspace);
                });
            }
            return workspaces;
        };
        const getBlocklyDraggedBlock = pending => {
            const element = pending?.element;
            const hasDraggingClass = Boolean(
                element?.classList?.contains('blocklyDragging') || element?.closest?.('.blocklyDragging')
            );
            const workspaces = workspacesForDrag();
            if (!workspaces.length) return hasDraggingClass ? {id: pending.item.blockId} : null;
            for (const workspace of workspaces) {
                if (!workspace?.isDragging?.()) continue;
                const gesture = workspace.currentGesture_;
                if (!gesture?.isDragging?.()) continue;
                const targetBlock = gesture.targetBlock_ || gesture.startBlock_;
                if (targetBlock?.id === pending.item.blockId ||
                    (pending.inFlyout && targetBlock && gesture.flyout_)) return targetBlock;
                if (hasDraggingClass) return targetBlock || {id: pending.item.blockId};
            }
            return null;
        };
        const markBlockDragStarted = event => {
            const pending = pendingDragRef.current;
            if (!pending || pending.kind !== 'block' || pending.active) return false;
            const draggedBlock = pending.thresholdExceeded && getBlocklyDraggedBlock(pending);
            if (!draggedBlock?.id) return false;
            pending.active = true;
            pending.observer?.disconnect();
            cancelActivationCheck();
            const blockId = String(draggedBlock.id).slice(0, 160);
            const heldItem = {
                ...pending.item,
                key: `block:${blockId}`,
                blockId,
                dragging: true
            };
            heldBlockRef.current = heldItem;
            finishHeldItemImage(heldItem, Promise.resolve().then(() => blockToImage(heldItem.blockId)));
            sendPresence(event || pending.lastEvent || null, true);
            return true;
        };
        const scheduleBlockDragCheck = () => {
            const pending = pendingDragRef.current;
            if (!pending || pending.kind !== 'block' || !pending.thresholdExceeded || pending.active ||
                pending.activationScheduled) return;
            pending.activationScheduled = true;
            activationTimer = setTimeout(() => {
                activationTimer = null;
                const check = () => {
                    activationFrame = null;
                    if (pendingDragRef.current !== pending) return;
                    pending.activationScheduled = false;
                    markBlockDragStarted(pending.lastEvent);
                };
                if (typeof requestAnimationFrame === 'function') activationFrame = requestAnimationFrame(check);
                else check();
            }, 0);
        };
        const updateBlockDragCandidate = event => {
            const pending = pendingDragRef.current;
            if (!pending || pending.kind !== 'block' || pending.active) return;
            const x = Number(event.clientX);
            const y = Number(event.clientY);
            if (!Number.isFinite(x) || !Number.isFinite(y)) return;
            pending.lastPoint = {x, y};
            pending.lastEvent = event;
            if (!pending.thresholdExceeded) {
                const dx = x - pending.startPoint.x;
                const dy = y - pending.startPoint.y;
                pending.thresholdExceeded = Math.hypot(dx, dy) > pending.dragRadius;
            }
            if (!pending.thresholdExceeded) return;
            if (!markBlockDragStarted(event)) scheduleBlockDragCheck();
        };
        const cancelLocalDrag = () => {
            discardPendingDrag();
            heldBlockRef.current = null;
            heldBlockStartPointRef.current = null;
            assetDragActiveRef.current = false;
        };
        const pointerDown = event => {
            if (event.isPrimary === false) return;
            presenceVisibleRef.current = true;
            const primaryButton = !Number.isFinite(event.button) || event.button === 0;
            const block = primaryButton && !isBlockDragExcludedTarget(event.target) ? blockPresence(event.target) : null;
            const asset = primaryButton && !block ? heldItemAt(event.target) : null;
            discardPendingDrag();
            heldBlockRef.current = null;
            assetDragActiveRef.current = false;
            if (block) {
                const element = blockElementAt(event.target);
                const ScratchBlocks = window.ScratchBlocks;
                const configuredRadius = Number(ScratchBlocks?.DRAG_RADIUS);
                const dragRadius = Number.isFinite(configuredRadius) ? configuredRadius : BLOCK_DRAG_RADIUS;
                const point = {x: Number(event.clientX), y: Number(event.clientY)};
                const pending = {
                    kind: 'block',
                    item: block,
                    element,
                    inFlyout: Boolean(element?.closest?.('.blocklyFlyout')),
                    startPoint: point,
                    lastPoint: point,
                    lastEvent: event,
                    pointerId: event.pointerId,
                    dragRadius,
                    thresholdExceeded: false,
                    activationScheduled: false,
                    active: false,
                    observer: null
                };
                pendingDragRef.current = pending;
                heldBlockStartPointRef.current = point;
                if (typeof MutationObserver !== 'undefined' && element) {
                    pending.observer = new MutationObserver(() => {
                        if (pendingDragRef.current === pending) markBlockDragStarted(pending.lastEvent);
                    });
                    pending.observer.observe(element, {attributes: true, attributeFilter: ['class']});
                }
            } else if (asset) {
                pendingDragRef.current = {
                    kind: 'asset',
                    item: {key: asset.key, kind: asset.kind, image: null},
                    pointerId: event.pointerId
                };
            } else {
                heldBlockStartPointRef.current = null;
            }
            sendPresence(event, true);
        };
        const pointerMove = event => {
            if (event.isPrimary === false) return;
            presenceVisibleRef.current = true;
            localCursorPointRef.current = {x: event.clientX, y: event.clientY};
            if (inlineChatOpen) setInlineChatPosition(localCursorPointRef.current);
            updateBlockDragCandidate(event);
            sendPresence(event);
        };
        const pointerUp = event => {
            const pending = pendingDragRef.current;
            if (pending && pending.pointerId !== undefined && event.pointerId !== undefined &&
                pending.pointerId !== event.pointerId) return;
            discardPendingDrag();
            if (!assetDragActiveRef.current) heldBlockRef.current = null;
            heldBlockStartPointRef.current = null;
            sendPresence(event, true);
            setTimeout(() => sendPresence(null, true), 0);
        };
        const assetDragChanged = event => {
            const detail = event.detail || {};
            assetDragActiveRef.current = Boolean(detail.dragging);
            if (!detail.dragging || !detail.img) {
                discardPendingDrag();
                heldBlockRef.current = null;
                sendPresence(null, true);
                return;
            }
            const pending = pendingDragRef.current?.kind === 'asset' ? pendingDragRef.current : null;
            const heldItem = {
                ...(pending?.item || {
                    key: `asset:${String(detail.dragType || 'asset')}:${Date.now()}`,
                    kind: String(detail.dragType || 'asset')
                }),
                dragging: true,
                image: null
            };
            discardPendingDrag();
            assetDragActiveRef.current = true;
            heldBlockRef.current = heldItem;
            sendPresence(null, true);
            const image = new Image();
            image.src = String(detail.img);
            finishHeldItemImage(heldItem, imageThumbnail(image));
        };
        const hidePointer = () => {
            const client = clientRef.current;
            presenceVisibleRef.current = false;
            cancelLocalDrag();
            if (client && roleRef.current) client.sendPresence({visible: false});
        };
        const cancelOnEscape = event => {
            if (event.key !== 'Escape' || (!pendingDragRef.current && !heldBlockRef.current)) return;
            cancelLocalDrag();
            sendPresence(null, true);
        };
        const cancelOnContextMenu = () => {
            if (!pendingDragRef.current && !heldBlockRef.current) return;
            cancelLocalDrag();
            sendPresence(null, true);
        };
        const fallbackDragMove = event => updateBlockDragCandidate(event);
        const visibilityChanged = () => {
            if (document.hidden) hidePointer();
        };
        let layoutFrame = null;
        const layoutChanged = () => {
            if (layoutFrame !== null) return;
            layoutFrame = requestAnimationFrame(() => {
                layoutFrame = null;
                setPresenceLayoutVersion(version => version + 1);
                remoteHeldBlockVisibilityRef.current.refresh();
                sendPresence(null, true);
            });
        };
        const domObserver = typeof MutationObserver === 'undefined' ? null : new MutationObserver(layoutChanged);
        domObserver?.observe(document.body, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: [
                'class',
                'style',
                'aria-selected',
                'data-nyaitter-presence-selected',
                'data-nyaitter-presence-target-id',
                'data-nyaitter-presence-target-name'
            ]
        });
        const heartbeat = setInterval(() => {
            remoteHeldBlockVisibilityRef.current.refresh();
            sendPresence(null, true);
        }, 750);
        window.addEventListener('pointerdown', pointerDown, true);
        window.addEventListener('pointermove', pointerMove, true);
        window.addEventListener('pointerup', pointerUp, true);
        window.addEventListener('pointercancel', pointerUp, true);
        window.addEventListener('mousemove', fallbackDragMove, true);
        window.addEventListener('touchmove', fallbackDragMove, true);
        window.addEventListener('nditor-local-asset-drag', assetDragChanged);
        window.addEventListener('pointerleave', hidePointer);
        window.addEventListener('blur', hidePointer);
        window.addEventListener('keydown', cancelOnEscape, true);
        window.addEventListener('contextmenu', cancelOnContextMenu, true);
        document.addEventListener('visibilitychange', visibilityChanged);
        window.addEventListener('resize', layoutChanged);
        window.addEventListener('scroll', layoutChanged, true);
        window.addEventListener('transitionend', layoutChanged, true);
        return () => {
            clearInterval(heartbeat);
            if (layoutFrame !== null) cancelAnimationFrame(layoutFrame);
            sendPresenceRef.current = () => {};
            window.removeEventListener('pointerdown', pointerDown, true);
            window.removeEventListener('pointermove', pointerMove, true);
            window.removeEventListener('pointerup', pointerUp, true);
            window.removeEventListener('pointercancel', pointerUp, true);
            window.removeEventListener('mousemove', fallbackDragMove, true);
            window.removeEventListener('touchmove', fallbackDragMove, true);
            window.removeEventListener('nditor-local-asset-drag', assetDragChanged);
            window.removeEventListener('pointerleave', hidePointer);
            window.removeEventListener('blur', hidePointer);
            window.removeEventListener('keydown', cancelOnEscape, true);
            window.removeEventListener('contextmenu', cancelOnContextMenu, true);
            document.removeEventListener('visibilitychange', visibilityChanged);
            window.removeEventListener('resize', layoutChanged);
            window.removeEventListener('scroll', layoutChanged, true);
            window.removeEventListener('transitionend', layoutChanged, true);
            discardPendingDrag();
            cancelPendingDragRef.current = () => {};
            domObserver?.disconnect();
        };
    }, [inlineChatOpen]);

    React.useEffect(() => {
        let active = null;
        let frame = null;
        let sendTimer = null;
        let pendingPayload = null;
        let lastSentAt = 0;

        const blockFieldIndex = (block, field) => {
            let index = 0;
            for (const input of block?.inputList || []) {
                for (const candidate of input.fieldRow || []) {
                    if (candidate === field) return index;
                    index += 1;
                }
            }
            return null;
        };

        const getFieldType = (field, ScratchBlocks) => {
            const argTypes = String(field?.getArgTypes?.() || '');
            if (argTypes.includes('textdropdown')) return 'textdropdown';
            if (argTypes.includes('dropdown') || field instanceof (ScratchBlocks?.FieldDropdown || Function)) return 'dropdown';
            if (argTypes.includes('number') || field instanceof (ScratchBlocks?.FieldNumber || Function)) return 'number';
            if (argTypes.includes('text') || field instanceof (ScratchBlocks?.FieldTextInput || Function)) return 'text';
            return 'unknown';
        };

        const getActiveField = () => {
            const ScratchBlocks = window.ScratchBlocks;
            const widget = ScratchBlocks?.WidgetDiv;
            const dropdown = ScratchBlocks?.DropDownDiv;
            const widgetOwner = widget?.isVisible?.() ? widget.owner_ : null;
            const dropdownOwner = dropdown?.isVisible?.() ? dropdown.owner_ : null;
            const field = widgetOwner || dropdownOwner;
            const block = field?.sourceBlock_;
            const root = field?.getSvgRoot?.();
            const fieldIndex = blockFieldIndex(block, field);
            if (!field || !block || block.isInFlyout || !root?.isConnected ||
                (!field.name && fieldIndex === null)) return null;
            const input = widgetOwner === field ? ScratchBlocks?.FieldTextInput?.htmlInput_ ||
                widget?.DIV?.querySelector?.('.blocklyHtmlInput') : null;
            return {
                field,
                block,
                root,
                input,
                fieldType: getFieldType(field, ScratchBlocks),
                fieldIndex
            };
        };

        const getPreviewPayload = (current, phase, reason = null) => {
            const {field, block, root, input, fieldType, fieldIndex} = current;
            const text = input ? String(input.value || '') : String(field.getText?.() ?? field.getValue?.() ?? '');
            const rect = root.getBoundingClientRect();
            const target = vmRef.current?.editingTarget || vmRef.current?.runtime?.getEditingTarget?.();
            const user = getAuthSession()?.user;
            const client = clientRef.current;
            return {
                phase,
                reason: reason ? String(reason).slice(0, 32) : undefined,
                blockId: String(block.id || '').slice(0, 160),
                fieldName: String(field.name || '').slice(0, 160),
                fieldIndex,
                fieldType,
                value: text.slice(0, BLOCK_INPUT_PREVIEW_MAX_TEXT),
                displayValue: String(field.getText?.() ?? text).slice(0, BLOCK_INPUT_PREVIEW_MAX_TEXT),
                selectionStart: input && Number.isFinite(input.selectionStart) ? input.selectionStart : null,
                selectionEnd: input && Number.isFinite(input.selectionEnd) ? input.selectionEnd : null,
                targetId: target?.id || null,
                targetName: target?.getName?.() || null,
                anchor: {
                    left: Number(rect.left),
                    top: Number(rect.top),
                    width: Number(rect.width),
                    height: Number(rect.height)
                },
                viewportWidth: window.innerWidth,
                viewportHeight: window.innerHeight,
                name: authDisplayName(user) || client?.guestName || 'ゲスト',
                color: client ? cursorColor(client.participantId) : '#0969da'
            };
        };

        const sendNow = payload => {
            const client = clientRef.current;
            if (!client || !roleRef.current) return false;
            lastSentAt = performance.now();
            const targetId = collaborationSyncRef.current?.toCanonicalTargetId(payload?.targetId) || payload?.targetId;
            return client.sendBlockInputPreview({...payload, ...(targetId ? {targetId} : {})});
        };

        const sendPreview = (payload, force = false) => {
            if (!payload) return;
            const now = performance.now();
            if (!force && now - lastSentAt < 30) {
                pendingPayload = payload;
                if (sendTimer === null) {
                    sendTimer = setTimeout(() => {
                        sendTimer = null;
                        const pending = pendingPayload;
                        pendingPayload = null;
                        sendNow(pending);
                    }, Math.max(0, 30 - (now - lastSentAt)));
                }
                return;
            }
            pendingPayload = null;
            sendNow(payload);
        };

        const finish = reason => {
            if (!active) return;
            clearTimeout(sendTimer);
            sendTimer = null;
            pendingPayload = null;
            const payload = active.lastPayload ? {
                ...active.lastPayload,
                phase: 'end',
                reason: String(reason || 'blur').slice(0, 32)
            } : null;
            active = null;
            sendPreview(payload, true);
        };

        const sync = (force = false) => {
            const current = getActiveField();
            if (!current) {
                finish('blur');
                return;
            }
            const key = `${current.block.id}:${current.field.name || `#${current.fieldIndex}`}`;
            if (active && active.key !== key) finish('switch');
            if (!active) {
                active = {key, lastPayload: null};
                const startPayload = getPreviewPayload(current, 'start');
                active.lastPayload = startPayload;
                sendPreview(startPayload, true);
                return;
            }
            const updatePayload = getPreviewPayload(current, 'update');
            active.lastPayload = updatePayload;
            sendPreview(updatePayload, force);
        };

        const scheduleSync = (force = false) => {
            if (frame !== null) return;
            frame = requestAnimationFrame(() => {
                frame = null;
                sync(force);
            });
        };

        const isTextInput = target => target?.classList?.contains('blocklyHtmlInput');
        const onFocusIn = event => {
            if (isTextInput(event.target)) scheduleSync(true);
        };
        const onInput = event => {
            if (isTextInput(event.target)) scheduleSync();
        };
        const onSelectionChange = () => scheduleSync();
        const onPointerDown = () => scheduleSync(true);
        const onKeyDown = event => {
            if (!isTextInput(event.target)) return;
            if (event.key === 'Escape') finish('cancel');
            else if (event.key === 'Enter' || event.key === 'Tab') finish('commit');
            else scheduleSync();
        };
        const onFocusOut = () => setTimeout(() => sync(), 0);
        const onVisibilityChange = () => {
            if (document.visibilityState === 'hidden') finish('disconnect');
        };
        const interval = setInterval(() => sync(), 100);

        document.addEventListener('focusin', onFocusIn, true);
        document.addEventListener('input', onInput, true);
        document.addEventListener('selectionchange', onSelectionChange, true);
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown, true);
        document.addEventListener('focusout', onFocusOut, true);
        document.addEventListener('visibilitychange', onVisibilityChange);
        return () => {
            finish('disconnect');
            clearInterval(interval);
            clearTimeout(sendTimer);
            if (frame !== null) cancelAnimationFrame(frame);
            document.removeEventListener('focusin', onFocusIn, true);
            document.removeEventListener('input', onInput, true);
            document.removeEventListener('selectionchange', onSelectionChange, true);
            document.removeEventListener('pointerdown', onPointerDown, true);
            document.removeEventListener('keydown', onKeyDown, true);
            document.removeEventListener('focusout', onFocusOut, true);
            document.removeEventListener('visibilitychange', onVisibilityChange);
        };
    }, []);

    React.useEffect(() => {
        const timer = setInterval(() => {
            const cutoff = Date.now() - 15000;
            const expiredParticipants = remoteHeldBlockVisibilityRef.current.prune(cutoff);
            expiredParticipants.forEach(participantId => remoteHeldItemsRef.current.delete(participantId));
            setRemoteCursors(current => {
                const next = {};
                Object.keys(current).forEach(key => {
                    if (current[key].lastSeen >= cutoff) next[key] = current[key];
                });
                return next;
            });
            setRemoteBlockInputPreviews(current => {
                const next = {};
                Object.keys(current).forEach(key => {
                    if (current[key].updatedAt >= cutoff) next[key] = current[key];
                });
                return next;
            });
        }, 5000);
        return () => clearInterval(timer);
    }, []);

    React.useEffect(() => {
        const openInlineChat = event => {
            if (!roleRef.current || !event.ctrlKey || event.altKey || event.metaKey ||
                (event.code !== 'Slash' && event.key !== '/')) return;
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation?.();
            setInlineChatPosition(localCursorPointRef.current);
            setInlineChatOpen(open => {
                if (open) setInlineChatText('');
                return !open;
            });
        };
        window.addEventListener('keydown', openInlineChat, true);
        return () => window.removeEventListener('keydown', openInlineChat, true);
    }, []);

    React.useEffect(() => {
        if (!inlineChatOpen) return undefined;
        const frame = requestAnimationFrame(() => inlineChatInputRef.current?.focus());
        return () => cancelAnimationFrame(frame);
    }, [inlineChatOpen]);

    React.useEffect(() => {
        if (!inlineChatOpen) stopInlineChatTyping();
    }, [inlineChatOpen, stopInlineChatTyping]);

    React.useEffect(() => {
        if (!runtimeStream || role !== 'guest') {
            setStageSurface(null);
            return undefined;
        }
        const update = () => {
            const canvas = vmRef.current?.runtime?.renderer?.canvas || vmRef.current?.renderer?.canvas;
            if (!canvas?.isConnected) return;
            const surface = canvas.closest?.('[data-nyaitter-presence-surface="stage"]') || null;
            setStageSurface(current => (current === surface ? current : surface));
        };
        update();
        const interval = setInterval(update, 250);
        window.addEventListener('resize', update);
        window.addEventListener('scroll', update, true);
        return () => {
            clearInterval(interval);
            window.removeEventListener('resize', update);
            window.removeEventListener('scroll', update, true);
        };
    }, [runtimeStream, role]);

    React.useEffect(() => {
        if (!videoRef.current) return;
        if (videoRef.current.srcObject === runtimeStream) return;
        videoRef.current.srcObject = runtimeStream;
        if (runtimeStream) videoRef.current.play().catch(() => {});
    }, [runtimeStream, stageSurface]);

    const startHost = async values => {
        try {
            const session = await refreshAuthSession();
            const user = session?.user || getAuthSession()?.user;
            const room = await createCollaborationRoom({
                access_mode: values?.accessMode || 'private',
                allow_anonymous: values?.allowAnonymous !== false,
                invited_users: String(values?.invitedUsers || '').split(/[\s,]+/)
                    .filter(Boolean)
            });
            connect(room, authDisplayName(user) || values?.hostName || 'ホスト');
            setModal({type: 'invite', url: invitationUrl(room.token)});
        } catch (error) {
            showNotice(error.message || '共同作業を開始できませんでした。', 'error');
        }
    };

    const join = async values => {
        const session = await refreshAuthSession();
        const user = session?.user || getAuthSession()?.user;
        connect({token: modal.token, host_ticket: null}, authDisplayName(user) || values?.guestName || 'ゲスト');
        setModal(null);
    };

    const requestAccess = async values => {
        try {
            if (modal.room?.access?.requires_auth) {
                const result = await startAuth();
                window.sessionStorage.setItem('nditor:nyaitter-auth-state', result.state);
                window.location.assign(result.auth_url);
                return;
            }
            const user = getAuthSession()?.user;
            const result = await requestCollaborationAccess(
                modal.token,
                authDisplayName(user) || values?.guestName || ''
            );
            setModal(current => ({
                ...current,
                room: {
                    ...current.room,
                    access: {...current.room.access, status: result.status, request_id: result.request_id}
                }
            }));
        } catch (error) {
            showNotice(error.message || '参加申請を送れませんでした。', 'error');
        }
    };

    React.useEffect(() => {
        if (modal?.type !== 'access' || modal.room?.access?.status !== 'pending') return undefined;
        let disposed = false;
        const check = async () => {
            try {
                const result = await getCollaborationAccessRequestStatus(modal.token);
                if (disposed) return;
                if (result.granted) {
                    const [room, session] = await Promise.all([
                        getCollaborationRoom(modal.token),
                        refreshAuthSession()
                    ]);
                    if (disposed) return;
                    const user = session?.user || getAuthSession()?.user;
                    if (user) {
                        connectRef.current({token: modal.token, host_ticket: null}, authDisplayName(user) || 'ゲスト');
                        setModal(null);
                    } else {
                        setModal({type: 'join', room, token: modal.token});
                    }
                } else if (result.status === 'rejected') {
                    setModal(current => ({
                        ...current,
                        room: {...current.room, access: {...current.room.access, status: 'rejected'}}
                    }));
                }
            } catch (_) {
                return;
            }
        };
        const timer = setInterval(check, 3000);
        void check();
        return () => {
            disposed = true;
            clearInterval(timer);
        };
    }, [modal?.type, modal?.token, modal?.room?.access?.status]);

    const saveCollaborationSettings = async settings => {
        try {
            const room = await updateCollaborationSettings(modal.token, settings);
            const management = await getCollaborationAccessManagement(modal.token);
            if (clientRef.current) clientRef.current.room = {...clientRef.current.room, ...room};
            setModal(current => ({...current, room: {...current.room, ...room}, management}));
            showNotice('共同作業の設定を保存しました。');
        } catch (error) {
            showNotice(error.message || '共同作業の設定を保存できませんでした。', 'error');
        }
    };

    const decideAccessRequest = async (requestId, decision) => {
        try {
            await decideCollaborationAccessRequest(modal.token, requestId, decision);
            const management = await getCollaborationAccessManagement(modal.token);
            setModal(current => ({...current, management}));
        } catch (error) {
            showNotice(error.message || '参加申請を処理できませんでした。', 'error');
        }
    };

    const copyInvitation = async () => {
        try {
            await navigator.clipboard.writeText(modal.url);
            showNotice('招待URLをコピーしました');
        } catch (_) {
            showNotice('招待URLを選択してコピーしてください。', 'error');
        }
        setModal(null);
    };

    const sendChat = text => {
        setLocalChatTypingSource('modal', false);
        stopInlineChatTyping();
        sendPresenceRef.current(null, true);
        const user = getAuthSession()?.user;
        const currentPresence = localPresenceRef.current;
        const chatPresence = currentPresence ? {
            ...currentPresence,
            heldItem: currentPresence.heldItem ? {
                key: currentPresence.heldItem.key,
                kind: currentPresence.heldItem.kind,
                ...(currentPresence.heldItem.blockId ? {blockId: currentPresence.heldItem.blockId} : {}),
                dragging: Boolean(currentPresence.heldItem.dragging)
            } : null
        } : null;
        const message = clientRef.current?.sendChat(
            text,
            authDisplayName(user) || (roleRef.current === 'host' ? 'ホスト' : 'ゲスト'),
            chatPresence
        );
        if (message) setChatMessages(current => [...current, {...message, from: clientRef.current.participantId, isOwn: true}].slice(-100));
        else showNotice('共同作業に接続してからチャットを送信してください。', 'error');
    };
    sendChatRef.current = sendChat;

    const handleChatTypingChange = React.useCallback(active => {
        setLocalChatTypingSource('modal', active);
    }, [setLocalChatTypingSource]);

    const submitInlineChat = event => {
        event.preventDefault();
        event.stopPropagation();
        const message = inlineChatText.trim();
        stopInlineChatTyping();
        if (!message) return;
        sendChatRef.current(message);
        setInlineChatText('');
        setInlineChatOpen(false);
    };

    const sendStagePointer = (event, isDown) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const width = vmRef.current?.runtime?.stageWidth || 480;
        const height = vmRef.current?.runtime?.stageHeight || 360;
        clientRef.current?.sendRuntimeInput('mouse', {
            x: Math.max(0, Math.min(width, (event.clientX - rect.left) / rect.width * width)),
            y: Math.max(0, Math.min(height, (event.clientY - rect.top) / rect.height * height)),
            canvasWidth: width,
            canvasHeight: height,
            button: event.button || 0,
            ...(typeof isDown === 'boolean' ? {isDown} : {})
        });
    };

    const sendStageKey = (event, isDown) => {
        event.stopPropagation();
        clientRef.current?.sendRuntimeInput('keyboard', {key: event.key, isDown});
        if ([' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) event.preventDefault();
    };

    const remoteBlockInputPreviewPosition = (participantId, preview) => {
        const fieldRect = remoteBlockFieldRect(preview);
        if (fieldRect) return fieldRect;
        const cursor = remoteCursors[participantId];
        const resolved = cursor ? (interpolatedRemoteCursors[participantId] ||
            resolvePresence(cursor, vmRef.current)) : null;
        if (resolved) {
            return {
                left: resolved.x,
                top: resolved.y,
                width: Math.max(80, Number(preview.anchor?.width) || 160),
                height: Math.max(20, Number(preview.anchor?.height) || 24)
            };
        }
        const viewportWidth = Number(preview.viewportWidth) || window.innerWidth;
        const viewportHeight = Number(preview.viewportHeight) || window.innerHeight;
        const anchor = preview.anchor;
        if (!anchor || !Number.isFinite(anchor.left) || !Number.isFinite(anchor.top)) return null;
        return {
            left: Math.max(0, Math.min(window.innerWidth, anchor.left / viewportWidth * window.innerWidth)),
            top: Math.max(0, Math.min(window.innerHeight, anchor.top / viewportHeight * window.innerHeight)),
            width: Math.max(80, Number(anchor.width) || 160),
            height: Math.max(20, Number(anchor.height) || 24)
        };
    };
    const renderedBlockInputPreviews = Object.entries(remoteBlockInputPreviews)
        .map(([participantId, preview]) => {
            const position = remoteBlockInputPreviewPosition(participantId, preview);
            return position ? {participantId, preview, position} : null;
        })
        .filter(Boolean);

    const renderedCursors = [];
    const anchorGroupsByKey = new Map();
    Object.entries(remoteCursors).forEach(([participantId, cursor]) => {
        const resolved = interpolatedRemoteCursors[participantId] || resolvePresence(cursor, vmRef.current);
        if (!resolved) return;
        const targetName = cursor.context?.targetName || (
            resolved.anchorKey?.startsWith('target:') ? resolved.contextLabel : ''
        );
        const screenName = presenceSurfaceLabel(cursor.context, resolved.contextLabel);
        const chat = cursorChatTyping[participantId] ? {
            typing: true,
            text: '...'
        } : cursorChats[participantId];
        const inputPreview = remoteBlockInputPreviews[participantId] || null;
        const entry = {
            participantId,
            cursor,
            resolved,
            targetName,
            screenName,
            chat,
            inputPreview,
            x: resolved.x,
            y: resolved.y
        };
        if (resolved.mode === 'anchor') {
            const anchorKey = resolved.anchorKey || `anchor:${resolved.x}:${resolved.y}`;
            let group = anchorGroupsByKey.get(anchorKey);
            if (!group) {
                group = {
                    anchorKey,
                    resolved,
                    x: resolved.x,
                    y: resolved.y,
                    participants: []
                };
                anchorGroupsByKey.set(anchorKey, group);
            }
            group.participants.push(entry);
            return;
        }
        renderedCursors.push({
            ...entry,
            chatLayout: chat ? chatBubbleLayout({resolved, x: resolved.x, y: resolved.y, text: chat.text}) : null
        });
    });
    const renderedAnchorGroups = [...anchorGroupsByKey.values()].map(group => {
        const hasChat = group.participants.some(participant => participant.chat);
        return {
            ...group,
            hasChat,
            chatLayout: hasChat ? chatBubbleLayout({
                resolved: group.resolved,
                x: group.x,
                y: group.y,
                text: group.participants
                    .filter(participant => participant.chat)
                    .map(participant => participant.chat.text)
                    .join('\n')
            }) : null
        };
    });

    const renderRemoteBlockInputText = preview => {
        const isTextInput = ['text', 'number', 'textdropdown'].includes(preview.fieldType);
        const text = String(isTextInput ? preview.value : (preview.displayValue || preview.value || ''));
        if (!isTextInput) return text;
        const start = Number.isFinite(preview.selectionStart) ?
            Math.max(0, Math.min(text.length, preview.selectionStart)) : text.length;
        const end = Number.isFinite(preview.selectionEnd) ?
            Math.max(start, Math.min(text.length, preview.selectionEnd)) : start;
        return (<React.Fragment>
            {text.slice(0, start)}
            {start !== end && <span className={styles.remoteBlockInputSelection}>{text.slice(start, end)}</span>}
            <span className={styles.remoteBlockInputCaret} aria-hidden="true" />
            {text.slice(end)}
        </React.Fragment>);
    };

    return (<React.Fragment>
        {notices.length > 0 && <div className={styles.notices}>
            {notices.map(notice => <div
                key={notice.id}
                className={notice.kind === 'error' ? styles.noticeError : styles.notice}
                role="status"
            ><span>{notice.message}</span><button
                    type="button"
                    className={styles.noticeClose}
                    aria-label="通知を閉じる"
                    onClick={() => closeNotice(notice.id)}
                >×</button></div>)}
        </div>}
        {modal?.type === 'host' && <FormModal
            title="共同作業を開始"
            fields={[
                ...(authReady && getAuthSession()?.user ? [] : [{name: 'hostName', label: '表示名', value: '', maxLength: 40}]),
                {
                    name: 'accessMode',
                    label: '権限',
                    type: 'select',
                    value: 'private',
                    disabled: !authReady,
                    options: [
                        {value: 'invite', label: 'Invite — 招待または承認したユーザーのみ'},
                        {value: 'private', label: 'Private — URLを知っているユーザー'}
                    ]
                },
                {name: 'allowAnonymous', label: 'ゲストユーザーの参加を許可', type: 'checkbox', value: true, required: false, disabled: !authReady},
                {
                    name: 'invitedUsers',
                    label: '招待するNyaitterID（カンマ区切り）',
                    value: '',
                    required: false,
                    visibleWhen: values => values.accessMode === 'invite'
                }
            ]}
            submitLabel="招待URLを作成"
            onCancel={() => setModal(null)}
            onSubmit={startHost}
        />}
        {modal?.type === 'join' && <FormModal
            title="共同作業に参加"
            fields={authReady && getAuthSession()?.user ? [] : [{name: 'guestName', label: '表示名', value: '', maxLength: 40}]}
            submitLabel="参加"
            onCancel={() => setModal(null)}
            onSubmit={join}
        />}
        {modal?.type === 'access' && <FormModal
            title={modal.room?.access?.status === 'pending' ? '参加申請は承認待ちです' :
                modal.room?.access?.status === 'rejected' ? '参加申請が拒否されました' :
                    modal.room?.access?.requires_auth ? 'ログインが必要です' : '共同作業に参加申請'}
            fields={!modal.room?.access?.requires_auth && !getAuthSession()?.user &&
                modal.room?.access?.status !== 'pending' ?
                [{name: 'guestName', label: '表示名', value: '', maxLength: 40}] : []}
            submitLabel={modal.room?.access?.status === 'pending' ? '閉じる' :
                modal.room?.access?.requires_auth ? 'NyaitterIDでログイン' : '参加申請を送る'}
            onCancel={() => setModal(null)}
            onSubmit={modal.room?.access?.status === 'pending' ? () => setModal(null) : requestAccess}
        />}
        {modal?.type === 'invite' && <FormModal
            title="共同作業の招待"
            fields={[{name: 'url', label: '招待URL', value: modal.url, readOnly: true}]}
            submitLabel="コピーして閉じる"
            onCancel={() => setModal(null)}
            onSubmit={copyInvitation}
        />}
        {modal?.type === 'settings' && <CollaborationSettingsModal
            room={modal.room}
            url={modal.url}
            management={modal.management}
            onClose={() => setModal(null)}
            canChangePolicy={Boolean(getAuthSession()?.user)}
            onSave={saveCollaborationSettings}
            onDecision={decideAccessRequest}
            onOpenCloudSettings={() => {
                setModal(null);
                window.dispatchEvent(new CustomEvent('nditor-open-cloud-modal', {detail: {tab: 'settings'}}));
            }}
        />}
        <ChatModal
            isOpen={chatOpen}
            onClose={() => {
                setLocalChatTypingSource('modal', false);
                setChatOpen(false);
            }}
            messages={chatMessages}
            onSendMessage={sendChat}
            onTypingChange={handleChatTypingChange}
            currentParticipantId={clientRef.current?.participantId}
            participants={participants}
        />
        {inlineChatOpen && <form
            className={styles.inlineChat}
            style={{
                left: `${Math.max(8, Math.min(window.innerWidth - 300, inlineChatPosition.x + 18))}px`,
                top: `${Math.max(8, Math.min(window.innerHeight - 48, inlineChatPosition.y + 18))}px`
            }}
            onSubmit={submitInlineChat}
        >
            <input
                ref={inlineChatInputRef}
                maxLength={500}
                placeholder="メッセージを入力"
                type="text"
                value={inlineChatText}
                onChange={event => {
                    setInlineChatText(event.target.value);
                    markInlineChatTyping();
                }}
                onKeyDown={event => {
                    event.stopPropagation();
                    if (event.key === 'Escape') {
                        event.preventDefault();
                        setInlineChatText('');
                        stopInlineChatTyping();
                        setInlineChatOpen(false);
                        return;
                    }
                    markInlineChatTyping();
                }}
                onCompositionStart={markInlineChatTyping}
                onCompositionUpdate={markInlineChatTyping}
                onBlur={stopInlineChatTyping}
            />
            <button disabled={!inlineChatText.trim()} type="submit">送信</button>
        </form>}
        {renderedBlockInputPreviews.map(({participantId, preview, position}) => (
            <div
                key={`block-input-preview-${participantId}`}
                aria-hidden="true"
                className={styles.remoteBlockInputPreview}
                style={{
                    left: `${position.left}px`,
                    top: `${position.top}px`,
                    minWidth: `${position.width}px`,
                    minHeight: `${position.height}px`,
                    borderColor: preview.color
                }}
            >
                <span className={styles.remoteBlockInputPreviewText}>{renderRemoteBlockInputText(preview)}</span>
            </div>
        ))}
        {runtimeStream && role === 'guest' && stageSurface && ReactDOM.createPortal(<video
            ref={videoRef}
            className={styles.runtimeStream}
            autoPlay
            muted={runtimeMuted}
            playsInline
            tabIndex="0"
            aria-label="共同作業のステージ"
            onPointerDown={event => {
                if (runtimeMuted) {
                    setRuntimeMuted(false);
                    event.currentTarget.muted = false;
                    event.currentTarget.play().catch(() => {});
                }
                event.currentTarget.focus();
                event.currentTarget.setPointerCapture?.(event.pointerId);
                sendStagePointer(event, true);
            }}
            onPointerMove={event => sendStagePointer(event)}
            onPointerUp={event => sendStagePointer(event, false)}
            onPointerCancel={event => sendStagePointer(event, false)}
            onContextMenu={event => event.preventDefault()}
            onKeyDown={event => sendStageKey(event, true)}
            onKeyUp={event => sendStageKey(event, false)}
        />, stageSurface)}
        {renderedCursors.map(({participantId, cursor, chat, chatLayout, inputPreview, x, y}) => (
            <div
                key={participantId}
                className={styles.remoteCursor}
                style={{left: `${x}px`, top: `${y}px`}}
            >
                {inputPreview && ['text', 'number', 'textdropdown'].includes(inputPreview.fieldType) ? <svg
                    className={styles.cursorTextSvg}
                    width="12"
                    height="22"
                    viewBox="0 0 12 22"
                >
                    <title>入力中のテキストカーソル</title>
                    <path d="M2 1v20M10 1v20M1 1h10M1 21h10" fill="none" stroke={cursor.color} strokeWidth="1.5" />
                </svg> : <svg className={styles.cursorSvg} width="18" height="22" viewBox="0 0 18 22">
                    <title>参加者のカーソル</title>
                    <path d="M1 1l15 9-7 2 4 7-3 2-4-8-5 5z" fill={cursor.color} stroke="#ffffff" strokeWidth="1.5" />
                </svg>}
                <div className={styles.cursorPresence}>
                    <strong
                        className={styles.cursorNameTag}
                        style={{backgroundColor: cursor.color}}
                    >
                        {cursor.name || 'ゲスト'}
                        {participants.some(participant => participant.id === participantId && participant.user_id) &&
                            <NyaitterIdBadge />}
                    </strong>
                    {chat && <span
                        aria-label={chat.typing ? '入力中' : undefined}
                        aria-live="polite"
                        className={`${styles.cursorChatBubble} ${styles.cursorInlineChat} ${chat.typing ? styles.cursorChatTyping : ''} ${chatLayout?.above ? styles.cursorInlineChatAbove : ''}`}
                        style={chatLayout ? {
                            left: `${chatLayout.offset}px`,
                            width: `${chatLayout.width}px`
                        } : null}
                    >
                        {chat.text}
                    </span>}
                    {cursor.heldItem?.dragging && cursor.heldItem?.image && <img
                        className={styles.cursorHeldItem}
                        data-kind={cursor.heldItem.kind}
                        draggable={false}
                        src={cursor.heldItem.image}
                    />}
                </div>
            </div>
        ))}
        {renderedAnchorGroups.map(({anchorKey, resolved, x, y, participants: groupParticipants, hasChat, chatLayout}) => (
            <div
                key={anchorKey}
                className={`${styles.remoteCursor} ${styles.remoteCursorAnchor}`}
                style={{left: `${x}px`, top: `${y}px`}}
            >
                <div className={styles.cursorPresence}>
                    <button
                        aria-label={`${resolved.contextLabel || '別画面'}にいる参加者 ${groupParticipants.length}人: ${groupParticipants.map(participant => participant.cursor.name || 'ゲスト').join('、')}`}
                        className={`${styles.cursorBadge} ${hasChat ? styles.cursorBadgeHasChat : ''}`}
                        title="参加者の詳細を表示"
                        type="button"
                    >
                        <span aria-hidden="true">{groupParticipants.length}</span>
                    </button>
                    <div
                        className={`${styles.cursorPresenceDetails} ${hasChat ? styles.cursorPresenceDetailsWithChat : ''} ${chatLayout?.above ? styles.cursorPresenceDetailsAbove : ''}`}
                        style={chatLayout ? {
                            left: `${chatLayout.offset}px`,
                            width: `${chatLayout.width}px`
                        } : null}
                    >
                        {resolved.contextLabel && <strong className={styles.cursorGroupLabel}>{resolved.contextLabel}</strong>}
                        {groupParticipants.map(participant => (
                            <div
                                key={participant.participantId}
                                className={styles.cursorGroupParticipant}
                            >
                                <span
                                    aria-hidden="true"
                                    className={styles.cursorGroupColor}
                                    style={{backgroundColor: participant.cursor.color}}
                                />
                                <div className={styles.cursorGroupParticipantContent}>
                                    <strong className={styles.cursorPresenceName}>{participant.cursor.name || 'ゲスト'}
                                        {participants.some(item => item.id === participant.participantId && item.user_id) &&
                                            <NyaitterIdBadge />}
                                    </strong>
                                    {participant.targetName && participant.targetName !== resolved.contextLabel && <span>対象: {participant.targetName}</span>}
                                    {participant.screenName && participant.screenName !== resolved.contextLabel && <span>画面: {participant.screenName}</span>}
                                    {participant.chat && <span
                                        aria-label={participant.chat.typing ? '入力中' : undefined}
                                        aria-live="polite"
                                        className={`${styles.cursorChatBubble} ${participant.chat.typing ? styles.cursorChatTyping : ''}`}
                                    >
                                        {participant.chat.text}
                                    </span>}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        ))}
    </React.Fragment>);
};

export default CollaborationBridge;
