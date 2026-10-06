import type { LxInitedData, LxScriptInfo } from '@/types/lxMusic';
import * as lxCrypto from '@/utils/lxCrypto';

type WorkerInitMessage = {
  type: 'initialize';
  script: string;
  scriptInfo: LxScriptInfo;
};

type WorkerInvokeMessage = {
  type: 'invoke-request';
  callId: string;
  payload: any;
};

type WorkerHttpResponseMessage = {
  type: 'http-response';
  requestId: string;
  response: any;
  body: any;
  error?: string;
};

type WorkerHostMessage = WorkerInitMessage | WorkerInvokeMessage | WorkerHttpResponseMessage;

type HostInitializedMessage = {
  type: 'initialized';
  data: LxInitedData;
};

type HostScriptErrorMessage = {
  type: 'script-error';
  message: string;
};

type HostInvokeResultMessage = {
  type: 'invoke-result';
  callId: string;
  result: any;
};

type HostInvokeErrorMessage = {
  type: 'invoke-error';
  callId: string;
  message: string;
};

type HostHttpRequestMessage = {
  type: 'http-request';
  requestId: string;
  url: string;
  options: any;
};

type HostLogMessage = {
  type: 'log';
  level: 'log' | 'warn' | 'error' | 'info';
  args: any[];
};

type HostWorkerMessage =
  | HostInitializedMessage
  | HostScriptErrorMessage
  | HostInvokeResultMessage
  | HostInvokeErrorMessage
  | HostHttpRequestMessage
  | HostLogMessage;

let requestHandler: ((data: any) => Promise<any>) | null = null;
let initialized = false;
let requestCounter = 0;

const pendingHttpCallbacks = new Map<
  string,
  (error: Error | null, response: any, body: any) => void
>();

const postToHost = (message: HostWorkerMessage) => {
  self.postMessage(message);
};

const postLog = (level: HostLogMessage['level'], ...args: any[]) => {
  postToHost({
    type: 'log',
    level,
    args
  });
};

/**
 * 确认脚本初始化的时间上限，故意比宿主 `LxMusicSourceRunner.initialize()`
 * 的 10000ms 略短，好让下面那条更具体的报错先送达，而不是被笼统的
 * 「脚本初始化超时」抢先。
 */
const INIT_CONFIRM_TIMEOUT_MS = 9000;

/**
 * 脚本在初始化期间抛出的异常。
 * `import()` 只等模块的**同步部分**执行完就 resolve，所以脚本里那些
 * 「先把远端配置 await 回来再发 inited」的写法，它抛的错我们是接不到的
 * （同步抛错会被 import 接住并 reject，异步的不会）。这里单独记一笔，
 * 超时的时候就能把真正的报错透出去。
 */
let lastScriptError: Error | null = null;

self.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
  // 初始化完成之后的未捕获异常属于脚本运行期问题，不影响初始化判定
  if (initialized) return;
  lastScriptError =
    event.reason instanceof Error ? event.reason : new Error(String(event.reason));
  postLog('error', '[LxScript] 初始化期间未捕获的异常:', lastScriptError.message);
});

const hardenGlobalScope = () => {
  const blockedKeys: Array<keyof typeof globalThis> = [
    'fetch',
    'XMLHttpRequest',
    'WebSocket',
    'EventSource'
  ] as any;

  blockedKeys.forEach((key) => {
    try {
      Object.defineProperty(globalThis, key, {
        configurable: true,
        writable: false,
        value: undefined
      });
    } catch {
      // ignore
    }
  });
};

