export default {
  menu: {
    play: '재생',
    playNext: '다음에 재생',
    download: '곡 다운로드',
    downloadLyric: '가사 다운로드',
    addToPlaylist: '플레이리스트에 추가',
    favorite: '좋아요',
    unfavorite: '좋아요 취소',
    removeFromPlaylist: '플레이리스트에서 삭제',
    dislike: '싫어요',
    undislike: '싫어요 취소'
  },
  message: {
    downloading: '다운로드 중입니다. 잠시 기다려주세요...',
    downloadFailed: '다운로드 실패',
    downloadQueued: '다운로드 대기열에 추가됨',
    addedToNextPlay: '다음 재생에 추가됨',
    getUrlFailed: '음악 다운로드 주소 가져오기 실패, 로그인 상태를 확인하세요',
    noLyric: '이 곡에는 가사가 없습니다',
    lyricDownloaded: '가사 다운로드 완료',
    lyricDownloadFailed: '가사 다운로드 실패',
    downloadSaved: '{path}에 저장했습니다',
    downloadPartialSuccess: '다운로드 완료: 성공 {success}곡, 실패 {failed}곡',
    downloadNoDirectory:
      '사용할 수 있는 다운로드 폴더가 없습니다. "설정 → 다운로드 설정"에서 선택해 주세요',
    downloadOldAndroid:
      'OS 버전이 낮아 음악 라이브러리에 저장할 수 없습니다. 먼저 사용자 지정 폴더를 선택해 주세요',
    downloadDirectorySet: '다운로드 폴더를 {path}(으)로 설정했습니다'
  },
  dialog: {
    dislike: {
      title: '알림!',
      content: '이 곡을 싫어한다고 확인하시겠습니까? 다시 들어가면 일일 추천에서 제외됩니다.',
      positiveText: '싫어요',
      negativeText: '취소'
    }
  }
};
