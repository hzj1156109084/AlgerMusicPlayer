/**
 * 端内网易云 API —— 加密层
 *
 * 移植自 netease-cloud-music-api-alger@4.30.0 的 util/crypto.js，两处关键差异：
 *  1. AES 直接复用 crypto-js（项目已有依赖，renderer 侧本来就在用，见 utils/lxCrypto.ts）
 *  2. RSA 原实现依赖 node-forge 的 `encrypt(str, 'NONE')`（裸 RSA，无填充）。
 *     node-forge 是纯 JS 但在浏览器里体积过大，这里用 BigInt 等价实现。
 */
import CryptoJS from 'crypto-js';

const IV = '0102030405060708';
const PRESET_KEY = '0CoJUm6Qyw8W8jud';
const EAPI_KEY = 'e82ckenh8dichen8';
const BASE62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * weapi 公钥模数（1024 bit）。
 * 取自包内 util/crypto.js 的 PEM：MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2...
 * （已用 Node 的 crypto.createPublicKey 解出比对，除去 DER 的符号填充字节 00 后完全一致）
 */
const RSA_MODULUS = BigInt(
  '0x' +
    'e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7'
);
const RSA_EXPONENT = 65537n;
/** 模数 1024 bit → 密文固定 128 字节 → 256 个 hex 字符 */
const RSA_OUTPUT_HEX_LEN = 256;

/**
 * 模幂运算（快速幂取模）。
 *
 * 注意：不能写成 `base ** exp % mod` —— BigInt 的 `**` 会先把整个幂算出来，
 * 65537 次方会产生约 8MB 的中间大数，既慢又占内存。必须逐位平方取模。
 */
const modPow = (base: bigint, exp: bigint, mod: bigint): bigint => {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
};

/**
 * AES 加密
 *
 * @param text 明文
 * @param mode 'cbc'（weapi 用）或 'ecb'（eapi / linuxapi 用）
 * @param key  密钥
 * @param iv   初始向量，ECB 模式传空字符串
 * @param format 'base64' 返回标准 base64；'hex' 返回大写 hex
 */
const aesEncrypt = (
  text: string,
  mode: 'cbc' | 'ecb',
  key: string,
  iv: string,
  format: 'base64' | 'hex' = 'base64'
): string => {
  const encrypted = CryptoJS.AES.encrypt(
    CryptoJS.enc.Utf8.parse(text),
    CryptoJS.enc.Utf8.parse(key),
    {
      iv: CryptoJS.enc.Utf8.parse(iv),
      mode: mode === 'cbc' ? CryptoJS.mode.CBC : CryptoJS.mode.ECB,
      padding: CryptoJS.pad.Pkcs7
    }
  );

  if (format === 'base64') {
    return encrypted.toString();
  }
  return encrypted.ciphertext.toString().toUpperCase();
};

/**
 * AES 解密（eapi 响应解密用）
 *
 * @param ciphertext hex 密文
 */
const aesDecryptHex = (ciphertext: string): CryptoJS.lib.WordArray => {
  return CryptoJS.AES.decrypt(
    { ciphertext: CryptoJS.enc.Hex.parse(ciphertext) },
    CryptoJS.enc.Utf8.parse(EAPI_KEY),
    {
      iv: CryptoJS.enc.Utf8.parse(''),
      mode: CryptoJS.mode.ECB,
      padding: CryptoJS.pad.Pkcs7
    }
  );
};

/**
 * 裸 RSA 加密（无填充），等价于 node-forge 的 `publicKey.encrypt(text, 'NONE')`。
 *
 * forge 会把入参字符串按 UTF-8 字节序列当作大端整数。这里的入参是纯 ASCII 的
 * 16 字符 secretKey，每字符恰好一字节，所以逐字符 charCodeAt 即可。
 *
 * @param text 已反转的 secretKey（反转由调用方 weapi() 负责，与原实现保持一致）
 * @returns 256 个 hex 字符
 */
export const rsaEncrypt = (text: string): string => {
  let hex = '';
  for (let i = 0; i < text.length; i++) {
    hex += text.charCodeAt(i).toString(16).padStart(2, '0');
  }

  const m = BigInt('0x' + hex);
  return modPow(m, RSA_EXPONENT, RSA_MODULUS).toString(16).padStart(RSA_OUTPUT_HEX_LEN, '0');
};

export interface WeapiResult {
  params: string;
  encSecKey: string;
}

/**
 * weapi 加密：双层 AES-128-CBC，再对随机 secretKey 做 RSA
 */
export const weapi = (object: Record<string, any>): WeapiResult => {
  const text = JSON.stringify(object);

  let secretKey = '';
  for (let i = 0; i < 16; i++) {
    secretKey += BASE62.charAt(Math.round(Math.random() * 61));
  }

  return {
    params: aesEncrypt(aesEncrypt(text, 'cbc', PRESET_KEY, IV), 'cbc', secretKey, IV),
    encSecKey: rsaEncrypt(secretKey.split('').reverse().join(''))
  };
};

export interface EapiResult {
  params: string;
}

/**
 * eapi 加密：AES-128-ECB，无 RSA。比 weapi 简单，但需要解密响应。
 */
export const eapi = (url: string, object: any): EapiResult => {
  const text = typeof object === 'object' ? JSON.stringify(object) : object;
  const message = `nobody${url}use${text}md5forencrypt`;
  const digest = CryptoJS.MD5(message).toString();
  const data = `${url}-36cd479b6b5-${text}-36cd479b6b5-${digest}`;

  return {
    params: aesEncrypt(data, 'ecb', EAPI_KEY, '', 'hex')
  };
};

/**
 * 解密 eapi 响应。
 *
 * 原实现用 Node 的 zlib（同步），浏览器只有异步的 DecompressionStream，
 * 所以这里是 async —— 仅 eapi 路径需要，weapi 路径不涉及。
 *
 * @param aeapi 响应是否为 gzip 压缩（对应请求里的 e_r / x-aeapi）
 */
export const eapiResDecrypt = async (encryptedParams: string, aeapi = false): Promise<any> => {
  try {
    const decrypted = aesDecryptHex(encryptedParams);

    if (!aeapi) {
      return JSON.parse(decrypted.toString(CryptoJS.enc.Utf8));
    }

    // 带压缩：先 base64 解码，再 gunzip
    const base64 = decrypted.toString(CryptoJS.enc.Base64);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    const stream = new DecompressionStream('gzip');
    const writer = stream.writable.getWriter();
    writer.write(bytes);
    writer.close();

    const reader = stream.readable.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }

    const total = chunks.reduce((acc, c) => acc + c.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.length;
    }

    return JSON.parse(new TextDecoder().decode(merged));
  } catch (error) {
    console.error('[ncm] eapi 响应解密失败:', error);
    return null;
  }
};
