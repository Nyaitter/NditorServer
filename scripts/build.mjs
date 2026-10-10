import {createRequire} from 'node:module';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
process.chdir(root);
process.env.NODE_ENV = process.argv.includes('--development') ? 'development' : (process.env.NODE_ENV || 'production');
await import('./clean-build.mjs');

// Use worker threads on Windows so minification does not depend on launching
// additional command-shell processes. Keep memory use bounded on small hosts.
if (process.platform === 'win32') {
    const workerPath = require.resolve('terser-webpack-plugin/node_modules/jest-worker');
    const workerExports = require(workerPath);
    const Worker = workerExports.default || workerExports;
    class ThreadWorker extends Worker {
        constructor(workerFile, options) {
            super(workerFile, {...options, enableWorkerThreads: true});
        }
    }
    if (workerExports.default) workerExports.default = ThreadWorker;
    else require.cache[workerPath].exports = ThreadWorker;
}

const webpack = require('webpack');
const configurations = require('../webpack.config.js');
for (const configuration of configurations) {
    configuration.plugins = configuration.plugins.filter(plugin => plugin.constructor.name !== 'ProgressPlugin');
    for (const minimizer of configuration.optimization?.minimizer || []) {
        if (minimizer.options) minimizer.options.parallel = 1;
    }
}
webpack(configurations, (error, stats) => {
    if (error) {
        console.error(error);
        process.exitCode = 1;
        return;
    }
    console.log(stats.toString({all: false, errors: true, warnings: true, timings: true}));
    if (stats.hasErrors()) process.exitCode = 1;
});