const createLxApi = (scriptInfo: LxScriptInfo) => {
  return {
    version: '2.8.0',
    env: 'desktop',
    appInfo: {
      version: '2.8.0',
      versionNum: 208,
      locale: 'zh-cn'
    },
    currentScriptInfo: scriptInfo,
    EVENT_NAMES: {
      inited: 'inited',
      request: 'request',
      updateAlert: 'updateAlert'
    },
    on: (eventName: string, handler: (data: any) => Promise<any>) => {
      if (eventName === 'request') {
        requestHandler = handler;
      }
    },
    send: (eventName: string, data: any) => {
      if (eventName === 'inited') {
        initialized = true;
        postToHost({
          type: 'initialized',
          data: data as LxInitedData
        });
      } else if (eventName === 'updateAlert') {
        postLog('info', '[LxScript][updateAlert]', data);
      }
    },
    request: (
      url: string,
      options: any,
      callback: (err: Error | null, resp: any, body: any) => void
    ) => {
      const requestId = `wreq_${Date.now()}_${requestCounter++}`;
      pendingHttpCallbacks.set(requestId, callback);
      postToHost({
        type: 'http-request',
        requestId,
        url,
        options
      });
      return () => {
        pendingHttpCallbacks.delete(requestId);
      };
    },
    utils: {
      buffer: {
        from: (data: any, _encoding?: string) => {
          if (typeof data === 'string') {
            return new TextEncoder().encode(data);
          }
          return new Uint8Array(data);
        },
        bufToString: (buffer: Uint8Array, encoding?: string) => {
          return new TextDecoder(encoding || 'utf-8').decode(buffer);
        }
      },
      crypto: {
        md5: lxCrypto.md5,
        sha1: lxCrypto.sha1,
        sha256: lxCrypto.sha256,
        randomBytes: lxCrypto.randomBytes,
        aesEncrypt: lxCrypto.aesEncrypt,
        aesDecrypt: lxCrypto.aesDecrypt,
        rsaEncrypt: lxCrypto.rsaEncrypt,
        rsaDecrypt: lxCrypto.rsaDecrypt,
        base64Encode: lxCrypto.base64Encode,
        base64Decode: lxCrypto.base64Decode
      },
      zlib: {
        inflate: async (buffer: ArrayBuffer) => {
          try {
            const ds = new DecompressionStream('deflate');
            const writer = ds.writable.getWriter();
            writer.write(buffer);
            writer.close();
            const reader = ds.readable.getReader();
            const chunks: Uint8Array[] = [];
            let done = false;
            while (!done) {
              const result = await reader.read();
              done = result.done;
              if (result.value) chunks.push(result.value);
            }
            const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
            const result = new Uint8Array(totalLength);
            let offset = 0;
            for (const chunk of chunks) {
              result.set(chunk, offset);
              offset += chunk.length;
            }
            return result.buffer;
          } catch {
            return buffer;
          }
        },
        deflate: async (buffer: ArrayBuffer) => {
          try {
            const cs = new CompressionStream('deflate');
            const writer = cs.writable.getWriter();
            writer.write(buffer);
            writer.close();
            const reader = cs.readable.getReader();
            const chunks: Uint8Array[] = [];
            let done = false;
            while (!done) {
              const result = await reader.read();
              done = result.done;
              if (result.value) chunks.push(result.value);
            }
            const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
            const result = new Uint8Array(totalLength);
            let offset = 0;
            for (const chunk of chunks) {
              result.set(chunk, offset);
              offset += chunk.length;
            }
            return result.buffer;
          } catch {
            return buffer;
          }
        }
      }
    }
  };
};

const resetWorkerState = () => {
  requestHandler = null;
  initialized = false;
  lastScriptError = null;
  pendingHttpCallbacks.clear();
  requestCounter = 0;
};

/**
 * 等脚本调用 `lx.send(EVENT_NAMES.inited, data)`。
 *
 * **不能**在 `await import()` 之后同步查 `initialized` —— ES module 的 `import()`
 * 只等同步部分就跑完了，而现实里的落雪音源大多要先 `await` 把远端配置拉回来
 * 才发 inited（本仓库 `resources/洛雪音乐 V3.0.js` 那种在模块顶层直接同步发的反而是少数）。
 * 同步查会把它们全部误判成「脚本未调用 lx.send」。
 */
