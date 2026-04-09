const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const { google } = require('googleapis');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// Multer for ZIP uploads
const upload = multer({ dest: os.tmpdir() });

// In-memory job store
const jobs = {};

// ─── Health Check ────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ─── POST /render ─────────────────────────────────────────────────────────
app.post('/render', upload.single('zip'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'ZIP file required' });

  const jobId = uuidv4();
  const outputDir = path.join(os.tmpdir(), `job_output_${jobId}`);
  fs.mkdirSync(outputDir, { recursive: true });

  jobs[jobId] = { status: 'rendering', progress: 0, message: 'Starting...', outputDir };

  res.json({ jobId });

  // Render in background
  renderVideo(req.file.path, outputDir, jobId).catch(err => {
    jobs[jobId].status = 'error';
    jobs[jobId].error = err.message;
  });
});

// ─── GET /status/:jobId ───────────────────────────────────────────────────
app.get('/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// ─── GET /result/:jobId ───────────────────────────────────────────────────
app.get('/result/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job || job.status !== 'done') return res.status(404).json({ error: 'Video not ready' });
  res.sendFile(job.finalOutputPath);
});

// ─── POST /upload ─────────────────────────────────────────────────────────
app.post('/upload', async (req, res) => {
  const { jobId, clientId, clientSecret, publishAt } = req.body;
  const job = jobs[jobId];
  if (!job || job.status !== 'done') return res.status(400).json({ error: 'Video not ready' });

  try {
    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, 'http://localhost:3000');
    const tokenPath = path.join(os.tmpdir(), `yt_token_${Buffer.from(clientId).toString('base64').slice(0, 8)}.json`);

    if (!fs.existsSync(tokenPath)) {
      return res.status(401).json({ error: 'YouTube not authorized. Login from desktop app first.' });
    }

    oauth2Client.setCredentials(JSON.parse(fs.readFileSync(tokenPath)));
    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

    const status = publishAt
      ? { privacyStatus: 'private', publishAt, selfDeclaredMadeForKids: false }
      : { privacyStatus: 'public', selfDeclaredMadeForKids: false };

    const result = await youtube.videos.insert({
      part: 'snippet,status',
      requestBody: {
        snippet: {
          title: job.metadata?.title || 'AI Shorts',
          description: job.metadata?.description || '',
          tags: (job.metadata?.tags || '').split(',').map(t => t.trim()),
          categoryId: '24',
        },
        status,
      },
      media: { body: fs.createReadStream(job.finalOutputPath) },
    });

    res.json({ success: true, url: `https://www.youtube.com/watch?v=${result.data.id}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Render Engine ────────────────────────────────────────────────────────
async function renderVideo(zipPath, outputDir, jobId) {
  const update = (progress, message) => {
    jobs[jobId] = { ...jobs[jobId], progress, message };
    console.log(`[${jobId}] ${progress}% - ${message}`);
  };

  update(5, 'Extracting ZIP...');
  const tempDir = path.join(os.tmpdir(), `render_temp_${jobId}`);
  fs.mkdirSync(tempDir, { recursive: true });

  const zip = new AdmZip(zipPath);
  zip.extractAllTo(tempDir, true);

  const scriptPath = path.join(tempDir, 'script.json');
  if (!fs.existsSync(scriptPath)) throw new Error('script.json not found in ZIP');

  const scriptData = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
  const segments = scriptData.segments || [];
  if (!segments.length) throw new Error('No segments found');

  update(10, 'Analyzing audio...');

  // Check for single voice file
  const singleVoicePath = path.join(tempDir, 'voice.mp3');
  let hasSingleVoice = false;
  let singleVoiceDuration = 0;
  if (fs.existsSync(singleVoicePath)) {
    try {
      singleVoiceDuration = await getAudioDuration(singleVoicePath);
      hasSingleVoice = true;
    } catch (e) {}
  }

  // Build segment info
  const segmentData = [];
  let totalDuration = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const imagePath = path.join(tempDir, seg.imageFile || `${i}.png`);
    let duration = hasSingleVoice ? singleVoiceDuration / segments.length : 5;
    let audioPath = null;

    if (!hasSingleVoice) {
      for (const ext of ['.wav', '.mp3', '.m4a']) {
        const p = path.join(tempDir, `voice_seg_${i}${ext}`);
        if (fs.existsSync(p)) { audioPath = p; break; }
      }
      if (audioPath) {
        try { duration = await getAudioDuration(audioPath); } catch (e) {}
      } else {
        audioPath = path.join(tempDir, `silence_${i}.wav`);
        await runFFmpeg(['-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', String(duration), '-c:a', 'pcm_s16le', audioPath]);
      }
    }

    segmentData.push({ imagePath, audioPath, duration, text: seg.text || '' });
    totalDuration += duration;
  }

  // Pass 1: Build clips
  const clipPaths = [];
  for (let i = 0; i < segmentData.length; i++) {
    const seg = segmentData[i];
    update(15 + Math.round((i / segmentData.length) * 35), `Building clip ${i + 1}/${segmentData.length}...`);
    const clipPath = path.join(tempDir, `clip_${i}.mp4`);
    clipPaths.push(clipPath);

    const fps = 25;
    const frames = Math.max(Math.round(seg.duration * fps), 1);
    const args = ['-y', '-loop', '1', '-i', seg.imagePath];

    if (hasSingleVoice) {
      const startTime = segmentData.slice(0, i).reduce((s, d) => s + d.duration, 0);
      args.push('-ss', String(startTime), '-t', String(seg.duration), '-i', singleVoicePath);
    } else {
      args.push('-i', seg.audioPath);
    }

    // Lightweight filter for cloud server (no 2K upscale to save RAM)
    const vf = `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,zoompan=z='zoom+0.001':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1080x1920:fps=${fps}[vout]`;
    const af = `aformat=sample_rates=44100:channel_layouts=stereo[aout]`;
    args.push('-filter_complex', `[0:v]${vf}; [1:a]${af}`);
    args.push('-map', '[vout]', '-map', '[aout]', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-shortest', '-t', String(seg.duration), clipPath);
    await runFFmpeg(args);
  }

  // Pass 2: Transitions
  update(55, 'Merging clips with transitions...');
  const concatPath = path.join(tempDir, 'concat.mp4');
  if (clipPaths.length === 1) {
    fs.copyFileSync(clipPaths[0], concatPath);
  } else {
    const transDur = 0.3;
    const transitions = ['fade', 'dissolve', 'slideleft', 'slideright'];
    let lastV = '[0:v]', lastA = '[0:a]', filterStr = '';
    let offset = segmentData[0].duration - transDur;
    const inputArgs = [];
    for (let i = 0; i < clipPaths.length; i++) inputArgs.push('-i', clipPaths[i]);
    for (let i = 1; i < clipPaths.length; i++) {
      const trans = transitions[Math.floor(Math.random() * transitions.length)];
      filterStr += `${lastV}[${i}:v]xfade=transition=${trans}:duration=${transDur}:offset=${offset.toFixed(3)}[v${i}out];`;
      filterStr += `${lastA}[${i}:a]acrossfade=d=${transDur}[a${i}out];`;
      lastV = `[v${i}out]`; lastA = `[a${i}out]`;
      offset += (segmentData[i].duration - transDur);
    }
    await runFFmpeg(['-y', ...inputArgs, '-filter_complex', filterStr, '-map', lastV, '-map', lastA, '-c:v', 'libx264', '-preset', 'fast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', concatPath]);
  }

  // Subtitles
  update(75, 'Generating subtitles...');
  const transDur = 0.3;
  const finalDuration = totalDuration - ((clipPaths.length - 1) * transDur);
  let assContent = `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,80,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,3,2,2,5,10,10,250,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  let currT = 0;
  for (let i = 0; i < segmentData.length; i++) {
    const { text, duration } = segmentData[i];
    const words = text.split(/\s+/).filter(w => w);
    if (words.length) {
      const wDur = duration / words.length;
      for (let w = 0; w < words.length; w++) {
        const s = currT + w * wDur, e = s + wDur;
        const line = words.map((wd, j) => j === w ? `{\\c&H47E0FD&}${wd}{\\r}` : wd).join(' ');
        assContent += `Dialogue: 0,${fmtTime(s)},${fmtTime(e)},Default,,0,0,0,,${line}\n`;
      }
    }
    currT += (duration - transDur);
  }
  const assFile = path.join(tempDir, 'subs.ass');
  fs.writeFileSync(assFile, assContent, 'utf8');
  const assEsc = assFile.replace(/\\/g, '/').replace(/:/g, '\\:');

  // Pass 3: Final (Subtitles only - stable)
  const finalPath = path.join(outputDir, 'output.mp4');
  const mainFilter = `[0:v]ass='${assEsc}'[vfinal]`;

  await runFFmpeg(['-y', '-i', concatPath, '-filter_complex', mainFilter, '-map', '[vfinal]', '-map', '0:a', '-c:v', 'libx264', '-preset', 'fast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', finalPath]);

  // Cleanup
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.rmSync(zipPath, { force: true });

  jobs[jobId] = { ...jobs[jobId], status: 'done', progress: 100, message: 'Done!', finalOutputPath: finalPath, metadata: { title: scriptData.title || 'AI Shorts', description: scriptData.description || '', tags: scriptData.tags || '' } };
}

// Helpers
function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg code ${code}: ${stderr.slice(-300)}`)));
    proc.on('error', reject);
  });
}

function getAudioDuration(fp) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', fp]);
    let out = '';
    p.stdout.on('data', d => out += d);
    p.on('close', code => {
      const dur = parseFloat(out.trim());
      (!isNaN(dur) && dur > 0) ? resolve(dur) : reject(new Error('Bad duration'));
    });
  });
}

function fmtTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60), cs = Math.floor((s % 1) * 100);
  return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}.${String(cs).padStart(2,'0')}`;
}

app.listen(PORT, () => console.log(`🚀 ZIP-to-Video Backend running on port ${PORT}`));
