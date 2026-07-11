/*
 * render_video.js — builds a 60-second vertical video for @charisma.il:
 *   English ElevenLabs voiceover + Hebrew subtitles (Arial Bold) + Pixabay clips
 *   that switch exactly when the subtitle changes + a fixed CTA at the end.
 *
 * Usage:  node render_video.js <content.json>
 *
 * content.json:
 * {
 *   "outDir": "C:/Users/2pac4/Charsima/Video 1",
 *   "voiceId": "pNInz6obpgDQGcFmaJgB",           // optional (default Adam)
 *   "segments": [
 *     { "en": "English narration line.", "he": "כתובית בעברית.", "query": "stock clip search" },
 *     ...
 *   ],
 *   "cta": { "en": "Comment ...", "he": "תגיבו \"אני\" ...", "query": "sunrise success" }
 * }
 *
 * Needs: ffmpeg/ffprobe (found automatically), ElevenLabs key, Pixabay key.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

// Free Microsoft Edge neural TTS -> writes mp3, returns word timings [{t,d} in seconds].
function edgeTTS(text, voice, outPath) {
  return new Promise((resolve, reject) => {
    (async () => {
      const tts = new MsEdgeTTS();
      await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, { wordBoundaryEnabled: true, sentenceBoundaryEnabled: false });
      const { audioStream, metadataStream } = tts.toStream(text);
      const out = fs.createWriteStream(outPath);
      const words = [];
      audioStream.on('data', (c) => out.write(c));
      metadataStream.on('data', (chunk) => {
        try {
          const m = JSON.parse(chunk.toString());
          for (const b of (m.Metadata || [])) {
            if (b.Type === 'WordBoundary') words.push({ t: b.Data.Offset / 1e7, d: b.Data.Duration / 1e7 });
          }
        } catch (e) {}
      });
      audioStream.on('end', () => { out.end(); out.on('finish', () => resolve(words)); });
      audioStream.on('error', reject);
    })().catch(reject);
  });
}

const CONTENT_PATH = process.argv[2];
if (!CONTENT_PATH) { console.error('Usage: node render_video.js <content.json>'); process.exit(1); }
const C = JSON.parse(fs.readFileSync(CONTENT_PATH, 'utf8'));

const EL_KEY = process.env.ELEVENLABS_KEY || 'YOUR_ELEVENLABS_KEY_OPTIONAL';
const PIXABAY_KEY = process.env.PIXABAY_KEY || 'YOUR_PIXABAY_KEY';
const VOICE = C.voice || 'en-US-AndrewNeural';    // free Edge neural voice, English male
let TOTAL = 60.0;                                       // video length (seconds); set adaptively below
const W = 1080, H = 1920, FPS = 30;

const OUT_DIR = C.outDir;
if (!OUT_DIR) { console.error('content.json needs "outDir"'); process.exit(1); }
const WORK = path.join(OUT_DIR, '.work');

// ---- locate ffmpeg / ffprobe ----
function findBin(name) {
  try { execFileSync(name, ['-version'], { stdio: 'ignore' }); return name; } catch (e) {}
  const roots = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft/WinGet/Packages') : null,
    'C:/Program Files', 'C:/ffmpeg',
  ].filter(Boolean);
  for (const r of roots) {
    let found = null;
    (function walk(d, depth) {
      if (found || depth > 5 || !fs.existsSync(d)) return;
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
      for (const e of entries) {
        if (found) return;
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (e.name.toLowerCase() === name + '.exe') found = p;
      }
    })(r, 0);
    if (found) return found;
  }
  throw new Error('Could not find ' + name);
}
const FFMPEG = process.env.FFMPEG_PATH || findBin('ffmpeg');
const FFPROBE = process.env.FFMPEG_PATH ? process.env.FFMPEG_PATH.replace('ffmpeg', 'ffprobe') : findBin('ffprobe');

// ---- tiny http helpers ----
function reqJSON(opts, bodyBuf) {
  return new Promise((resolve, reject) => {
    const r = https.request(opts, (res) => {
      let d = [];
      res.on('data', (c) => d.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(d) }));
    });
    r.on('error', reject);
    if (bodyBuf) r.write(bodyBuf);
    r.end();
  });
}
function getBuf(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return getBuf(res.headers.location).then(resolve, reject);
      }
      let d = [];
      res.on('data', (c) => d.push(c));
      res.on('end', () => resolve(Buffer.concat(d)));
    }).on('error', reject);
  });
}
function ff(args, cwd) { execFileSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { cwd, stdio: 'inherit' }); }
function probeDur(file) {
  const out = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim();
  return parseFloat(out);
}
function tc(sec) {
  if (sec < 0) sec = 0;
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = (sec % 60);
  return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

// Generates a short, calm procedural melody loop (pentatonic scale, random root and
// note pattern per video) so there's no licensing concern and each render sounds a
// little different. Each note is a warm plucked tone (fundamental + 2 soft harmonics)
// with a natural exponential decay, and notes overlap slightly (like a kalimba/music
// box) instead of a harsh sine beeping on and off. Rendered quiet under the narration
// later in the pipeline.
function generateMelody(durationSec, outPath) {
  const roots = [130.81, 146.83, 164.81, 174.61, 196.00]; // C3, D3, E3, F3, G3
  const ratios = [1, 9 / 8, 5 / 4, 3 / 2, 5 / 3, 2]; // major pentatonic + octave
  const root = roots[Math.floor(Math.random() * roots.length)];
  const scale = ratios.map((r) => root * r);
  const gapChoices = [0.55, 0.65, 0.75, 0.85];
  const ringDur = 1.8; // seconds each note rings out for (notes overlap the next one)

  const notes = [];
  for (let t = 0; t < durationSec; ) {
    const freq = scale[Math.floor(Math.random() * scale.length)];
    notes.push({ freq, onset: t });
    t += gapChoices[Math.floor(Math.random() * gapChoices.length)];
  }

  const inputs = [];
  const delayParts = [];
  notes.forEach((n, i) => {
    const expr = `(sin(2*PI*${n.freq.toFixed(2)}*t)+0.3*sin(2*PI*${(n.freq * 2).toFixed(2)}*t)+0.15*sin(2*PI*${(n.freq * 3).toFixed(2)}*t))*exp(-2.2*t)*0.5`;
    inputs.push('-f', 'lavfi', '-i', `aevalsrc=exprs='${expr}':s=44100:d=${ringDur}`);
    const delayMs = Math.round(n.onset * 1000);
    delayParts.push(`[${i}:a]adelay=delays=${delayMs}:all=1[d${i}]`);
  });
  const mixInputs = notes.map((_, i) => `[d${i}]`).join('');
  const filterComplex = `${delayParts.join(';')};${mixInputs}amix=inputs=${notes.length}:duration=longest:normalize=0,alimiter=limit=0.9,lowpass=f=6000[raw]`;
  ff([...inputs, '-filter_complex', filterComplex, '-map', '[raw]', '-ac', '2', '-c:a', 'libmp3lame', outPath]);
}

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  const segs = [...C.segments, C.cta];

  // 1) build full English text + char offsets per segment
  let offset = 0; const parts = [];
  segs.forEach((s, i) => { s._cs = offset; s._ce = offset + s.en.length; offset += s.en.length; if (i < segs.length - 1) offset += 1; parts.push(s.en); });
  const fullText = parts.join(' ');

  // 2) Free Microsoft Edge neural TTS with word boundaries (cached by script text)
  const textHash = crypto.createHash('md5').update(fullText + '|' + VOICE).digest('hex');
  const voicePath = path.join(WORK, 'voice.mp3');
  const timingPath = path.join(WORK, 'timing.json');
  let words;
  const cachedTiming = fs.existsSync(voicePath) && fs.existsSync(timingPath) ? JSON.parse(fs.readFileSync(timingPath, 'utf8')) : null;
  if (cachedTiming && cachedTiming.hash === textHash && cachedTiming.words) {
    words = cachedTiming.words;
    console.log('Reusing cached voiceover.');
  } else {
    console.log('Generating voiceover (Edge Neural TTS, free)...');
    words = await edgeTTS(fullText, VOICE, voicePath);
    fs.writeFileSync(timingPath, JSON.stringify({ hash: textHash, words }));
  }

  // map each segment to its words -> speech start/end times
  segs.forEach((s) => { s._wc = s.en.trim().split(/\s+/).filter(Boolean).length; });
  let _wi = 0;
  segs.forEach((s) => {
    const start = words[Math.min(_wi, words.length - 1)];
    const end = words[Math.min(_wi + s._wc - 1, words.length - 1)];
    s.tstart = start ? start.t : 0;
    s.tend = end ? (end.t + end.d) : (s.tstart + 0.8);
    _wi += s._wc;
  });

  const voiceDur = probeDur(voicePath);
  // Adaptive length: end ~2.4s after the narration so there is no dead hold at the
  // end. Pass "totalSeconds" in the content JSON to force a fixed length instead.
  TOTAL = C.totalSeconds || Math.round((voiceDur + 2.4) * 100) / 100;

  // contiguous boundaries: clip/subtitle i runs from its start to the NEXT one's start (last -> TOTAL)
  segs.forEach((s, i) => { s.dstart = (i === 0) ? 0 : s.tstart; s.dend = (i < segs.length - 1) ? segs[i + 1].tstart : TOTAL; });

  console.log(`Voiceover ${voiceDur.toFixed(2)}s; video length ${TOTAL.toFixed(2)}s across ${segs.length} segments.`);

  // 2b) background music bed — always on. Uses an explicit C.musicFile override if
  // given; otherwise always generates a calm procedural melody (random scale/pattern
  // per video, so consecutive videos don't sound identical). Mixed quietly under the
  // narration later in the pipeline.
  const bgPath = path.join(WORK, 'bg.mp3');
  if (C.musicFile && fs.existsSync(C.musicFile)) {
    fs.copyFileSync(C.musicFile, bgPath);
    console.log('Using provided background music file.');
  } else {
    generateMelody(TOTAL + 1, bgPath);
    console.log('Generated calm background melody.');
  }

  // 3) fetch a Pixabay clip per segment, normalize to its exact duration
  console.log('Fetching clips + building segments...');
  const listLines = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const dur = Math.max(0.6, s.dend - s.dstart);
    const seg = path.join(WORK, `seg${String(i).padStart(2, '0')}.mp4`);
    const keyPath = seg + '.key';
    const key = s.query + '|' + dur.toFixed(3);
    listLines.push(`file '${path.basename(seg)}'`);
    if (fs.existsSync(seg) && fs.existsSync(keyPath) && fs.readFileSync(keyPath, 'utf8') === key) {
      console.log(`  seg ${i + 1}/${segs.length} cached`);
      continue;
    }
    const api = `https://pixabay.com/api/videos/?key=${PIXABAY_KEY}&q=${encodeURIComponent(s.query)}&per_page=50&safesearch=true`;
    const data = JSON.parse((await getBuf(api)).toString());
    const hits = data.hits || [];
    if (!hits.length) throw new Error('No Pixabay video for: ' + s.query);
    // pick the hit whose tags best match the query words (most relevant, not just first)
    const words = s.query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    let hit = hits[0], bestScore = -1;
    for (const h of hits) {
      const tags = (h.tags || '').toLowerCase();
      const score = words.reduce((a, w) => a + (tags.includes(w) ? 1 : 0), 0);
      if (score > bestScore) { bestScore = score; hit = h; }
    }
    const v = hit.videos.large || hit.videos.medium || hit.videos.small;
    const raw = path.join(WORK, `raw${i}.mp4`);
    fs.writeFileSync(raw, await getBuf(v.url));
    // slow Ken Burns zoom, alternating in / out per clip for variety
    const bigW = Math.round(W * 1.25), bigH = Math.round(H * 1.25);
    const zExpr = (i % 2 === 0) ? 'min(1.0+0.0014*on,1.25)' : 'max(1.25-0.0014*on,1.0)';
    ff(['-stream_loop', '-1', '-i', raw, '-t', dur.toFixed(3),
      '-vf', `scale=${bigW}:${bigH}:force_original_aspect_ratio=increase,crop=${bigW}:${bigH},` +
        `zoompan=z='${zExpr}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${FPS},setsar=1,format=yuv420p`,
      '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', seg]);
    fs.writeFileSync(keyPath, key);
    console.log(`  seg ${i + 1}/${segs.length} "${s.query}" -> ${dur.toFixed(2)}s`);
  }

  // 4) concat the silent video track
  fs.writeFileSync(path.join(WORK, 'list.txt'), listLines.join('\n'));
  ff(['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', 'novoice.mp4'], WORK);

  // 5) subtitles (ASS, Arial Bold) — one entry per segment, timed to the clip changes
  const ASSETS = path.join(__dirname, '..', 'assets');
  const hasLogo = fs.existsSync(path.join(ASSETS, 'logo_circle.png'));
  if (hasLogo) fs.copyFileSync(path.join(ASSETS, 'logo_circle.png'), path.join(WORK, 'logo_circle.png'));
  for (const f of ['arialbd.ttf', 'arial.ttf', 'seguiemj.ttf']) { const s = path.join('C:/Windows/Fonts', f); if (fs.existsSync(s)) fs.copyFileSync(s, path.join(WORK, f)); }

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Def,Arial,68,&H00FFFFFF,&H9EFFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,4,2,5,120,120,0,1
Style: Brand,Arial,40,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,3,1,8,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  // eye-catching captions: centered, pop-in (fade + scale) on each subtitle
  // exact screen center (H/2 = 960), \an5 middle anchor, quick fade-in.
  // Always a single physical line of 4-6 words: each segment's sentence is split into
  // word chunks (never more than 6 words, only fewer if the sentence is short) that
  // are shown one after another across the segment's time window.
  const lead = (extra) => `{\\an5\\pos(540,960)\\fad(120,60)${extra || ''}}`;
  // emoji don't render in color in libass, so strip them from the burned text and
  // overlay a real color emoji image separately (see the final mux below).
  const stripEmoji = (t) => t.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '');
  const oneLine = (t) => stripEmoji(t).replace(/\n+/g, ' ').replace(/[ \t]+/g, ' ').trim();
  const rtl = (t) => '‫' + t + '‬';
  const DEF_FONT = 68;
  const SAFE_W = W - 240; // Def style MarginL(120) + MarginR(120)
  const CHAR_RATIO = 0.53; // empirical avg glyph width / fontSize for Arial Bold Hebrew
  const fitFontSize = (text) => {
    const est = text.length * CHAR_RATIO * DEF_FONT;
    if (est <= SAFE_W) return DEF_FONT;
    return Math.max(30, Math.floor(SAFE_W / (text.length * CHAR_RATIO)));
  };
  // splits words into groups of at most `max` words, sized as evenly as possible
  // (so a 10-word sentence becomes 5+5, a 13-word sentence becomes 5+4+4, etc.)
  const MIN_WORDS = 4, MAX_WORDS = 6;
  const chunkWords = (words) => {
    const n = words.length;
    if (n === 0) return [];
    if (n <= MAX_WORDS) return [words];
    const numChunks = Math.ceil(n / MAX_WORDS);
    const base = Math.floor(n / numChunks), rem = n % numChunks;
    const chunks = [];
    let idx = 0;
    for (let i = 0; i < numChunks; i++) {
      const size = base + (i < rem ? 1 : 0);
      chunks.push(words.slice(idx, idx + size));
      idx += size;
    }
    return chunks;
  };
  segs.forEach((s) => {
    const words = oneLine(s.he).split(' ').filter(Boolean);
    const chunks = chunkWords(words);
    const totalWords = words.length || 1;
    const segDur = s.dend - s.dstart;
    let t = s.dstart;
    s._chunks = chunks.map((chunk) => {
      const text = chunk.join(' ');
      const dur = segDur * (chunk.length / totalWords);
      const start = t, end = t + dur;
      t = end;
      return { text, start, end };
    });
  });
  const capEv = segs.flatMap((s) => s._chunks.map((c) => {
    const size = fitFontSize(c.text);
    const sizeTag = size < DEF_FONT ? `\\fs${size}` : '';
    return `Dialogue: 0,${tc(c.start)},${tc(c.end)},Def,,0,0,0,,${lead(sizeTag)}${rtl(c.text)}`;
  })).join('\n');
  // color 👇 emoji overlay during the CTA (last segment), if present
  const ctaSeg = segs[segs.length - 1];
  const hasPointEmoji = /\u{1F447}/u.test(ctaSeg.he || '') && fs.existsSync(path.join(ASSETS, 'emoji_point_down.png'));
  let ctaStart = ctaSeg.dstart;
  const emojiSize = 74;
  let emX = 0, emY = 0;
  if (hasPointEmoji) {
    fs.copyFileSync(path.join(ASSETS, 'emoji_point_down.png'), path.join(WORK, 'emoji.png'));
    // place the emoji just past the (left/RTL) end of the CTA's last word chunk
    const lastChunk = ctaSeg._chunks[ctaSeg._chunks.length - 1];
    ctaStart = lastChunk.start;
    const ctaSize = fitFontSize(lastChunk.text);
    const estW = lastChunk.text.length * ctaSize * CHAR_RATIO;
    emX = Math.round((540 - estW / 2) - 8 - emojiSize); // emoji right edge sits just left of the line (RTL end)
    emY = 960 - Math.round(emojiSize / 2);               // single line is vertically centered on the \pos anchor
  }
  // consistent branding: the handle sits under the logo, on screen the whole time
  const brandEv = `Dialogue: 0,${tc(0)},${tc(TOTAL)},Brand,,0,0,0,,{\\an8\\pos(540,1705)}@legacy.israel`;
  fs.writeFileSync(path.join(WORK, 'subs.ass'), header + brandEv + '\n' + capEv + '\n', 'utf8');

  // 6) final mux: logo watermark + burned captions + color CTA emoji + voice + music
  console.log('Rendering final video...');
  const hasBg = fs.existsSync(path.join(WORK, 'bg.mp3'));
  const inputs = ['-i', 'novoice.mp4', '-i', 'voice.mp3'];
  let nextIdx = 2;
  let logoIdx = -1;
  if (hasLogo) { inputs.push('-loop', '1', '-i', 'logo_circle.png'); logoIdx = nextIdx++; }
  let audioFc;
  if (hasBg) {
    const bgIdx = nextIdx++;
    inputs.push('-stream_loop', '-1', '-i', 'bg.mp3');
    audioFc = '[1:a]apad,volume=1.0[voice];' +
      `[${bgIdx}:a]loudnorm=I=-28,afade=t=in:st=0:d=2,afade=t=out:st=${(TOTAL - 3).toFixed(2)}:d=3[bg];` +
      '[voice][bg]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[a]';
  } else {
    audioFc = '[1:a]apad[a]';
  }
  let vidFc = '[0:v]drawbox=x=0:y=0:w=iw:h=ih:color=black@0.25:t=fill,ass=subs.ass:fontsdir=.[vs];';
  if (hasLogo) {
    vidFc += `[${logoIdx}:v]scale=175:175[lg];[vs][lg]overlay=(W-w)/2:1510[vv];`;
  } else {
    vidFc += '[vs]null[vv];';
  }
  if (hasPointEmoji) {
    const emIdx = nextIdx++;
    inputs.push('-i', 'emoji.png');
    vidFc += `[${emIdx}:v]scale=${emojiSize}:${emojiSize}[em];[vv][em]overlay=${emX}:${emY}:enable='between(t,${ctaStart.toFixed(2)},${TOTAL.toFixed(2)})'[v];`;
  } else {
    vidFc += '[vv]null[v];';
  }
  ff([...inputs, '-filter_complex', vidFc + audioFc, '-map', '[v]', '-map', '[a]', '-t', String(TOTAL),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '176k', '-r', String(FPS), 'final.mp4'], WORK);

  const outFile = path.join(OUT_DIR, 'video.mp4');
  fs.copyFileSync(path.join(WORK, 'final.mp4'), outFile);
  console.log('DONE -> ' + outFile + ' (' + probeDur(outFile).toFixed(2) + 's)');
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
