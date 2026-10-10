'use strict';

const path = require('node:path');
const os = require('node:os');
const v8 = require('node:v8');
const {fork} = require('node:child_process');
const {Worker} = require('node:worker_threads');
const fflate = require('fflate');

const SCRATCH_VM_PATH = process.env.SCRATCH_VM_PATH || require.resolve('scratch-vm');

let ScratchVM = null;
function getScratchVmClass() {
  if (!ScratchVM) {
    ScratchVM = require(SCRATCH_VM_PATH);
  }
  return ScratchVM;
}

const DEFAULT_FRAMERATE = 30;
const DEFAULT_MAX_CLONES = 300;
const RUNTIME_STATE_INTERVAL_MS = 50; // ~20 updates per second

class ServerProjectVm {
  constructor({
    projectId,
    cloudProjectService,
    collaborationRooms,
    framerate = DEFAULT_FRAMERATE,
    maxClones = DEFAULT_MAX_CLONES,
  } = {}) {
    this.projectId = String(projectId);
    this.cloudProjectService = cloudProjectService;
    this.collaborationRooms = collaborationRooms;
    const requestedFramerate = Number(framerate);
    this.framerate = Number.isFinite(requestedFramerate) ?
      Math.min(250, Math.max(0, requestedFramerate)) : DEFAULT_FRAMERATE;
    this.maxClones = Math.min(Math.max(10, Number(maxClones) || DEFAULT_MAX_CLONES), 300);

    this.vm = null;
    this.controller = null;
    this.sequence = 0;
    this.hostQueue = Promise.resolve();
    this.pendingOperations = 0;
    this.assetFiles = {};
    this.assetReferences = new Set();
    this.running = false;
    this.stopped = false;
  }

  async init(snapshotBuffer) {
    const VM = getScratchVmClass();
    this.vm = new VM();
    this.vm.runtime._nditorExtensionLoader = require('./CloudExtensionLoader');
    this.vm.securityManager.canLoadExtensionFromProject = () => true;
    const ScratchStorage = require(require.resolve('@turbowarp/scratch-storage', {paths: [SCRATCH_VM_PATH]}));
    this.vm.attachStorage(new ScratchStorage());

    this.vm.setFramerate(this.framerate);
    this.vm.setRuntimeOptions({maxClones: this.maxClones});

    // Cache original assets so costumes and sounds are 100% preserved
    try {
      this.assetFiles = fflate.unzipSync(snapshotBuffer);
    } catch (_) {
      this.assetFiles = {};
    }

    // Mock audioEngine to broadcast sound playback events to clients
    this.vm.runtime.audioEngine = {
      createBank: () => ({
        soundPlayers: {},
        playerTargets: new Map(),
        soundEffects: new Map(),
        addSoundPlayer(soundPlayer) {
          this.soundPlayers[soundPlayer.id] = soundPlayer;
        },
        getSoundPlayer(soundId) {
          return this.soundPlayers[soundId];
        },
        playSound: (target, soundId) => {
          this.broadcast({
            type: 'runtime_sound',
            targetId: this.controller?.toCanonicalTargetId(target?.id) || target?.id,
            soundId,
          });
          return Promise.resolve();
        },
        stopAllSounds: () => {
          this.broadcast({ type: 'runtime_sound_stop_all' });
        },
        stop: (target, soundId) => {
          this.broadcast({
            type: 'runtime_sound_stop',
            targetId: this.controller?.toCanonicalTargetId(target?.id) || target?.id,
            soundId,
          });
        },
        setEffects: () => {},
        dispose: () => {},
      }),
      decodeSoundPlayer: sound => Promise.resolve({
        id: sound.assetId || sound.md5,
        buffer: {sampleRate: sound.rate || 48000, length: sound.sampleCount || 0},
      }),
    };

    this.vm.runtime.on('QUESTION', (question) => {
      this.broadcast({
        type: 'runtime_question',
        question,
      });
    });

    await this.vm.loadProject(snapshotBuffer);
    this.vm.setCompilerOptions({enabled: true, liveEditing: true});
    this.refreshAssetCache();

    this.controller = this.vm.createCollaborationController({
      role: 'host',
      onOperation: (operation) => this.handleLocalOperation(operation),
      onRuntimeState: (delta) => this.broadcastRuntimeState(delta),
      runtimeInterval: RUNTIME_STATE_INTERVAL_MS,
    });

    this.vm.start();
    this.running = true;
    this.stopped = false;
  }

