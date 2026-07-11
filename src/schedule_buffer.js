'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');

const BUFFER_TOKEN = process.env.BUFFER_TOKEN;
const GRAPHQL_URL = 'https://api.buffer.com/graphql';

// Every channel this pipeline posts to. Instagram is required; TikTok is posted to as
// well when its channel id is configured (BUFFER_TIKTOK_CHANNEL_ID).
const CHANNELS = [
  { name: 'instagram', channelId: process.env.BUFFER_CHANNEL_ID || 'YOUR_CHANNEL_ID_HERE', metadata: { instagram: { type: 'reel', shouldShareToFeed: true } } },
  ...(process.env.BUFFER_TIKTOK_CHANNEL_ID ? [{ name: 'tiktok', channelId: process.env.BUFFER_TIKTOK_CHANNEL_ID, metadata: { tiktok: {} } }] : []),
];

function gql(query, variables) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query, variables });
    const opts = {
      hostname: 'api.buffer.com',
      path: '/graphql',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${BUFFER_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(opts, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(d);
          if (parsed.errors) return reject(new Error(parsed.errors[0].message));
          resolve(parsed.data);
        } catch (e) {
          reject(new Error('Invalid JSON: ' + d.slice(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Upload video via curl to a temporary host and return public URL
function uploadVideo(filePath) {
  const { execFileSync } = require('child_process');
  const os = require('os');

  // Copy to a temp path with no special characters (avoids Hebrew path issues on Windows)
  const tmpPath = path.join(os.tmpdir(), 'ryze_upload.mp4');
  fs.copyFileSync(filePath, tmpPath);

  const bin = `ryze-${Date.now()}`;
  const hosts = [
    // filebin.net: 6-day retention, direct URL, no auth needed
    () => {
      execFileSync('curl', ['-s', '-f', '-X', 'POST', '--data-binary', `@${tmpPath}`, '-H', 'Content-Type: video/mp4', `https://filebin.net/${bin}/video.mp4`], { timeout: 180000 });
      // verify the file is accessible
      const check = execFileSync('curl', ['-s', '-f', '-I', `https://filebin.net/${bin}/video.mp4`], { timeout: 30000 }).toString();
      if (!check.includes('200')) throw new Error('filebin check failed');
      return `https://filebin.net/${bin}/video.mp4`;
    },
    // uguu.se: 48h retention
    () => {
      const out = execFileSync('curl', ['-s', '-f', '-F', `files[]=@${tmpPath}`, 'https://uguu.se/upload'], { timeout: 180000 }).toString().trim();
      const data = JSON.parse(out);
      if (!data.files || !data.files[0] || !data.files[0].url) throw new Error('uguu failed: ' + out);
      return data.files[0].url;
    },
  ];

  try {
    for (let i = 0; i < hosts.length; i++) {
      try {
        const url = hosts[i]();
        console.log(`  upload via host ${i + 1} -> ${url}`);
        return url;
      } catch (err) {
        console.warn(`  host ${i + 1} failed: ${err.message}`);
        if (i === hosts.length - 1) throw err;
      }
    }
  } finally {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
  }
}

// Schedule a post via Buffer GraphQL
async function schedulePost(channelId, metadata, videoUrl, caption, scheduledAt) {
  const mutation = `
    mutation CreatePost($input: CreatePostInput!) {
      createPost(input: $input) {
        ... on PostActionSuccess {
          post { id status dueAt }
        }
        ... on NotFoundError { message }
        ... on UnauthorizedError { message }
        ... on UnexpectedError { message }
        ... on RestProxyError { message }
        ... on LimitReachedError { message }
        ... on InvalidInputError { message }
      }
    }
  `;

  const variables = {
    input: {
      channelId,
      text: caption,
      dueAt: scheduledAt,
      schedulingType: 'automatic',
      mode: 'customScheduled',
      metadata,
      assets: [{ video: { url: videoUrl } }],
    },
  };

  return gql(mutation, variables);
}

async function uploadAndSchedule(videoPath, caption, scheduledAt) {
  console.log(`  uploading ${path.basename(videoPath)}...`);
  const videoUrl = await uploadVideo(videoPath);
  console.log(`  uploaded -> ${videoUrl}`);

  console.log(`  scheduling for ${new Date(scheduledAt).toISOString()}...`);
  const posts = [];
  for (const ch of CHANNELS) {
    try {
      const result = await schedulePost(ch.channelId, ch.metadata, videoUrl, caption, scheduledAt);
      const payload = result?.createPost;
      if (payload?.message) throw new Error(payload.message);
      const post = payload?.post;
      console.log(`  [${ch.name}] scheduled -> post id: ${post?.id} status: ${post?.status}`);
      posts.push(post);
    } catch (err) {
      console.error(`  [${ch.name}] Buffer error: ${err.message}`);
    }
  }
  if (!posts.length) throw new Error('Buffer error: failed to schedule on every channel');
  return posts;
}

module.exports = { uploadAndSchedule };
