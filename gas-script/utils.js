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

/**
 * GitHub APIを使ってファイルを作成/更新する（共通関数）
 * @param {string} repo - リポジトリ名 (user/repo)
 * @param {string} path - ファイルパス
 * @param {string} contentBase64 - Base64エンコードされたコンテンツ
 * @param {string} message - コミットメッセージ
 * @param {string} token - GitHubトークン
 */
function uploadToGitHub(repo, path, contentBase64, message, token) {
  const url = `https://api.github.com/repos/${repo}/contents/${path}`;
  
  // 同名ファイルがあるかチェック（上書き用SHA取得）
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
    throw new Error(`GitHub API Error (${path}): ${response.getContentText()}`);
  }
}