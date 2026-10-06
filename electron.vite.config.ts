import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'electron-vite';
import { resolve } from 'path';
import AutoImport from 'unplugin-auto-import/vite';
import { NaiveUiResolver } from 'unplugin-vue-components/resolvers';
import Components from 'unplugin-vue-components/vite';
import viteCompression from 'vite-plugin-compression';
import VueDevTools from 'vite-plugin-vue-devtools';

export default defineConfig(({ mode }) => {
  /**
   * Android（Capacitor）构建**必须**关掉 viteCompression。
   *
   * 它会为每个产物额外生成一份 `.gz`。桌面端没问题 —— out/renderer 由主进程的
   * Express 静态服务托管，可以协商 Content-Encoding 用上这些预压缩文件。
   *
   * 但 Android 端是把 out/renderer 整个拷进 app/src/main/assets/public，
   * 而 AGP 合并 assets 时会把 `.gz` 后缀规范化掉，于是
   *   index.html  与  index.html.gz
   * 被判定成同一个资源名，构建直接以
   *   `Error: Duplicate resources`
   * 失败（每个产物都撞一次，几十条）。
   *
   * 而 WebView 从本地 assets 加载文件，根本没有 HTTP 协商这一步，
   * 这些 `.gz` 在 Android 上没有任何用处，纯属体积负担。
   */
  const isAndroid = mode === 'android';

  return {
    main: {},
    preload: {},
    renderer: {
      resolve: {
        alias: {
          '@': resolve('src/renderer'),
          '@renderer': resolve('src/renderer'),
          '@i18n': resolve('src/i18n')
        }
      },
      plugins: [
        vue(),
        ...(isAndroid ? [] : [viteCompression()]),
        VueDevTools(),
        AutoImport({
          imports: [
            'vue',
            {
              'naive-ui': ['useDialog', 'useMessage', 'useNotification', 'useLoadingBar']
            }
          ]
        }),
        Components({
          resolvers: [NaiveUiResolver()]
        })
      ],
      publicDir: resolve('resources'),
      build: {
        /**
         * 显式清空输出目录。
         *
         * Vite 的默认行为是「outDir 在 root 之外时不清空」—— 而 renderer 的
         * root 是 src/renderer、outDir 是 out/renderer，正好命中这条规则。
         * 后果是老产物会一直赖在 out/renderer 里，再被 cap sync 合并进
         * Android 工程。上面关掉 viteCompression 时就是被这一点咬到：
         * 插件已经不再生成 .gz 了，可上一轮的 .gz 还在，照样让 Gradle 报
         * Duplicate resources。
         */
        emptyOutDir: true
      },
      server: {
        host: '0.0.0.0',
        port: 2389
      }
    }
  };
});
