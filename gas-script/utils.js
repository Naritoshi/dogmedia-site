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
 * 生成可能なモデルのリストを優先度順に取得する
 * @param {string} apiKey - Gemini APIキー
 * @return {string[]} - モデル名の配列 (例: ['gemini-1.5-flash', 'gemini-1.5-pro', ...])
 */
function getPrioritizedModels(apiKey) {
  const modelsUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
  // API取得失敗時のフォールバックリスト
  const defaultModels = ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-1.0-pro'];
  
  try {
    const response = UrlFetchApp.fetch(modelsUrl, {
      method: 'get',
      muteHttpExceptions: true
    });

    if (response.getResponseCode() === 200) {
      const data = JSON.parse(response.getContentText());
      if (!data.models) return defaultModels;

      const models = data.models
        .filter(m => m.supportedGenerationMethods.includes('generateContent'))
        .map(m => m.name.replace('models/', ''));

      // 優先順位: flash > pro > その他 (かつ latest を優先)
      return models.sort((a, b) => {
        const getScore = (name) => {
          let score = 0;
          if (name.includes('flash')) score += 10;
          if (name.includes('pro')) score += 5;
          if (name.includes('latest')) score += 2;
          return score;
        };
        return getScore(b) - getScore(a);
      });
    }
  } catch (e) {
    Logger.log(`モデル一覧取得エラー: ${e.toString()}`);
  }
  return defaultModels;
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

/**
 * 画像ファイルから位置情報を抽出し、住所に変換する
 * @param {GoogleAppsScript.Drive.File} file - 処理対象の画像ファイル
 * @returns {{locationInfo: string, mapLink: string, lat: number|null, lng: number|null}} - 位置情報を含むオブジェクト
 */
function getLocationData(file) {
  const locationData = {
    locationInfo: "",
    mapLink: "",
    lat: null,
    lng: null
  };

  try {
    // Drive APIを有効にする必要がある
    const driveFile = Drive.Files.get(file.getId(), { fields: 'imageMediaMetadata' });

    if (!driveFile.imageMediaMetadata || !driveFile.imageMediaMetadata.location) {
      Logger.log('ℹ️ 画像に位置情報メタデータが含まれていません。');
      return locationData;
    }

    const loc = driveFile.imageMediaMetadata.location;
    if (!loc.latitude || !loc.longitude) {
      Logger.log('ℹ️ 位置情報メタデータに有効な緯度・経度が含まれていません。');
      return locationData;
    }

    locationData.lat = loc.latitude;
    locationData.lng = loc.longitude;
    locationData.mapLink = `https://www.google.com/maps?q=${locationData.lat},${locationData.lng}`;

    // 逆ジオコーディングで座標を住所に変換
    const geoResponse = Maps.newGeocoder().setLanguage('ja').reverseGeocode(locationData.lat, locationData.lng);
    
    if (geoResponse.status === 'OK' && geoResponse.results.length > 0) {
      locationData.locationInfo = geoResponse.results[0].formatted_address;
      Logger.log(`📍 位置情報特定成功: ${locationData.locationInfo} (${locationData.mapLink})`);
    } else {
      // 住所が取得できなくても、緯度経度は記録されているのでマップリンクは有効
      Logger.log(`⚠️ 逆ジオコーディングに失敗しました。ステータス: ${geoResponse.status}`);
    }
    
  } catch (e) {
    Logger.log(`⚠️ 位置情報取得中にエラーが発生しました。Drive APIが無効か、その他の問題の可能性があります。エラー: ${e.toString()}`);
  }

  return locationData;
}