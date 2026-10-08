package com.algermusic.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // registerPlugin 必须**在** super.onCreate 之前：BridgeActivity.onCreate 里就会调
        // load()，而 load() 会消费掉 bridgeBuilder。晚一步插件就进不了 bridge。
        //
        // 这也是唯一的注册途径。Capacitor 的自动发现（PluginManager.loadPluginClasses）
        // 只读 cap sync 生成的 capacitor.plugins.json，那里只有 node_modules 里的插件，
        // 手写在 :app 模块里的类对它不可见。反过来说 cap sync **不会**覆盖本文件
        // （它只重写 capacitor.* 生成物和 assets/**），所以在这里加代码是安全的。
        registerPlugin(AndroidStoragePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
