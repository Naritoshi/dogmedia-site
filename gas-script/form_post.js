/**
 * スプレッドシートの編集イベントハンドラ
 * ※この関数を「インストール可能なトリガー（編集時）」として設定してください
 */
function onSpreadsheetEdit(e) {
  // トリガー実行でない場合のガード
  if (!e || !e.range) return;

  const props = PropertiesService.getScriptProperties();

  const range = e.range;
  const sheet = range.getSheet();
  
  // G列 (7列目) のチェックボックスが ON になった場合のみ実行
  if (range.getColumn() === 7 && (e.value === 'TRUE' || e.value === true || e.value === '投稿する')) {
    const row = range.getRow();
    if (row < 2) return; // ヘッダー行は無視

    // 処理中ステータス表示
    range.setValue('⏳ 処理中...');
    SpreadsheetApp.flush();

    try {
      // データの取得 (A列〜F列)
      // A:Timestamp, B:Email, C:Photo, D:Location, E:Category, F:Memo
      const data = sheet.getRange(row, 1, 1, 6).getValues()[0];
      const email = data[1];
      const photoUrl = data[2];
      const location = data[3];
      const category = data[4];
      const memo = data[5];

      const allowedEmail = props.getProperty('ALLOWED_EMAIL');

      if (allowedEmail && email !== allowedEmail) {
        throw new Error(`⛔ 許可されていないユーザー: ${email}`);
      }

      // Google Drive URLからID抽出
      let fileId = "";
      const idMatch = photoUrl.match(/id=([a-zA-Z0-9_-]+)/);
      const dMatch = photoUrl.match(/\/d\/([a-zA-Z0-9_-]+)/);
      
      if (idMatch) {
        fileId = idMatch[1];
      } else if (dMatch) {
        fileId = dMatch[1];
      } else {
        throw new Error('❌ 写真URLが無効です');
      }

      const file = DriveApp.getFileById(fileId);

      // 投稿処理実行
      const title = processFormImage(file, location, category, memo, props);
      
      // 完了ステータス
      range.setValue(`✅ ${title}`);
      
    } catch (err) {
      // エラー表示
      range.setValue(`❌ ${err.toString()}`);
      console.error(err);
    }
  }
}

/**
 * フォームの回答をトリガーに実行されるメイン関数
 * @param {Object} e - イベントオブジェクト
 */
function onFormSubmit(e) {
  const props = PropertiesService.getScriptProperties();
  
  // 1. セキュリティチェック (自分自身の投稿か確認)
  const allowedEmail = props.getProperty('ALLOWED_EMAIL');
  
  // エディタからの直接実行などで e.response がない場合のガード
  if (!e || !e.response) {
    Logger.log('⚠️ この関数はフォーム送信トリガーから実行してください');
    return;
  }

  const respondentEmail = e.response.getRespondentEmail();
  if (allowedEmail && respondentEmail !== allowedEmail) {
    Logger.log(`⛔ 許可されていないユーザーからの投稿をブロックしました: ${respondentEmail}`);
    return;
  }

  Logger.log(`🚀 フォーム投稿を受信: ${respondentEmail}`);

  // 2. 回答データの抽出
  const itemResponses = e.response.getItemResponses();
  let fileId, location, category, memo;
  let shouldPost = true; // デフォルトは投稿する

  itemResponses.forEach(itemResponse => {
    const title = itemResponse.getItem().getTitle();
    const response = itemResponse.getResponse();

    if (title === '写真') fileId = response[0]; // ファイルアップロードは配列で返る
    if (title === '撮影場所') location = response;
    if (title === 'カテゴリー') category = response;
    if (title === '状況・メモ') memo = response;
    
    // 「投稿」チェックボックスの確認
    if (title === '投稿' || title === '投稿する') {
      // 配列または文字列で「はい」が含まれているか確認
      const val = Array.isArray(response) ? response.join('') : response;
      if (!val.includes('はい')) {
        shouldPost = false;
      }
    }
  });

  if (!fileId) {
    Logger.log('❌ 写真が見つかりません');
    return;
  }

  if (!shouldPost) {
    Logger.log('⏭️ 「投稿」チェックがないため、GitHubへのアップロードをスキップしました。');
    return;
  }

  // 3. 画像ファイルの取得と処理実行
  try {
    const file = DriveApp.getFileById(fileId);
    processFormImage(file, location, category, memo, props);
  } catch (err) {
    Logger.log(`❌ エラーが発生しました: ${err.toString()}`);
  }
}

