/**
 * LRC 文本处理。
 *
 * 从 hooks/useDownload.ts 里搬出来的：端上下载也要把翻译合进同名 .lrc，
 * 而 useDownload 会 import services/nativeDownload（走原生分支），
 * nativeDownload 再回头 import useDownload 取这个函数就成环了。
 * 放到 utils 里两边都能拿，且谁都不依赖谁。
 */

/**
 * 解析 LRC 文本为 Map<timeTag, content>
 */
export function parseLrcText(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split('\n')) {
    const tags = line.match(/\[\d{2}:\d{2}(\.\d{1,3})?\]/g);
    if (!tags) continue;
    const content = line.replace(/\[\d{2}:\d{2}(\.\d{1,3})?\]/g, '').trim();
    if (!content) continue;
    for (const tag of tags) {
      map.set(tag, content);
    }
  }
  return map;
}

/**
 * 将原文歌词和翻译歌词合并为一个 LRC 字符串
 */
export function mergeLrcWithTranslation(originalText: string, translationText: string): string {
  const originalMap = parseLrcText(originalText);
  const translationMap = parseLrcText(translationText);

  const mergedLines: string[] = [];

  for (const [timeTag, content] of originalMap.entries()) {
    mergedLines.push(`${timeTag}${content}`);
    const translated = translationMap.get(timeTag);
    if (translated) {
      mergedLines.push(`${timeTag}${translated}`);
    }
  }

  // 按时间排序
  mergedLines.sort((a, b) => {
    const ta = a.match(/\[\d{2}:\d{2}(\.\d{1,3})?\]/)?.[0] || '';
    const tb = b.match(/\[\d{2}:\d{2}(\.\d{1,3})?\]/)?.[0] || '';
    return ta.localeCompare(tb);
  });

  return mergedLines.join('\n');
}
