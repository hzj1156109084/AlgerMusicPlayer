import { Capacitor, registerPlugin } from '@capacitor/core';

/**
 * 原生下载落点插件（com.algermusic.app.AndroidStoragePlugin）的 JS 壳。
 *
 * 三条纪律，都跟「同一个 renderer 也跑在 Electron 和浏览器里」有关：
 *
 * 1. 顶层的 registerPlugin **不做任何调用**。web 上它只是返回一个 Proxy，属性访问本身不炸；
 *    真正会炸的是调用——那是一个 rejected promise（不是同步抛）。所以每个导出函数的第一行
 *    都必须是平台守卫。
 *
 * 2. 守卫用 `Capacitor.getPlatform() === 'android'` 而不是 `isNativePlatform()`：iOS 上
 *    后者为 true，但本插件没有 iOS 实现，调下去只会 reject。这点和 utils 里的 `isAndroid`
 *    保持同一个判据，「按钮显不显示」和「点了能不能用」才不会各说各话。
 *
 * 3. 所有函数**永不抛**：不可用/失败返回 null / false / `{ ok: false, code }`。调用方据此
 *    决定提示还是回退。这与 audioDiskCache 的守卫风格一致（见该文件里「守卫要放在
 *    ensureLoaded() 之前」那段注释的由来）。
 */

/** 落点模式。'mediastore' = 系统音乐库的 Music/<subDir>/；'saf' = 用户自己挑的目录。 */
export type AndroidSaveMode = 'mediastore' | 'saf';

export type AndroidSaveFailureCode =
  /** 非 Android / 插件不可用 */
  | 'unavailable'
  /** 参数不合法 */
  | 'invalid_input'
  /** 源文件不在（缓存被清了、被淘汰了） */
  | 'source_not_found'
  /** API < 29：没有 RELATIVE_PATH，走不了音乐库，应改走 'saf' */
  | 'unsupported_api_level'
  /** 目标目录没授权 / 授权被撤销 */
  | 'no_directory_permission'
  | 'io_error'
  | 'unknown';

export type AndroidSaveOutcome =
  | { ok: true; uri: string; displayPath: string; size: number }
  | { ok: false; code: AndroidSaveFailureCode; fallback?: 'saf'; message?: string };

export type AndroidStorageDirectory = {
  /** SAF tree URI（content://...），由原生侧持久化授权 */
  uri: string;
  /** 展示用名字，如 "AlgerMusic" / "内部存储" */
  label: string;
};

export type AndroidSaveFileOptions = {
  /**
   * 源文件。相对路径按 Directory.Data（getFilesDir()）解析，与 audioDiskCache 的
   * AudioCacheEntry.filePath 同义；也接受绝对路径 / file:// / content://。
   */
  sourcePath: string;
  /** 目标文件名，含扩展名 */
  fileName: string;
  mimeType: string;
  mode: AndroidSaveMode;
  /** 目标子目录，只在 mediastore 模式用；空串表示直接写 Music/ 根 */
  subDir?: string;
  /** mode='saf' 时必填 */
  treeUri?: string;
};

type AndroidStorageNative = {
  pickDirectory(): Promise<AndroidStorageDirectory>;
  getDirectoryLabel(options: { uri: string }): Promise<{ label: string }>;
  hasDirectoryPermission(options: { uri: string }): Promise<{ granted: boolean }>;
  /**
   * 注意：原生侧**失败也 resolve**（返回 `{ ok: false, code, ... }`），只有用户取消
   * pickDirectory 才 reject。这样 JS 侧不必去猜 Capacitor 的 reject 值形状
   * （它是桥内部拼的 `{ message, code, data }`，不是稳定的公开契约）。
   */
  saveFile(options: AndroidSaveFileOptions): Promise<AndroidSaveOutcome>;
};

// 顶层注册是安全的：名字必须与 @CapacitorPlugin(name = "AndroidStorage") 逐字一致
const AndroidStorage = registerPlugin<AndroidStorageNative>('AndroidStorage');

const isAndroidNative = (): boolean => Capacitor.getPlatform() === 'android';

/** 下载按钮和设置页据此决定要不要出现。 */
export const isAndroidStorageAvailable = (): boolean => isAndroidNative();

/**
 * 拉起系统目录选择器（ACTION_OPEN_DOCUMENT_TREE）。
 * 非 Android、用户取消、或任何异常一律返回 null。
 */
export const pickDirectory = async (): Promise<AndroidStorageDirectory | null> => {
  if (!isAndroidNative()) return null;
  try {
    const result = await AndroidStorage.pickDirectory();
    return result?.uri ? result : null;
  } catch (error) {
    // 用户取消也走这里（原生 reject 'cancelled'），不该当错误报出来
    console.warn('[androidStorage] 选择目录未完成:', error);
    return null;
  }
};

/** 设置页那一行展示用。查不到返回 null，由调用方回退到提示文案。 */
export const getDirectoryLabel = async (uri: string): Promise<string | null> => {
  if (!isAndroidNative() || !uri) return null;
  try {
    const { label } = await AndroidStorage.getDirectoryLabel({ uri });
    return label || null;
  } catch (error) {
    console.warn('[androidStorage] 读取目录名失败:', error);
    return null;
  }
};

/** 校验之前持久化的目录授权是否还有效（用户可能在系统设置里撤销了）。 */
export const hasDirectoryPermission = async (uri: string): Promise<boolean> => {
  if (!isAndroidNative() || !uri) return false;
  try {
    const { granted } = await AndroidStorage.hasDirectoryPermission({ uri });
    return !!granted;
  } catch (error) {
    console.warn('[androidStorage] 校验目录授权失败:', error);
    return false;
  }
};

/**
 * 把应用私有目录里的一个文件复制到目标位置。**幂等覆盖**：原生侧先按「目录+文件名」
 * 找已有项，有就截断重写，所以重复下载不会产生 `歌名 (1).mp3`。
 */
export const saveFile = async (options: AndroidSaveFileOptions): Promise<AndroidSaveOutcome> => {
  if (!isAndroidNative()) return { ok: false, code: 'unavailable' };
  try {
    return await AndroidStorage.saveFile(options);
  } catch (error) {
    // 正常路径不会走到这里（原生失败也 resolve）。留着是为了不让一个桥层异常
    // 穿透到调用方——下载失败该是一条提示，不是一个未捕获的 rejection。
    console.error('[androidStorage] 落盘失败:', error);
    return { ok: false, code: 'unknown', message: (error as Error)?.message };
  }
};
