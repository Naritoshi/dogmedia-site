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

  // 1. セキュリティチェック (e.namedValuesからメールアドレス取得)
  const allowedEmail = props.getProperty('ALLOWED_EMAIL');
  const respondentEmail = e.namedValues['メールアドレス'] ? e.namedValues['メールアドレス'][0] : null;

  if (!respondentEmail) {
    Logger.log('⛔ メールアドレスが取得できませんでした。フォームとスプレッドシートの列名「メールアドレス」を確認してください。');
    return;
  }

  if (allowedEmail && respondentEmail !== allowedEmail) {
    Logger.log(`⛔ 許可されていないユーザーからの投稿をブロックしました: ${respondentEmail}`);
    return;
  }

  Logger.log(`🚀 フォーム投稿を受信: ${respondentEmail}`);

  // 2. 回答データの抽出 (e.namedValuesから)
  const photoUrl = e.namedValues['写真'] ? e.namedValues['写真'][0] : null;
  const location = e.namedValues['撮影場所'] ? e.namedValues['撮影場所'][0] : null;
  const category = e.namedValues['カテゴリ'] ? e.namedValues['カテゴリ'][0] : null;
  const memo = e.namedValues['状況・メモ'] ? e.namedValues['状況・メモ'][0] : null;
  const shouldPostRaw = e.namedValues['投稿'] ? e.namedValues['投稿'][0] : '';

  if (!photoUrl) {
    Logger.log('❌ 写真のURLが見つかりません');
    return;
  }

  // "投稿する" という値でチェック
  if (shouldPostRaw !== '投稿する') {
    Logger.log(`⏭️ 「投稿する」チェックがないため、処理をスキップしました。(値: ${shouldPostRaw})`);
    return;
  }

  // 3. 画像ファイルの取得と処理実行
  try {
    // Google Drive URLからID抽出 (onSpreadsheetEditのロジックを統合)
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
    const title = processFormImage(file, location, category, memo, props);

    // 成功ステータスをシートに書き込む (G列を想定)
    const sheet = e.source.getActiveSheet();
    sheet.getRange(e.range.rowStart, 7).setValue(`✅ ${title}`);

  } catch (err) {
    Logger.log(`❌ エラーが発生しました: ${err.toString()}`);
    // エラーステータスをシートに書き込む (G列を想定)
    try {
      const sheet = e.source.getActiveSheet();
      sheet.getRange(e.range.rowStart, 7).setValue(`❌ ${err.toString()}`);
    } catch (sheetErr) {
      Logger.log(`シートへのエラー書き込みにも失敗しました: ${sheetErr.toString()}`);
    }
  }
}

/**
 * 画像とメタデータを処理してGitHubへアップロードする
 */
