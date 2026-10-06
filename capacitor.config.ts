import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor 配置。
 *
 * 基本照抄官方 APK 的 assets/capacitor.config.json
 * （从官方 5.1.0 APK 中解出核对，
 *   包名 com.algermusic.app / compileSdk 36 / webDir out/renderer 都一致）。
 *
 * 只加了一处安全相关的显式关闭：CapacitorCookies。见下方注释。
 */
const config: CapacitorConfig = {
  /** 与官方 APK 保持一致，这样打出来的包可以直接覆盖安装官方版 */
  appId: 'com.algermusic.app',
  appName: 'AlgerMusicPlayer',

  /**
   * 与 electron-vite 的 renderer 输出目录一致。
   * 官方 APK 用的也是这个值 —— 也就是说官方自己就是「Capacitor + out/renderer」
   * 这套流程，我们从源码构建等于复刻它原本的构建方式。
   */
  webDir: 'out/renderer',

  server: {
    // WebView 以 http://localhost 加载本地资源，避免 file:// 的一堆限制
    androidScheme: 'http',
    // 允许明文；网易云的音频 CDN 有时是 http
    cleartext: true
  },

  android: {
    // 播放页会加载 http 的封面/音频，页面本身是 https 时会触发混合内容拦截
    allowMixedContent: true
  },

  plugins: {
    /**
     * ★ 本项目与官方配置的唯一实质差异：显式关闭原生 cookie jar。
     *
     * CapacitorCookies 是 @capacitor/core 的内置插件，且**默认开启**
     * （它不在 capacitor.plugins.json 里，所以从 APK 的插件清单看不出来）。
     * 一旦开启，WebView 里的 document.cookie 会被同步进原生 cookie jar，
     * 而 CapacitorHttp 发出的**每一个**原生请求都会自动带上这个 jar 里的
     * cookie（按域匹配）—— 包括 LX 音源脚本触发的那 些请求。
     *
     * 用户的 MUSIC_U 可以访问完整账号（歌单/收藏/VIP），绝不能存在
     * 「某个第三方请求自动带着它出去」的路径。
     *
     * 关闭之后：cookie 只由 services/ncm/request.ts 从 localStorage['token']
     * 读出、手动写进 Cookie 头，且只发往 music.163.com / interface.music.163.com。
     */
    CapacitorCookies: {
      enabled: false
    },

    /**
     * ★ 必须开启：所有网易云请求走原生 HTTP。
     *
     * 两个不可替代的理由：
     *  1. music.163.com 不返回 CORS 头，浏览器 fetch 会被直接拦掉
     *  2. Set-Cookie 是 fetch 的 forbidden response header，读不到 ——
     *     而二维码登录的 803 分支完全依赖它拿 MUSIC_U
     *
     * 另外 Referer / User-Agent 在浏览器 fetch 里同样是 forbidden header，
     * 会被静默丢弃，而网易的风控会看这两个。
     */
    CapacitorHttp: {
      enabled: true
    },

    // ↓↓↓ 以下与官方 APK 配置逐项保持一致 ↓↓↓

    /**
     * Capacitor 7 起用 SystemBars 统一管理状态栏/导航栏。
     * 这也是本项目需要 JDK 21 的原因（Capacitor 7+ 的要求）。
     */
    SystemBars: {
      insetsHandling: 'css',
      style: 'DARK',
      hidden: false
    },

    StatusBar: {
      backgroundColor: '#00000000',
      style: 'dark',
      overlaysWebView: true,
      androidOverlaysWebView: true
    },

    /**
     * ⚠️ 这一段目前是**悬空配置**，没有任何效果，但先留着。
     *
     * `SplashScreen` 由独立的 `@capacitor/splash-screen` 包提供，本项目**没有装**
     * （它不在 capacitor.plugins.json 里）。启动图现在由 Android 原生的
     * `androidx.core:core-splashscreen` 接管 —— 见 android/variables.gradle 里的
     * `coreSplashScreenVersion`，由 Capacitor 的 BridgeActivity 自动隐藏。
     *
     * 反过来说：如果哪天 `npm i @capacitor/splash-screen`，这段配置就会生效，
     * 而 `launchAutoHide: false` 意味着**启动图永不自动消失**，必须由 JS 显式
     * 调用 `SplashScreen.hide()`。而我已确认全部源码里**没有任何地方**调用它
     * —— 那样应用会永久卡在启动图上。装这个包之前必须先加 hide() 调用，
     * 或者把 launchAutoHide 改回 true。
     */
    SplashScreen: {
      launchAutoHide: false,
      showSpinner: false
    },

    /** 刘海屏/挖孔屏安全区，靠 CSS 变量注入 */
    SafeArea: {
      enabled: true,
      customColorsForSystemBars: true,
      statusBarColor: '#00000000',
      statusBarContent: 'light',
      navigationBarColor: '#00000000',
      navigationBarContent: 'light',
      offset: 0
    },

    /** 搜索框聚焦时把 body 顶上去，而不是盖住输入框 */
    Keyboard: {
      resize: 'body',
      style: 'DARK',
      resizeOnFullScreen: true
    }
  }
};

export default config;
