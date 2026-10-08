package com.algermusic.app;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Intent;
import android.content.UriPermission;
import android.database.Cursor;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.DocumentsContract;
import android.provider.MediaStore;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.List;

/**
 * 把应用私有目录里的一个文件复制到用户看得见的地方。
 *
 * 存在的原因是桌面的下载链是**纯 Electron 主进程**的（node:fs + node-id3 + 系统通知），
 * 端上 window.electron 是 undefined，一行都跑不了；而端上要落到用户看得见的位置，
 * 就必须过 MediaStore / SAF 这两道系统的门，那就只能是原生代码。
 *
 * 两条落点：
 *  - {@code mode = "mediastore"}（默认）：`Music/<subDir>/`，进系统媒体库，
 *    系统音乐 App 直接扫得到。API 29+ 自己 insert 的行**不需要任何权限**。
 *  - {@code mode = "saf"}：用户自己用系统目录选择器挑的目录，可以是任意位置，
 *    同样不需要权限（授权是 per-URI 的）。
 *
 * 三条容易写错、且错了很难查的地方，都在下面各自的注释里说明：
 *  - `@PluginMethod` 必须 public（Capacitor 用 `getMethods()` 反射）；
 *  - `@ActivityCallback` 的方法名必须与 `startActivityForResult` 的字符串逐字相同；
 *  - 覆盖已存在文件要用 `openOutputStream(uri, "wt")`，`"t"` 才是截断。
 *
 * 权限、依赖、gradle、manifest **都不需要动**：整个类就是 :app 模块里一个普通源文件。
 */
@CapacitorPlugin(name = "AndroidStorage")
public class AndroidStoragePlugin extends Plugin {

    private static final String MODE_MEDIASTORE = "mediastore";
    private static final String MODE_SAF = "saf";

    /** 与 {@code Environment.DIRECTORY_MUSIC} 同值，写死是为了让 displayPath 的拼接一眼能读 */
    private static final String MUSIC_DIR = "Music";

    /** 拷贝缓冲。64KB 是流式拷贝的常规选择，太小 syscall 多、太大无谓占内存 */
    private static final int COPY_BUFFER = 64 * 1024;

    // ==================== 目录选择（SAF） ====================

    /**
     * 拉起系统目录选择器。授权是**长期**的（下面 takePersistableUriPermission），
     * 所以只需选一次，重启后还在。
     */
    @PluginMethod
    public void pickDirectory(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(
            Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
                | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION
        );

        try {
            // 第三个参数是**回调方法名**，必须与下面 pickDirectoryResult 逐字相同。
            // startActivityForResult 内部已经 bridge.saveCall(call) 保住了这个 call，
            // 所以**不要**再调 call.setKeepAlive(true) —— 那会把它永久留在 savedCalls 里。
            startActivityForResult(call, intent, "pickDirectoryResult");
        } catch (Exception ex) {
            // 少数设备没有 DocumentsUI（被裁掉了），这里会抛 ActivityNotFoundException
            call.reject("无法打开目录选择器: " + ex.getMessage(), "unavailable");
        }
    }

    /**
     * @ActivityCallback 用 getDeclaredMethods() 扫，所以可以是 private（内部会 setAccessible）。
     * 参数签名固定是 (PluginCall, ActivityResult)。
     */
    @ActivityCallback
    private void pickDirectoryResult(PluginCall call, ActivityResult result) {
        // 进程被杀后重建时回调照样会跑，但那时 call 是 null。第一行就必须防，
        // 否则一个 NPE 会让整个 App 崩在这。
        if (call == null) return;

        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            // 用户取消。**必须 reject**：Capacitor 的 promise 没有超时，
            // 不 reject 的话 JS 侧那个 await 就永远挂着。
            call.reject("用户取消了目录选择", "cancelled");
            return;
        }

        Uri treeUri = data.getData();
        try {
            getContext()
                .getContentResolver()
                .takePersistableUriPermission(
                    treeUri,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                );
        } catch (SecurityException ex) {
            call.reject("系统未授予长期目录访问权限: " + ex.getMessage(), "no_directory_permission");
            return;
        }