function processFormImage(file, location, category, memo, props) {
  const apiKey = props.getProperty('GEMINI_API_KEY');
  const githubToken = props.getProperty('GITHUB_TOKEN');
  const repo = props.getProperty('GITHUB_REPO');

  const blob = file.getBlob();
  const base64Image = Utilities.base64Encode(blob.getBytes());
  const mimeType = file.getMimeType();
  const fileExt = file.getName().split('.').pop();

  // --- 0. 位置情報処理 (カテゴリによる制限付き) ---
  let sourceLocationInfo = '不明';
  let sourceMapLink = null;
  let sourceLat = null;
  let sourceLng = null;

  // 特定のカテゴリの場合のみ位置情報を取得する
  const locationEnabledCategories = ['公園', '旅行', 'ドックラン', 'お店'];
  if (category && locationEnabledCategories.includes(category)) {
      
      // Step 1: 画像のEXIFデータから位置情報を試す
      const exifData = getLocationData(file);

      if (exifData && exifData.lat && exifData.lng) {
        // 有効なEXIFデータを使用
        sourceLocationInfo = exifData.locationInfo || `緯度: ${exifData.lat}, 経度: ${exifData.lng}`;
        sourceMapLink = exifData.mapLink;
        sourceLat = exifData.lat;
        sourceLng = exifData.lng;
        Logger.log(`📍 [${category}] カテゴリのためEXIFから位置情報を取得しました: ${sourceLocationInfo}`);
      } else if (location && location.trim() !== '' && location.trim() !== '不明') {
        // Step 2: EXIFがなければフォームの入力情報をフォールバックとして使用
        sourceLocationInfo = location.trim();
        sourceMapLink = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(sourceLocationInfo)}`;
        // lat/lngはnullのまま
        Logger.log(`ℹ️ [${category}] カテゴリのためフォーム入力の場所情報を使用します: ${sourceLocationInfo}`);
      } else {
        Logger.log(`🤷‍♀️ [${category}] カテゴリですが、利用できる位置情報がありませんでした。`);
      }

  } else {
    Logger.log(`🏠 自宅などプライベートな場所の可能性があるため、位置情報の取得をスキップしました。(カテゴリ: ${category || '未設定'})`);
  }


  // --- 1. Gemini での記事生成 ---
  const models = getPrioritizedModels(apiKey);

  // プロンプトの構築
  const prompt = `
    あなたはプロのブロガーです。以下の情報を元に、ブログ記事のJSONデータを作成してください。
    
    【入力情報】
    - 撮影場所: ${sourceLocationInfo}
    - カテゴリー: ${category || '日常'}
    - メモ: ${memo || '特になし'}
    
    【要件】
    - JSON形式のみ出力すること（Markdownコードブロックは不要）
    - "filename": 画像の内容を表す英単語(ケバブケース, 拡張子なし)
    - "title": 魅力的なタイトル(30文字以内)
    - "content": 記事本文(Markdown形式)。場所やメモの内容を自然に盛り込むこと。
    - "tags": タグの配列
  `;

  const payload = {
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: mimeType, data: base64Image } }
      ]
    }],
    generationConfig: {
      responseMimeType: "application/json"
    }
  };

  // リトライロジック
  let response;
  let lastError;
  for (const modelName of models) {
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
    console.log(`🤖 Trying model: ${modelName}`);
    try {
      response = UrlFetchApp.fetch(apiUrl, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
      if (response.getResponseCode() === 200) break;
      console.warn(`⚠️ Model ${modelName} failed (${response.getResponseCode()}). Trying next...`);
      lastError = response.getContentText();
      Utilities.sleep(1000);
    } catch (e) {
      console.warn(`⚠️ Model ${modelName} exception: ${e.toString()}`);
      lastError = e.toString();
    }
  }

  if (!response || response.getResponseCode() !== 200) {
    throw new Error(`All models failed. Last error: ${lastError}`);
  }
  
  const result = JSON.parse(response.getContentText());
  const jsonText = result.candidates[0].content.parts[0].text;
  const articleData = JSON.parse(jsonText);

  // --- 2. ファイルとMarkdownの準備 ---
  const dateStr = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  const baseName = `${dateStr}-${articleData.filename}`;
  const imagePath = `static/images/${baseName}.${fileExt}`;
  const postPath = `content/posts/${baseName}.md`;

  // マップ表示セクションの作成
  let locationSection = "";
  if (sourceLocationInfo && sourceLocationInfo !== '不明') {
    locationSection = `\n\n### 📍 撮影場所\n${sourceLocationInfo}\n\n`;
    if (sourceMapLink) {
      locationSection += `[Google マップで見る](${sourceMapLink})`;
    }
  }

  // --- 3. GitHubへのアップロード ---
  // 3-1. 画像をアップロード
  uploadToGitHub(repo, imagePath, base64Image, `Add image: ${baseName}`, githubToken);

  // 3-2. Markdownを作成してアップロード
  const markdownContent = `---
title: "${articleData.title}"
date: ${new Date().toISOString()}
tags: ${JSON.stringify(articleData.tags || [])}
categories: ["${category || '未分類'}"]
cover:
  image: "/images/${baseName}.${fileExt}"
${sourceLat ? `location:\n  lat: ${sourceLat}\n  lng: ${sourceLng}` : ''}
---

${articleData.content}
${locationSection}
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
    if (t.getHandlerFunction() === 'onFormSubmit') ScriptApp.deleteTrigger(t);
  });

  // 新しいトリガーを作成
  ScriptApp.newTrigger('onSpreadsheetEdit').forSpreadsheet(sheetId).onEdit().create();
  ScriptApp.newTrigger('onFormSubmit').forSpreadsheet(sheetId).onFormSubmit().create();
  Logger.log(`✅ トリガーを設定しました: ${sheetId}`);
}