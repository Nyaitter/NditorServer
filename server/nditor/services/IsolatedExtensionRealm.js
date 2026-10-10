'use strict';

const {getQuickJS} = require('quickjs-emscripten');

// No host callbacks, Node objects, module loader or WASI imports are installed.
// The caller exchanges primitive values / JSON with this separate JS engine.
module.exports = async ({memoryBytes = 16 * 1024 * 1024, timeoutMs = 100,
  cpuBudget = {tokens: 250, time: Date.now()}} = {}) => {
  const engine = await getQuickJS();
  const runtime = engine.newRuntime();
  runtime.setMemoryLimit(memoryBytes);
  runtime.setMaxStackSize(512 * 1024);
  let deadline = 0;
  let disposed = false;
  runtime.setInterruptHandler(() => disposed || Date.now() >= deadline);
  const context = runtime.newContext();
  const failure = handle => {
    try {
      const value = context.dump(handle);
      return new Error(typeof value?.message === 'string' ? value.message.slice(0, 1000) : 'Isolated extension failed');
    } finally { handle.dispose(); }
  };
  return {
    run (code) {
      if (disposed) throw new Error('Isolated extension is disposed');
      const started = Date.now();
      cpuBudget.tokens = Math.min(250, cpuBudget.tokens + Math.max(0, started - cpuBudget.time) / 4);
      cpuBudget.time = started;
      if (cpuBudget.tokens < 1) throw new Error('Extension CPU budget exceeded');
      deadline = started + Math.min(timeoutMs, cpuBudget.tokens);
      try {
        const result = context.evalCode(code, 'nditor-extension.js', {type: 'global'});
        if (result.error) throw failure(result.error);
        try {
          const type = context.typeof(result.value);
          if (!['undefined','string','number','boolean'].includes(type) &&
              !context.eq(result.value, context.null)) {
            throw new Error('Only primitive values may cross the extension boundary');
          }
          const value = context.dump(result.value);
          // Drain a bounded number of guest promise jobs under the same deadline.
          const jobs = runtime.executePendingJobs(64);
          if (jobs.error) throw failure(jobs.error);
          if (runtime.hasPendingJob()) throw new Error('Extension promise job limit exceeded');
          return value;
        } finally { result.value.dispose(); }
      } finally { cpuBudget.tokens = Math.max(0, cpuBudget.tokens - (Date.now() - started)); }
    },
    dispose () {
      if (disposed) return;
      disposed = true;
      context.dispose();
      runtime.dispose();
    }
  };
};