        JSObject ret = new JSObject();
        ret.put("uri", treeUri.toString());
        ret.put("label", describeTreeUri(treeUri));
        call.resolve(ret);
    }

    /**
     * 设置页那一行展示用。查不到就返回空串，由 JS 侧回退到提示文案。
     */
    @PluginMethod
    public void getDirectoryLabel(PluginCall call) {
        String raw = call.getString("uri");
        JSObject ret = new JSObject();
        ret.put("label", (raw == null || raw.isEmpty()) ? "" : describeTreeUri(Uri.parse(raw)));
        call.resolve(ret);
    }

    /**
     * 之前存的 URI 还有没有授权。用户完全可能在系统设置里把它撤销掉，
     * 所以设置页挂载时要校验一次，别等到下载失败才发现。
     */
    @PluginMethod
    public void hasDirectoryPermission(PluginCall call) {
        String raw = call.getString("uri");
        JSObject ret = new JSObject();

        boolean granted = false;
        if (raw != null && !raw.isEmpty()) {
            try {
                granted = hasPersistedPermission(Uri.parse(raw));
            } catch (Exception ignored) {
                // 存下来的字符串不是合法 URI（被外部改过）→ 当作没有授权
                granted = false;
            }
        }

        ret.put("granted", granted);
        call.resolve(ret);
    }

    // ==================== 落盘 ====================

    /**
     * 把 {@code sourcePath} 的文件复制到目的地。
     *
     * 参数：{@code sourcePath, fileName, mimeType, mode, subDir, treeUri}
     * 返回：成功 {@code {ok:true, uri, displayPath, size}}；
     * 失败 {@code {ok:false, code, message?, fallback?}}。
     *
     * **失败也 resolve，不 reject。** JS 侧要按 code 分派（没选目录 → 引导去设置页；
     * 老系统 → 自动切到 SAF），而 Capacitor 的 reject 值形状（{@code {message, code, data}}）
     * 是桥内部拼的，不是稳定的公开契约 —— 别把控制流建在它上面。
     *
     * 这个方法跑在 Capacitor 的插件线程（HandlerThread "CapacitorPlugins"）上，
     * 所以一次几十 MB 的同步拷贝不会 ANR。
     */
    @PluginMethod
    public void saveFile(PluginCall call) {
        String sourcePath = call.getString("sourcePath");
        String fileName = call.getString("fileName");
        String mimeType = call.getString("mimeType", "application/octet-stream");
        String mode = call.getString("mode", MODE_MEDIASTORE);
        String subDir = call.getString("subDir", "");
        String treeUriRaw = call.getString("treeUri", "");

        if (sourcePath == null || sourcePath.isEmpty() || fileName == null || fileName.isEmpty()) {
            fail(call, "invalid_input", "缺少 sourcePath 或 fileName", null);
            return;
        }

        InputStream in;
        try {
            in = openSource(sourcePath);
        } catch (Exception ex) {
            fail(call, "source_not_found", ex.getMessage(), null);
            return;
        }

        JSObject out = new JSObject();
        try {
            ContentResolver resolver = getContext().getContentResolver();

            if (MODE_SAF.equals(mode)) {
                if (treeUriRaw == null || treeUriRaw.isEmpty()) {
                    fail(call, "no_directory_permission", "还没选择自定义目录", null);
                    return;
                }

                Uri treeUri = Uri.parse(treeUriRaw);
                if (!hasPersistedPermission(treeUri)) {
                    fail(call, "no_directory_permission", "目录授权已失效，请重新选择", null);
                    return;
                }

                writeToSaf(resolver, in, treeUri, fileName, mimeType, out);
            } else {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
                    // RELATIVE_PATH 和无权限写入都是 API 29 才有的，老设备上音乐库这条路是死的。
                    // 不实现 WRITE_EXTERNAL_STORAGE 的 legacy 直写分支：它要加权限、要一套运行时
                    // 授权状态机、要第二份覆盖逻辑和 MediaScanner 扫描，而**全部无法在真机上验证**
                    // （编译 targetSdk 36，任何可用设备都 ≥ API 29）。SAF 从 API 21 起就可用，
                    // 用户一点功能都不损失 —— 所以降级到 SAF，而不是写一段没跑过的外存代码。
                    fail(call, "unsupported_api_level", "Android 9 及以下不支持保存到系统音乐库", MODE_SAF);
                    return;
                }

                writeToMediaStore(resolver, in, fileName, mimeType, subDir, out);
            }
        } catch (Exception ex) {
            fail(call, "io_error", ex.getMessage(), null);
            return;
        } finally {
            closeQuietly(in);
        }

        out.put("ok", true);
        out.put("displayPath", buildDisplayPath(mode, subDir, treeUriRaw, fileName));
        call.resolve(out);
    }

    // ==================== MediaStore ====================

    private void writeToMediaStore(
        ContentResolver resolver,
        InputStream in,
        String fileName,
        String mimeType,
        String subDir,
        JSObject out
    ) throws IOException {
        // 音频进 Audio 集合；歌词走 Files 集合 —— **Audio 集合不收 text/plain**，
        // 往里插 .lrc 要么被 provider 拒掉，要么留下一条没有数据的行。
        // 也不要用 MediaStore.Downloads：它被钉死在 Download/ 下。
        Uri collection = isAudioTarget(mimeType)
            ? MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
            : MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);

        String relativePath = buildRelativePath(subDir);
        Uri existing = findExisting(resolver, collection, relativePath, fileName);

        if (existing != null) {
            // 重复下载同一首歌要**覆盖**，不能变成「歌名 (1).mp3」。
            // 模式里的 t 是关键：它才截断。只写 "w" 在新内容更短时会留下旧文件的尾巴。
            try (OutputStream os = resolver.openOutputStream(existing, "wt")) {
                if (os == null) throw new IOException("openOutputStream 返回 null");
                out.put("size", copy(in, os));
            }
            out.put("uri", existing.toString());
            return;
        }

        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, fileName);
        values.put(MediaStore.MediaColumns.MIME_TYPE, mimeType);
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, relativePath);
        values.put(MediaStore.MediaColumns.IS_PENDING, 1);

        Uri created = resolver.insert(collection, values);
        if (created == null) throw new IOException("MediaStore.insert 返回 null");

        try {
            try (OutputStream os = resolver.openOutputStream(created, "w")) {
                if (os == null) throw new IOException("openOutputStream 返回 null");
                out.put("size", copy(in, os));
            }

            // IS_PENDING 归零这一下不能省：不清的话这行不进索引，
            // 文件管理器/音乐 App 里根本看不到 —— 这是最容易悄悄失效的一环。
            ContentValues done = new ContentValues();
            done.put(MediaStore.MediaColumns.IS_PENDING, 0);
            resolver.update(created, done, null, null);
        } catch (IOException ex) {
            // 半截文件留在库里比不留更糟（用户会看到一首放不出来的歌）：清掉再往上抛
            resolver.delete(created, null, null);
            throw ex;
        }

        out.put("uri", created.toString());
    }

    /**
     * 按「目录 + 文件名」找已有项，找不到返回 null。
     *
     * 带尾斜杠和不带尾斜杠各查一次：不同 ROM 存回来的 RELATIVE_PATH 尾斜杠不一致，
     * 两个等值查询就能盖住。比上 LIKE + 通配符转义干净得多（文件名里有 `%` `_` 是常事）。
     */
    private Uri findExisting(
        ContentResolver resolver,
        Uri collection,
        String relativePath,
        String fileName
    ) {
        String selection =
            MediaStore.MediaColumns.RELATIVE_PATH + "=? AND " + MediaStore.MediaColumns.DISPLAY_NAME + "=?";

        String trimmed = relativePath.endsWith("/")
            ? relativePath.substring(0, relativePath.length() - 1)
            : relativePath;

        String[] candidates = { relativePath, trimmed, trimmed + "/" };
        String[] projection = { MediaStore.MediaColumns._ID };

        for (String candidate : candidates) {
            try (
                Cursor cursor = resolver.query(
                    collection,
                    projection,
                    selection,
                    new String[] { candidate, fileName },
                    null
                )
            ) {
                if (cursor != null && cursor.moveToFirst()) {
                    return ContentUris.withAppendedId(collection, cursor.getLong(0));
                }
            } catch (Exception ignored) {
                // 某个变体不被这个 ROM 的 provider 支持就试下一个，不值得中断整个下载
            }
        }

        return null;
    }

    // ==================== SAF ====================

    private void writeToSaf(
        ContentResolver resolver,
        InputStream in,
        Uri treeUri,
        String fileName,
        String mimeType,
        JSObject out
    ) throws IOException {
        Uri parent = DocumentsContract.buildDocumentUriUsingTree(
            treeUri,
            DocumentsContract.getTreeDocumentId(treeUri)
        );

        Uri existing = findChild(resolver, parent, fileName);

        if (existing != null) {
            try (OutputStream os = resolver.openOutputStream(existing, "wt")) {
                if (os == null) throw new IOException("openOutputStream 返回 null");
                out.put("size", copy(in, os));
            }
            out.put("uri", existing.toString());
            scanIfPrimaryPath(resolver, existing, mimeType);
            return;
        }

        // 必须先按名字查过再 createDocument：SAF 遇到重名会**自动改名**（加 " (1)"），
        // 那正是我们要避免的。
        //
        // mimeType 只在文件名没有点时才用来补后缀，`歌名.lrc` / `歌名.flac` 都带点，
        // 所以 provider 会原样保留我们给的名字（ExternalStorageProvider 的
        // FileUtils.splitFileName 就是按最后一个点切的）。
        Uri created = DocumentsContract.createDocument(resolver, parent, mimeType, fileName);
        if (created == null) throw new IOException("createDocument 返回 null");

        try (OutputStream os = resolver.openOutputStream(created, "w")) {
            if (os == null) throw new IOException("openOutputStream 返回 null");
            out.put("size", copy(in, os));
        }

        out.put("uri", created.toString());
        scanIfPrimaryPath(resolver, created, mimeType);
    }

    /**
     * 在 tree 的直接子项里按 DISPLAY_NAME 找。
     * **同名目录不算命中** —— 在目录 URI 上开 OutputStream 会直接抛。
     */
    private Uri findChild(ContentResolver resolver, Uri parent, String fileName) {
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(
            parent,
            DocumentsContract.getDocumentId(parent)
        );

        String[] projection = {
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE
        };

        try (
            Cursor cursor = resolver.query(children, projection, null, null, null)
        ) {
            if (cursor == null) return null;

            while (cursor.moveToNext()) {
                String name = cursor.getString(1);
                String mime = cursor.getString(2);
                if (fileName.equals(name) && !DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                    return DocumentsContract.buildDocumentUriUsingTree(parent, cursor.getString(0));
                }
            }
        } catch (Exception ignored) {
            // 列不出来就当没有 —— 走 createDocument 新建，也是正确结果
        }

        return null;
    }

    /**
     * 让媒体库知道刚写进去的这个文件。
     *
     * MediaStore 模式不需要（那本来就是往索引里插行），但 SAF 写主存储**可能**只是
     * 落了字节、没进 MediaProvider 的索引，于是文件管理器看得见、系统音乐 App 看不见。
     * 这里从 document id 反推绝对路径扫一次 —— 推不出来就是 no-op，没有任何副作用。
     *
     * document id 的形状是 `音量:路径`，如 `primary:Music/AlgerMusic/a.flac`。
     */
    private void scanIfPrimaryPath(ContentResolver resolver, Uri documentUri, String mimeType) {
        if (!isAudioTarget(mimeType)) return; // 歌词不用扫

        try {
            String docId = DocumentsContract.getDocumentId(documentUri);
            int colon = docId.indexOf(':');
            if (colon <= 0) return;

            String volume = docId.substring(0, colon);
            String relative = docId.substring(colon + 1);
            String root = "primary".equals(volume) ? "/storage/emulated/0" : "/storage/" + volume;

            File file = new File(root, relative);
            if (!file.isFile()) return;

            MediaScannerConnection.scanFile(
                getContext(),
                new String[] { file.getAbsolutePath() },
                null,
                null
            );
        } catch (Exception ignored) {
            // 不是主存储（云盘类 provider）/ id 反推不出来 —— 不影响已落盘的事实
        }
    }

    // ==================== 工具 ====================

    /**
     * 打开源文件。收四种形态：
     *  - 相对路径：按 `getFilesDir()` 解析，与 audioDiskCache 的 AudioCacheEntry.filePath 同义
     *  - 绝对路径
     *  - `file://`（Filesystem.getUri 给的就是这个，歌词中转走这条）
     *  - `content://`
     */
    private InputStream openSource(String sourcePath) throws IOException {
        if (sourcePath.startsWith("content://")) {
            InputStream in = getContext().getContentResolver().openInputStream(Uri.parse(sourcePath));
            if (in == null) throw new IOException("openInputStream 返回 null");
            return in;
        }

        File file;
        if (sourcePath.startsWith("file://")) {
            file = new File(Uri.parse(sourcePath).getPath());
        } else {
            file = new File(sourcePath);
            if (!file.isAbsolute()) {
                file = new File(getContext().getFilesDir(), sourcePath);
            }
        }

        if (!file.isFile()) throw new IOException("源文件不存在: " + file.getAbsolutePath());
        return new FileInputStream(file);
    }

    private long copy(InputStream in, OutputStream out) throws IOException {
        byte[] buffer = new byte[COPY_BUFFER];
        long total = 0;
        int read;
        while ((read = in.read(buffer)) > 0) {
            out.write(buffer, 0, read);
            total += read;
        }
        out.flush();
        return total;
    }

    private void closeQuietly(InputStream in) {
        try {
            in.close();
        } catch (Exception ignored) {
            // 关不掉无所谓，字节已经落盘了
        }
    }

    /**
     * 判据用 mimeType 而不是扩展名：调用方（nativeDownload.ts）的 mime 是按**嗅探出来的
     * 真实容器**算的，比再猜一次文件名可靠。
     */
    private boolean isAudioTarget(String mimeType) {
        return mimeType != null && mimeType.startsWith("audio/");
    }

    private String buildRelativePath(String subDir) {
        String clean = sanitizeSubDir(subDir);
        return clean.isEmpty() ? MUSIC_DIR + "/" : MUSIC_DIR + "/" + clean + "/";
    }

    /**
     * 清洗用户填的子目录名。
     *
     * 它来自设置页一个自由文本输入框，会被直接拼进 RELATIVE_PATH —— 不清洗的话一个 `..`
     * 就能把文件写到 `Music/` 外面去。所以逐段过滤，丢弃空段 / `.` / `..`，
     * 再把存储上非法的字符换成下划线。
     */
    private String sanitizeSubDir(String raw) {
        if (raw == null) return "";

        StringBuilder sb = new StringBuilder();
        for (String part : raw.replace('\\', '/').split("/")) {
            String segment = part.trim();
            if (segment.isEmpty() || ".".equals(segment) || "..".equals(segment)) continue;

            segment = segment.replaceAll("[*?:\"<>|\\\\]", "_").trim();
            if (segment.isEmpty()) continue;

            if (sb.length() > 0) sb.append('/');
            sb.append(segment);
        }

        return sb.toString();
    }

    /**
     * 落点的人类可读描述，直接进下载成功的提示里。
     * 用户手机连不上电脑、用不了 chrome://inspect，这是这个功能在设备上**唯一**能自查落点的地方。
     */
    private String buildDisplayPath(String mode, String subDir, String treeUriRaw, String fileName) {
        if (MODE_SAF.equals(mode)) {
            String label = "";
            try {
                label = describeTreeUri(Uri.parse(treeUriRaw));
            } catch (Exception ignored) {
                // 退化成只显示文件名，总比显示一串 content:// 强
            }
            return (label.isEmpty() ? "所选目录" : label) + "/" + fileName;
        }

        String clean = sanitizeSubDir(subDir);
        return clean.isEmpty()
            ? MUSIC_DIR + "/" + fileName
            : MUSIC_DIR + "/" + clean + "/" + fileName;
    }

    /** 这个 tree URI 现在还有没有写授权。 */
    private boolean hasPersistedPermission(Uri treeUri) {
        List<UriPermission> permissions = getContext()
            .getContentResolver()
            .getPersistedUriPermissions();

        for (UriPermission permission : permissions) {
            if (permission.isWritePermission() && permission.getUri().equals(treeUri)) {
                return true;
            }
        }

        return false;
    }

    /**
     * 给 tree URI 取一个人类可读的名字。
     * 先问系统要 display name（根目录的显示名是本地化的「内部存储」之类），
     * 拿不到再从 document id 里取最后一段。
     */
    private String describeTreeUri(Uri treeUri) {
        try {
            String docId = DocumentsContract.getTreeDocumentId(treeUri);
            Uri docUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, docId);

            try (
                Cursor cursor = getContext()
                    .getContentResolver()
                    .query(
                        docUri,
                        new String[] { DocumentsContract.Document.COLUMN_DISPLAY_NAME },
                        null,
                        null,
                        null
                    )
            ) {
                if (cursor != null && cursor.moveToFirst()) {
                    String name = cursor.getString(0);
                    if (name != null && !name.isEmpty()) return name;
                }
            }
        } catch (Exception ignored) {
            // 有些 provider 不认 buildDocumentUriUsingTree，或压根不返回这一列 → 落到下面的解析
        }

        // 兜底：`primary:Music/MyFolder` → `MyFolder`；整卷根（`primary:`）→ 空串
        try {
            String docId = DocumentsContract.getTreeDocumentId(treeUri);
            int colon = docId.indexOf(':');
            String tail = colon >= 0 ? docId.substring(colon + 1) : docId;

            while (tail.endsWith("/")) tail = tail.substring(0, tail.length() - 1);

            int slash = tail.lastIndexOf('/');
            return slash >= 0 ? tail.substring(slash + 1) : tail;
        } catch (Exception ignored) {
            return "";
        }
    }

    /**
     * 失败也 resolve（原因见 {@link #saveFile}）。只有 pickDirectory 的用户取消才真 reject。
     */
    private void fail(PluginCall call, String code, String message, String fallback) {
        JSObject ret = new JSObject();
        ret.put("ok", false);
        ret.put("code", code);
        if (message != null) ret.put("message", message);
        if (fallback != null) ret.put("fallback", fallback);
        call.resolve(ret);
    }
}
