# Bitbuket to Slack

Bitbuket のプルリクエスト を Slack に通知する AWS Lambda 向けのボットです。
毎日8時〜21時まで3分毎にBitbucketAPIをポーリングしてSlackへ通知します。

※ 開発環境に [node-lambda](https://github.com/motdotla/node-lambda) を使用しています
※ ポーリング日時は `event_sources.json` の `ScheduleExpression` で変更可能

## 使い方

1. `npm install -g node-lambda`
2. `npm install`
3. `$ cp .env.example .env`
4. .envのAWS設定

```
AWS_REGION=ap-northeast-1
AWS_ACCESS_KEY_ID=your_key
AWS_SECRET_ACCESS_KEY=your_secret
AWS_ROLE_ARN=your_role
```

5. Bitbuckt の OAuth トークンを取得する
6. Slack の OAuth トークンを取得する
7. AWS Lambda に環境変数に追加する

※ 環境変数の説明は `.env.example` を参考

```
BB_OAUTH_KEY
BB_OAUTH_SECRET
BB_WORKSPACE ← Bitbucket Warkspace Name
S3_BUCKET_NAME
S3_BUCKET_FILE
SLACK_TOKEN
TARGETS
NAME_TO_MENTIONS
```

8. `$ node-lambda deploy`

### ローカル動作確認

`$ node-lambda run`

