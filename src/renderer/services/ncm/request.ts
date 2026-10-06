/**
 * 端内网易云 API —— 请求层
 *
 * 移植自 netease-cloud-music-api-alger@4.30.0 的 util/request.js。
 * 原实现依赖 Node（http/https agent、tunnel、pac-proxy-agent、fs、os.tmpdir），
 * 这里换成浏览器可用的实现，但**输入输出契约完全保持一致**，
 * 因此包内 366 个 module/*.js 无需任何改动即可运行。
 *
 * 安全边界：本文件只向 music.163.com / interface.music.163.com 发请求，
 * 用户的 Cookie 仅来自调用方传入的 option.cookie（由 utils/request.ts 从
 * localStorage['token'] 注入），绝不发往任何第三方。
 */
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import CryptoJS from 'crypto-js';
// 直接复用包内配置，避免两处常量各自漂移。
// 该包 package.json 没有 exports 字段，所以深层导入是允许的。
import { APP_CONF } from 'netease-cloud-music-api-alger/util/config.json';

import { eapi, eapiResDecrypt, weapi } from './crypto';
import type { NcmOption, NcmRequestFn, NcmResponse } from './types';

/**
 * 域名取自包内 APP_CONF（apiDomain = interface.music.163.com，domain = music.163.com），
 * 不硬编码 —— 上游换域名时这里跟着走。
 */
const DOMAIN = APP_CONF.domain;
const API_DOMAIN = APP_CONF.apiDomain;

/**
 * 这些业务码在原实现里会被归一成 HTTP 200，让模块 resolve 而不是 reject。
 * 800/801/802/803 正是二维码登录的轮询状态（已过期 / 待扫码 / 已扫码 / 成功）。
 * 注意 301 不在此列 —— 它会被原样透出，正是登出的信号。
 */
const SPECIAL_STATUS_CODES = new Set([201, 302, 400, 502, 800, 801, 802, 803]);

const OS_MAP: Record<string, { os: string; appver: string; osver: string; channel: string }> = {
  pc: {
    os: 'pc',
    appver: '3.1.17.204416',
    osver: 'Microsoft-Windows-10-Professional-build-19045-64bit',
    channel: 'netease'
  },
  android: {
    os: 'android',
    appver: '8.20.20.231215173437',
    osver: '14',
    channel: 'xiaomi'
  },
  iphone: {
    os: 'iPhone OS',
    appver: '9.0.90',
    osver: '16.2',
    channel: 'distribution'
  }
};

const USER_AGENT_MAP: Record<string, Record<string, string>> = {
  weapi: {
    pc: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0'
  },
  api: {
    pc: 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/91.0.4472.164 NeteaseMusicDesktop/3.0.18.203152',
    android:
      'NeteaseMusic/9.1.65.240927161425(9001065);Dalvik/2.1.0 (Linux; U; Android 14; 23013RK75C Build/UKQ1.230804.001)',
    iphone: 'NeteaseMusic 9.0.90/5038 (iPhone; iOS 16.2; zh_CN)'
  }
};

