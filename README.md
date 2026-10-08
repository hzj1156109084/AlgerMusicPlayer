<h2 align="center">🎵 Alger Music Player</h2>
<div align="center">
<div align="center">
  <a href="https://github.com/algerkong/AlgerMusicPlayer/stargazers">
    <img src="https://img.shields.io/github/stars/algerkong/AlgerMusicPlayer?style=for-the-badge&logo=github&label=Stars&logoColor=white&color=22c55e" alt="GitHub stars">
  </a>
  <a href="https://github.com/algerkong/AlgerMusicPlayer/releases">
    <img src="https://img.shields.io/github/v/release/algerkong/AlgerMusicPlayer?style=for-the-badge&logo=github&label=Release&logoColor=white&color=1a67af" alt="GitHub release">
  </a>
  <a href="https://pd.qq.com/s/cs056n33q?b=5">
    <img src="https://img.shields.io/badge/QQ频道-algermusic-blue?style=for-the-badge&color=yellow" alt="加入频道">
  </a>
  <a href="https://t.me/+9efsKRuvKBk2NWVl">
    <img src="https://img.shields.io/badge/AlgerMusic-blue?style=for-the-badge&logo=telegram&logoColor=white&label=Telegram" alt="Telegram">
  </a>
   <a href="https://donate.alger.fun/">
    <img src="https://img.shields.io/badge/%E9%A1%B9%E7%9B%AE%E6%8D%90%E8%B5%A0-blue?style=for-the-badge&logo=telegram&logoColor=pink&color=pink&label=%E8%B5%9E%E5%8A%A9" alt="赞助">
  </a>
</div>
</div>
<div align="center">
  <a href="https://hellogithub.com/repository/607b849c598d48e08fe38789d156ebdc" target="_blank"><img src="https://api.hellogithub.com/v1/widgets/recommend.svg?rid=607b849c598d48e08fe38789d156ebdc&claim_uid=ObuMXUfeHBmk9TI&theme=neutral" alt="Featured｜HelloGitHub" width="160" height="32" /></a>
</div>

