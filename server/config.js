'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname,'..');
const envPath = path.join(root,'.env');
const configPath = path.join(root,'config.json');

// Parse data, never source/eval .env as shell code. Quoted multiline values,
// export prefixes, comments and escaped newlines follow dotenv conventions.
const envPattern = /(?:^|\n)\s*(?:export\s+)?([\w.-]+)\s*=\s*("(?:\\.|[^"\\])*"|'[^']*'|`[^`]*`|[^\n]*)/g;
function parseEnv(text) {
  const values = {};
  for (const match of text.replace(/\r\n/g,'\n').matchAll(envPattern)) {
    let value = match[2].trim();
    const quote = value[0];
    if (['"',"'",'`'].includes(quote) && value.endsWith(quote)) {
      value = value.slice(1,-1);
      if (quote === '"') value = value.replace(/\\n/g,'\n').replace(/\\r/g,'\r').replace(/\\"/g,'"').replace(/\\\\/g,'\\');
    } else value = value.replace(/\s*#.*$/,'').trim();
    if (!['__proto__','constructor','prototype'].includes(match[1])) values[match[1]] = value;
  }
  return values;
}
function rawConfig() {
  if (!fs.existsSync(configPath)) return {};
  let value;
  try { value = JSON.parse(fs.readFileSync(configPath,'utf8')); }
  catch { throw new Error('config.json contains invalid JSON'); }
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('config.json must contain an object');
  return value;
}
const fields = {
  url: ['NDITOR_URL','URL'],
  nyaitter_url: ['NDITOR_NYAITTER_URL','NYAITTER_URL','NDITOR_UPSTREAM'],
  token: ['NDITOR_TOKEN','TOKEN','NDITOR_EXTENSION_API_KEY']
};
function read() {
  const json = rawConfig();
  const fileEnv = fs.existsSync(envPath) ? parseEnv(fs.readFileSync(envPath,'utf8')) : {};
  const setting = (names, keys, fallback) => {
    for (const env of [process.env,fileEnv]) for (const name of names) {
      if (env[name] !== undefined && env[name] !== '') return env[name];
    }
    for (const key of keys) {
      const value = key.split('.').reduce((object,part)=>object?.[part],json);
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return fallback;
  };
  const url = validUrl(setting(fields.url,['url'],'http://127.0.0.1:3001'));
  const upstream = validUrl(setting(fields.nyaitter_url,['nyaitter_url'],'http://127.0.0.1:3000'));
  const allowHttp = String(setting(['NDITOR_ALLOW_HTTP'],['allow_http'],'false')).toLowerCase();
  if (upstream.protocol === 'http:' && !['localhost','127.0.0.1','[::1]'].includes(upstream.hostname) &&
      !['true','1','yes','on'].includes(allowHttp)) throw new Error('Use HTTPS for remote NyaitterServer, or set NDITOR_ALLOW_HTTP=true');
  const port = Number(setting(['NDITOR_PORT','PORT'],['port'],url.port || 3001));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535');
  const local = ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  const host = String(setting(['NDITOR_HOST'],['host'],local ? url.hostname.replace(/^\[|\]$/g,'') : '127.0.0.1'));
  if (!host || /[\s\/\\]/.test(host)) throw new Error('Invalid listen host');
  const token = String(setting(fields.token,['token'],'')).trim();
  if (token.length > 8192 || /\s/.test(token)) throw new Error('token must be a single token without whitespace');
  const apiPath = String(setting(['NDITOR_NYAITTER_API_PATH'],['nyaitter_api_path','api_path'],
    upstream.pathname === '/' ? '/server' : upstream.pathname.replace(/\/$/,'')));
  if (!/^\/(?:[a-zA-Z0-9_-]+\/?)*$/.test(apiPath)) throw new Error('Invalid Nyaitter API path');
  return {url:url.href.replace(/\/$/,''),nyaitter_url:upstream.href.replace(/\/$/,''),token,port,host,apiPath,
    webRoot:path.resolve(setting(['NDITOR_WEB_ROOT'],['web_root'],path.join(root,'build'))),fileEnv};
}
function validUrl(value) {
  const url = new URL(String(value));
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('url / nyaitter_url must be HTTP(S) URLs without credentials, query or fragment');
  }
  return url;
}
function apply() {
  const config = read();
  for (const [key,value] of Object.entries(config.fileEnv)) if (!Object.hasOwn(process.env,key)) process.env[key] = value;
  Object.assign(process.env,{NDITOR_URL:config.url,NDITOR_UPSTREAM:new URL(config.nyaitter_url).origin,
    NDITOR_EXTENSION_API_KEY:config.token,NDITOR_PORT:String(config.port),NDITOR_HOST:config.host,
    NDITOR_NYAITTER_API_PATH:config.apiPath,NDITOR_WEB_ROOT:config.webRoot});
  return config;
}
function set(id,value) {
  if (!Object.hasOwn(fields,id)) throw new Error('Supported config IDs: url, nyaitter_url, token');
  if (id !== 'token') validUrl(value);
  else if (!value || value.length > 8192 || /\s/.test(value)) throw new Error('Invalid token');
  const json = rawConfig();
  json[id] = value;
  fs.writeFileSync(configPath,JSON.stringify(json,null,2)+'\n',{mode:0o600});
  fs.chmodSync(configPath,0o600);
  if (fs.existsSync(envPath)) {
    let text = fs.readFileSync(envPath,'utf8').replace(/\r\n/g,'\n');
    const active = new Set(fields[id]);
    let replaced = false;
    text = text.replace(envPattern,(whole,key)=>{
      if (!active.has(key)) return whole;
      replaced = true;
      return `${whole.startsWith('\n') ? '\n' : ''}${key}=${JSON.stringify(value)}`;
    });
    if (!replaced) text = text.replace(/\s*$/,'')+`\n${fields[id][0]}=${JSON.stringify(value)}\n`;
    fs.writeFileSync(envPath,text,{mode:0o600});
    fs.chmodSync(envPath,0o600);
  }
}
module.exports = {read,apply,set,root,fields};
