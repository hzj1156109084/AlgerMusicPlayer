export default {
  menu: {
    play: '再生',
    playNext: '次に再生',
    download: '楽曲をダウンロード',
    downloadLyric: '歌詞をダウンロード',
    addToPlaylist: 'プレイリストに追加',
    favorite: 'いいね',
    unfavorite: 'いいね解除',
    removeFromPlaylist: 'プレイリストから削除',
    dislike: '嫌い',
    undislike: '嫌い解除'
  },
  message: {
    downloading: 'ダウンロード中です。しばらくお待ちください...',
    downloadFailed: 'ダウンロードに失敗しました',
    downloadQueued: 'ダウンロードキューに追加しました',
    addedToNextPlay: '次の再生に追加しました',
    getUrlFailed:
      '音楽ダウンロードアドレスの取得に失敗しました。ログインしているか確認してください',
    noLyric: 'この楽曲には歌詞がありません',
    lyricDownloaded: '歌詞のダウンロードが完了しました',
    lyricDownloadFailed: '歌詞のダウンロードに失敗しました',
    downloadSaved: '{path} に保存しました',
    downloadPartialSuccess: 'ダウンロード完了：成功 {success} 曲、失敗 {failed} 曲',
    downloadNoDirectory:
      '利用できるダウンロード先がありません。「設定 → ダウンロード設定」で選択してください',
    downloadOldAndroid:
      'OS バージョンが古く音楽ライブラリに保存できません。先に任意のフォルダを選択してください',
    downloadDirectorySet: 'ダウンロード先を {path} に設定しました'
  },
  dialog: {
    dislike: {
      title: 'お知らせ！',
      content: 'この楽曲を嫌いにしますか？再度アクセスすると毎日のおすすめから除外されます。',
      positiveText: '嫌い',
      negativeText: 'キャンセル'
    }
  }
};
