/**
 * 端内网易云 API —— 路由表
 *
 * ⚠️ 本文件由 scripts/gen-ncm-routes.mjs 自动生成，请勿手动修改。
 *    重新生成：node scripts/gen-ncm-routes.mjs
 *
 * 共 79 个端点（weapi 55 个，
 * eapi 24 个）。
 *
 * 模块来自 netease-cloud-music-api-alger，其统一签名为 (query, request) => Promise<{status, body, cookie}>，
 * request 由本层注入（见 ./request.ts），因此模块源码无需任何改动。
 */
import type { NcmModule, NcmRoute } from './types';

import m_album from 'netease-cloud-music-api-alger/module/album.js';
import m_album_new from 'netease-cloud-music-api-alger/module/album_new.js';
import m_album_newest from 'netease-cloud-music-api-alger/module/album_newest.js';
import m_album_sub from 'netease-cloud-music-api-alger/module/album_sub.js';
import m_album_sublist from 'netease-cloud-music-api-alger/module/album_sublist.js';
import m_artist_album from 'netease-cloud-music-api-alger/module/artist_album.js';
import m_artist_detail from 'netease-cloud-music-api-alger/module/artist_detail.js';
import m_artist_new_song from 'netease-cloud-music-api-alger/module/artist_new_song.js';
import m_artist_songs from 'netease-cloud-music-api-alger/module/artist_songs.js';
import m_banner from 'netease-cloud-music-api-alger/module/banner.js';
import m_cloudsearch from 'netease-cloud-music-api-alger/module/cloudsearch.js';
import m_comment_dj from 'netease-cloud-music-api-alger/module/comment_dj.js';
import m_dj_banner from 'netease-cloud-music-api-alger/module/dj_banner.js';
import m_dj_category_recommend from 'netease-cloud-music-api-alger/module/dj_category_recommend.js';
import m_dj_catelist from 'netease-cloud-music-api-alger/module/dj_catelist.js';
import m_dj_detail from 'netease-cloud-music-api-alger/module/dj_detail.js';
import m_dj_personalize_recommend from 'netease-cloud-music-api-alger/module/dj_personalize_recommend.js';
import m_dj_program from 'netease-cloud-music-api-alger/module/dj_program.js';
import m_dj_program_detail from 'netease-cloud-music-api-alger/module/dj_program_detail.js';
import m_dj_radio_hot from 'netease-cloud-music-api-alger/module/dj_radio_hot.js';
import m_dj_recommend from 'netease-cloud-music-api-alger/module/dj_recommend.js';
import m_dj_recommend_type from 'netease-cloud-music-api-alger/module/dj_recommend_type.js';
import m_dj_sub from 'netease-cloud-music-api-alger/module/dj_sub.js';
import m_dj_sublist from 'netease-cloud-music-api-alger/module/dj_sublist.js';
import m_dj_today_perfered from 'netease-cloud-music-api-alger/module/dj_today_perfered.js';
import m_dj_toplist from 'netease-cloud-music-api-alger/module/dj_toplist.js';
import m_fm_trash from 'netease-cloud-music-api-alger/module/fm_trash.js';
import m_history_recommend_songs from 'netease-cloud-music-api-alger/module/history_recommend_songs.js';
import m_history_recommend_songs_detail from 'netease-cloud-music-api-alger/module/history_recommend_songs_detail.js';
import m_like from 'netease-cloud-music-api-alger/module/like.js';
import m_likelist from 'netease-cloud-music-api-alger/module/likelist.js';
import m_login_cellphone from 'netease-cloud-music-api-alger/module/login_cellphone.js';
import m_login_qr_check from 'netease-cloud-music-api-alger/module/login_qr_check.js';
import m_login_qr_create from 'netease-cloud-music-api-alger/module/login_qr_create.js';
import m_login_qr_key from 'netease-cloud-music-api-alger/module/login_qr_key.js';
import m_login_status from 'netease-cloud-music-api-alger/module/login_status.js';
import m_logout from 'netease-cloud-music-api-alger/module/logout.js';
import m_lyric_new from 'netease-cloud-music-api-alger/module/lyric_new.js';
import m_mv_all from 'netease-cloud-music-api-alger/module/mv_all.js';
import m_mv_detail from 'netease-cloud-music-api-alger/module/mv_detail.js';
import m_mv_url from 'netease-cloud-music-api-alger/module/mv_url.js';
import m_personal_fm from 'netease-cloud-music-api-alger/module/personal_fm.js';
import m_personalized from 'netease-cloud-music-api-alger/module/personalized.js';
import m_personalized_djprogram from 'netease-cloud-music-api-alger/module/personalized_djprogram.js';
import m_personalized_mv from 'netease-cloud-music-api-alger/module/personalized_mv.js';
import m_personalized_newsong from 'netease-cloud-music-api-alger/module/personalized_newsong.js';
import m_personalized_privatecontent from 'netease-cloud-music-api-alger/module/personalized_privatecontent.js';
import m_playlist_catlist from 'netease-cloud-music-api-alger/module/playlist_catlist.js';
import m_playlist_create from 'netease-cloud-music-api-alger/module/playlist_create.js';
import m_playlist_detail from 'netease-cloud-music-api-alger/module/playlist_detail.js';
import m_playlist_import_name_task_create from 'netease-cloud-music-api-alger/module/playlist_import_name_task_create.js';
import m_playlist_import_task_status from 'netease-cloud-music-api-alger/module/playlist_import_task_status.js';
import m_playlist_subscribe from 'netease-cloud-music-api-alger/module/playlist_subscribe.js';
import m_playlist_tracks from 'netease-cloud-music-api-alger/module/playlist_tracks.js';
import m_playmode_intelligence_list from 'netease-cloud-music-api-alger/module/playmode_intelligence_list.js';
import m_recommend_songs from 'netease-cloud-music-api-alger/module/recommend_songs.js';
import m_recommend_songs_dislike from 'netease-cloud-music-api-alger/module/recommend_songs_dislike.js';
import m_record_recent_album from 'netease-cloud-music-api-alger/module/record_recent_album.js';
import m_record_recent_dj from 'netease-cloud-music-api-alger/module/record_recent_dj.js';
import m_record_recent_playlist from 'netease-cloud-music-api-alger/module/record_recent_playlist.js';
import m_record_recent_song from 'netease-cloud-music-api-alger/module/record_recent_song.js';
import m_search_default from 'netease-cloud-music-api-alger/module/search_default.js';
import m_search_hot_detail from 'netease-cloud-music-api-alger/module/search_hot_detail.js';
import m_search_suggest from 'netease-cloud-music-api-alger/module/search_suggest.js';
import m_song_detail from 'netease-cloud-music-api-alger/module/song_detail.js';
import m_song_download_url_v1 from 'netease-cloud-music-api-alger/module/song_download_url_v1.js';
import m_song_music_detail from 'netease-cloud-music-api-alger/module/song_music_detail.js';
import m_song_url_v1 from 'netease-cloud-music-api-alger/module/song_url_v1.js';
import m_top_album from 'netease-cloud-music-api-alger/module/top_album.js';
import m_top_artists from 'netease-cloud-music-api-alger/module/top_artists.js';
import m_top_playlist from 'netease-cloud-music-api-alger/module/top_playlist.js';
import m_top_playlist_highquality from 'netease-cloud-music-api-alger/module/top_playlist_highquality.js';
import m_toplist from 'netease-cloud-music-api-alger/module/toplist.js';
import m_user_account from 'netease-cloud-music-api-alger/module/user_account.js';
import m_user_detail from 'netease-cloud-music-api-alger/module/user_detail.js';
import m_user_followeds from 'netease-cloud-music-api-alger/module/user_followeds.js';
import m_user_follows from 'netease-cloud-music-api-alger/module/user_follows.js';
import m_user_playlist from 'netease-cloud-music-api-alger/module/user_playlist.js';
import m_user_record from 'netease-cloud-music-api-alger/module/user_record.js';