/** 与原实现一致：每个会话生成一次 */
const WNMCID = (() => {
  const chars = 'abcdefghijklmnopqrstuvwxyz';
  let randomString = '';
  for (let i = 0; i < 6; i++) {
    randomString += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `${randomString}.${Date.now()}.01.0`;
})();

/** 原实现用 crypto.randomBytes(32).toString('hex')，会话级随机即可 */
const DEVICE_ID = CryptoJS.lib.WordArray.random(32).toString();

const toBoolean = (val: any): any => {
  if (typeof val === 'boolean') return val;
  if (val === '') return val;
  return val === 'true' || val == '1';
};

/**
 * 解析 cookie 字符串。
 *
 * ⚠️ 这里**故意偏离**上游 util/index.js 的实现。
 *
 * 上游写法是 `const arr = item.split('='); if (arr.length === 2) ...`，
 * 也就是要求每段恰好被 `=` 切成两半。但 cookie 的**值本身可能含 `=`**
 * （base64 填充最常见），这时 split 出来是 3 段以上，条件不成立，
 * 整个字段被**静默丢弃**。
 *
 * 实测（用上游实现跑）：
 *   'MUSIC_U=YWJjZGVmZ2g=; __csrf=xyz'  →  { __csrf: 'xyz' }   ← MUSIC_U 没了
 *   'MUSIC_U=00A1B2C3=; __csrf=abc'     →  { __csrf: 'abc' }   ← MUSIC_U 没了
 *
 * 也就是说：只要用户的 MUSIC_U 带一个 `=` 结尾，整个登录态就直接失效，
 * 而且不报任何错。改用「按第一个 = 切分」即可，对正常输入结果完全一致。
 */
const cookieToJson = (cookie: string): Record<string, string> => {
  if (!cookie) return {};
  const obj: Record<string, string> = {};
  for (const item of cookie.split(';')) {
    const idx = item.indexOf('=');
    // idx === 0 是空 key（如 token 末尾多出的 ';'），直接跳过
    if (idx <= 0) continue;
    const key = item.slice(0, idx).trim();
    if (!key) continue;
    obj[key] = item.slice(idx + 1).trim();
  }
  return obj;
};

const cookieObjToString = (cookie: Record<string, any>): string => {
  return Object.keys(cookie)
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(cookie[key])}`)
    .join('; ');
};

/**
 * 补全 cookie —— 与原实现 processCookieObject 一致。
 * 这些字段（_ntes_nuid / WNMCID / os 等）是网易接口用来识别客户端的，缺了会有风控问题。
 */
const processCookieObject = (
  cookie: Record<string, any>,
  uri: string
): Record<string, any> => {
  const ntesNuid = CryptoJS.lib.WordArray.random(32).toString();
  const os = OS_MAP[cookie.os] || OS_MAP['pc'];

  const processed: Record<string, any> = {
    ...cookie,
    __remember_me: 'true',
    ntes_kaola_ad: '1',
    _ntes_nuid: cookie._ntes_nuid || ntesNuid,
    _ntes_nnid: cookie._ntes_nnid || `${ntesNuid},${Date.now()}`,
    WNMCID: cookie.WNMCID || WNMCID,
    WEVNSM: cookie.WEVNSM || '1.0.0',
    osver: cookie.osver || os.osver,
    deviceId: cookie.deviceId || DEVICE_ID,
    os: cookie.os || os.os,
    channel: cookie.channel || os.channel,
    appver: cookie.appver || os.appver
  };

  // 登录相关接口不带 NMTID
  if (uri.indexOf('login') === -1) {
    processed['NMTID'] = CryptoJS.lib.WordArray.random(16).toString();
  }

  // 桌面端从 os.tmpdir()/anonymous_token 读，那里写的是空字符串，所以这里等价于不设置
  if (!processed.MUSIC_U) {
    processed.MUSIC_A = processed.MUSIC_A || '';
  }

  return processed;
};

const chooseUserAgent = (crypto: string, uaType = 'pc'): string => {
  return USER_AGENT_MAP[crypto]?.[uaType] || '';
};

const generateRequestId = (): string => {
  return `${Date.now()}_${Math.floor(Math.random() * 1000)
    .toString()
    .padStart(4, '0')}`;
};

interface RawHttpResult {
  status: number;
  /** 已经是对象就是已解析的 JSON，否则是待解析的字符串 */
  data: any;
  /** Set-Cookie 原始值，可能不存在（浏览器 fetch 读不到） */
  setCookie?: string[] | string;
  rawText?: string;
}

/**
 * 发一个 POST。
 *
 * 必须优先走 CapacitorHttp 而不是 fetch，原因有二：
 *  1. music.163.com 不返回 CORS 头，浏览器 fetch 会被拦
 *  2. Set-Cookie 是 fetch 的 forbidden response header，读不到，
 *     而二维码登录的 803 分支完全依赖它拿 MUSIC_U
 * 另外 Referer / User-Agent 在浏览器 fetch 里也是 forbidden header，会被静默丢弃。
 */
const postForm = async (
  url: string,
  body: string,
  headers: Record<string, string>
): Promise<RawHttpResult> => {
  const allHeaders = {
    ...headers,
    'Content-Type': 'application/x-www-form-urlencoded'
  };

  if (Capacitor.isNativePlatform()) {
    const res = await CapacitorHttp.request({
      url,
      method: 'POST',
      headers: allHeaders,
      data: body,
      connectTimeout: 15000,
      readTimeout: 15000
    });

    return {
      status: res.status,
      data: res.data,
      setCookie: (res.headers as Record<string, any>)?.['set-cookie']
    };
  }

  // 浏览器回退分支：仅供 Web 端开发调试，Set-Cookie / Referer 拿不到
  const res = await fetch(url, { method: 'POST', headers: allHeaders, body });
  const text = await res.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 保持原始文本
  }
  return { status: res.status, data: parsed, rawText: text };
};

/** 归一化 Set-Cookie：可能是数组、单字符串，或原生层用逗号拼接的长串 */
const normalizeSetCookie = (value: string[] | string | undefined): string[] => {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((item) => item.replace(/\s*Domain=[^(;|$)]+;*/, ''));
};

/**
 * 注入给包内各 module 的 request 函数。
 *
 * @param uri 带 /api 前缀的网易内部路径，如 /api/song/enhance/player/url/v1
 * @param data 业务参数
 * @param option 由 createOption(query) 构造
 */
export const ncmRequest: NcmRequestFn = async (
  uri: string,
  data: any,
  option: NcmOption = {}
): Promise<NcmResponse> => {
  const headers: Record<string, string> = { ...(option.headers || {}) };

  // 真实 IP 伪装（原实现 :167-174）。桌面端由 setData.realIP 驱动，
  // 移动端一般用不到，但保留以保持行为一致。
  const ip = option.realIP || option.ip || '';
  if (ip) {
    headers['X-Real-IP'] = ip;
    headers['X-Forwarded-For'] = ip;
  }

  // cookie 准备
  let cookie = option.cookie || ({} as Record<string, any>);
  if (typeof cookie === 'string') {
    cookie = cookieToJson(cookie);
  }
  if (typeof cookie === 'object') {
    cookie = processCookieObject(cookie, uri);
    headers['Cookie'] = cookieObjToString(cookie);
  }

  const csrfToken = cookie['__csrf'] || '';
  // 未显式指定时走 eapi —— 与包内 APP_CONF.encrypt = true 的行为一致
  const crypto = option.crypto || (APP_CONF.encrypt ? 'eapi' : 'api');

  data = data || {};

  /**
   * 返回值是否加密。原实现（:197-205）在**进入加密分支之前**就把结果写回 data.e_r，
   * 优先级为 options.e_r > data.e_r > APP_CONF.encryptResponse(=false)。
   * 本包的 encryptResponse 是 false，且没有任何模块传 e_r，所以实际恒为 false；
   * 逻辑仍照搬，避免以后上游打开它时行为漂移。
   */
  let e_r = APP_CONF.encryptResponse;
  if (data.e_r !== undefined) e_r = data.e_r;
  if (option.e_r !== undefined) e_r = option.e_r;
  data.e_r = toBoolean(e_r);

  let url = '';
  let payload: any = {};

  if (crypto === 'weapi') {
    headers['Referer'] = option.domain || DOMAIN;
    headers['User-Agent'] = option.ua || chooseUserAgent('weapi');
    data.csrf_token = csrfToken;
    payload = weapi(data);
    url = `${option.domain || DOMAIN}/weapi/${uri.substr(5)}`;
  } else {
    // eapi（以及原实现里未实现的 'api' 明文模式，本项目用不到）
    const header: Record<string, any> = {
      osver: cookie.osver,
      deviceId: cookie.deviceId,
      os: cookie.os,
      appver: cookie.appver,
      versioncode: cookie.versioncode || '140',
      mobilename: cookie.mobilename || '',
      buildver: cookie.buildver || Date.now().toString().substr(0, 10),
      resolution: cookie.resolution || '1920x1080',
      __csrf: csrfToken,
      channel: cookie.channel,
      requestId: generateRequestId(),
      // ⚠️ options.checkToken 只是开关，头值固定取 APP_CONF.checkToken（原实现 :243-245）。
      // 收藏歌单（playlist_subscribe.js）依赖它，写错会直接被风控拒绝。
      ...(option.checkToken ? { 'X-antiCheatToken': APP_CONF.checkToken } : {})
    };

    if (cookie.MUSIC_U) header['MUSIC_U'] = cookie.MUSIC_U;
    if (cookie.MUSIC_A) header['MUSIC_A'] = cookie.MUSIC_A;

    headers['Cookie'] = cookieObjToString(header);
    headers['User-Agent'] = option.ua || chooseUserAgent('api', 'iphone');

    data.header = header;

    payload = eapi(uri, data);
    url = `${option.domain || API_DOMAIN}/eapi/${uri.substr(5)}`;
  }

  const body = new URLSearchParams(payload as Record<string, string>).toString();

  const answer: NcmResponse = { status: 500, body: {}, cookie: [] };

  let res: RawHttpResult;
  try {
    res = await postForm(url, body, headers);
  } catch (error: any) {
    // 与原实现 :366-371 一致：网络层异常归一成 502 再 reject，
    // 而不是把原始异常抛出去 —— 模块内部是按 answer 的形状处理的。
    answer.status = 502;
    answer.body = { code: 502, msg: error?.message || String(error) };
    console.warn('[ncm] 网络异常', uri, answer.body.msg);
    return Promise.reject(answer);
  }

  answer.cookie = normalizeSetCookie(res.setCookie);

  /**
   * 响应加密开关。原实现 :282：(crypto === 'eapi' || crypto === 'weapi') && data.e_r。
   * 本包 APP_CONF.encryptResponse = false 且没有模块传 e_r，所以实际恒为 false。
   *
   * acapi 参数对应原实现的 headers['x-aeapi']（:256 被注释掉了，从未设置），
   * 因此这里固定传 false。
   */
  const useER = (crypto === 'eapi' || crypto === 'weapi') && !!data.e_r;

  let parsedBody: any;
  if (useER) {
    parsedBody = await eapiResDecrypt(String(res.data).toUpperCase(), false);
    if (parsedBody === null) {
      // 与原实现一致：解密失败时 body 保持空，随后会因取不到 code 而落到 400
      console.warn('[ncm] 响应解密失败', uri);
      parsedBody = {};
    }
  } else {
    try {
      parsedBody = typeof res.data === 'object' ? res.data : JSON.parse(String(res.data));
    } catch {
      parsedBody = res.data;
    }
  }

  answer.body = parsedBody;

  try {
    if (answer.body && answer.body.code !== undefined) {
      answer.body.code = Number(answer.body.code);
    }
    answer.status = Number((answer.body && answer.body.code) || res.status);

    if (SPECIAL_STATUS_CODES.has(answer.body?.code)) {
      answer.status = 200;
    }
  } catch (error) {
    answer.body = parsedBody;
    answer.status = res.status;
  }

  answer.status =
    answer.status > 100 && answer.status < 600 ? answer.status : 400;

  if (answer.status === 200) {
    return answer;
  }

  // 与原实现一致：非 200 时 reject，模块内部各自 try/catch 处理
  console.warn('[ncm] 请求失败', answer.status, uri);
  return Promise.reject(answer);
};
