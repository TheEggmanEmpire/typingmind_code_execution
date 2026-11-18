// Reuse the plugin's pure renderers and remote compiler adapters in an isolated
// context. Server fetch is direct: browser CORS patches never run here.
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
const ctx = vm.createContext({
  fetch, URL, URLSearchParams, TextEncoder, TextDecoder, AbortController, AbortSignal,
  setTimeout, clearTimeout, console, crypto: crypto.webcrypto, Blob, FormData,
  Response, Request, Headers, DecompressionStream, atob, btoa, performance, Uint8Array, ArrayBuffer,
  __crRealFetch: fetch, __crFetchTimeout: 30000, __crNoPublicProxies: true,
  __crCorsProxy: '', __crSecrets: {}
});
const names = ['previewHtml','previewKind','guessMime','extOf','fmtSize','mdEscape','FENCE_BY_EXT',
  'ALL_LANGS','CE_LANGS','WB_LANGS','LANG_ALIASES','normalizeLanguage','runRemote','buildNotebook',
  'CHART_HTML','PY_HELPERS','R_HELPERS','sniffImage','imageMake','imageFailText',
  'IMAGE_API_BASE','globToRegex','parseCsvHeader','csvCell','PY_PIP_ALIASES','TS_GLOBALS'];
vm.runInContext(fs.readFileSync(new URL('../../implementation.js', import.meta.url),'utf8') +
  '\n; netFetch = (input, init) => timedFetch(rawFetch(), input, init, 30000);' +
  '\n; globalThis.__exports = {' + names.join(',') + '};', ctx, {filename:'implementation.js'});
export const legacy = { ...ctx.__exports,
  buildNotebook(history, format) {
    return ctx.__exports.buildNotebook(history.map(h => ({...h,lang:h.lang ?? h.language,out:h.out ?? h.output,t:h.t ?? h.time})),format);
  }
};
