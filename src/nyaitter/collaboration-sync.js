/* eslint-disable arrow-parens, max-len, no-undefined */

const createOperationId = () => `${Date.now()}-${Math.random().toString(36)
    .slice(2, 10)}`;

const operationResources = operation => {
    if (!operation?.kind) return [];
    const target = String(operation.targetId || '');
    if (operation.kind === 'block') {
        const event = operation.event || {};
        if (String(event.type || '').startsWith('var_')) {
            const owner = event.variableIsLocal ? `target:${target}` : 'stage';
            return [`variables:${owner}:${String(event.varId || '*')}`];
        }
        if (String(event.type || '').startsWith('comment_')) {
            return [`target:${target}:comments:${String(event.commentId || '*')}`];
        }
        const blockIds = [
            event.blockId,
            event.oldParentId,
            event.newParentId,
            ...(Array.isArray(event.ids) ? event.ids : [])
        ]
            .filter(Boolean)
            .map(String);
        return blockIds.length ? blockIds.map(id => `target:${target}:blocks:${id}`) :
            [`target:${target}:blocks:*`];
    }
    if (operation.kind === 'blocks.add') return [`target:${target}:blocks:*`];
    if (operation.kind.startsWith('costume.')) return [`target:${target}:costumes:*`];
    if (operation.kind.startsWith('sound.')) return [`target:${target}:sounds:*`];
    if (operation.kind === 'sprite.add') return ['targets:*', `target:${target}:*`];
    if (operation.kind === 'sprite.delete') return ['targets:*', `target:${target}:*`];
    if (operation.kind === 'target.reorder') return ['targets:*'];
    if (operation.kind.startsWith('sprite.')) return [`target:${target}:sprite:*`];
    if (operation.kind === 'extension.load') return [`extensions:${String(operation.source || '*')}`];
    if (operation.kind === 'project.options' || operation.kind === 'runtime.options') return ['project:options'];
    return [`operation:${operation.kind}`];
};

const resourcesOverlap = (left, right) => {
    if (left === right) return true;
    if (left.endsWith('*') && right.startsWith(left.slice(0, -1))) return true;
    if (right.endsWith('*') && left.startsWith(right.slice(0, -1))) return true;
    return false;
};

const operationsConflict = (left, right) => {
    const leftResources = operationResources(left);
    const rightResources = operationResources(right);
    return leftResources.some(a => rightResources.some(b => resourcesOverlap(a, b)));
};

/**
 * Orders VM operations around the host. Project snapshots are only used when
 * joining or reconnecting; normal edits never reload or diff the project.
 */
class CollaborationSync {
    constructor ({vm, role, getClient, beginLoading, isLoading, onStatus, onError}) {
        this.vm = vm;
        this.role = role;
        this.getClient = getClient;
        this.beginLoading = beginLoading;
        this.isLoading = isLoading;
        this.onStatus = onStatus;
        this.onError = onError;
        this.sequence = 0;
        this.synchronized = role === 'host';
        this.closed = false;
        this.pendingLocal = new Map();
        this.activeCommitOperation = null;
        this.pendingHostApplies = new Set();
        this.hostQueue = Promise.resolve();
        this.receiveQueue = Promise.resolve();
        this.hostReads = new Map();
        this.readHost = request => new Promise((resolve, reject) => {
            const requestId = createOperationId();
            const timer = setTimeout(() => {
                this.hostReads.delete(requestId);
                reject(new Error('ホストの値取得がタイムアウトしました。'));
            }, 5000);
            this.hostReads.set(requestId, {resolve, reject, timer});
            const targetId = request?.targetId || this.vm.editingTarget?.id;
            if (!this.getClient()?.sendRuntimeCommand('nditor_read', {
                requestId, request: {...request, targetId: this.toCanonicalTargetId(targetId)}
            })) {
                clearTimeout(timer);
                this.hostReads.delete(requestId);
                reject(new Error('ホストに接続していません。'));
            }
        });
        if (role === 'guest') vm._nditorHostRead = this.readHost;

        this.controller = vm.createCollaborationController({
            role,
            onOperation: operation => this.handleLocalOperation(operation),
            onRuntimeState: role === 'host' ? state => {
                if (!this.isLoading()) this.getClient()?.sendRuntimeState(state);
            } : null
        });
        this.controller.setPaused(this.isLoading());
    }

