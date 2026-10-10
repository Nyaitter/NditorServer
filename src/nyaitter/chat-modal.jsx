/* eslint-disable arrow-parens, react/prop-types, react/jsx-no-bind */
import React from 'react';
import NyaitterIdBadge from './nyaitter-id-badge.jsx';
import styles from './chat-modal.css';

const formatTime = timestamp => {
    const d = new Date(timestamp);
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    return `${h}:${m}`;
};

const clampChatPosition = (position, element) => {
    const documentElement = typeof document !== 'undefined' ? document.documentElement : null;
    const viewportWidth = Math.max(
        Number(window.innerWidth) || 0,
        Number(documentElement?.clientWidth) || 0
    );
    const viewportHeight = Math.max(
        Number(window.innerHeight) || 0,
        Number(documentElement?.clientHeight) || 0
    );
    const rect = element?.getBoundingClientRect?.();
    const width = Math.max(Number(rect?.width) || 0, Number(element?.offsetWidth) || 0);
    const height = Math.max(Number(rect?.height) || 0, Number(element?.offsetHeight) || 0);
    const maxLeft = Math.max(0, viewportWidth - width);
    const maxTop = Math.max(0, viewportHeight - height);

    return {
        left: Math.round(Math.max(0, Math.min(maxLeft, Number(position.left) || 0))),
        top: Math.round(Math.max(0, Math.min(maxTop, Number(position.top) || 0)))
    };
};

const isDragExcludedTarget = target => {
    if (!target || typeof target.closest !== 'function') return false;
    return Boolean(target.closest(
        'button, input, textarea, select, option, [data-chat-drag-ignore="true"]'
    ));
};