/**
 * 画像とメタデータを処理してGitHubへアップロードする
 */
function processFormImage(file, location, category, memo, props) {
  const apiKey = props.getProperty('GEMINI_API_KEY');
  const githubToken = props.getProperty('GITHUB_TOKEN');
  const repo = props.getProperty('GITHUB_REPO'); // 例: "username/repo"

  const blob = file.getBlob();
  const base64Image = Utilities.base64Encode(blob.getBytes());
  const mimeType = file.getMimeType();
  const fileExt = file.getName().split('.').pop();

  // Gemini モデルの動的選択 (utils.jsの関数を利用)
  const modelName = getValidFlashModel(apiKey);
  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

  // プロンプトの構築
  const prompt = `
    あなたはプロのブロガーです。以下の情報を元に、ブログ記事のJSONデータを作成してください。
    
    【入力情報】
    - 撮影場所: ${location || '不明'}
    - カテゴリー: ${category || '日常'}
    - メモ: ${memo || '特になし'}
    
    【要件】
    - JSON形式のみ出力すること（Markdownコードブロックは不要）
    - "filename": 画像の内容を表す英単語(ケバブケース, 拡張子なし)
    - "title": 魅力的なタイトル(30文字以内)
    - "content": 記事本文(Markdown形式)。場所やメモの内容を自然に盛り込むこと。
    - "tags": タグの配列
    - "location": "${location}" をそのまま使用
  `;

  const payload = {
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: mimeType, data: base64Image } }
      ]
    }],
    generationConfig: {
      responseMimeType: "application/json" // JSONモードを強制
    }
  };

  const response = UrlFetchApp.fetch(apiUrl, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  if (response.getResponseCode() !== 200) {
    throw new Error(`Gemini API Error: ${response.getContentText()}`);
  }

  const result = JSON.parse(response.getContentText());
  const jsonText = result.candidates[0].content.parts[0].text;
  const articleData = JSON.parse(jsonText);

  // ファイル名の決定 (日付 + Geminiが提案したファイル名)
  const dateStr = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  const baseName = `${dateStr}-${articleData.filename}`;
  
  // パス設定 (PaperMod向け: 画像はstatic/images, 記事はcontent/posts)
  const imagePath = `static/images/${baseName}.${fileExt}`;
  const postPath = `content/posts/${baseName}.md`;

  // 1. 画像をGitHubへアップロード (utils.jsの関数を利用)
  uploadToGitHub(repo, imagePath, base64Image, `Add image: ${baseName}`, githubToken);

  // 2. Markdownを作成してアップロード (utils.jsの関数を利用)
  const markdownContent = `---
title: "${articleData.title}"
date: ${new Date().toISOString()}
tags: ${JSON.stringify(articleData.tags)}
categories: ["${category}"]
locations: ["${articleData.location}"]
cover:
  image: "/images/${baseName}.${fileExt}"
---

${articleData.content}
`;

  const markdownBase64 = Utilities.base64Encode(markdownContent, Utilities.Charset.UTF_8);
  uploadToGitHub(repo, postPath, markdownBase64, `Add post: ${articleData.title}`, githubToken);
  
  Logger.log(`✅ 投稿完了: ${articleData.title}`);
  return articleData.title;
}

/**
 * スプレッドシートのトリガーを手動設定する関数
 * GUIで「スプレッドシートから」が選べない場合に、この関数を一度だけ実行してください。
 */
function setupSpreadsheetTrigger() {
  // ↓ここにトリガーを設定したいスプレッドシートのIDを入力してください
  const sheetId = '1e4zuZXf2jk9zv6SG5DVGAf4JltVVlpi-zTzsWsgejbg';
  
  if (sheetId === 'ここにスプレッドシートIDを貼り付けてください') {
    throw new Error('❌ スプレッドシートIDを入力してから実行してください');
  }

  // 既存の同名トリガーがあれば削除（重複防止）
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => {
    if (t.getHandlerFunction() === 'onSpreadsheetEdit') ScriptApp.deleteTrigger(t);
  });

  // 新しいトリガーを作成
  ScriptApp.newTrigger('onSpreadsheetEdit').forSpreadsheet(sheetId).onEdit().create();
  Logger.log(`✅ トリガーを設定しました: ${sheetId}`);
}