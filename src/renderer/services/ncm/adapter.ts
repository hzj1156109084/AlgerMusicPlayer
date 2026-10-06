/**
 * 端内网易云 API —— axios 适配器
 *
 * 这是整个端内 API 层唯一的对外入口：挂到 utils/request.ts 的 axios 实例上之后，
 * src/renderer/api/*.ts 里那 ~90 个调用点一行都不用改。
 *
 * 数据流：
 *   api/*.ts  →  axios(挂本适配器)  →  routes.generated.ts 查表
 *             →  包内 module/*.js   →  ./request.ts 加密并发出
 *             →  music.163.com      →  原始 JSON 作为 response.data 返回
 *
 * 响应契约（已对照 QrLogin.vue 等消费端确认）：
 *   response.data 就是网易云原始 JSON body，不额外包一层。
 *   例如 qrKey.data.data.unikey、data.code === 803、data.cookie。
 */
import { AxiosError } from 'axios';
import type { AxiosAdapter, AxiosResponse, InternalAxiosRequestConfig } from 'axios';

import { OVERRIDES } from './overrides';
import { ROUTES } from './routes.generated';
import { ncmRequest } from './request';
import type { NcmResponse } from './types';

/** 从 axios config 里取出接口路径（去掉 baseURL 与查询串） */
const extractPath = (config: InternalAxiosRequestConfig): string => {
  const raw = config.url || '';
  const full =
    config.baseURL && !/^https?:\/\//i.test(raw) ? `${config.baseURL}${raw}` : raw;

  try {
    return new URL(full, 'http://ncm.local').pathname;
  } catch {
    return raw.split('?')[0];
  }
};

/**
 * 组装查询参数。
 *
 * axios 的 transformRequest 已经在适配器之前跑过，所以 POST 的 config.data
 * 是被序列化过的字符串，这里要还原成对象。
 *
 * 注意这里**不做字段过滤** —— 原实现里 app 的参数（含 timestamp / device /
 * noCookie 等）本来就是原样发给后端服务的，包内模块只按名字取自己要的字段，
 * 保持原样才能保证行为一致。
 */
const buildQuery = (config: InternalAxiosRequestConfig): Record<string, any> => {
  const params = { ...(config.params || {}) };

  let bodyData: Record<string, any> = {};
  if (config.data) {
    if (typeof config.data === 'string') {
      try {
        bodyData = JSON.parse(config.data);
      } catch {
        bodyData = {};
      }
    } else if (typeof config.data === 'object') {
      bodyData = config.data as Record<string, any>;
    }
  }

  return { ...params, ...bodyData };
};

export const ncmAdapter: AxiosAdapter = async (config) => {
  const path = extractPath(config);
  // 本地覆盖优先 —— 目前只有 /login/qr/create（上游故意返回「不支持」的图，见 overrides.ts）
  const module = OVERRIDES[path] || ROUTES[path]?.module;

  if (!module) {
    // 软失败：不抛异常，避免整页白屏。正常情况不该走到这里（79 个端点已全部映射）
    console.warn(`[ncm] 未实现的接口: ${path}`);
    return {
      data: { code: 404, msg: `ncm: 未实现的接口 ${path}`, data: null },
      status: 200,
      statusText: '',
      headers: {},
      config,
      request: {}
    } as AxiosResponse;
  }

  const query = buildQuery(config);

  let result: NcmResponse;
  try {
    result = await module(query, ncmRequest);
  } catch (error) {
    // 包内模块的 request 在非 200 时是 reject 的，reject 出来的就是答案对象本身
    if (error && typeof error === 'object' && 'status' in error && 'body' in error) {
      result = error as NcmResponse;
    } else {
      throw error;
    }
  }

  const response: AxiosResponse = {
    data: result.body,
    status: result.status,
    statusText: '',
    headers: {},
    config,
    request: {}
  };

  // 与 axios 默认 validateStatus（200-299 视为成功）一致。
  // 关键点：网易返回 code 301 时 result.status 就是 301，
  // utils/request.ts:93 的登出逻辑读的正是 error.response.status，所以这里必须走 reject 分支。
  if (response.status >= 200 && response.status < 300) {
    return response;
  }

  throw new AxiosError(
    `Request failed with status code ${response.status}`,
    response.status >= 500 ? AxiosError.ERR_BAD_RESPONSE : AxiosError.ERR_BAD_REQUEST,
    config,
    {},
    response
  );
};
