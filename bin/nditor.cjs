#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const envFile = path.join(root,'.env');
if (fs.existsSync(envFile)) for (const line of fs.readFileSync(envFile,'utf8').split(/\r?\n/)) {
  const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
  if (match && !Object.hasOwn(process.env,match[1])) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/,'$2');
}
const help = `NditorServer CLI

  nditor install [--no-build]                 Fork依存を取得し、npm依存とWebUIを準備
  nditor build [--development]                WebUIをビルド
  nditor connect --server URL --token-file FILE [--api-path /server]
                                             Nyaitter接続先と拡張トークンを保存
  nditor serve [--port 3001] [--host 127.0.0.1] [--web-root DIR] [--development]
                                             WebUIと共同作業APIを配信
  nditor status                              秘密情報を伏せて設定を表示
  nditor --help

全コマンド: --config-dir DIR （既定: ユーザー設定領域）
connect: HTTPSまたはローカルHTTP。その他のHTTPを使用する場合は --allow-http
`;

function argumentsOf(argv) {
  const flags = new Set(['help','no-build','development','allow-http']);
  const values = new Set(['config-dir','server','token-file','api-path','port','host','web-root']);
  const options = {};
  let command = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      if (command) throw new Error(`Unexpected argument: ${arg}`);
      command = arg;
      continue;
    }
    const [name, ...inline] = arg.slice(2).split('=');
    if (flags.has(name)) {
      if (inline.length) throw new Error(`--${name} does not accept a value`);
      options[name] = true;
    } else if (values.has(name)) {
      const value = inline.length ? inline.join('=') : argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`);
      options[name] = value;
    } else throw new Error(`Unknown option: --${name}`);
  }
  return {command: command || 'help', options};
}

function execute(program, args, cwd = root, capture = false) {
  const result = spawnSync(program, args, {cwd, env: process.env,
    stdio: capture ? ['ignore','pipe','pipe'] : 'inherit', encoding: 'utf8'});
  if (result.error || result.status !== 0) {
    throw new Error(`${path.basename(program)} failed${result.error ? `: ${result.error.message}` : ` (${result.status})`}`);
  }
  return capture ? result.stdout.trim() : null;
}

function npmCommand(args) {
  const candidates = [process.env.npm_execpath,
    path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js'),
    path.resolve(path.dirname(process.execPath),'../lib/node_modules/npm/bin/npm-cli.js')].filter(Boolean);
  const script = candidates.find(file => path.basename(file) === 'npm-cli.js' && fs.existsSync(file));
  if (script) return execute(process.execPath, [script, ...args]);
  if (process.platform === 'win32') {
    // Fixed arguments only; never interpolate paths or secrets into a shell.
    if (args.some(arg => !/^[a-z=-]+$/.test(arg))) throw new Error('Unsafe npm arguments');
    return execute(process.env.ComSpec || 'cmd.exe', ['/d','/c','npm.cmd',...args]);
  }
  return execute('npm', args);
}

function configDirectory(options) {
  const base = process.platform === 'win32' ? process.env.LOCALAPPDATA || os.homedir() :
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(),'.config');
  return path.resolve(options['config-dir'] || process.env.NDITOR_CONFIG_DIR || path.join(base,'nditor-server'));
}

function readConfig(directory) {
  const file = path.join(directory,'config.json');
  if (!fs.existsSync(file)) return {};
  const config = JSON.parse(fs.readFileSync(file,'utf8'));
  if (!config || Array.isArray(config) || typeof config !== 'object') throw new Error('Invalid config.json');
  return config;
}

function normalizeServer(value, allowHttp = false) {
  const url = new URL(value);
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Server must be an HTTP(S) URL without credentials, query or fragment');
  }
  const local = ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if (url.protocol === 'http:' && !local && !allowHttp) {
    throw new Error('Use HTTPS for remote NyaitterServer, or explicitly pass --allow-http');
  }
  return url;
}

function connect(options, directory) {
  if (!options.server || !options['token-file']) throw new Error('connect requires --server and --token-file');
  const url = normalizeServer(options.server, options['allow-http']);
  if (directory === root || directory.startsWith(root+path.sep)) {
    throw new Error('Store connection settings outside the NditorServer checkout');
  }
  const source = path.resolve(options['token-file']);
  if (fs.statSync(source).size > 8192) throw new Error('Extension token file is too large');
  const token = fs.readFileSync(source,'utf8').trim();
  if (!token || /\s/.test(token)) throw new Error('Extension token must be a single nonempty token');
  const apiPath = options['api-path'] || (url.pathname === '/' ? '/server' : url.pathname.replace(/\/$/,''));
  if (!/^\/(?:[a-zA-Z0-9_-]+\/?)*$/.test(apiPath)) throw new Error('Invalid --api-path');
  fs.mkdirSync(directory, {recursive:true, mode:0o700});
  const tokenFile = path.join(directory,'extension-token');
  fs.writeFileSync(tokenFile,token+'\n',{mode:0o600});
  fs.chmodSync(tokenFile,0o600);
  const config = {...readConfig(directory), server:url.origin, apiPath, tokenFile,
    allowHttp:Boolean(options['allow-http'])};
  const file = path.join(directory,'config.json');
  fs.writeFileSync(file,JSON.stringify(config,null,2)+'\n',{mode:0o600});
  fs.chmodSync(file,0o600);
  console.log(`NyaitterServer connection configured: ${url.origin}${apiPath}`);
  console.log('Extension token saved; its value is not displayed. Start with nditor serve.');
}

function install(options) {
  const sources = JSON.parse(fs.readFileSync(path.join(root,'vendor/sources.json'),'utf8'));
  for (const source of Object.values(sources)) {
    const target = path.resolve(root,source.path);
    if (!target.startsWith(path.join(root,'vendor')+path.sep) || !/^https:\/\/github\.com\/Nyaitter\/[\w.-]+\.git$/.test(source.repository) ||
        !/^[a-f0-9]{40}$/.test(source.revision)) throw new Error('Invalid dependency source manifest');
    if (!fs.existsSync(target)) {
      execute('git',['clone','--depth','1','--branch',source.branch,source.repository,target]);
    }
    if (!fs.existsSync(path.join(target,'.git'))) throw new Error(`Existing dependency is not a Git checkout: ${source.path}`);
    const origin = execute('git',['remote','get-url','origin'],target,true);
    if (origin !== source.repository) throw new Error(`Unexpected dependency origin: ${source.path}`);
    if (execute('git',['status','--porcelain'],target,true)) throw new Error(`Dependency has local changes: ${source.path}`);
    const head = execute('git',['rev-parse','HEAD'],target,true);
    if (head !== source.revision) {
      execute('git',['fetch','--depth','1','origin',source.revision],target);
      execute('git',['checkout','--detach',source.revision],target);
    }
    console.log(`${source.path}: ${source.revision.slice(0,12)}`);
  }
  // Upstream lifecycle hooks may build, download binaries or run tests. The
  // required application build is explicit and uses the pinned source forks.
  npmCommand(['ci','--include=dev','--ignore-scripts','--no-audit','--no-fund']);
  if (!options['no-build']) build(options);
}

function build(options) {
  execute(process.execPath,[path.join(root,'scripts/build.mjs'),...(options.development ? ['--development'] : [])]);
}

function serve(options, directory) {
  const config = readConfig(directory);
  const port = Number(options.port || process.env.NDITOR_PORT || config.port || 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be an integer from 1 to 65535');
  const host = options.host || process.env.NDITOR_HOST || config.host || '127.0.0.1';
  if (!host || /[\s\/\\]/.test(host)) throw new Error('Invalid listen host');
  const webRoot = path.resolve(options['web-root'] || process.env.NDITOR_WEB_ROOT || path.join(root,'build'));
  if (!fs.existsSync(path.join(webRoot,'editor.html'))) throw new Error('WebUI is missing. Run nditor install or nditor build first.');
  const serverUrl = options.server || process.env.NDITOR_UPSTREAM || config.server || 'http://127.0.0.1:3000';
  const url = normalizeServer(serverUrl, options['allow-http'] || config.allowHttp);
  const tokenFile = options['token-file'] ? path.resolve(options['token-file']) :
    process.env.NDITOR_EXTENSION_API_KEY_FILE || config.tokenFile;
  if (options['token-file'] && !fs.existsSync(tokenFile)) throw new Error('Extension token file does not exist');
  Object.assign(process.env, {NDITOR_PORT:String(port),NDITOR_HOST:host,NDITOR_WEB_ROOT:webRoot,
    NDITOR_UPSTREAM:url.origin,NDITOR_NYAITTER_API_PATH:options['api-path'] || config.apiPath || '/server',
    NODE_ENV:options.development ? 'development' : 'production'});
  if (tokenFile) process.env.NDITOR_EXTENSION_API_KEY_FILE = tokenFile;
  process.env.NDITOR_STORAGE_ROOT ||= path.join(directory,'storage');
  process.chdir(root);
  require(path.join(root,'server.js'));
}

try {
  const {command,options} = argumentsOf(process.argv.slice(2));
  const directory = configDirectory(options);
  if (options.help || command === 'help') console.log(help);
  else if (command === 'install') install(options);
  else if (command === 'build') build(options);
  else if (command === 'connect') connect(options,directory);
  else if (command === 'serve') serve(options,directory);
  else if (command === 'status') {
    const config = readConfig(directory);
    console.log(JSON.stringify({configDirectory:directory,server:config.server || null,apiPath:config.apiPath || '/server',
      extensionTokenConfigured:Boolean(config.tokenFile && fs.existsSync(config.tokenFile)),
      webUiReady:fs.existsSync(path.join(root,'build/editor.html'))},null,2));
  } else throw new Error(`Unknown command: ${command}`);
} catch (error) {
  console.error(`NditorServer: ${error.message}`);
  process.exitCode = 1;
}
