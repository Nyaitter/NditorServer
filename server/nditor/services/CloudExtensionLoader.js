'use strict';

const createRealm = require('./IsolatedExtensionRealm');
const https = require('node:https');
const dns = require('node:dns');
const path = require('node:path');
const {BlockList, isIP} = require('node:net');
const MAX_BYTES = 2 * 1024 * 1024;
const blocked = new BlockList();
const globalIPv6 = new BlockList();
globalIPv6.addSubnet('2000::', 3, 'ipv6');
for (const [ip, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10],
  ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]]) blocked.addSubnet(ip, bits);
for (const [ip, bits] of [['::', 96], ['::ffff:0:0', 96], ['fc00::', 7],
  ['fe80::', 10], ['fec0::', 10], ['ff00::', 8], ['2001::', 23],
  ['2002::', 16], ['2001:db8::', 32]]) blocked.addSubnet(ip, bits, 'ipv6');
blocked.addAddress('::1', 'ipv6');
const privateAddress = (address, family) => blocked.check(address, family === 6 ? 'ipv6' : 'ipv4') ||
  (family === 6 && !globalIPv6.check(address, 'ipv6'));

const loadText = (source, redirects = 0) => new Promise((resolve, reject) => {
  if (source.startsWith('data:')) {
    try {
      const comma = source.indexOf(',');
      if (comma < 0 || source.length > MAX_BYTES * 4) throw new Error('Invalid extension data URL');
      const data = source.slice(0, comma).endsWith(';base64') ?
        Buffer.from(source.slice(comma + 1), 'base64') : Buffer.from(decodeURIComponent(source.slice(comma + 1)));
      if (data.length > MAX_BYTES) throw new Error('Extension data is too large');
      resolve(data.toString('utf8'));
    } catch (error) { reject(error); }
    return;
  }
  let url;
  try {
    url = new URL(source);
    if (url.protocol !== 'https:' || url.username || url.password || redirects > 3) {
      throw new Error('Cloud extensions require public HTTPS or data URLs');
    }
    const literal = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(literal) && privateAddress(literal, isIP(literal))) {
      throw new Error('Private extension address is not allowed');
    }
  } catch (error) { reject(error); return; }
  const request = https.get(url, {signal: AbortSignal.timeout(10000),
    headers: {'accept-encoding': 'identity'},
    lookup: (hostname, options, callback) => dns.lookup(hostname, {all: true}, (error, addresses) => {
      if (error) return callback(error);
      if (!addresses.length || addresses.some(a => privateAddress(a.address, a.family))) {
        return callback(new Error('Private extension address is not allowed'));
      }
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    })
  }, response => {
    if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
      response.resume();
      try { loadText(new URL(response.headers.location, url).href, redirects + 1).then(resolve, reject); }
      catch (error) { reject(error); }
      return;
    }
    if (response.statusCode !== 200) {
      response.resume(); reject(new Error(`Extension HTTP ${response.statusCode}`)); return;
    }
    let size = 0;
    const chunks = [];
    response.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BYTES) request.destroy(new Error('Extension data is too large'));
      else chunks.push(chunk);
    });
    response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    response.on('error', reject);
  });
  request.on('error', reject);
});

const stateOf = vm => ({
  targets: vm.runtime.targets.map(t => ({id: t.id, name: t.getName(), isStage: t.isStage,
    originalTargetId: t.sprite.clones[0]?.id, rotationStyle: t.rotationStyle, draggable: t.draggable,
    isOriginal: t.isOriginal, x: t.x, y: t.y, direction: t.direction, size: t.size, visible: t.visible,
    currentCostume: t.currentCostume, volume: t.volume, variables: t.variables, effects: t.effects,
    costumes: t.getCostumes().map(c => ({name: c.name, assetId: c.assetId, dataFormat: c.dataFormat}))})),
  editingTargetId: vm.editingTarget?.id, stageWidth: vm.runtime.stageWidth, stageHeight: vm.runtime.stageHeight,
  currentMSecs: vm.runtime.currentMSecs, timer: vm.runtime.ioDevices.clock.projectTimer(),
  answer: vm.runtime._primitives.sensing_answer(),
  mouse: {x: vm.runtime.ioDevices.mouse.getScratchX(), y: vm.runtime.ioDevices.mouse.getScratchY(),
    clientX: vm.runtime.ioDevices.mouse.getClientX(), clientY: vm.runtime.ioDevices.mouse.getClientY(),
    down: vm.runtime.ioDevices.mouse.getIsDown(), buttons: [...vm.runtime.ioDevices.mouse._buttons]},
  keys: vm.runtime.ioDevices.keyboard._keysPressed,
  options: require('@turbowarp/json').stringify(vm.runtime._generateAllProjectOptions())
});