  attachToRoom(room) {
    if (!room) return;
    room.isServerVm = true;
    room.currentHostParticipantId = 'server-vm';
    room.participants.set('server-vm', {
      id: 'server-vm',
      user_id: null,
      name: 'サーバーVM (ホスト)',
      role: 'host',
      hasAccess: true,
      isServerVm: true,
      socket: null,
      joinedAt: new Date().toISOString(),
    });
  }

  refreshAssetCache() {
    const next = new Set();
    const sprites = new Set();
    for (const target of this.vm.runtime.targets) {
      if (!target.sprite || sprites.has(target.sprite)) continue;
      sprites.add(target.sprite);
      for (const item of [...target.getCostumes(), ...(target.sprite.sounds || [])]) {
        const asset = item.asset;
        const id = asset?.assetId || item.assetId;
        const format = asset?.dataFormat || item.dataFormat;
        const name = id && format ? `${id}.${format}` : item.md5 || item.md5ext;
        if (name) {
          next.add(name);
          if (!this.assetFiles[name] && asset?.data) this.assetFiles[name] = Buffer.from(asset.data);
        }
        if (item.broken?.md5) {
          next.add(item.broken.md5);
          if (!this.assetFiles[item.broken.md5] && item.broken.asset?.data) {
            this.assetFiles[item.broken.md5] = Buffer.from(item.broken.asset.data);
          }
        }
      }
    }
    for (const name of this.assetReferences) if (!next.has(name)) delete this.assetFiles[name];
    this.assetReferences = next;
  }

  getRoom() {
    return this.collaborationRooms?.getRoomByContext(`cloud:${this.projectId}`) || null;
  }

  broadcast(packet, excludedSenderId = null) {
    const room = this.getRoom();
    if (!room) return;
    this.collaborationRooms.broadcast(room.id, excludedSenderId, {
      type: 'collaboration_message',
      message: packet,
    });
  }

  sendTo(targetParticipantId, packet) {
    const room = this.getRoom();
    if (!room) return;
    const participant = room.participants.get(String(targetParticipantId));
    if (participant?.socket?.readyState === 1) {
      try {
        participant.socket.send(JSON.stringify({
          type: 'collaboration_message',
          message: packet,
        }));
      } catch (_) {}
    }
  }

  broadcastRuntimeState(delta) {
    if (this.stopped || !this.running) return;
    this.broadcast({
      type: 'runtime_state',
      state: delta,
    });
  }

