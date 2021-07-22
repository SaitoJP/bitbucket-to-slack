const axios = require('axios');
const aws = require('aws-sdk');
aws.config.region = process.env.AWS_REGION;
const s3 = new aws.S3();


// 環境変数をデコード（Lambdaの環境変数にJSONを保持させるにはbase64化する必要あり）
const _mentions = Buffer.from(process.env.NAME_TO_MENTIONS, 'base64');
// デコードした環境変数をオブジェクトに変換
const mentions = JSON.parse(_mentions);

const fetchBitbucketToken = async () => {
  const params = new URLSearchParams();
  params.append('grant_type', 'client_credentials');
  const response = await axios.post('https://bitbucket.org/site/oauth2/access_token', params, {
    auth: {
      username: process.env.BB_OAUTH_KEY,
      password: process.env.BB_OAUTH_SECRET
    }
  })

  return response.data.access_token;
}


const writeStorage = async (object) => {
  const params = {
    Bucket: process.env.S3_BUCKET_NAME,
    Key: process.env.S3_BUCKET_FILE,
      Body: JSON.stringify(object)
  }
  await s3.putObject(params).promise()
}


const readStorage = async () => {
  const params = { Bucket: process.env.S3_BUCKET_NAME, Key: process.env.S3_BUCKET_FILE }
  const data = await s3.getObject(params).promise()
  const result = JSON.parse(data.Body ?? '{}')
  return result
}


let accessTokenParams = null;
const fetchPullRequestItem = async (pullrequestUrl) => {
  const response = await axios.get(pullrequestUrl, { params: accessTokenParams });
  return { reviewersObj: gerReviewersObj(response), authorObj: getAuthorObj(response) }
}


const gerReviewersObj = (response) => {
  let result = '';

  for (const item of response.data.participants) {
    if (item.role === 'REVIEWER') {
      if (item.state === 'approved') {
        result += item.user.display_name;
        result += ':white_check_mark:,   ';
      } else {
        result += mentions[item.user.display_name];
        result += ',   ';
      }
    }
  }

  return result;
}


const getAuthorObj = (response) => {
  return { mention: mentions[response.data.author.display_name], imageUrl: response.data.author.links.avatar.href };
}

const getCommentUserName = async (commentUrl) => {
  const response = await axios.get(commentUrl, { params: accessTokenParams });
  return response.data.user.display_name;
}


// 取得しやすいデータ形式に整形する
const parseData = async (data) => {
  let result = [];

  for (const items of data.values) {
    const pullrequest = items['pull_request']

    const title = pullrequest.title;
    const pullRequestItem = await fetchPullRequestItem(pullrequest.links.self.href);
    let authorObj = null;
    let reviewersObj = null;
    let href = pullrequest.links.html.href;
    let date = '';
    let content = null;
    let replies = null;
    const actionKey = Object.keys(items).filter(word => word != 'pull_request')[0]
    const values = items[actionKey]
    let actionMsg = { imageUrl: null, text: '-' };

    switch(actionKey) {
      case 'update':
        date = values.date;
        actionMsg.imageUrl = values.author.links.avatar.href;
        actionMsg.text = `:wink: *${values.author.display_name}* がプルリクエスト更新`;

        // FIXME: プルリク変更点がタイトルや本文の場合はメンションを飛ばさない
        // if (!values.changes.title && !values.changes.description) {
          reviewersObj = pullRequestItem.reviewersObj;
        // }
        break;
      case 'comment':
        date = values.updated_on;
        actionMsg.imageUrl = values.user.links.avatar.href;
        actionMsg.text = `:speech_balloon: *${values.user.display_name}* がコメント`;
        href = values.links.html.href;
        content = values.content.raw; // コメント内容

        // 自分のプルリクに自分がコメントした場合、メンションを飛ばさない
        if (mentions[values.user.display_name] !== pullRequestItem.authorObj.mention) {
          authorObj = pullRequestItem.authorObj;
        }

        // 返信対象のコメント記入者にメンションを飛ばす
        if (values.parent) {
          const displayName = await getCommentUserName(values.parent.links.self.href);
          replies = `*Reply to:* ${mentions[displayName]}`;
        }

        break;
      case 'approval':
        authorObj = pullRequestItem.authorObj;
        date = values.date;
        actionMsg.imageUrl = values.user.links.avatar.href;
        actionMsg.text = `:thumbsup:  *${values.user.display_name}* が承認`;
        break;
      default:
        console.log(`Switch Error is ${actionKey}`);
    }

    result.push({ date, title, href, actionMsg, content, replies, reviewersObj, authorObj });
  }

  return result;
}


