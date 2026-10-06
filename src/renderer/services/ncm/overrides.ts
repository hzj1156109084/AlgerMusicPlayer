/**
 * 端内网易云 API —— 本地覆盖实现
 *
 * 这个文件存在的唯一原因：上游 netease-cloud-music-api-alger 把**二维码登录**
 * 故意做成了不可用。
 *
 * module/login_qr_create.js 不生成二维码，而是返回一张写着
 * 「不支持二维登录 / 请使用其他方式 / 不需要再反馈了」的 SVG 图片：
 *
 *   const svg = `<svg ...><text>不支持二维登录</text>...</svg>`
 *   return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')
 *
 * 已实测确认（node -e 直接调用该模块，解码 qrimg 得到的正是那句话）。
 * 桌面版同样中招 —— src/main/server.ts 的 serveNcmApi 走的是同一个包。
 *
 * 但它返回的 qrurl 本身是**正确**的：`https://music.163.com/login?codekey=<unikey>`，
 * 这正是网易云官方网页扫码登录的地址。缺的只是「把这个 URL 编码成二维码图片」这一步。
 * 上游把这个包从 Node 端搬进浏览器时，丢掉了 qrcode 那一步（该模块改成不依赖 qrcode 了）。
 *
 * 所以这里用 qrcode（项目依赖）把它补回来。除此之外没有任何逻辑改动。
 */
import QRCode from 'qrcode';

import type { NcmModule, NcmResponse } from './types';

/** 与包内 util/index.js 的 getCookieValue 等价 */
const getCookieValue = (cookieStr: string, name: string): string => {
  if (!cookieStr) return '';
  const parts = ('; ' + cookieStr).split('; ' + name + '=');
  if (parts.length === 2) return parts.pop()!.split(';').shift()!;
  return '';
};

/** 与包内 util/index.js 的 generateChainId 等价（仅 platform === 'web' 时用） */
const generateChainId = (cookie: string): string => {
  const deviceId =
    getCookieValue(cookie, 'sDeviceId') || `unknown-${Math.floor(Math.random() * 1e6)}`;
  return `v1_${deviceId}_web_login_${Date.now()}`;
};

/**
 * 二维码图片边长（像素）。
 * 登录页容器是 200×200 且用了 object-fit: cover，给 2 倍图保证清晰度。
 */
const QR_SIZE = 400;

/**
 * 重建 /login/qr/create。
 *
 * 入参 query 与上游一致：{ key, qrimg, platform, cookie }
 * 返回体结构也与上游保持一致（body.data.qrurl / body.data.qrimg），
 * 因为 QrLogin.vue:43 读的正是 `data.data.qrimg`。
 */
const loginQrCreate: NcmModule = async (query): Promise<NcmResponse> => {
  const key = query?.key;
  if (!key) {
    return {
      status: 200,
      body: { code: 400, msg: '缺少 key', data: null },
      cookie: []
    };
  }

  const platform = query?.platform || 'pc';
  let qrurl = `https://music.163.com/login?codekey=${key}`;
  if (platform === 'web') {
    qrurl += `&chainId=${generateChainId(query?.cookie || '')}`;
  }

  // qrimg 为假值时上游返回空串，保持一致
  let qrimg = '';
  if (query?.qrimg) {
    qrimg = await QRCode.toDataURL(qrurl, {
      width: QR_SIZE,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#000000ff', light: '#ffffffff' }
    });
  }

  return {
    status: 200,
    body: { code: 200, data: { qrurl, qrimg } },
    cookie: []
  };
};

/**
 * 本地覆盖表。adapter 查表时**优先**匹配这里，命中则不加载包内模块。
 *
 * 加新条目前请先确认上游确实坏了 —— 大多数情况下包内实现是对的，
 * 无谓的覆盖只会让以后升级上游时更难对拍。
 */
export const OVERRIDES: Record<string, NcmModule> = {
  '/login/qr/create': loginQrCreate
};
