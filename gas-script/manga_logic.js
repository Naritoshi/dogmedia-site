/**
 * 4コマ漫画の構成を Gemini で生成する
 * @param {GoogleAppsScript.Base.Blob} imageBlob - ユーザーがアップロードした写真
 * @param {string} apiKey - Gemini APIキー
 * @return {Object} - 4コマの構成データ
 */
function generateMangaStructure(imageBlob, apiKey) {
  // 【修正】既存の utils.js にある関数を使って、有効な最新の Flash モデルを取得
  const modelName = getValidFlashModel(apiKey);
  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

  const base64Image = Utilities.base64Encode(imageBlob.getBytes());
  const mimeType = imageBlob.getContentType();

  const prompt = `
    あなたは犬専門の4コマ漫画家です。
    提供された1枚の写真をもとに、コミカルで心温まる4コマ漫画のストーリー（起承転結）を考えてください。
    1コマ目は「提供された写真そのもの」を使用します。2〜4コマ目は、その前後に起きる架空のシーンを考えてください。

    【出力形式】
    以下のJSON形式のみを出力してください（Markdownコードブロックは不要）。

    {
      "title": "漫画のタイトル",
      "frames": [
        {
          "step": "起",
          "is_original": true,
          "scene_description": "提供された写真の状況を客観的に説明（例：柴犬が首をかしげてこちらを見ている）",
          "dialogue": "1コマ目のセリフ（犬の心の声）",
          "image_gen_prompt": "1コマ目の状況を再現するための画像生成用英語プロンプト（2コマ目以降との一貫性のため）"
        },
        {
          "step": "承",
          "is_original": false,
          "scene_description": "2コマ目の状況説明",
          "dialogue": "2コマ目のセリフ",
          "image_gen_prompt": "2コマ目を画像生成AIで描画するための詳細な英語プロンプト。1コマ目の犬の特徴（犬種、毛色、首輪など）を維持すること"
        },
        {
          "step": "転",
          "is_original": false,
          "scene_description": "3コマ目の状況説明（予想外の展開）",
          "dialogue": "3コマ目のセリフ",
          "image_gen_prompt": "3コマ目を画像生成AIで描画するための詳細な英語プロンプト"
        },
        {
          "step": "結",
          "is_original": false,
          "scene_description": "4コマ目の状況説明（オチ）",
          "dialogue": "4コマ目のセリフ",
          "image_gen_prompt": "4コマ目を画像生成AIで描画するための詳細な英語プロンプト"
        }
      ],
      "overall_theme": "漫画全体の雰囲気（例：ドタバタ、ほっこり、シュール）"
    }
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
  return JSON.parse(jsonText);
}

/**
 * Imagen 3 API を使用して画像を生成する
 * @param {string} prompt - 画像生成用の英語プロンプト
 * @param {string} apiKey - Gemini APIキー
 * @return {GoogleAppsScript.Base.Blob} - 生成された画像のBlob
 */
function generateImage(prompt, apiKey) {
  // 注: Google AI Studio で Imagen 3 が有効になっている必要があります
  const modelName = 'imagen-3.0-generate-001'; 
  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:predict?key=${apiKey}`;

  const payload = {
    instances: [
      { prompt: prompt }
    ],
    parameters: {
      sampleCount: 1,
      aspectRatio: "1:1" // 4コマ漫画なので正方形
    }
  };

  const response = UrlFetchApp.fetch(apiUrl, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  if (response.getResponseCode() !== 200) {
    throw new Error(`Imagen 3 Error: ${response.getContentText()}`);
  }

  const result = JSON.parse(response.getContentText());
  const base64Image = result.predictions[0].bytesBase64Encoded;
  const imageBlob = Utilities.newBlob(Utilities.base64Decode(base64Image), 'image/png', 'manga-frame.png');
  
  return imageBlob;
}

/**
 * 4コマ漫画記事を処理してGitHubへアップロードする
 */
function processMangaPost(file, memo, props) {
  const apiKey = props.getProperty('GEMINI_API_KEY');
  const githubToken = props.getProperty('GITHUB_TOKEN');
  const repo = props.getProperty('GITHUB_REPO');

  const originalBlob = file.getBlob();
  const fileExt = file.getName().split('.').pop();

  // 1. 4コマの構成を生成
  const mangaData = generateMangaStructure(originalBlob, apiKey);

  // 2. ファイル名の準備
  const dateStr = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  const timestamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'HHmmss');
  const baseName = `${dateStr}-${timestamp}-manga`;
  const postPath = `content/posts/${baseName}.md`;

  // 3. 各コマの画像を生成・アップロード
  const frameImageUrls = [];
  
  for (let i = 0; i < mangaData.frames.length; i++) {
    const frame = mangaData.frames[i];
    const frameIndex = i + 1;
    let frameBlob;
    let currentExt = fileExt;

    if (frame.is_original) {
      // 1コマ目：元の写真を使用
      frameBlob = originalBlob;
    } else {
      // 2-4コマ目：AIで画像生成
      Logger.log(`🎨 Generating AI image for frame ${frameIndex}...`);
      try {
        frameBlob = generateImage(frame.image_gen_prompt, apiKey);
        currentExt = 'png'; // AI生成はPNG
      } catch (e) {
        Logger.log(`⚠️ Frame ${frameIndex} generation failed: ${e.toString()}`);
        frameBlob = null; // 失敗時は画像なし（ト書きのみ）
      }
    }

    if (frameBlob) {
      const imagePath = `static/images/${baseName}-${frameIndex}.${currentExt}`;
      const base64Content = Utilities.base64Encode(frameBlob.getBytes());
      uploadToGitHub(repo, imagePath, base64Content, `Add manga frame ${frameIndex}: ${baseName}`, githubToken);
      frameImageUrls.push(`/images/${baseName}-${frameIndex}.${currentExt}`);
    } else {
      frameImageUrls.push(null);
    }
  }

  // 4. Markdown の作成
  const framesHtml = mangaData.frames.map((frame, index) => {
    const imageUrl = frameImageUrls[index];
    return `
<div class="manga-frame">
  <div class="frame-number">${index + 1}</div>
  <div class="frame-image">
    ${imageUrl ? `<img src="${imageUrl}" alt="Frame ${index + 1}">` : `<div class="ai-scene-placeholder">🖼️ AI生成失敗: ${frame.scene_description}</div>`}
  </div>
  <div class="frame-dialogue">${frame.dialogue}</div>
</div>
`}).join('');

  const markdownContent = `---
title: "【4コマ】${mangaData.title}"
date: ${new Date().toISOString()}
tags: ["4コマ漫画", "AI生成", "ゴールデンドゥードル"]
categories: ["エンタメ"]
isManga: true
cover:
  image: "${frameImageUrls[0] || ''}"
---

<div class="manga-container">
${framesHtml}
</div>

---
**AI漫画家のつぶやき:** この漫画は「${mangaData.overall_theme}」をテーマに描きました。
`;

  const markdownBase64 = Utilities.base64Encode(markdownContent, Utilities.Charset.UTF_8);
  uploadToGitHub(repo, postPath, markdownBase64, `Add manga post: ${mangaData.title}`, githubToken);

  return mangaData.title;
}

/**
 * 画像生成単体のテスト実行用関数
 */
function debugGenerateImage() {
  const props = PropertiesService.getScriptProperties();
  const apiKey = props.getProperty('GEMINI_API_KEY');
  
  try {
    Logger.log("🎨 テスト画像生成中...");
    const blob = generateImage("A cute golden doodle dog playing with a ball in a park, comic book style", apiKey);
    Logger.log("✅ 生成成功！ファイルサイズ: " + blob.getBytes().length + " bytes");
  } catch (e) {
    Logger.log("❌ 生成失敗: " + e.toString());
  }
}
