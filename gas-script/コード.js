function main() {
  const props = PropertiesService.getScriptProperties();
  const folderId = props.getProperty('FOLDER_ID');
  const processedFolderId = props.getProperty('PROCESSED_FOLDER_ID');
  
  if (!folderId || !processedFolderId) {
    Logger.log('❌ FOLDER_ID または PROCESSED_FOLDER_ID が設定されていません');
    return;
  }

  const folder = DriveApp.getFolderById(folderId);
  const processedFolder = DriveApp.getFolderById(processedFolderId);
  const files = folder.getFiles();
  const startTime = Date.now(); // 実行開始時刻を記録
  
  while (files.hasNext()) {
    // 5分（300,000ミリ秒）経過していたら安全に中断 (GASの6分制限対策)
    if (Date.now() - startTime > 300000) {
      Logger.log('⏳ タイムアウト防止のため処理を中断します。残りは次回のトリガーで処理されます。');
      break;
    }

    const file = files.next();
    const mimeType = file.getMimeType();
    
    // JPEG/PNG以外はスキップ
    if (mimeType !== MimeType.JPEG && mimeType !== MimeType.PNG) {
      continue;
    }

    Logger.log(`🚀 処理開始: ${file.getName()}`);

    try {
      const originalName = file.getName();
      processImage(file, props);
      processedFolder.addFile(file); // 処理済みフォルダに追加
      folder.removeFile(file); // 元のフォルダから削除
      Logger.log(`✅ 完了: ${originalName} を処理済みフォルダに移動しました。`);
    } catch (e) {
      Logger.log(`❌ エラー: ${e.toString()}`);
    }
  }
}

function processImage(file, props) {
  const apiKey = props.getProperty('GEMINI_API_KEY');
  const githubToken = props.getProperty('GITHUB_TOKEN');
  const repo = props.getProperty('GITHUB_REPO');

  const blob = file.getBlob();
  const base64Image = Utilities.base64Encode(blob.getBytes());
  const mimeType = file.getMimeType();

  // --- 0. 位置情報 (Exif) の取得と住所特定 ---
  const { locationInfo, mapLink, lat, lng } = getLocationData(file);

  // --- 1. Gemini で記事生成 & ファイル名決定 ---
  // 【修正】利用可能なモデルを動的に取得
  const modelName = getValidFlashModel(apiKey);
  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
  const prompt = `
    この画像をブログ記事用に分析し、以下のJSON形式のみを出力してください。
    Markdownコードブロックは不要です。

    【撮影場所データ】
    ${locationInfo ? `検出された住所: ${locationInfo}` : '位置情報なし'}

    【記事執筆のガイドライン】
    1. 客観的な観察者として記述すること。「当スタジオ」「当店」などの一人称や運営者視点は禁止。
    2. 画像に写っている事実（犬の様子、背景、設備）を中心に描写すること。
    3. 場所や状況が不明確な場合は断定せず、「〜のような場所」「〜と思われる」と推測表現を使うこと。
    4. 架空のサービス勧誘や宣伝文句を書かないこと。

    {
      "filename": "画像の内容を表す英単語(ケバブケース、例: golden-retriever-run)",
      "title": "記事タイトル(30文字以内)",
      "tags": ["タグ1", "タグ2"],
      "content": "Markdown形式の本文。客観的な観察レポートとして記述。"
    }
  `;

  const payload = {
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: mimeType, data: base64Image } }
      ]
    }]
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

  let rawText = JSON.parse(response.getContentText()).candidates[0].content.parts[0].text;
  rawText = rawText.replace(/```json|```/g, '').trim();
  const data = JSON.parse(rawText);

  // --- 2. ファイル名生成 (タイムスタンプ + AIファイル名) ---
  const now = new Date();
  // yyyyMMddHHmmssSSS 形式のタイムスタンプ (例: 20240625123000123)
  const timestamp = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyyMMddHHmmssSSS');
  const ext = (file.getName().split('.').pop() || 'jpg').toLowerCase();
  // AIが決めたファイル名を使用 (英数字とハイフン以外は除去して安全にする)
  const aiFileName = (data.filename || 'image').replace(/[^a-zA-Z0-9-]/g, '');
  const safeName = `${timestamp}-${aiFileName}.${ext}`;

  // --- 3. 画像を GitHub (static/images/) にアップロード ---
  const imagePath = `static/images/${safeName}`;
  // utils.js の uploadToGitHub (Hが大文字) を使用
  uploadToGitHub(repo, imagePath, base64Image, `📸 Add image: ${safeName}`, githubToken);
  Logger.log(`📤 画像アップロード完了: ${imagePath}`);

  // マップ表示セクションの作成
  let locationSection = "";
  if (locationInfo || mapLink) {
    locationSection = `\n\n### 📍 撮影場所\n`;
    if (locationInfo) locationSection += `住所: ${locationInfo}\n\n`;
    if (mapLink) locationSection += `[Google マップで見る](${mapLink})`;
  }

  // --- 4. Markdown 生成 (画像リンク付き) ---
  const markdownContent = `---
title: "${data.title}"
date: ${new Date().toISOString()}
cover:
  image: "images/${safeName}"
tags: [${(data.tags || []).map(t => `"${t}"`).join(', ')}]
aiGenerated: true
${lat ? `location:\n  lat: ${lat}\n  lng: ${lng}` : ''}
---

!${data.title}

${data.content}
${locationSection}

---
*Generated by Gemini*
`;

  // --- 5. 記事を GitHub (content/posts/) にアップロード ---
  // safeName から拡張子を除いた部分を取得してIDとする
  const fileId = safeName.substring(0, safeName.lastIndexOf('.')) || safeName;
  const postPath = `content/posts/${fileId}.md`;
  const base64Markdown = Utilities.base64Encode(markdownContent, Utilities.Charset.UTF_8);
  
  // utils.js の uploadToGitHub (Hが大文字) を使用
  uploadToGitHub(repo, postPath, base64Markdown, `🤖 AI generated: ${data.title}`, githubToken);
  Logger.log(`📤 記事アップロード完了: ${postPath}`);
}