  handleLocalOperation(operation) {
    if (this.stopped) return;
    this.sequence += 1;
    this.broadcast({
      type: 'operation_commit',
      operation,
      sequence: this.sequence,
      operationId: `server-op-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      originParticipantId: 'server-vm',
    });
  }

  async captureFullProjectSnapshot() {
    if (this.stopped || !this.vm) throw new Error('VM is stopped');
    await this.hostQueue;
    return this.captureSnapshotNow();
  }

  async captureSnapshotNow() {
    const fullZip = { ...this.assetFiles, 'project.json': Buffer.from(this.vm.toJSON(), 'utf8') };
    const mergedZip = fflate.zipSync(fullZip);

    return {
      format: 'sb3-base64',
      data: Buffer.from(mergedZip).toString('base64'),
      targets: this.vm.runtime.targets
        .filter((target) => target.isOriginal !== false)
        .map((target) => ({ id: target.id, isStage: target.isStage, name: target.getName(),
          blockLinks: this.controller.captureBlockLinks(target) })),
      editingTargetId: this.vm.editingTarget?.id || null,
      options: this.controller.captureOptions(),
      question: this.vm.runtime._collaborationQuestion ?? null,
      questionInput: this.vm.runtime._collaborationQuestionInput || '',
    };
  }

  async handleClientMessage(participantId, message) {
    if (this.stopped || !message || typeof message !== 'object') return;

    if (message.type === 'project_request') {
      try {
        const snapshot = await this.captureFullProjectSnapshot();
        this.sendTo(participantId, {
          type: 'project_snapshot',
          snapshot,
          sequence: this.sequence,
          to: participantId,
        });
        const runtimeState = this.controller?.captureRuntime();
        if (runtimeState) {
          this.sendTo(participantId, {
            type: 'runtime_state',
            state: runtimeState,
            to: participantId,
          });
        }
      } catch (err) {
        console.warn('[server-vm] Failed to handle project_request:', err.message);
      }
      return;
    }

    if (message.type === 'operation_request') {
      const operationId = message.operationId;
      const operation = message.operation;
      if (!operation?.kind) return;
      if (this.pendingOperations >= 32) return;
      this.pendingOperations += 1;

      this.hostQueue = this.hostQueue.catch(() => {}).then(async () => {
        if (this.stopped) return;
        const committedOperation = await this.controller.applyOperation(operation) || operation;
        if (committedOperation.costume?.assetData?.data && committedOperation.costume.md5) {
          this.assetFiles[committedOperation.costume.md5] =
            Buffer.from(committedOperation.costume.assetData.data, 'base64');
        }
        if (operation.kind.startsWith('costume.') || operation.kind.startsWith('sound.') ||
            operation.kind === 'sprite.add' || operation.kind === 'sprite.delete') this.refreshAssetCache();
        this.sequence += 1;
        this.broadcast({
          type: 'operation_commit',
          operation: committedOperation,
          sequence: this.sequence,
          operationId,
          originParticipantId: participantId,
        });
      }).catch((err) => {
        console.warn('[server-vm] Operation apply error:', err.message);
      }).finally(() => {
        this.pendingOperations -= 1;
      });
      return this.hostQueue;
    }

    if (message.type === 'runtime_command') {
      const { command, args } = message;
      if (command === 'green_flag') {
        if (!this.vm.runtime?._steppingInterval && !this.vm.runtime?.frameLoop?.running) this.vm.start();
        this.vm.greenFlag();
        const runtimeState = this.controller?.captureRuntime();
        if (runtimeState) {
          this.broadcastRuntimeState({ ...runtimeState, running: true });
        }
      } else if (command === 'stop_all') {
        this.vm.stopAll();
        this.broadcastRuntimeState({ running: false, scriptGlows: [] });
      } else if (command === 'answer') {
        this.vm.runtime?.emit('ANSWER', args?.answer);
      } else if (command === 'question_input') {
        if (this.vm.runtime?._collaborationQuestion != null) {
          const text = String(args?.text ?? '');
          this.vm.runtime._collaborationQuestionInput = text;
          this.broadcast({type: 'runtime_question_input', text});
        }
      } else if (command === 'nditor_read') {
        try {
          const request = args?.request || {};
          const value = await this.vm.extensionManager.readNditorHost({...request,
            targetId: this.controller?.toLocalTargetId(request.targetId) || request.targetId});
          this.sendTo(participantId, {type: 'runtime_report', report: {requestId: args?.requestId, value}});
        } catch (error) {
          this.sendTo(participantId, {type: 'runtime_report',
            report: {requestId: args?.requestId, error: error.message}});
        }
      } else if (command === 'stack_click') {
        const targetId = this.controller?.toLocalTargetId(args?.targetId) || args?.targetId;
        const target = this.vm.runtime?.getTargetById(targetId);
        if (target && args?.blockId) {
          this.vm.installCollaborationFlyoutBlocks?.(args?.flyoutBlocks);
          const blockId = this.controller?.toLocalBlockId(args.blockId) || args.blockId;
          const reportHandler = report => {
            if (report?.id !== blockId || report?.targetId !== target.id) return;
            this.vm.off('COLLABORATION_VISUAL_REPORT', reportHandler);
            clearTimeout(timer);
            this.sendTo(participantId, {type: 'runtime_report', report: {
              id: args.blockId, targetId: args.targetId, value: report.value}});
          };
          const timer = setTimeout(() => this.vm?.off('COLLABORATION_VISUAL_REPORT', reportHandler), 5000);
          timer.unref?.();
          this.vm.on('COLLABORATION_VISUAL_REPORT', reportHandler);
          this.vm.runtime.toggleScript(blockId, { target, stackClick: true });
        }
      } else if (command === 'variable_set') {
        const targetId = this.controller?.toLocalTargetId(args?.targetId) || args?.targetId;
        this.vm.setVariableValue(targetId, args?.variableId, args?.value);
      } else if (command === 'monitor_update') {
        this.vm.updateMonitor(args?.delta);
      } else if (command === 'monitor_visibility') {
        const targetId = this.controller?.toLocalTargetId(args?.targetId) || args?.targetId;
        this.vm.applyCollaborationMonitorVisibility?.(targetId, args?.event, args?.block);
      }
      return;
    }

    if (message.type === 'runtime_input') {
      if (message.device === 'mouse' || message.device === 'keyboard') {
        this.vm.postIOData(message.device, message.data || {});
      }
      return;
    }

    // Peer relayed messages (chat, chat_typing, presence, paint_preview, block_input_preview)
    if (message.to) {
      this.sendTo(message.to, message);
    } else {
      this.broadcast(message, participantId);
    }
  }

  async reloadSnapshot(buffer) {
    this.hostQueue = this.hostQueue.catch(() => {}).then(async () => {
      if (this.stopped) return;
      try {
        this.assetFiles = fflate.unzipSync(buffer);
      } catch (_) {
        this.assetFiles = {};
      }
      await this.vm.loadProject(buffer);
      this.vm.setCompilerOptions({enabled: true, liveEditing: true});
      this.assetReferences.clear();
      this.refreshAssetCache();
      this.sequence += 1;
      const snapshot = await this.captureSnapshotNow();
      this.broadcast({
        type: 'project_snapshot',
        snapshot,
        sequence: this.sequence,
      });
      const runtimeState = this.controller?.captureRuntime();
      if (runtimeState) {
        this.broadcast({
          type: 'runtime_state',
          state: runtimeState,
        });
      }
    });
    return this.hostQueue;
  }

  async saveProjectSb3() {
    if (!this.vm) throw new Error('VM is not initialized');
    await this.hostQueue;
    this.vm.runtime.storeProjectOptions();
    const fullZip = { ...this.assetFiles, 'project.json': Buffer.from(this.vm.toJSON(), 'utf8') };
    return Buffer.from(fflate.zipSync(fullZip));
  }

  async saveToStorage() {
    try {
      const buffer = await this.saveProjectSb3();
      await this.cloudProjectService.persistVmSnapshot(this.projectId, buffer);
      return buffer;
    } catch (err) {
      console.error(`[server-vm] Failed to save project ${this.projectId} to storage:`, err.message);
      throw err;
    }
  }

  async stop({ save = false } = {}) {
    this.stopped = true;
    if (save) {
      await this.saveToStorage().catch(() => {});
    }
    try { this.vm?.stop(); } catch (_) {}
    try { this.vm?.runtime?.emit('NDITOR_VM_SHUTDOWN'); } catch (_) {}
    try { this.controller?.close?.(); } catch (_) {}
    this.running = false;
  }
}

const memoryBudgetMb = () => {
  const configuredTotal = Number(process.env.NDITOR_MAX_MEMORY_MB);
  const constrained = Number(process.constrainedMemory?.());
  const total = configuredTotal > 0 ? configuredTotal :
    Math.floor(Math.min(os.totalmem(), constrained > 0 && constrained < os.totalmem() ? constrained : Infinity) / 1048576);
  const configuredMain = Number(process.env.NDITOR_MAIN_MEMORY_MB);
  const main = configuredMain > 0 ? configuredMain :
    Math.ceil(v8.getHeapStatistics().heap_size_limit / 1048576);
  return Math.max(0, total - main);
};

class ServerProjectVmProcess {
  constructor({projectId, cloudProjectService, collaborationRooms, options}) {
    this.projectId = String(projectId);
    this.cloudProjectService = cloudProjectService;
    this.collaborationRooms = collaborationRooms;
    this.options = options;
    this.sequence = 0;
    this.worker = null;
    this.pending = new Map();
    this.nextRequestId = 1;
    this.rebalancing = null;
  }

  async start(buffer, limitMb) {
    const heapMb = Math.max(16, Math.floor(limitMb - 64));
    const script = path.join(__dirname, 'ServerProjectVmWorker.js');
    const createThread = () => {
      const thread = new Worker(script, {
        execArgv: process.execArgv.filter(arg => !arg.startsWith('--max-old-space-size=')),
        resourceLimits: {maxOldGenerationSizeMb: heapMb},
      });
      thread.connected = true;
      thread.exitCode = null;
      thread.send = (message, callback) => {
        try { thread.postMessage(message); callback?.(); }
        catch (error) { if (callback) callback(error); else throw error; }
      };
      thread.kill = () => { thread.connected = false; void thread.terminate().catch(() => {}); };
      thread.once('exit', code => { thread.exitCode = code; thread.connected = false; });
      return thread;
    };
    let worker;
    try {
      worker = this.useThread ? createThread() : fork(script, [], {
        serialization: 'advanced',
        execArgv: [...process.execArgv.filter(arg => !arg.startsWith('--max-old-space-size=')),
          `--max-old-space-size=${heapMb}`],
      });
    } catch (error) {
      if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
      worker = createThread();
    }
    this.worker = worker;
    worker.on('error', error => {
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
    });
    worker.on('message', (message) => {
      if (message?.type === 'broadcast') {
        if (message.packet?.sequence) this.sequence = message.packet.sequence;
        const room = this.collaborationRooms.getRoomByContext(`cloud:${this.projectId}`);
        if (room) this.collaborationRooms.broadcast(room.id, message.excludedSenderId || null, {
          type: 'collaboration_message', message: message.packet,
        });
      } else if (message?.type === 'sendTo') {
        const room = this.collaborationRooms.getRoomByContext(`cloud:${this.projectId}`);
        const participant = room?.participants.get(String(message.participantId));
        if (participant?.socket?.readyState === 1) {
          participant.socket.send(JSON.stringify({type: 'collaboration_message', message: message.packet}));
        }
      } else if (message?.type === 'response') {
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error));
        else request.resolve(message.result);
      }
    });
    worker.on('exit', (code) => {
      if (this.worker !== worker) return;
      this.worker = null;
      for (const request of this.pending.values()) request.reject(new Error(`クラウドVMプロセスが終了しました (${code})`));
      this.pending.clear();
    });
    try {
      if (!(worker instanceof Worker) && !worker.pid) {
        await new Promise((resolve, reject) => {
          worker.once('spawn', resolve);
          worker.once('error', reject);
        });
      }
      await this.call('init', {buffer, projectId: this.projectId, options: this.options});
    } catch (error) {
      worker.kill();
      if (!(worker instanceof Worker) && (error.code === 'EPERM' || error.code === 'EACCES')) {
        this.worker = null;
        // Some Node versions report the spawn failure through an error event.
        this.useThread = true;
        return this.start(buffer, limitMb);
      }
      throw error;
    }
  }

  call(type, payload = {}) {
    if (!this.worker?.connected) return Promise.reject(new Error('クラウドVMプロセスが利用できません。'));
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {resolve, reject});
      this.worker.send({id, type, payload}, error => {
        if (error && this.pending.has(id)) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  async endWorker(worker) {
    if (worker.exitCode !== null) return;
    const exited = new Promise(resolve => worker.once('exit', resolve));
    worker.kill();
    await exited;
  }

  attachToRoom(room) {
    if (!room) return;
    room.isServerVm = true;
    room.currentHostParticipantId = 'server-vm';
    room.participants.set('server-vm', {
      id: 'server-vm', user_id: null, name: 'サーバーVM', role: 'host',
      hasAccess: true, isServerVm: true, socket: null, joinedAt: new Date().toISOString(),
    });
  }

  broadcast(packet) {
    const room = this.collaborationRooms.getRoomByContext(`cloud:${this.projectId}`);
    if (room) this.collaborationRooms.broadcast(room.id, null, {type: 'collaboration_message', message: packet});
  }

  async handleClientMessage(participantId, message) {
    if (this.rebalancing) await this.rebalancing;
    return this.call('clientMessage', {participantId, message});
  }

  async captureFullProjectSnapshot() {
    return this.call('snapshot');
  }

  async captureRuntime() {
    return this.call('runtime');
  }

  async reloadSnapshot(buffer) {
    if (this.rebalancing) await this.rebalancing;
    return this.call('reload', {buffer});
  }

  async rebalance(limitMb) {
    this.rebalancing = (async () => {
      const buffer = await this.call('save');
      const previous = this.worker;
      await this.call('stop');
      await this.endWorker(previous);
      await this.start(buffer, limitMb);
      this.sequence = 0;
      const snapshot = await this.captureFullProjectSnapshot();
      this.broadcast({type: 'project_snapshot', snapshot, sequence: this.sequence});
      this.broadcast({type: 'runtime_state', state: await this.captureRuntime()});
    })();
    try { await this.rebalancing; } finally { this.rebalancing = null; }
  }

  async stop({save = false} = {}) {
    if (this.rebalancing) await this.rebalancing;
    if (!this.worker) return;
    if (save) {
      const buffer = await this.call('save');
      await this.cloudProjectService.persistVmSnapshot(this.projectId, Buffer.from(buffer));
    }
    const worker = this.worker;
    await this.call('stop');
    await this.endWorker(worker);
  }
}

class ServerProjectVmManager {
  constructor({ cloudProjectService, collaborationRooms, options = {} } = {}) {
    this.cloudProjectService = cloudProjectService;
    this.collaborationRooms = collaborationRooms;
    this.options = options;
    this.vms = new Map();
    this.startingVms = new Map();
    this.budgetMb = memoryBudgetMb();
    this.capacityQueue = Promise.resolve();
  }

  runCapacityTask(task) {
    const operation = this.capacityQueue.catch(() => {}).then(task);
    this.capacityQueue = operation.catch(() => {});
    return operation;
  }

  async getOrStartVm(projectId, room = null) {
    const id = String(projectId);
    if (this.vms.has(id)) {
      const existing = this.vms.get(id);
      if (room) existing.attachToRoom(room);
      return existing;
    }

    // Deduplicate concurrent starts
    if (this.startingVms.has(id)) {
      return await this.startingVms.get(id);
    }

    const startPromise = (async () => {
      try {
        const { buffer } = await this.cloudProjectService.readSnapshot(id, null, { internal: true });
        return await this.runCapacityTask(async () => {
          const count = this.vms.size + 1;
          const limitMb = Math.floor(this.budgetMb / count);
          if (limitMb < 80) throw new Error('クラウドVM用のメモリが不足しています。');
          const serverVm = new ServerProjectVmProcess({
            projectId: id,
            cloudProjectService: this.cloudProjectService,
            collaborationRooms: this.collaborationRooms,
            options: this.options,
          });
          await Promise.all([...this.vms.values()].map(vm => vm.rebalance(limitMb)));
          await serverVm.start(buffer, limitMb);
          if (room) serverVm.attachToRoom(room);
          this.vms.set(id, serverVm);
          return serverVm;
        });
      } finally {
        this.startingVms.delete(id);
      }
    })();

    this.startingVms.set(id, startPromise);
    return await startPromise;
  }

  getVm(projectId) {
    return this.vms.get(String(projectId)) || null;
  }

  async reloadSnapshot(projectId, buffer) {
    const vm = this.getVm(projectId);
    if (vm) {
      await vm.reloadSnapshot(buffer);
    }
  }

  async saveAndStop(projectId) {
    return this.runCapacityTask(async () => {
      const id = String(projectId);
      const vm = this.vms.get(id);
      if (!vm) return false;
      this.vms.delete(id);
      await vm.stop({save: true});
      const limitMb = Math.floor(this.budgetMb / Math.max(1, this.vms.size));
      await Promise.all([...this.vms.values()].map(active => active.rebalance(limitMb)));
      return true;
    });
  }

  async restartVm(projectId) {
    const id = String(projectId);
    await this.saveAndStop(id);

    const context = `cloud:${id}`;
    const room = this.collaborationRooms?.getRoomByContext(context);
    if (room) {
      const newVm = await this.getOrStartVm(id, room);
      // Broadcast new snapshot to all clients currently connected to the room
      const snapshot = await newVm.captureFullProjectSnapshot();
      newVm.broadcast({
        type: 'project_snapshot',
        snapshot,
        sequence: newVm.sequence,
      });
      const runtimeState = await newVm.captureRuntime();
      if (runtimeState) {
        newVm.broadcast({
          type: 'runtime_state',
          state: runtimeState,
        });
      }
    }
    return true;
  }

  handleClientMessage(roomId, participantId, message, bytes = 0) {
    const room = this.collaborationRooms?.getRoom(roomId);
    if (!room?.cloudProjectId) return;
    const participant = room.participants.get(participantId);
    if (!participant || participant.isServerVm || !message || typeof message !== 'object') return;
    const relayTypes = new Set(['chat', 'chat_typing', 'presence', 'block_input_preview', 'paint_preview']);
    const acceptedTypes = new Set(['project_request', 'operation_request', 'runtime_command', 'runtime_input']);
    if (!relayTypes.has(message.type) && !acceptedTypes.has(message.type)) return;
    const read = message.type === 'runtime_command' && message.command === 'nditor_read' &&
      ['variable','target','options','timer','answer'].includes(message.args?.request?.kind);
    if (!participant.hasAccess && (message.type === 'operation_request' || message.type === 'runtime_input' ||
      (message.type === 'runtime_command' && !read))) return;
    const now = Date.now();
    const quota = participant._vmMessageQuota || {tokens: 200, bytes: 64 * 1024 * 1024, time: now};
    const elapsed = Math.max(0, now - quota.time);
    quota.tokens = Math.min(200, quota.tokens + elapsed / 10);
    quota.bytes = Math.min(64 * 1024 * 1024, quota.bytes + elapsed * 6400);
    quota.time = now;
    participant._vmMessageQuota = quota;
    if (quota.tokens < 1 || quota.bytes < bytes) return;
    quota.tokens -= 1;
    quota.bytes -= bytes;
    if (message.to && message.to !== 'server-vm' && !room.participants.has(message.to)) return;
    message = {...message, from: participantId};
    const vm = this.getVm(room.cloudProjectId);
    if (vm) {
      const count = vm._clientRequestsActive || 0;
      const pendingBytes = vm._clientRequestsBytes || 0;
      if (count >= 32 || pendingBytes + bytes > 64 * 1024 * 1024) return;
      vm._clientRequestsActive = count + 1;
      vm._clientRequestsBytes = pendingBytes + bytes;
      void vm.handleClientMessage(participantId, message).catch(error => {
        console.warn('[server-vm] Message failed:', error.message);
      }).finally(() => {
        vm._clientRequestsActive -= 1;
        vm._clientRequestsBytes -= bytes;
      });
    }
  }

  async stopAll() {
    const tasks = [];
    for (const [id, vm] of this.vms.entries()) {
      tasks.push(vm.stop({ save: true }));
    }
    this.vms.clear();
    await Promise.allSettled(tasks);
  }
}

module.exports = {
  ServerProjectVm,
  ServerProjectVmManager,
  DEFAULT_FRAMERATE,
  DEFAULT_MAX_CLONES,
};