// 未読のアクティビティを抽出する
const filterViewdData = (viewedDate, data) => {
  // console.log(`viewedDate: ${viewedDate}`)
  viewedDate = viewedDate ?? '0';
  return data.filter( (value) => {
    // console.log(`value.date: ${value.date}`)
    return value.date > viewedDate
  });
}


// Slack に通知する
const sendSlack = async (filterdData, slackChannel) => {
  for (const item of filterdData) {

    // Slack に通知する（Block Kit Builder）
    // https://app.slack.com/block-kit-builder/TEKJRPVJP
    const params =
      { blocks: [
        { type: 'context', elements: [
          { type: 'mrkdwn', text: `:large_blue_diamond: *Bitbuket* ` },
          (item.authorObj !== null ? { type: 'image', image_url: item.authorObj.imageUrl, alt_text: '-' } : null),
          (item.authorObj !== null ? { type: 'mrkdwn', text: `${item.authorObj.mention}, ` } : null),
          { type: 'mrkdwn', text: `*<${item.href}|${item.title}>*` }
        ].filter(v => v) },
        { type: 'context', elements: [
          { type: 'image', image_url: item.actionMsg.imageUrl, alt_text: '-' },
          { type: 'mrkdwn', text: `${item.actionMsg.text}` }
        ] },
        (item.replies !== null ? { type: 'section', text: { type: 'mrkdwn', text: item.replies }} : null),
        (item.reviewersObj !== null ? { type: 'section', text: { type: 'mrkdwn', text: `　　*Reviewers:* ${item.reviewersObj}` }} : null),
        { type: 'divider' },
      ].filter(v => v) };

    // console.log(`slackChannel: ${slackChannel}`)

    const config = {
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${process.env.SLACK_TOKEN}`
      }
    };
    const postParams = { channel: slackChannel, ...params };
    const response = await axios.post('https://slack.com/api/chat.postMessage', postParams, config);

    // コメント内容はスレッドに表示
    if (item.content) {
      const commentParams =
        { blocks: [ { type: 'section', text: { type: 'mrkdwn', text: item.content } } ] };
      await axios.post('https://slack.com/api/chat.postMessage', {
        channel: slackChannel,
        thread_ts: response.data.ts,
        ...commentParams
      }, config);
    }

  }
}



exports.handler = async (_event, _context) => {
  const bitbucketToken = await fetchBitbucketToken()

  // 環境変数をデコード（Lambdaの環境変数にJSONを保持させるにはbase64化する必要あり）
  const _targets = Buffer.from(process.env.TARGETS, 'base64')
  // デコードした環境変数をオブジェクトに変換
  const targets = JSON.parse(_targets)

  accessTokenParams = { access_token: bitbucketToken }
  // console.log(accessTokenParams);

  const workspace = process.env.BB_WORKSPACE

  // ファイルストレージから既読日時を取得
  let storage = {};

  if (!process.env.DEV_MODE) {
    try {
      storage = await readStorage();
    } catch(error) {
      console.log(error);
      await writeStorage({});
    }
  }

  for (const [repository, slackChannel] of Object.entries(targets)) {
    const url = `https://bitbucket.org/api/2.0/repositories/${workspace}/${repository}/pullrequests/activity`
    const response = await axios.get(url, { params: accessTokenParams })
    // console.log(response.data);

    // データ整形
    const data = await parseData(response.data);
    // console.log(data);
    const filterdData = filterViewdData(storage[repository], data);
    // console.log(`filterdData: ${filterdData}`);

    await sendSlack(filterdData, slackChannel);

    // 最新のアクティビティ日時を既読日時として保持
    const lastUpdatedDate = data[0].date
    if (lastUpdatedDate) {
      storage[repository] = lastUpdatedDate
    }
  }

  if (!process.env.DEV_MODE) {
    // ファイルストレージの既読日時を更新する
    await writeStorage(storage);
  }

  return true
}
