function createDogMediaForm() {
  // フォームの新規作成
  const form = FormApp.create('Dog Media 投稿フォーム')
      .setCollectEmail(true); // メールアドレスを収集（本人確認のため必須）
  
  // 1. 写真 (ファイルアップロード)
  // ※初回実行時、ドライブへのアクセス権限が求められます
  form.addFileUploadItem()
      .setTitle('写真')
      .setRequired(true);

  // 2. 撮影場所 (記述式)
  // ※後でよく行く場所をプルダウンにするのもアリですが、まずは自由入力で
  form.addTextItem()
      .setTitle('撮影場所')
      .setRequired(true)
      .setHelpText('例: 代々木公園, 自宅');

  // 3. カテゴリー (プルダウン)
  form.addListItem()
      .setTitle('カテゴリー')
      .setChoiceValues(['散歩', '旅行', 'ドッグラン', '日常', 'その他'])
      .setRequired(true);

  // 4. 状況・メモ (段落テキスト)
  form.addParagraphTextItem()
      .setTitle('状況・メモ')
      .setHelpText('AIへの指示になります。例: 風が強かった、初めての友達と遊んだ')
      .setRequired(false);

  // 完了ログ
  console.log('フォームが作成されました！');
  console.log('編集URL: ' + form.getEditUrl());
}