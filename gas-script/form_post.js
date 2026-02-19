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

  itemResponses.forEach(itemResponse => {
    const title = itemResponse.getItem().getTitle();
    const response = itemResponse.getResponse();

    if (title === '写真') fileId = response[0]; // ファイルアップロードは配列で返る
    if (title === '撮影場所') location = response;
    if (title === 'カテゴリー') category = response;
    if (title === '状況・メモ') memo = response;
  });

  if (!fileId) {
    Logger.log('❌ 写真が見つかりません');
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
}