export const ROUTES: Record<string, NcmRoute> = {
  '/album': { crypto: 'weapi', module: m_album },
  '/album/new': { crypto: 'weapi', module: m_album_new },
  '/album/newest': { crypto: 'weapi', module: m_album_newest },
  '/album/sub': { crypto: 'weapi', module: m_album_sub },
  '/album/sublist': { crypto: 'weapi', module: m_album_sublist },
  '/artist/album': { crypto: 'weapi', module: m_artist_album },
  '/artist/detail': { crypto: 'eapi', module: m_artist_detail },
  '/artist/new/song': { crypto: 'weapi', module: m_artist_new_song },
  '/artist/songs': { crypto: 'eapi', module: m_artist_songs },
  '/banner': { crypto: 'eapi', module: m_banner },
  '/cloudsearch': { crypto: 'eapi', module: m_cloudsearch },
  '/comment/dj': { crypto: 'weapi', module: m_comment_dj },
  '/dj/banner': { crypto: 'weapi', module: m_dj_banner },
  '/dj/category/recommend': { crypto: 'weapi', module: m_dj_category_recommend },
  '/dj/catelist': { crypto: 'weapi', module: m_dj_catelist },
  '/dj/detail': { crypto: 'weapi', module: m_dj_detail },
  '/dj/personalize/recommend': { crypto: 'weapi', module: m_dj_personalize_recommend },
  '/dj/program': { crypto: 'weapi', module: m_dj_program },
  '/dj/program/detail': { crypto: 'weapi', module: m_dj_program_detail },
  '/dj/radio/hot': { crypto: 'weapi', module: m_dj_radio_hot },
  '/dj/recommend': { crypto: 'weapi', module: m_dj_recommend },
  '/dj/recommend/type': { crypto: 'weapi', module: m_dj_recommend_type },
  '/dj/sub': { crypto: 'weapi', module: m_dj_sub },
  '/dj/sublist': { crypto: 'weapi', module: m_dj_sublist },
  '/dj/today/perfered': { crypto: 'weapi', module: m_dj_today_perfered },
  '/dj/toplist': { crypto: 'weapi', module: m_dj_toplist },
  '/fm_trash': { crypto: 'weapi', module: m_fm_trash },
  '/history/recommend/songs': { crypto: 'weapi', module: m_history_recommend_songs },
  '/history/recommend/songs/detail': { crypto: 'weapi', module: m_history_recommend_songs_detail },
  '/like': { crypto: 'weapi', module: m_like },
  '/likelist': { crypto: 'eapi', module: m_likelist },
  '/login/cellphone': { crypto: 'weapi', module: m_login_cellphone },
  '/login/qr/check': { crypto: 'eapi', module: m_login_qr_check },
  '/login/qr/create': { crypto: 'eapi', module: m_login_qr_create },
  '/login/qr/key': { crypto: 'eapi', module: m_login_qr_key },
  '/login/status': { crypto: 'weapi', module: m_login_status },
  '/logout': { crypto: 'eapi', module: m_logout },
  '/lyric/new': { crypto: 'eapi', module: m_lyric_new },
  '/mv/all': { crypto: 'eapi', module: m_mv_all },
  '/mv/detail': { crypto: 'weapi', module: m_mv_detail },
  '/mv/url': { crypto: 'weapi', module: m_mv_url },
  '/personal_fm': { crypto: 'weapi', module: m_personal_fm },
  '/personalized': { crypto: 'weapi', module: m_personalized },
  '/personalized/djprogram': { crypto: 'weapi', module: m_personalized_djprogram },
  '/personalized/mv': { crypto: 'weapi', module: m_personalized_mv },
  '/personalized/newsong': { crypto: 'weapi', module: m_personalized_newsong },
  '/personalized/privatecontent': { crypto: 'weapi', module: m_personalized_privatecontent },
  '/playlist/catlist': { crypto: 'eapi', module: m_playlist_catlist },
  '/playlist/create': { crypto: 'weapi', module: m_playlist_create },
  '/playlist/detail': { crypto: 'eapi', module: m_playlist_detail },
  '/playlist/import/name/task/create': { crypto: 'eapi', module: m_playlist_import_name_task_create },
  '/playlist/import/task/status': { crypto: 'eapi', module: m_playlist_import_task_status },
  '/playlist/subscribe': { crypto: 'eapi', module: m_playlist_subscribe },
  '/playlist/tracks': { crypto: 'eapi', module: m_playlist_tracks },
  '/playmode/intelligence/list': { crypto: 'eapi', module: m_playmode_intelligence_list },
  '/recommend/songs': { crypto: 'weapi', module: m_recommend_songs },
  '/recommend/songs/dislike': { crypto: 'weapi', module: m_recommend_songs_dislike },
  '/record/recent/album': { crypto: 'weapi', module: m_record_recent_album },
  '/record/recent/dj': { crypto: 'weapi', module: m_record_recent_dj },
  '/record/recent/playlist': { crypto: 'weapi', module: m_record_recent_playlist },
  '/record/recent/song': { crypto: 'weapi', module: m_record_recent_song },
  '/search/default': { crypto: 'eapi', module: m_search_default },
  '/search/hot/detail': { crypto: 'weapi', module: m_search_hot_detail },
  '/search/suggest': { crypto: 'weapi', module: m_search_suggest },
  '/song/detail': { crypto: 'weapi', module: m_song_detail },
  '/song/download/url/v1': { crypto: 'eapi', module: m_song_download_url_v1 },
  '/song/music/detail': { crypto: 'eapi', module: m_song_music_detail },
  '/song/url/v1': { crypto: 'eapi', module: m_song_url_v1 },
  '/top/album': { crypto: 'weapi', module: m_top_album },
  '/top/artists': { crypto: 'weapi', module: m_top_artists },
  '/top/playlist': { crypto: 'weapi', module: m_top_playlist },
  '/top/playlist/highquality': { crypto: 'weapi', module: m_top_playlist_highquality },
  '/toplist': { crypto: 'eapi', module: m_toplist },
  '/user/account': { crypto: 'weapi', module: m_user_account },
  '/user/detail': { crypto: 'weapi', module: m_user_detail },
  '/user/followeds': { crypto: 'eapi', module: m_user_followeds },
  '/user/follows': { crypto: 'weapi', module: m_user_follows },
  '/user/playlist': { crypto: 'weapi', module: m_user_playlist },
  '/user/record': { crypto: 'weapi', module: m_user_record }
};
