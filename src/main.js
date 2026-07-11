'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const topics = require(path.join(ROOT, 'content', 'video_topics.json'));
const { buildContent } = require('./generate_content.js');
const { uploadAndSchedule } = require('./schedule_buffer.js');

const STATE_PATH = path.join(ROOT, 'state.json');
const VIDEOS_DIR = path.join(ROOT, 'out');

// 10 posting times in Israel timezone (HH:MM)
const SCHEDULE_TIMES = ['07:00', '08:30', '10:00', '11:30', '13:00', '14:30', '16:00', '18:00', '20:00', '22:00'];
const POSTS_PER_DAY = SCHEDULE_TIMES.length;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getIsraelDateStr() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
}

// Convert "HH:MM" Israel time today to UTC ISO string
function israelTimeToUTC(hhmm, dateStr) {
  const [h, m] = hhmm.split(':').map(Number);
  // dateStr = YYYY-MM-DD in Israel time
  // We create a date at Israel midnight and add hours
  // Israel is UTC+3 (winter) or UTC+2 (summer) — we let JS handle it via Intl
  const dt = new Date(`${dateStr}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00`);
  // Adjust for Israel offset: get Israel offset in minutes
  const israelOffset = getIsraelOffsetMinutes();
  const utcMs = dt.getTime() - israelOffset * 60 * 1000;
  return new Date(utcMs).toISOString();
}

function getIsraelOffsetMinutes() {
  // Get current Israel UTC offset
  const now = new Date();
  const israelStr = now.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' });
  const utcStr = now.toLocaleString('en-US', { timeZone: 'UTC' });
  const israelDate = new Date(israelStr);
  const utcDate = new Date(utcStr);
  return (israelDate - utcDate) / 60000;
}

function findFFmpeg() {
  // Try system ffmpeg first (GitHub Actions / Ubuntu)
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return 'ffmpeg'; } catch (e) {}
  // Try Windows WinGet path
  const wingetBase = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Microsoft/WinGet/Packages')
    : null;
  if (wingetBase) {
    const search = (d, depth = 0) => {
      if (depth > 5 || !fs.existsSync(d)) return null;
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return null; }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { const r = search(p, depth + 1); if (r) return r; }
        else if (e.name.toLowerCase() === 'ffmpeg.exe') return p;
      }
      return null;
    };
    const found = search(wingetBase);
    if (found) return found;
  }
  throw new Error('ffmpeg not found');
}

async function renderVideo(topic, videoIndex, outDir) {
  const contentJson = buildContent(topic, videoIndex, outDir);
  const contentPath = path.join(ROOT, `tmp_content_${videoIndex}.json`);
  fs.writeFileSync(contentPath, JSON.stringify(contentJson, null, 2));

  const renderScript = path.join(__dirname, 'render_video.js');
  const ffmpegPath = findFFmpeg();

  console.log(`  rendering video ${videoIndex + 1}...`);
  const result = spawnSync('node', [renderScript, contentPath], {
    stdio: 'inherit',
    env: { ...process.env, FFMPEG_PATH: ffmpegPath },
    timeout: 600000,
  });

  fs.unlinkSync(contentPath);

  if (result.status !== 0) throw new Error(`render failed for topic ${topic.id}`);
  return path.join(outDir, 'video.mp4');
}

async function main() {
  const todayIsrael = getIsraelDateStr();
  const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));

  const forceRun = process.env.FORCE_RUN === 'true';
  if (!forceRun && state.lastRunDate === todayIsrael) {
    console.log(`Already ran today (${todayIsrael}). Skipping.`);
    return;
  }

  fs.mkdirSync(VIDEOS_DIR, { recursive: true });

  console.log(`=== Ryze Instagram Daily Videos — ${todayIsrael} ===`);
  console.log(`Topics pool: ${topics.length}, starting at index ${state.nextIndex}`);

  const testLimit = parseInt(process.env.TEST_LIMIT, 10);
  const runCount = Number.isInteger(testLimit) && testLimit > 0 ? Math.min(testLimit, POSTS_PER_DAY) : POSTS_PER_DAY;
  if (runCount < POSTS_PER_DAY) console.log(`TEST_LIMIT set: running ${runCount} of ${POSTS_PER_DAY} videos`);

  let startIndex = state.nextIndex;
  if (process.env.TOPIC_ID) {
    const idx = topics.findIndex((t) => t.id === process.env.TOPIC_ID);
    if (idx === -1) throw new Error(`TOPIC_ID not found: ${process.env.TOPIC_ID}`);
    startIndex = idx;
    console.log(`TOPIC_ID set: starting at "${process.env.TOPIC_ID}" (index ${idx})`);
  }

  for (let i = 0; i < runCount; i++) {
    const topicIndex = (startIndex + i) % topics.length;
    const topic = topics[topicIndex];
    const scheduleTime = SCHEDULE_TIMES[i];
    const outDir = path.join(VIDEOS_DIR, `video_${i}`);
    fs.mkdirSync(outDir, { recursive: true });

    console.log(`\n[${i + 1}/${POSTS_PER_DAY}] Topic: ${topic.id} | Schedule: ${scheduleTime}`);

    try {
      // 1. Render
      const videoPath = await renderVideo(topic, i, outDir);

      // 2. Upload + schedule via Buffer
      const scheduledAt = israelTimeToUTC(scheduleTime, todayIsrael);
      await uploadAndSchedule(videoPath, topic.caption, scheduledAt);

      // 3. Delete local video to save disk
      fs.rmSync(outDir, { recursive: true, force: true });

      console.log(`  ✓ Done: ${topic.id} scheduled for ${scheduleTime} Israel time`);
    } catch (err) {
      console.error(`  ✗ Failed: ${topic.id} — ${err.message}`);
    }

    // Small pause between renders
    if (i < runCount - 1) await sleep(2000);
  }

  if (runCount < POSTS_PER_DAY) {
    console.log(`\n=== Test run done (${runCount} video(s)). State not updated. ===`);
    return;
  }

  // Save state
  state.nextIndex = (state.nextIndex + POSTS_PER_DAY) % topics.length;
  state.lastRunDate = todayIsrael;
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');

  console.log(`\n=== Done. Next run starts at topic index ${state.nextIndex} ===`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exitCode = 1;
});
