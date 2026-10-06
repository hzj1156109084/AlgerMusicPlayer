/**
 * 端内网易云 API —— 类型定义
 *
 * 这里的契约完全对齐 netease-cloud-music-api-alger 的 util/request.js，
 * 因为我们要原样复用它的 module/*.js（那些模块不关心 request 怎么实现）。
 */

/** request 的返回值，对应原实现里的 answer */
export interface NcmResponse {
  /** HTTP 语义的状态码，取自业务 body.code（见 request.ts 的归一化规则） */
  status: number;
  /** 网易云返回的原始 JSON body */
  body: any;
  /** Set-Cookie 列表（已剥掉 Domain 属性），模块会 join(';') 后塞进 body.cookie */
  cookie: string[];
}

/** 由 createOption(query, mode) 构造出的调用选项 */
export interface NcmOption {
  crypto?: string;
  cookie?: string;
  ua?: string;
  proxy?: string;
  realIP?: string;
  /** 原实现里 options.ip 与 realIP 等价，都会写进 X-Real-IP / X-Forwarded-For */
  ip?: string;
  /** 调用方预置的请求头（原实现 createRequest 支持，模块目前没用到，保留以免行为漂移） */
  headers?: Record<string, string>;
  e_r?: any;
  domain?: string;
  /**
   * 是否附加 X-antiCheatToken 头。
   *
   * ⚠️ 这是**布尔开关**，不是头值本身。原实现（util/request.js:243-245）是：
   *   options.checkToken ? { 'X-antiCheatToken': APP_CONF.checkToken } : {}
   * 头值固定取自 config.json 的 APP_CONF.checkToken。
   * 目前只有 playlist_subscribe.js 会把它置为 true（收藏歌单）。
   */
  checkToken?: boolean;
}

/**
 * 注入给每个 module 的 request 函数。
 *
 * 签名与 netease-cloud-music-api-alger/util/request.js 的 createRequest 一致：
 *   request(uri, data, option) => Promise<{status, body, cookie}>
 * 其中 uri 是带 /api 前缀的网易内部路径（如 /api/song/enhance/player/url/v1），
 * 模块自己带好了，本层负责剥离前缀并加密。
 */
export type NcmRequestFn = (
  uri: string,
  data: any,
  option?: NcmOption
) => Promise<NcmResponse>;

/** 包内每个 module 的导出签名 */
export type NcmModule = (query: any, request: NcmRequestFn) => Promise<NcmResponse>;

/** 路由表的表项 */
export interface NcmRoute {
  /** 该端点使用的加密方式（仅作调试参考，实际由模块内的 createOption 决定） */
  crypto: 'weapi' | 'eapi';
  module: NcmModule;
}
