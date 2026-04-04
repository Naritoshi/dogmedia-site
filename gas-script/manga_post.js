/**
 * 4コマ漫画専用フォームの回答をトリガーに実行される関数
 * @param {Object} e - イベントオブジェクト
 */
function onMangaFormSubmit(e) {
  const props = PropertiesService.getScriptProperties();

  // 1. セキュリティチェック
  const allowedEmail = props.getProperty('ALLOWED_EMAIL');
  const respondentEmail = e.namedValues['メールアドレス'] ? e.namedValues['メールアドレス'][0] : null;

  if (allowedEmail && respondentEmail !== allowedEmail) {
    Logger.log(`⛔ 許可されていないユーザーからの投稿をブロックしました: ${respondentEmail}`);
    return;
  }

  // 2. 回答データの抽出
  const photoUrl = e.namedValues['写真'] ? e.namedValues['写真'][0] : null;
  const memo = e.namedValues['どんな漫画にしたい？'] ? e.namedValues['どんな漫画にしたい？'][0] : '';

  if (!photoUrl) {
    Logger.log('❌ 写真のURLが見つかりません');
    return;
  }

  // 3. 画像ファイルの取得と処理実行
  try {
    let fileId = "";
    const idMatch = photoUrl.match(/id=([a-zA-Z0-9_-]+)/);
    const dMatch = photoUrl.match(/\/d\/([a-zA-Z0-9_-]+)/);
    
    if (idMatch) {
      fileId = idMatch[1];
    } else if (dMatch) {
      fileId = dMatch[1];
    } else {
      throw new Error('❌ 写真URLが無効です: ' + photoUrl);
    }
    
    const file = DriveApp.getFileById(fileId);
    
    // 4コマ漫画専用の処理を呼び出し
    const title = processMangaPost(file, memo, props);

    // 成功ステータスをシートに書き込む (G列を想定)
    const sheet = e.source.getActiveSheet();
    sheet.getRange(e.range.rowStart, e.range.columnEnd + 1).setValue(`✅ 4コマ漫画完了: ${title}`);

  } catch (err) {
    Logger.log(`❌ エラーが発生しました: ${err.toString()}`);
    try {
      const sheet = e.source.getActiveSheet();
      sheet.getRange(e.range.rowStart, e.range.columnEnd + 1).setValue(`❌ ${err.toString()}`);
    } catch (sheetErr) {}
  }
}