    setPaused (paused) {
        this.controller?.setPaused(paused);
        if (!paused && this.role === 'host') void this.sendProject();
        if (!paused && this.role === 'guest' && !this.synchronized) this.requestProject();
    }

    toCanonicalTargetId (targetId) {
        return this.controller?.toCanonicalTargetId(targetId) || targetId;
    }

    toLocalTargetId (targetId) {
        return this.controller?.toLocalTargetId(targetId) || targetId;
    }

    toCanonicalBlockId (blockId) {
        return this.controller?.toCanonicalBlockId(blockId) || blockId;
    }

    toLocalBlockId (blockId) {
        return this.controller?.toLocalBlockId(blockId) || blockId;
    }

    handleLocalOperation (operation) {
        if (this.closed || this.isLoading()) return;
        if (this.role === 'host') {
            const replay = [...this.pendingHostApplies]
                .some(entry => operationsConflict(operation, entry.operation));
            void this.commitHostOperation(operation, createOperationId(), this.getClient()?.participantId, replay);
            return;
        }
        if (!this.synchronized) return;
        const operationId = createOperationId();
        if (this.getClient()?.sendOperationRequest(operation, operationId)) {
            this.pendingLocal.set(operationId, {
                operation,
                conflicted: operationsConflict(operation, this.activeCommitOperation)
            });
        } else {
            this.onStatus(this.getClient()?.isServerHosted ? '共同作業への再接続を待っています…' :
                'ホストへの再接続を待っています…');
        }
    }

    commitHostOperation (operation, operationId, originParticipantId, apply) {
        const applyEntry = apply ? {operation} : null;
        if (applyEntry) this.pendingHostApplies.add(applyEntry);
        const commit = async () => {
            try {
                if (this.closed || this.role !== 'host' || this.isLoading()) return;
                let committedOperation = operation;
                if (apply) {
                    const applied = await this.controller.applyOperation(operation);
                    committedOperation = applied || operation;
                }
                if (committedOperation.kind === 'costume.update') {
                    committedOperation = {...committedOperation, canonicalCostume: true};
                }
                this.sequence += 1;
                this.getClient()?.sendOperationCommit(
                    committedOperation,
                    this.sequence,
                    operationId,
                    originParticipantId
                );
            } finally {
                if (applyEntry) this.pendingHostApplies.delete(applyEntry);
            }
        };
        this.hostQueue = this.hostQueue
            .catch(() => {})
            .then(commit)
            .catch(error => this.onError(error));
        return this.hostQueue;
    }

    sendProject (to = null) {
        const send = async () => {
            if (this.closed || this.role !== 'host' || this.isLoading()) return;
            const snapshot = await this.controller.captureProject();
            this.getClient()?.sendProjectSnapshot(snapshot, this.sequence, to);
            this.getClient()?.sendRuntimeState(this.controller.captureRuntime(), to);
        };
        this.hostQueue = this.hostQueue
            .catch(() => {})
            .then(send)
            .catch(error => this.onError(error));
        return this.hostQueue;
    }

    requestProject () {
        if (this.closed || this.role !== 'guest') return;
        this.synchronized = false;
        this.getClient()?.requestProject();
    }

    async applyCommitOperation (operation) {
        this.activeCommitOperation = operation;
        try {
            await this.controller.applyOperation(operation);
        } finally {
            if (this.activeCommitOperation === operation) this.activeCommitOperation = null;
        }
    }

    receiveProject (event) {
        const receive = async () => {
            if (this.closed || this.role !== 'guest') return;
            const finishLoading = this.beginLoading();
            this.controller.setPaused(true);
            this.pendingLocal.clear();
            this.onStatus(this.getClient()?.isServerHosted ? '共同作業のプロジェクトを受信中…' :
                'ホストのプロジェクトを受信中…');
            try {
                await this.controller.loadProject(event.snapshot);
                const sequence = Number(event.sequence);
                this.sequence = Number.isFinite(sequence) ? sequence : 0;
                this.synchronized = true;
                this.onStatus('共同作業に接続中');
                const renderer = this.vm?.runtime?.renderer || this.vm?.renderer;
                if (renderer) {
                    renderer.dirty = true;
                    renderer.draw();
                }
            } finally {
                this.controller.setPaused(false);
                finishLoading();
            }
        };
        this.receiveQueue = this.receiveQueue
            .catch(() => {})
            .then(receive)
            .catch(error => {
                this.synchronized = false;
                this.onError(error);
            });
        return this.receiveQueue;
    }

