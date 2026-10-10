'use strict';

const {ServerProjectVm} = require('./ServerProjectVmManager');
const {parentPort} = require('node:worker_threads');

let project = null;

const send = message => {
  if (parentPort) parentPort.postMessage(message);
  else if (process.connected) process.send(message);
};

const handle = async ({type, payload}) => {
  if (type === 'init') {
    const collaborationRooms = {
      getRoomByContext: () => ({id: payload.projectId}),
      broadcast: (_roomId, excludedSenderId, packet) => send({
        type: 'broadcast', packet: packet.message, excludedSenderId,
      }),
    };
    project = new ServerProjectVm({
      projectId: payload.projectId,
      collaborationRooms,
      ...payload.options,
    });
    project.sendTo = (participantId, packet) => send({type: 'sendTo', participantId, packet});
    await project.init(Buffer.from(payload.buffer));
    return true;
  }
  if (!project) throw new Error('クラウドVMが初期化されていません。');
  if (type === 'clientMessage') return project.handleClientMessage(payload.participantId, payload.message);
  if (type === 'snapshot') return project.captureFullProjectSnapshot();
  if (type === 'runtime') return project.controller.captureRuntime();
  if (type === 'reload') return project.reloadSnapshot(Buffer.from(payload.buffer));
  if (type === 'save') return project.saveProjectSb3();
  if (type === 'stop') {
    await project.stop();
    project = null;
    return true;
  }
  throw new Error(`Unknown cloud VM command: ${type}`);
};

const receive = async message => {
  try {
    const result = await handle(message);
    send({type: 'response', id: message.id, result});
  } catch (error) {
    send({type: 'response', id: message.id, error: error.message});
  }
};
if (parentPort) parentPort.on('message', receive);
else process.on('message', receive);