[项目下安装以及常用问题文档](https://www.yuque.com/alger-pfg5q/ip4f1a/bmgmfmghnhgwghkm?singleDoc#)

主要功能如下

- 🎵 音乐推荐
- 🔐 账号登录与同步
- 📝 功能
  - 播放历史记录
  - 歌曲收藏管理
  - 歌单 MV 排行榜 每日推荐
  - 自定义快捷键配置（全局或应用内）
- 🎨 界面与交互
  - 沉浸式歌词显示（点击左下角封面进入）
  - 独立桌面歌词窗口
  - 明暗主题切换
  - 迷你模式
  - 状态栏控制
  - 多语言支持
- 🎼 音乐功能
  - 支持歌单、MV、专辑等完整音乐服务
  - 音乐资源解析（基于 @unblockneteasemusic/server）
  - EQ均衡器
  - 定时播放 远程控制播放 倍速播放
  - 高品质音乐
  - 音乐文件下载
  - 搜索 MV 音乐 专辑 歌单 bilibili
  - 音乐单独选择音源解析
- 🚀 技术特性
  - 本地化服务，无需依赖在线API (基于 netease-cloud-music-api)
  - 全平台适配（Desktop & Web & Mobile Web & Android<测试> & ios<后续>）

## 项目简介

一个第三方音乐播放器、本地服务、桌面歌词、音乐下载、最高音质

## 预览地址

[http://music.alger.fun/](http://music.alger.fun/)

## 软件截图

![首页白](./docs/image.png)
![首页黑](./docs/image3.png)
![歌词](./docs/image6.png)
![桌面歌词](./docs/image2.png)
![设置页面](./docs/image4.png)
![音乐远程控制](./docs/image5.png)

## 项目启动

```bash
npm install
npm run dev
```

## 自己编译 Android 版（APK）

本分支把 AlgerMusicPlayer 移植成了 Android 应用：Capacitor 外壳 + **端内** 网易云 API（所有网易云请求在设备本地完成，`MUSIC_U` 不出设备）。下面是 clone 之后从源码打出可安装 APK 的完整步骤。

### 1. 环境准备

| 需要        | 版本                                                                          |
| ----------- | ----------------------------------------------------------------------------- |
| Node.js     | 18+（CI 用 24）                                                               |
| **JDK 21**  | Capacitor 7+ 的要求，**17 不够**                                              |
| Android SDK | Platform **36** + Build-Tools 36 + Platform-Tools（minSdk 24 / targetSdk 36） |

`npm install` 会自动走国内镜像 —— 仓库自带 `.npmrc`（npmmirror registry + electron 二进制镜像），无需自己配。

JDK 21 怎么指定：`android/gradle.properties` 里**故意没写** `org.gradle.java.home`（绝对路径不能进仓库）。二选一：

- 设 `JAVA_HOME` 环境变量指向 JDK 21；
- 或写进**用户级**配置 `~/.gradle/gradle.properties`（Windows 是 `%USERPROFILE%\.gradle\gradle.properties`）：
  ```properties
  org.gradle.java.home=/path/to/jdk-21
  ```

别写进项目的 `android/gradle.properties` —— 那会跟着仓库走，别人拿到的就是你的错误路径。

### 2. 配好 Android SDK 路径（必做）

`android/local.properties` 是**机器专属**的，已从版本库排除，必须自己建一份：

```properties
sdk.dir=/path/to/Android/Sdk
```

Windows 下盘符和反斜杠要转义，例如 `sdk.dir=E\:\\Android\\Sdk`。用 Android Studio 打开一次 `android/` 目录也会自动生成这个文件；或者设好 `ANDROID_HOME` 环境变量也行。

### 3. 构建

```bash
npm install
npm run android:sync                              # = electron-vite build --mode android + cap sync android
cd android && ./gradlew assembleDebug             # Windows: gradlew.bat assembleDebug
```

产物在 `android/app/build/outputs/apk/debug/app-debug.apk`，装到手机：

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

也可以用 `npm run android:open` 直接开 Android Studio，或 `npm run android:run` 装到已连接的设备。

> **`android:sync` 不能跳过。** `android/app/src/main/assets/` 整个目录（含 `capacitor.plugins.json` 插件注册表和 WebView 资源）都在 gitignore 里，只有 `cap sync` 会生成它。跳过的话 APK 照样能编译出来，但原生插件没注册 —— 表现为离线缓存等功能静默失效，很难查。

### 4. 改成「自己的」应用

| 想改什么 | 改哪里                                                                                                                                      |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 包名     | `capacitor.config.ts` 的 `appId` + `android/app/build.gradle` 的 `namespace` 与 `applicationId`（**三处必须一致**）                         |
| 版本号   | `android/app/build.gradle` 的 `versionCode` / `versionName`                                                                                 |
| 应用名   | `capacitor.config.ts` 的 `appName`（`cap sync` 会把它写进 `values/strings.xml` 的 `app_name`；**只改 strings.xml 会在下次 sync 时被覆盖**） |
| 图标     | `android/app/src/main/res/mipmap-*/ic_launcher*.png`                                                                                        |

两点提醒：

- **versionCode 当前是 3**，与官方 5.1.0 APK 相同。同 versionCode 覆盖安装会失败（签名也不同），要么先卸载官方版，要么把自己的 versionCode 调大。
- `assembleDebug` 出的是 **debug 签名**包，自用足够；要发布正式包需自建 keystore 并在 `android/app/build.gradle` 里配 `signingConfigs`。

### 5. 三个已知的坑

**构建卡在 `:capacitor-filesystem:compileDebugKotlin` 十几分钟不动。** 真因是 Maven Central 不通 —— `@capacitor/filesystem` 是全项目唯一用 Kotlin 的插件，编译它要下 `kotlin-compiler-embeddable`（约 56MB，只发布在 Maven Central），Gradle 在那里反复超时重试，**不报错也不结束**，看起来像死锁。先跑一次 `./gradlew assembleDebug --offline`，静默挂起会立刻变成明确的「缺件」报错，一步定位。确认后加用户级 `~/.gradle/init.gradle` 走镜像：

```groovy
allprojects {
    repositories {
        maven { url 'https://maven.aliyun.com/repository/public' }
        maven { url 'https://maven.aliyun.com/repository/google' }
        maven { url 'https://maven.aliyun.com/repository/gradle-plugin' }
    }
}
```

（Gradle 发行包本身的下载源已经是腾讯云镜像，见 `android/gradle/wrapper/gradle-wrapper.properties`。只要新增一个带新依赖的插件，这个坑就可能复现。）

**LX 音源脚本不在仓库里**（版权 + 防篡改，有意排除）。没有它不影响构建、也不影响官方音源。要用就在应用内「设置 → 音源设置」里导入你自己合法获得的脚本 —— 不要去找那个文件名，它不会被提交上来。

**别动 `capacitor.config.ts` 里的 `CapacitorCookies`（保持关闭）和 `CapacitorHttp`（保持开启）。** 前者关着才能保证网易云 Cookie 只发往 `music.163.com`；后者是必须的：`music.163.com` 不返回 CORS 头，且 `Set-Cookie` 是浏览器 fetch 的 forbidden header，扫码登录拿 `MUSIC_U` 完全依赖它。改动这两项会同时破坏登录和隐私边界。

## 开发文档

点击这里[开发文档](./DEV.md)

## 赞赏☕️

[赞赏列表](http://donate.alger.fun/)

|                                                                     微信赞赏                                                                     |                                                                  支付宝赞赏                                                                   |
| :----------------------------------------------------------------------------------------------------------------------------------------------: | :-------------------------------------------------------------------------------------------------------------------------------------------: |
| <img src="https://github.com/algerkong/algerkong/blob/main/wechat.jpg?raw=true" alt="WeChat QRcode" width=200> <br><small>喝点咖啡继续干</small> | <img src="https://github.com/algerkong/algerkong/blob/main/alipay.jpg?raw=true" alt="Wechat QRcode" width=200> <br><small>来包辣条吧~</small> |

## 项目统计

[![Stargazers over time](https://starchart.cc/algerkong/AlgerMusicPlayer.svg?variant=adaptive)](https://starchart.cc/algerkong/AlgerMusicPlayer)
![Alt](https://repobeats.axiom.co/api/embed/c4d01b3632e241c90cdec9508dfde86a7f54c9f5.svg 'Repobeats analytics image')

## 欢迎提Issues

## 声明

本软件仅用于学习交流，禁止用于商业用途，否则后果自负。
希望大家还是要多多支持官方正版，此软件仅用作开发教学。
