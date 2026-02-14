/**
 * バイト配列を16進数文字列に変換するヘルパー関数
 * @param {byte[]} bytes - 変換するバイト配列
 * @return {string} 16進数文字列
 */
function bytesToHex(bytes) {
  return bytes.map(byte => {
    const hex = (byte & 0xFF).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  }).join('');
}

/**
 * 利用可能な最新の 'flash' モデル名を取得する
 * @param {string} apiKey - Gemini APIキー
 * @return {string} - モデル名 (例: 'gemini-1.5-flash-latest')
 */
function getValidFlashModel(apiKey) {
  const modelsUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
  try {
    const response = UrlFetchApp.fetch(modelsUrl, {
      method: 'get',
      muteHttpExceptions: true
    });

    if (response.getResponseCode() === 200) {
      const models = JSON.parse(response.getContentText()).models;
      // 'generateContent'をサポートし、名前に'flash'を含むモデルを探す
      const flashModel = models.find(m => 
        m.name.includes('flash') && 
        m.supportedGenerationMethods.includes('generateContent')
      );
      if (flashModel) {
        const modelName = flashModel.name.split('/').pop(); // 'models/'プレフィックスを削除
        Logger.log(`🤖 動的にモデルを選択しました: ${modelName}`);
        return modelName;
      }
    }
  } catch (e) {
    Logger.log(`モデル一覧の取得中にエラーが発生しました: ${e.toString()}`);
  }
  // モデルが見つからない場合やエラー発生時のフォールバック
  const fallbackModel = 'gemini-1.5-flash';
  Logger.log(`⚠️ 対応モデルが見つかりませんでした。フォールバックします: ${fallbackModel}`);
  return fallbackModel;
}

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
  
  while (files.hasNext()) {
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
      return; // PoC用: 1回1枚で終了
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

  // 【修正点1】ファイル内容からSHA-256ハッシュを生成し、ファイル名とする
  const hashBytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, blob.getBytes());
  const hashHex = bytesToHex(hashBytes);
  const ext = (file.getName().split('.').pop() || 'jpg').toLowerCase();
  const safeName = `${hashHex}.${ext}`;

  const mimeType = file.getMimeType();

  // --- 1. 画像を GitHub (static/images/) にアップロード ---
  const imagePath = `static/images/${safeName}`;
  uploadToGithub(repo, imagePath, base64Image, `📸 Add image: ${file.getName()} (${safeName})`, githubToken);
  Logger.log(`📤 画像アップロード完了: ${imagePath}`);

  // --- 2. Gemini で記事生成 ---
  // 【修正】利用可能なモデルを動的に取得
  const modelName = getValidFlashModel(apiKey);
  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
  const prompt = `
    この画像をブログ記事用に分析し、以下のJSON形式のみを出力してください。
    Markdownコードブロックは不要です。
    {
      "title": "記事タイトル(30文字以内)",
      "tags": ["タグ1", "タグ2"],
      "content": "Markdown形式の本文。施設の雰囲気や犬への対応などを記述。"
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

  // --- 3. Markdown 生成 (画像リンク付き) ---
  const markdownContent = `---
title: "${data.title}"
date: ${new Date().toISOString()}
cover:
  image: "/images/${safeName}"
tags: [${data.tags.map(t => `"${t}"`).join(', ')}]
aiGenerated: true
---

!${data.title}

${data.content}

---
*Generated by Gemini*
`;

  // --- 4. 記事を GitHub (content/posts/) にアップロード ---
  // 【修正点2】Markdownファイル名もハッシュ値ベースにし、重複を防ぐ
  const postPath = `content/posts/${hashHex}.md`;
  const base64Markdown = Utilities.base64Encode(markdownContent, Utilities.Charset.UTF_8);
  
  uploadToGithub(repo, postPath, base64Markdown, `🤖 AI generated: ${data.title}`, githubToken);
  Logger.log(`📤 記事アップロード完了: ${postPath}`);
}

// GitHub API アップロード用共通関数
function uploadToGithub(repo, path, contentBase64, message, token) {
  const url = `https://api.github.com/repos/${repo}/contents/${path}`;
  
  // 同名ファイルがあるかチェック（上書き用）
  let sha = null;
  try {
    const check = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { 'Authorization': `Bearer ${token}` },
      muteHttpExceptions: true
    });
    if (check.getResponseCode() === 200) {
      sha = JSON.parse(check.getContentText()).sha;
    }
  } catch (e) {}

  const payload = {
    message: message,
    content: contentBase64
  };
  if (sha) {
    payload.sha = sha;
  }

  const response = UrlFetchApp.fetch(url, {
    method: 'put',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json'
    },
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  if (response.getResponseCode() !== 201 && response.getResponseCode() !== 200) {
    throw new Error(`GitHub API Error: ${response.getContentText()}`);
  }
}