const waitForInitialized = (deadline: number): Promise<boolean> => {
  if (initialized) return Promise.resolve(true);
  return new Promise((resolve) => {
    const tick = () => {
      if (initialized) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(tick, 50);
    };
    setTimeout(tick, 50);
  });
};

const SCRIPT_PRELUDE = `const globalThisRef = globalThis;
const lx = globalThis.lx;`;

/**
 * 执行音源脚本。
 *
 * **优先按经典脚本执行** —— LX 的脚本本来就是经典脚本。
 * javascript-obfuscator 生成的全局解析链长这样：
 *
 *   typeof window === 'object' ? window
 *     : typeof global === 'object' ? global : this
 *
 * Worker 里 `window`/`global` 都是 undefined，全靠最后一跳 `this` 兜底拿全局对象。
 * 而 **ES module 的顶层 `this` 是 `undefined`**，整条链就返回 undefined，
 * 脚本第一次 `.console` 就炸：「Cannot read properties of undefined (reading 'console')」。
 *
 * 用 `new Function(...).call(globalThis)` 把 `this` 显式绑成全局对象，拿回经典语义。
 * 只有编译期就报 SyntaxError 的（真用了 import/export/顶层 await 的 ESM 脚本）
 * 才回退到 blob module，保持原来的能力不变。
 */
const runScript = async (script: string) => {
  let execute: (this: unknown) => unknown;
  try {
    execute = new Function(`${SCRIPT_PRELUDE}\n${script}`) as (this: unknown) => unknown;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    postLog('warn', '[LxScript] 不是经典脚本，回退到 ES module 方式执行:', error.message);
    const scriptUrl = URL.createObjectURL(
      new Blob([`${SCRIPT_PRELUDE}\n${script}\nexport {};`], {
        type: 'text/javascript'
      })
    );
    try {
      await import(/* @vite-ignore */ scriptUrl);
    } finally {
      URL.revokeObjectURL(scriptUrl);
    }
    return;
  }
  execute.call(globalThis);
};

const initializeScript = async (script: string, scriptInfo: LxScriptInfo) => {
  // 在第一个 await 之前取，等价于宿主发出 initialize 的时刻
  const deadline = Date.now() + INIT_CONFIRM_TIMEOUT_MS;

  resetWorkerState();
  hardenGlobalScope();

  (globalThis as any).lx = createLxApi(scriptInfo);

  await runScript(script);

  if (!(await waitForInitialized(deadline))) {
    throw lastScriptError
      ? new Error(`脚本初始化失败: ${lastScriptError.message}`)
      : new Error('脚本未调用 lx.send(EVENT_NAMES.inited, data)');
  }
};

const resolveInvocation = async (callId: string, payload: any) => {
  if (!requestHandler) {
    postToHost({
      type: 'invoke-error',
      callId,
      message: '脚本未注册请求处理器'
    });
    return;
  }

  try {
    const result = await requestHandler(payload);
    postToHost({
      type: 'invoke-result',
      callId,
      result
    });
  } catch (error) {
    postToHost({
      type: 'invoke-error',
      callId,
      message: error instanceof Error ? error.message : String(error)
    });
  }
};

self.onmessage = async (event: MessageEvent<WorkerHostMessage>) => {
  const message = event.data;

  switch (message.type) {
    case 'initialize':
      try {
        await initializeScript(message.script, message.scriptInfo);
      } catch (error) {
        postToHost({
          type: 'script-error',
          message: error instanceof Error ? error.message : String(error)
        });
      }
      break;

    case 'invoke-request':
      await resolveInvocation(message.callId, message.payload);
      break;

    case 'http-response': {
      const callback = pendingHttpCallbacks.get(message.requestId);
      if (!callback) return;
      pendingHttpCallbacks.delete(message.requestId);
      if (message.error) {
        callback(new Error(message.error), null, null);
      } else {
        callback(null, message.response, message.body);
      }
      break;
    }

    default:
      break;
  }
};