const ChatModal = ({isOpen, onClose, messages, onSendMessage, onTypingChange, currentParticipantId, participants = []}) => {
    const [inputText, setInputText] = React.useState('');
    const [windowPosition, setWindowPosition] = React.useState(null);
    const [isDragging, setIsDragging] = React.useState(false);
    const windowRef = React.useRef(null);
    const headerRef = React.useRef(null);
    const positionRef = React.useRef(null);
    const dragRef = React.useRef(null);
    const listRef = React.useRef(null);
    const inputRef = React.useRef(null);
    const typingActiveRef = React.useRef(false);
    const typingStopTimerRef = React.useRef(null);

    const setClampedPosition = React.useCallback(nextPosition => {
        const element = windowRef.current;
        const clamped = clampChatPosition(nextPosition, element);
        positionRef.current = clamped;
        setWindowPosition(clamped);
    }, []);

    const releasePointerCapture = React.useCallback(pointerId => {
        const header = headerRef.current;
        if (!header || typeof header.hasPointerCapture !== 'function') return;
        if (header.hasPointerCapture(pointerId)) {
            header.releasePointerCapture(pointerId);
        }
    }, []);

    const finishDragging = React.useCallback(pointerId => {
        const drag = dragRef.current;
        if (!drag || (pointerId !== undefined && drag.pointerId !== pointerId)) return;
        releasePointerCapture(drag.pointerId);
        dragRef.current = null;
        setIsDragging(false);
    }, [releasePointerCapture]);

    const handleHeaderPointerDown = React.useCallback(event => {
        if (isDragExcludedTarget(event.target)) return;
        if (event.pointerType === 'mouse' && event.button !== 0) return;

        const element = windowRef.current;
        if (!element) return;

        const rect = element.getBoundingClientRect();
        const startPosition = clampChatPosition(
            positionRef.current || {left: rect.left, top: rect.top},
            element
        );
        positionRef.current = startPosition;
        setWindowPosition(startPosition);
        dragRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            startLeft: startPosition.left,
            startTop: startPosition.top
        };
        event.currentTarget.setPointerCapture?.(event.pointerId);
        event.preventDefault();
        setIsDragging(true);
    }, []);

    const handleHeaderPointerMove = React.useCallback(event => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        setClampedPosition({
            left: drag.startLeft + event.clientX - drag.startX,
            top: drag.startTop + event.clientY - drag.startY
        });
        event.preventDefault();
    }, [setClampedPosition]);

    const handleHeaderPointerEnd = React.useCallback(event => {
        finishDragging(event.pointerId);
    }, [finishDragging]);

    React.useLayoutEffect(() => {
        if (!isOpen || !windowRef.current) return undefined;
        const element = windowRef.current;
        const rect = element.getBoundingClientRect();
        setClampedPosition(positionRef.current || {left: rect.left, top: rect.top});
        return undefined;
    }, [isOpen, setClampedPosition]);

    React.useEffect(() => {
        if (!isOpen) return undefined;
        const handleResize = () => {
            if (positionRef.current && windowRef.current) {
                setClampedPosition(positionRef.current);
            }
        };
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, [isOpen, setClampedPosition]);

    React.useEffect(() => {
        const handleWindowBlur = () => finishDragging();
        window.addEventListener('blur', handleWindowBlur);
        return () => window.removeEventListener('blur', handleWindowBlur);
    }, [finishDragging]);

    const setTypingActive = React.useCallback(active => {
        const next = Boolean(active);
        if (typingActiveRef.current === next) return;
        typingActiveRef.current = next;
        onTypingChange?.(next);
    }, [onTypingChange]);

    const stopTyping = React.useCallback(() => {
        clearTimeout(typingStopTimerRef.current);
        typingStopTimerRef.current = null;
        setTypingActive(false);
    }, [setTypingActive]);

    const markTyping = React.useCallback(() => {
        setTypingActive(true);
        clearTimeout(typingStopTimerRef.current);
        typingStopTimerRef.current = setTimeout(() => {
            typingStopTimerRef.current = null;
            setTypingActive(false);
        }, 2000);
    }, [setTypingActive]);

    React.useEffect(() => {
        if (isOpen) {
            if (listRef.current) {
                listRef.current.scrollTop = listRef.current.scrollHeight;
            }
            inputRef.current?.focus();
        }
    }, [isOpen, messages]);

    React.useEffect(() => {
        if (!isOpen) stopTyping();
        return () => stopTyping();
    }, [isOpen, stopTyping]);

    if (!isOpen) return null;

    const handleSubmit = e => {
        e.preventDefault();
        const trimmed = inputText.trim();
        stopTyping();
        if (!trimmed) return;
        onSendMessage(trimmed);
        setInputText('');
    };

    const handleClose = () => {
        stopTyping();
        onClose();
    };

    const handleKeyDown = e => {
        // IME 変換中の Enter は送信しない
        if (e.nativeEvent.isComposing) {
            markTyping();
            return;
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            setInputText('');
            stopTyping();
            onClose();
            return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
            handleSubmit(e);
            return;
        }
        markTyping();
    };

    const windowClassName = `${styles.chatWindow} ${isDragging ? styles.chatWindowDragging : ''}`;
    const windowStyle = windowPosition ? {
        left: `${windowPosition.left}px`,
        top: `${windowPosition.top}px`,
        right: 'auto',
        bottom: 'auto'
    } : undefined;

    return (
        <div
            ref={windowRef}
            className={windowClassName}
            style={windowStyle}
            role="dialog"
            aria-label="チャット"
        >
            <div
                ref={headerRef}
                className={styles.chatHeader}
                data-chat-drag-handle="true"
                onPointerDown={handleHeaderPointerDown}
                onPointerMove={handleHeaderPointerMove}
                onPointerUp={handleHeaderPointerEnd}
                onPointerCancel={handleHeaderPointerEnd}
                onLostPointerCapture={handleHeaderPointerEnd}
                aria-grabbed={isDragging}
            >
                <span>共同作業チャット</span>
                <button
                    type="button"
                    className={styles.closeButton}
                    data-chat-drag-ignore="true"
                    onClick={handleClose}
                    aria-label="閉じる"
                >
                    &times;
                </button>
            </div>
            <div className={styles.messageList} ref={listRef} data-chat-drag-ignore="true">
                {messages.length === 0 ? (
                    <div className={styles.messageEmpty}>メッセージはありません</div>
                ) : (
                    messages.map(msg => {
                        const isOwn = msg.from === currentParticipantId || msg.isOwn;
                        return (
                            <div
                                key={msg.id || `${msg.timestamp}-${msg.sender}`}
                                className={`${styles.messageItem} ${isOwn ? styles.messageItemOwn : ''}`}
                            >
                                <div className={styles.messageMeta}>
                                    <span className={styles.senderName}>{msg.sender}
                                        {participants.some(participant => participant.id === msg.from && participant.user_id) &&
                                            <NyaitterIdBadge />}
                                    </span>
                                    <span className={styles.messageTime}>{formatTime(msg.timestamp)}</span>
                                </div>
                                <div className={styles.messageText}>{msg.text}</div>
                            </div>
                        );
                    })
                )}
            </div>
            <form className={styles.chatForm} onSubmit={handleSubmit} data-chat-drag-ignore="true">
                <input
                    ref={inputRef}
                    type="text"
                    className={styles.chatInput}
                    placeholder="メッセージを入力…"
                    value={inputText}
                    onChange={e => {
                        setInputText(e.target.value);
                        markTyping();
                    }}
                    onKeyDown={handleKeyDown}
                    onCompositionStart={markTyping}
                    onCompositionUpdate={markTyping}
                    onBlur={stopTyping}
                    maxLength={500}
                />
                <button
                    type="submit"
                    className={styles.sendButton}
                    disabled={!inputText.trim()}
                    style={{opacity: inputText.trim() ? 1 : 0.6}}
                >
                    送信
                </button>
            </form>
        </div>
    );
};

export {ChatModal};
export default ChatModal;