    receiveCommit (event) {
        const receive = async () => {
            if (this.closed || this.role !== 'guest' || !this.synchronized) return;
            const sequence = Number(event.sequence);
            if (!Number.isFinite(sequence) || sequence <= this.sequence) return;
            if (sequence !== this.sequence + 1) {
                this.onStatus(this.getClient()?.isServerHosted ? '共同作業のプロジェクトを再取得中…' :
                    'ホストのプロジェクトを再取得中…');
                this.requestProject();
                return;
            }
            const pending = this.pendingLocal.get(event.operationId);
            const ownOperation = event.originParticipantId === this.getClient()?.participantId || Boolean(pending);
            if (ownOperation) {
                this.pendingLocal.delete(event.operationId);
                if (pending?.conflicted || event.operation?.kind === 'costume.update' ||
                    event.operation?.kind === 'runtime.options' || event.operation?.kind === 'project.options') {
                    await this.applyCommitOperation(event.operation);
                }
            } else {
                this.pendingLocal.forEach(entry => {
                    if (operationsConflict(entry.operation, event.operation)) entry.conflicted = true;
                });
                await this.applyCommitOperation(event.operation);
            }
            this.sequence = sequence;
        };
        this.receiveQueue = this.receiveQueue
            .catch(() => {})
            .then(receive)
            .catch(error => {
                this.synchronized = false;
                this.onError(error);
                this.requestProject();
            });
        return this.receiveQueue;
    }

    receiveRuntime (state) {
        if (this.closed || this.role !== 'guest') return;
        // Runtime/glow packets can arrive immediately after a project snapshot,
        // while loadProject is still pending. Apply them after that snapshot.
        const receive = () => {
            if (this.closed || !this.synchronized) return;
            this.controller?.applyRuntime(state);
        };
        this.receiveQueue = this.receiveQueue.then(receive).catch(error => this.onError(error));
        return this.receiveQueue;
    }

    handle (event) {
        if (event.type === 'runtime_command' && event.command === 'nditor_read' && this.role === 'host') {
            const request = event.args?.request || {};
            const local = {...request, targetId: this.toLocalTargetId(request.targetId)};
            this.vm.extensionManager.readNditorHost(local).then(value => {
                this.getClient()?.sendRuntimeReport({requestId: event.args.requestId, value}, event.from);
            })
                .catch(error => {
                    this.getClient()?.sendRuntimeReport({requestId: event.args.requestId, error: error.message}, event.from);
                });
            return true;
        }
        if (event.type === 'runtime_report' && event.report?.requestId && this.role === 'guest') {
            const report = event.report;
            const pending = this.hostReads.get(report.requestId);
            if (pending) {
                clearTimeout(pending.timer);
                this.hostReads.delete(report.requestId);
                if (report.error) pending.reject(new Error(report.error));
                else pending.resolve(report.value);
            }
            return true;
        }
        if (event.type === 'project_request' && this.role === 'host') {
            void this.sendProject(event.from);
            return true;
        }
        if (event.type === 'project_snapshot' && event.snapshot && this.role === 'guest') {
            void this.receiveProject(event);
            return true;
        }
        if (event.type === 'operation_request' && event.operation && this.role === 'host') {
            void this.commitHostOperation(event.operation, event.operationId, event.from, true);
            return true;
        }
        if (event.type === 'operation_commit' && event.operation && this.role === 'guest') {
            void this.receiveCommit(event);
            return true;
        }
        if (event.type === 'runtime_state' && this.role === 'guest') {
            void this.receiveRuntime(event.state);
            return true;
        }
        return false;
    }

    close () {
        this.closed = true;
        if (this.vm._nditorHostRead === this.readHost) this.vm._nditorHostRead = null;
        for (const pending of this.hostReads.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error('共同作業を終了しました。'));
        }
        this.hostReads.clear();
        this.pendingLocal.clear();
        this.activeCommitOperation = null;
        this.pendingHostApplies.clear();
        this.controller?.close();
        this.controller = null;
    }
}

export default CollaborationSync;
