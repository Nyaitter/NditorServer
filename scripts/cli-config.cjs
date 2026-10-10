'use strict';
const fs = require('node:fs');
const path = require('node:path');
const settings = require('../server/config');
try {
  const [command,id,value,...extra] = process.argv.slice(2);
  if (extra.length) throw new Error('Unexpected arguments');
  if (command === 'set') {
    if (value === undefined) throw new Error('Missing configuration value');
    settings.set(id,value); console.log(`${id} updated`);
  } else if (command === 'get') {
    if (!Object.hasOwn(settings.fields,id)) throw new Error('Unknown config ID');
    const config = settings.read();console.log(id === 'token' ? (config.token ? '[configured]' : '[unset]') : config[id]);
  } else if (command === 'status') {
    const {token,fileEnv,...config} = settings.read();
    console.log(JSON.stringify({...config,tokenConfigured:Boolean(token)},null,2));
  } else if (command === 'ready') {
    const config = settings.read();
    if (!fs.existsSync(path.join(config.webRoot,'editor.html'))) throw new Error('WebUI is missing; run nditor install or nditor build');
  } else if (command === 'npm-path') {
    const candidates = [process.env.npm_execpath,path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js'),
      path.resolve(path.dirname(process.execPath),'../lib/node_modules/npm/bin/npm-cli.js')].filter(Boolean);
    console.log(candidates.find(p=>path.basename(p)==='npm-cli.js' && fs.existsSync(p)) || '');
  } else if (command === 'dependencies') {
    const sources = JSON.parse(fs.readFileSync(path.join(settings.root,'vendor/sources.json'),'utf8'));
    for (const source of Object.values(sources)) {
      if (!/^https:\/\/github\.com\/Nyaitter\/[\w.-]+\.git$/.test(source.repository) || !/^[a-f0-9]{40}$/.test(source.revision) ||
          !/^[\w.-]+$/.test(source.branch) || !/^vendor\/[\w.-]+$/.test(source.path)) throw new Error('Invalid dependency source');
    }
    for (const source of Object.values(sources)) console.log([source.repository,source.revision,source.branch,source.path].join('\t'));
  } else throw new Error('Unknown config helper command');
} catch (error) {console.error(`NditorServer: ${error.message}`);process.exitCode=1;}