module.exports = async (url, vm) => {
  const source = await loadText(url);
  const count = vm.runtime._nditorCloudExtensionCount || 0;
  if (count >= 4) throw new Error('Cloud custom extension memory budget reached');
  vm.runtime._nditorCloudExtensionCount = count + 1;
  // Exchange only JSON strings with the realm. In particular, do not expose
  // host functions or objects which could grant access to Node or server files.
  let realm;
  const cpuBudget = vm.runtime._nditorExtensionCpuBudget || {tokens: 250, time: Date.now()};
  vm.runtime._nditorExtensionCpuBudget = cpuBudget;
  try { realm = await createRealm({cpuBudget}); }
  catch (error) { vm.runtime._nditorCloudExtensionCount -= 1; throw error; }
  const run = code => realm.run(code);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    realm.dispose();
    vm.runtime._nditorCloudExtensionCount -= 1;
  };
  let cleanup = release;
  try {
  const root = path.dirname(require.resolve('scratch-vm'));
  const constants = {};
  for (const [name, file] of [['ArgumentType', 'argument-type'], ['BlockType', 'block-type'],
    ['BlockShape', 'tw-block-shape'], ['TargetType', 'target-type']]) {
    constants[name] = require(path.join(root, 'extension-support', file));
  }
  run(`
    globalThis.__extensions = []; globalThis.__targets = new Map(); globalThis.__targetList = [];
    globalThis.__state = {};
    globalThis.__listeners = Object.create(null); globalThis.__results = Object.create(null);
    globalThis.__actions = []; globalThis.__timers = new Map(); globalThis.__timerId = 0;
    globalThis.__fetches = new Map(); globalThis.__fetchId = 0;
    globalThis.Scratch = ${JSON.stringify(constants)};
    globalThis.window = globalThis; globalThis.self = globalThis;
    globalThis.console = {log() {}, warn() {}, error() {}};
    globalThis.fetch = (url,options={}) => new Promise((resolve,reject)=>{
      if(options.method && options.method.toUpperCase()!=='GET') {
        reject(new Error('Cloud extension fetch currently supports GET requests')); return;
      }
      __fetches.set(++__fetchId,{url:String(url),resolve,reject,started:false});
    });
    Scratch.fetch=fetch;
    Scratch.canFetch=async url=>String(url).startsWith('https:')||String(url).startsWith('data:');
    Scratch.extensions = {unsandboxed: true, register: e => __extensions.push(e)};
    Scratch.Cast = {toNumber: v => Number(v) || 0, toString: v => String(v),
      toBoolean: v => !(!v || v === '0' || String(v).toLowerCase() === 'false'),
      compare: (a,b) => {const x=Number(a), y=Number(b); return Number.isNaN(x) || Number.isNaN(y) ?
        String(a).toLowerCase().localeCompare(String(b).toLowerCase()) : x-y},
      isInt: v => Number.isInteger(Number(v))};
    Scratch.translate = m => typeof m === 'string' ? m : m.default || m.id;
    Scratch.translate.setup = () => {}; Scratch.translate.language = 'ja';
    globalThis.__target = id => __state.targets.find(t => t.id === id);
    globalThis.__stage = () => __state.targets.find(t => t.isStage);
    globalThis.__read = r => {const t = __target(r.targetId || __state.editingTargetId) || __stage();
      if(r.kind === 'variable') return (t?.variables[r.id] || __stage()?.variables[r.id])?.value ?? null;
      if(r.kind === 'target') return t;
      if(r.kind === 'options') return __state.options;
      if(r.kind === 'timer') return __state.timer;
      if(r.kind === 'answer') return __state.answer;
      throw new Error('Unknown host value');
    };
    Scratch.nditor = {version: 1, isHost: true, readHost: async r => __read(r)};
    Scratch.vm = {runtime: null};
    Scratch.vm.runtime = {
      get targets() {return __state.targets}, getTargetById: __target, getTargetForStage: __stage,
      getSpriteTargetByName: name=>__state.targets.find(t=>!t.isStage&&t.name===name&&t.isOriginal),
      getEditingTarget: () => __target(__state.editingTargetId),
      get stageWidth() {return __state.stageWidth}, get stageHeight() {return __state.stageHeight},
      get currentMSecs() {return __state.currentMSecs},
      ioDevices: {clock: {projectTimer: () => __state.timer},
        mouse: {getScratchX: () => __state.mouse.x, getScratchY: () => __state.mouse.y,
          getClientX: () => __state.mouse.clientX, getClientY: () => __state.mouse.clientY,
          getIsDown: () => __state.mouse.down, getButtonIsDown: b => __state.mouse.buttons.includes(b)},
        keyboard: {getKeyIsDown: k => String(k).toLowerCase() === 'any' ? __state.keys.length > 0 :
          __state.keys.includes(String(k).length === 1 ? String(k).toUpperCase() : String(k).toLowerCase())}},
      on: (event, fn) => {(__listeners[event] || (__listeners[event] = [])).push(fn);return Scratch.vm.runtime},
      off: (event, fn) => {__listeners[event] = (__listeners[event] || []).filter(f => f !== fn);
        return Scratch.vm.runtime},
      removeListener: (event, fn) => Scratch.vm.runtime.off(event, fn),
      startHats: (...args) => {__actions.push({method: 'startHats', args}); return []}
    };
    Scratch.vm.getVariableValue = (targetId, id) => __read({kind: 'variable', targetId, id});
    Scratch.vm.setVariableValue = (targetId,id,value) => {
      const variable=__target(targetId)?.lookupVariableById(id);if(variable)variable.value=value;
    };
    globalThis.setTimeout = (fn, delay=0, ...args) => {
      const id=++__timerId; __timers.set(id,{fn,args,at:Date.now()+Math.max(0,Number(delay)||0)}); return id;
    };
    globalThis.setInterval = (fn, delay=0, ...args) => {
      const id=setTimeout(fn,delay,...args); __timers.get(id).interval=Math.max(1,Number(delay)||1); return id;
    };
    globalThis.clearTimeout = globalThis.clearInterval = id => __timers.delete(id);
    globalThis.__tick = () => {let count=0; for(const [id,t] of __timers) {
      if(t.at>Date.now()) continue; if(++count>100) break;
      if(t.interval)t.at=Date.now()+t.interval;else __timers.delete(id); t.fn(...t.args);
    }};
    globalThis.__update = state => {
      __state = state; __actions = [];
      state.targets = state.targets.map(incoming => {
        const t = __targets.get(incoming.id) || {variables: Object.create(null)};
        for(const id of Object.keys(t.variables)) if(!Object.hasOwn(incoming.variables,id)) delete t.variables[id];
        for(const [id,v] of Object.entries(incoming.variables)) {
          const old=t.variables[id];
          if(old) {if(Array.isArray(old.value)&&Array.isArray(v.value)) {
            old.value.length=v.value.length; for(let i=0;i<v.value.length;i++)old.value[i]=v.value[i];
            v.value=old.value;} Object.assign(old,v);
          } else t.variables[id]=v;
        }
        const costumes=t.costumes||[];
        costumes.length=incoming.costumes.length;
        for(let i=0;i<costumes.length;i++)costumes[i]=Object.assign(costumes[i]||{},incoming.costumes[i]);
        incoming.costumes=costumes;
        const variables=t.variables; Object.assign(t,incoming); t.variables=variables; __targets.set(t.id,t);
        if(!t.sprite)Object.defineProperty(t,'sprite',{value:{get name(){return t.name},
          get costumes(){return t.costumes},
          get clones(){return __state.targets.filter(c=>c.originalTargetId===t.originalTargetId)}}});
        t.getName=()=>t.name; t.getCostumes=()=>t.costumes;
        t.lookupVariableById=id=>t.variables[id]||__stage()?.variables[id];
        for(const name of ['setXY','setDirection','setSize','setVisible','setCostume']) {
          t[name]=(...args)=>__actions.push({targetId:t.id,method:name,args});
        }
        return t;
      });
      const present=new Set(state.targets.map(t=>t.id));
      for(const id of __targets.keys())if(!present.has(id))__targets.delete(id);
      __targetList.length=state.targets.length;
      for(let i=0;i<state.targets.length;i++)__targetList[i]=state.targets[i];
      state.targets=__targetList;
    };
    void 0;
  `);
  run(`__update(${JSON.stringify(stateOf(vm))})`);
  run(`${source}\n;void 0;`);
  const infos = JSON.parse(run('JSON.stringify(__extensions.map(e=>e.getInfo()))'));
  if (!infos.length) throw new Error('Extension did not register during script loading');
  let invocation = 0;
  let timer = null;
  let disposed = false;
  const networkBudget = vm.runtime._nditorExtensionNetworkBudget ||
    {active: 0, tokens: 16, time: Date.now()};
  vm.runtime._nditorExtensionNetworkBudget = networkBudget;
  const attached = new Map();
  cleanup = () => {
    disposed = true;
    clearTimeout(timer);
    for (const [event, listener] of attached) vm.runtime.off(event, listener);
    attached.clear();
    release();
  };
  const attach = () => {
    if (disposed) return;
    const events = new Set(JSON.parse(run('JSON.stringify(Object.keys(__listeners).filter(e=>__listeners[e].length))')));
    if (events.size > 32 || [...events].some(event => typeof event !== 'string' || event.length > 128)) {
      throw new Error('Extension event listener limit exceeded');
    }
    for (const [event, listener] of attached) if (!events.has(event)) {
      vm.runtime.off(event, listener); attached.delete(event);
    }
    for (const event of events) {
      if (attached.has(event)) continue;
      const listener = (...args) => {
        try {
          const values = args.map(v => v?.id && v?.getName ? {id:v.id,name:v.getName(),isStage:v.isStage} :
            (v === null || ['string','number','boolean'].includes(typeof v) ? v : null));
          invoke(-1, event, values);
        } catch (error) { console.warn('[cloud-extension]', error.message); }
      };
      attached.set(event, listener); vm.runtime.on(event, listener);
    }
    const requests = JSON.parse(run(`JSON.stringify([...__fetches].filter(([,r])=>!r.started)
      .map(([id,r])=>{r.started=true;return {id,url:r.url}}))`));
    if (!Array.isArray(requests) || requests.length > 16) throw new Error('Extension fetch queue limit exceeded');
    for (const request of requests) {
      const deliver = reply => {
        if (disposed) return;
        try { invoke(-3, '', {...reply,id:request.id}); }
        catch (error) { console.warn('[cloud-extension]',error.message); }
      };
      const now = Date.now();
      networkBudget.tokens = Math.min(16, networkBudget.tokens + Math.max(0, now - networkBudget.time) / 1000);
      networkBudget.time = now;
      if (!request || typeof request.url !== 'string' || request.url.length > 8192 ||
          !Number.isSafeInteger(request.id) || networkBudget.active >= 4 || networkBudget.tokens < 1) {
        deliver({error:'Extension network limit exceeded'});
        continue;
      }
      networkBudget.active += 1;
      networkBudget.tokens -= 1;
      loadText(request.url).then(text=>deliver({text}),error=>deliver({error:error.message}))
        .finally(()=>{networkBudget.active -= 1});
    }
    if (!timer && run('__timers.size') > 0) {
      timer = setTimeout(() => {
        timer = null;
        if (disposed) return;
        try { invoke(-2, '', []); } catch (error) { console.warn('[cloud-extension]', error.message); }
      }, 10);
      timer.unref?.();
    }
  };
  const invoke = (index, method, args, util) => {
    if (disposed) throw new Error('Cloud extension has been disposed');
    const id = ++invocation;
    const baseline = JSON.parse(JSON.stringify(stateOf(vm)));
    let frame = {};
    try { frame = JSON.parse(JSON.stringify(util?.stackFrame || {})); } catch (_) {}
    const expression = index === -3 ? `(()=>{const reply=${JSON.stringify(args)};
      const r=__fetches.get(reply.id);if(!r)return;__fetches.delete(reply.id);
      if(reply.error)r.reject(new Error(reply.error));
      else r.resolve({ok:true,status:200,text:async()=>reply.text,json:async()=>JSON.parse(reply.text)});
    })()` : index === -2 ? '__tick()' : index === -1 ?
      `(__listeners[${JSON.stringify(method)}]||[]).forEach(fn=>fn(...${JSON.stringify(args)}))` :
      `__extensions[${index}][${JSON.stringify(method)}](${JSON.stringify(args ?? {})},utility)`;
    run(`__update(${JSON.stringify(baseline)}); (()=>{
      const utility={target:__target(${JSON.stringify(util?.target?.id || vm.editingTarget?.id || null)}),
        runtime:Scratch.vm.runtime,stackFrame:${JSON.stringify(frame)},
        ioQuery:(device,method,args=[])=>Scratch.vm.runtime.ioDevices[device][method](...args),
        yield:()=>__actions.push({method:'yield'}),startHats:Scratch.vm.runtime.startHats};
      const state=__state,actions=__actions;
      const finish=value=>__results[${id}]={value,actions,targets:state.targets,frame:utility.stackFrame};
      try{const value=${expression};
        if(value&&typeof value.then==='function')value.then(finish,e=>__results[${id}]={error:String(e)});
        else finish(value);
      }catch(e){__results[${id}]={error:String(e)}}
    })()`);
    const finish = () => {
      const encoded = run(`JSON.stringify(__results[${id}])`);
      if (!encoded) return null;
      const result = JSON.parse(encoded); run(`delete __results[${id}]`);
      if (result.error) throw new Error(result.error);
      if (!Array.isArray(result.targets) || result.targets.length > baseline.targets.length ||
          new Set(result.targets.map(t=>t?.id)).size !== result.targets.length ||
          !Array.isArray(result.actions) || result.actions.length > 128) {
        throw new Error('Extension host action limit exceeded');
      }
      if (util) for (const [key, value] of Object.entries(result.frame || {})) {
        if (!['__proto__','constructor','prototype'].includes(key)) util.stackFrame[key] = value;
      }
      for (const remote of result.targets || []) {
        const original = baseline.targets.find(t => t.id === remote.id);
        const target = vm.runtime.getTargetById(remote.id);
        if (!original || !target) continue;
        for (const [variableId, variable] of Object.entries(remote.variables)) {
          if (JSON.stringify(variable.value) === JSON.stringify(original.variables[variableId]?.value)) continue;
          if (Object.hasOwn(target.variables, variableId)) {
            const current = target.variables[variableId];
            if (Array.isArray(current.value) && Array.isArray(variable.value)) {
              current.value.length = variable.value.length;
              for (let i = 0; i < variable.value.length; i++) current.value[i] = variable.value[i];
            } else current.value = variable.value;
            current._monitorUpToDate = false;
          }
        }
      }
      for (const action of result.actions || []) {
        if (action.method === 'yield') util?.yield?.();
        else if (action.method === 'startHats' && typeof action.args?.[0] === 'string') {
          vm.runtime.startHats(action.args[0], action.args[1], vm.runtime.getTargetById(action.args[2]?.id));
        } else if (['setXY','setDirection','setSize','setVisible','setCostume'].includes(action.method)) {
          const target = vm.runtime.getTargetById(action.targetId);
          target?.[action.method]?.(...action.args.map(v => typeof v === 'boolean' ? v : Number(v) || 0));
        }
      }
      attach(); return {value: result.value};
    };
    const immediate = finish();
    if (immediate) return immediate.value;
    attach();
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const poll = () => {
        try {
          if (disposed) throw new Error('Cloud extension has been disposed');
          run('void 0'); const result = finish();
          if (result) {resolve(result.value); return;}
          if (Date.now() >= deadline) {run(`delete __results[${id}]`); throw new Error('Cloud extension timed out');}
          setTimeout(poll, 10);
        } catch (error) {reject(error);}
      };
      poll();
    });
  };
  attach();
  // Scratch reuses extension services when switching projects. Only the VM's
  // actual shutdown should dispose their engine, not an ordinary project clear.
  vm.runtime.once('NDITOR_VM_SHUTDOWN', cleanup);
  return infos.map((info,index) => {
    const proxy = {getInfo:()=>info};
    for (const block of info.blocks || []) if (typeof block === 'object') {
      const method = block.func || block.opcode;
      if (method) proxy[method] = (args,util)=>invoke(index,method,args,util);
    }
    for (const menu of Object.values(info.menus || {})) {
      const method = typeof menu === 'string' ? menu : menu?.items;
      if (typeof method === 'string') proxy[method] = targetId=>invoke(index,method,targetId);
    }
    return proxy;
  });
  } catch (error) {
    cleanup();
    throw error;
  }
};
