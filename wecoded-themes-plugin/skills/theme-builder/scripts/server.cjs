const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ========== WebSocket Protocol (RFC 6455) ==========

const OPCODES = { TEXT: 0x01, CLOSE: 0x08, PING: 0x09, PONG: 0x0A };
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function computeAcceptKey(clientKey) {
  return crypto.createHash('sha1').update(clientKey + WS_MAGIC).digest('base64');
}

function encodeFrame(opcode, payload) {
  const fin = 0x80;
  const len = payload.length;
  let header;

  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = fin | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = fin | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = fin | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  return Buffer.concat([header, payload]);
}

function decodeFrame(buffer) {
  if (buffer.length < 2) return null;

  const secondByte = buffer[1];
  const opcode = buffer[0] & 0x0F;
  const masked = (secondByte & 0x80) !== 0;
  let payloadLen = secondByte & 0x7F;
  let offset = 2;

  if (!masked) throw new Error('Client frames must be masked');

  if (payloadLen === 126) {
    if (buffer.length < 4) return null;
    payloadLen = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buffer.length < 10) return null;
    payloadLen = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }

  const maskOffset = offset;
  const dataOffset = offset + 4;
  const totalLen = dataOffset + payloadLen;
  if (buffer.length < totalLen) return null;

  const mask = buffer.slice(maskOffset, dataOffset);
  const data = Buffer.alloc(payloadLen);
  for (let i = 0; i < payloadLen; i++) {
    data[i] = buffer[dataOffset + i] ^ mask[i % 4];
  }

  return { opcode, payload: data, bytesConsumed: totalLen };
}

// ========== Configuration ==========

const PORT = process.env.BRAINSTORM_PORT || (49152 + Math.floor(Math.random() * 16383));
const HOST = process.env.BRAINSTORM_HOST || '127.0.0.1';
const URL_HOST = process.env.BRAINSTORM_URL_HOST || (HOST === '127.0.0.1' ? 'localhost' : HOST);
const SESSION_DIR = process.env.BRAINSTORM_DIR || '/tmp/brainstorm';
const CONTENT_DIR = path.join(SESSION_DIR, 'content');
const STATE_DIR = path.join(SESSION_DIR, 'state');
let ownerPid = process.env.BRAINSTORM_OWNER_PID ? Number(process.env.BRAINSTORM_OWNER_PID) : null;

// ========== Live preview ==========
//
// The Kit page can drive the REAL app's theme by writing the reserved
// `_preview` theme, which YouCoded watches and hot-switches to. This is the
// only write this server will ever perform outside its own session dir.
//
// PROJECT_DIR comes from an explicit env var set by start-server.sh, NOT by
// walking `..` up from SESSION_DIR — that would be three levels of implicit
// coupling to a path layout nobody would think to keep in sync.
const PROJECT_DIR = process.env.BRAINSTORM_PROJECT_DIR || null;
const PREVIEW_DIR = PROJECT_DIR ? path.join(PROJECT_DIR, '_preview') : null;
const PREVIEW_MANIFEST = PREVIEW_DIR ? path.join(PREVIEW_DIR, 'manifest.json') : null;
const MAX_PREVIEW_BYTES = 256 * 1024; // custom_css can be sizeable

// Writes are only accepted while the page has explicitly enabled live preview.
let previewEnabled = false;

/**
 * Remove the preview manifest, reverting the app to the user's own theme.
 *
 * Deletes ONLY manifest.json, never the _preview directory. Removing the
 * manifest is enough for the app to revert (its read fails and it falls back to
 * the pre-preview theme), while `_preview/assets/` survives — the final pack
 * build copies wallpapers and mascots out of there, so deleting the folder
 * would throw away generated art.
 */
function teardownPreview(reason) {
  previewEnabled = false;
  if (!PREVIEW_MANIFEST) return;
  try {
    if (fs.existsSync(PREVIEW_MANIFEST)) {
      fs.unlinkSync(PREVIEW_MANIFEST);
      console.log(JSON.stringify({ type: 'preview-torn-down', reason }));
    }
  } catch (e) {
    console.error('preview teardown failed:', e.message);
  }
}

const MIME_TYPES = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml'
};

// ========== Templates and Constants ==========

const WAITING_PAGE = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Brainstorm Companion</title>
<style>body { font-family: system-ui, sans-serif; padding: 2rem; max-width: 800px; margin: 0 auto; }
h1 { color: #333; } p { color: #666; }</style>
</head>
<body><h1>Brainstorm Companion</h1>
<p>Waiting for the agent to push a screen...</p></body></html>`;

const frameTemplate = fs.readFileSync(path.join(__dirname, 'frame-template.html'), 'utf-8');
const helperScript = fs.readFileSync(path.join(__dirname, 'helper.js'), 'utf-8');
const helperInjection = '<script>\n' + helperScript + '\n</script>';

// ========== Helper Functions ==========

function isFullDocument(html) {
  const trimmed = html.trimStart().toLowerCase();
  return trimmed.startsWith('<!doctype') || trimmed.startsWith('<html');
}

function wrapInFrame(content) {
  return frameTemplate.replace('<!-- CONTENT -->', content);
}

function getNewestScreen() {
  const files = fs.readdirSync(CONTENT_DIR)
    .filter(f => f.endsWith('.html'))
    .map(f => {
      const fp = path.join(CONTENT_DIR, f);
      return { path: fp, mtime: fs.statSync(fp).mtime.getTime() };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return files.length > 0 ? files[0].path : null;
}

// ========== HTTP Request Handler ==========

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

/**
 * Is this request same-origin? Browsers can't forge Origin, and any page in the
 * user's browser could otherwise POST to a known-ish localhost port. A missing
 * Origin is allowed because non-browser callers (curl, tests) don't send one and
 * can't be CSRF'd anyway.
 */
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const allowed = [
    `http://${URL_HOST}:${PORT}`,
    `http://127.0.0.1:${PORT}`,
    `http://localhost:${PORT}`,
  ];
  return allowed.includes(origin);
}

/**
 * POST /preview — write the reserved `_preview` manifest.
 *
 * Body: { enabled: true, manifest: {...} }  → write
 *       { enabled: false }                  → tear down
 *
 * There is deliberately NO path parameter: the destination is a fixed constant,
 * so there is nothing to sanitize and no traversal surface. Assets are not
 * accepted either — a manifest can only ever reference art Claude already wrote,
 * which keeps the assets-before-manifest ordering rule intact.
 */
function handlePreviewPost(req, res) {
  if (!PREVIEW_DIR) {
    return sendJson(res, 503, { ok: false, error: 'no preview dir (BRAINSTORM_PROJECT_DIR unset)' });
  }
  if (!originAllowed(req)) {
    return sendJson(res, 403, { ok: false, error: 'bad origin' });
  }
  // Reject non-JSON up front: form-encoded is the one content type a
  // cross-origin page can POST without a preflight.
  const ctype = String(req.headers['content-type'] || '');
  if (!ctype.toLowerCase().startsWith('application/json')) {
    return sendJson(res, 415, { ok: false, error: 'bad content-type' });
  }

  let size = 0;
  const chunks = [];
  let aborted = false;

  req.on('data', (chunk) => {
    if (aborted) return;
    size += chunk.length;
    // Enforce DURING streaming, not after buffering — otherwise the cap does
    // nothing to protect memory.
    if (size > MAX_PREVIEW_BYTES) {
      aborted = true;
      sendJson(res, 413, { ok: false, error: 'too large' });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', () => {
    if (aborted) return;
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: 'invalid json' });
    }

    if (body && body.enabled === false) {
      teardownPreview('disabled by page');
      return sendJson(res, 200, { ok: true, enabled: false });
    }

    const manifest = body && body.manifest;
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      return sendJson(res, 400, { ok: false, error: 'missing manifest' });
    }
    // The single highest-value check here. The app keys hot-reload off the
    // DIRECTORY name but resolves the theme by the manifest's internal slug; if
    // they disagree it silently falls back to the default theme and the whole
    // feature looks broken for reasons invisible to the user. Historically the
    // #1 failure mode of this skill — rejecting it here makes it impossible.
    if (manifest.slug !== '_preview') {
      return sendJson(res, 400, { ok: false, error: `bad slug "${manifest.slug}" (must be "_preview")` });
    }
    if (!manifest.tokens || typeof manifest.tokens !== 'object') {
      return sendJson(res, 400, { ok: false, error: 'missing tokens' });
    }

    try {
      fs.mkdirSync(PREVIEW_DIR, { recursive: true });
      // Atomic: write to a temp name then rename, so the app's watcher can
      // never observe a half-written manifest. `.tmp` is outside the watched
      // extension set, so it produces no spurious reload.
      const tmp = path.join(PREVIEW_DIR, '.manifest.json.tmp');
      const json = JSON.stringify(manifest, null, 2);
      fs.writeFileSync(tmp, json);
      fs.renameSync(tmp, PREVIEW_MANIFEST);
      previewEnabled = true;
      sendJson(res, 200, { ok: true, bytes: Buffer.byteLength(json) });
    } catch (e) {
      console.error('preview write failed:', e.message);
      sendJson(res, 500, { ok: false, error: 'write failed: ' + e.message });
    }
  });

  req.on('error', () => { aborted = true; });
}

function handleRequest(req, res) {
  touchActivity();
  // Method-gated: a GET /preview still 404s.
  if (req.method === 'POST' && req.url === '/preview') {
    // Refuse to expose a write endpoint on a non-loopback bind. --host 0.0.0.0
    // is a supported flag, and a LAN-reachable endpoint that writes to the
    // user's theme directory is not worth the niche remote-preview use case.
    if (HOST !== '127.0.0.1') {
      return sendJson(res, 403, { ok: false, error: 'preview endpoint disabled on non-loopback bind' });
    }
    return handlePreviewPost(req, res);
  }
  if (req.method === 'GET' && req.url === '/') {
    const screenFile = getNewestScreen();
    let html = screenFile
      ? (raw => isFullDocument(raw) ? raw : wrapInFrame(raw))(fs.readFileSync(screenFile, 'utf-8'))
      : WAITING_PAGE;

    if (html.includes('</body>')) {
      html = html.replace('</body>', helperInjection + '\n</body>');
    } else {
      html += helperInjection;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } else if (req.method === 'GET' && req.url.startsWith('/files/')) {
    const fileName = req.url.slice(7);
    const filePath = path.join(CONTENT_DIR, path.basename(fileName));
    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(fs.readFileSync(filePath));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
}

// ========== WebSocket Connection Handling ==========

const clients = new Set();

/**
 * Live preview must not outlive the page that's driving it — closing the tab
 * should hand the user's app back to their own theme.
 *
 * The catch: at the socket layer a RELOAD is indistinguishable from a CLOSE,
 * and this server broadcasts a reload on every content-dir change, so reloads
 * are frequent. Tearing down on the first disconnect would kill the preview
 * constantly. Instead the last disconnect starts a grace timer, which any
 * reconnecting client cancels. 3s comfortably covers a reload round-trip while
 * still feeling immediate when a tab really is closed.
 */
const PREVIEW_GRACE_MS = 3000;
let previewGraceTimer = null;

function cancelPreviewGrace() {
  if (previewGraceTimer) {
    clearTimeout(previewGraceTimer);
    previewGraceTimer = null;
  }
}

function onClientGone() {
  if (clients.size > 0 || !previewEnabled) return;
  cancelPreviewGrace();
  previewGraceTimer = setTimeout(() => {
    previewGraceTimer = null;
    if (clients.size === 0) teardownPreview('page closed');
  }, PREVIEW_GRACE_MS);
  previewGraceTimer.unref?.();
}

function handleUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }

  const accept = computeAcceptKey(key);
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );

  let buffer = Buffer.alloc(0);
  clients.add(socket);
  cancelPreviewGrace(); // a client arrived: that disconnect was a reload, not a close

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length > 0) {
      let result;
      try {
        result = decodeFrame(buffer);
      } catch (e) {
        socket.end(encodeFrame(OPCODES.CLOSE, Buffer.alloc(0)));
        clients.delete(socket);
        onClientGone();
        return;
      }
      if (!result) break;
      buffer = buffer.slice(result.bytesConsumed);

      switch (result.opcode) {
        case OPCODES.TEXT:
          handleMessage(result.payload.toString());
          break;
        case OPCODES.CLOSE:
          socket.end(encodeFrame(OPCODES.CLOSE, Buffer.alloc(0)));
          clients.delete(socket);
          onClientGone();
          return;
        case OPCODES.PING:
          socket.write(encodeFrame(OPCODES.PONG, result.payload));
          break;
        case OPCODES.PONG:
          break;
        default: {
          const closeBuf = Buffer.alloc(2);
          closeBuf.writeUInt16BE(1003);
          socket.end(encodeFrame(OPCODES.CLOSE, closeBuf));
          clients.delete(socket);
          onClientGone();
          return;
        }
      }
    }
  });

  /**
   * 'end' is the one that actually fires when a browser tab closes.
   *
   * The peer's FIN half-closes the connection: the server receives 'end' but
   * never closes its own side, so 'close' does NOT arrive (verified with a
   * minimal repro — 'end' fired, 'close' never did). Listening only for
   * 'close'/'error' meant a real tab close was invisible and the live preview
   * would have outlived the page that was driving it, which is exactly the
   * failure this teardown exists to prevent. Destroying here also produces the
   * 'close' event, so the handler below stays as a backstop.
   */
  socket.on('end', () => { clients.delete(socket); socket.destroy(); onClientGone(); });
  socket.on('close', () => { clients.delete(socket); onClientGone(); });
  socket.on('error', () => { clients.delete(socket); onClientGone(); });
}

function handleMessage(text) {
  let event;
  try {
    event = JSON.parse(text);
  } catch (e) {
    console.error('Failed to parse WebSocket message:', e.message);
    return;
  }
  touchActivity();
  console.log(JSON.stringify({ source: 'user-event', ...event }));
  if (event.choice) {
    const eventsFile = path.join(STATE_DIR, 'events');
    fs.appendFileSync(eventsFile, JSON.stringify(event) + '\n');
  }
}

function broadcast(msg) {
  const frame = encodeFrame(OPCODES.TEXT, Buffer.from(JSON.stringify(msg)));
  for (const socket of clients) {
    try { socket.write(frame); } catch (e) { clients.delete(socket); }
  }
}

// ========== Activity Tracking ==========

const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
let lastActivity = Date.now();

function touchActivity() {
  lastActivity = Date.now();
}

// ========== File Watching ==========

const debounceTimers = new Map();

// ========== Server Startup ==========

function startServer() {
  if (!fs.existsSync(CONTENT_DIR)) fs.mkdirSync(CONTENT_DIR, { recursive: true });
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });

  // Track known files to distinguish new screens from updates.
  // macOS fs.watch reports 'rename' for both new files and overwrites,
  // so we can't rely on eventType alone.
  const knownFiles = new Set(
    fs.readdirSync(CONTENT_DIR).filter(f => f.endsWith('.html'))
  );

  const server = http.createServer(handleRequest);
  server.on('upgrade', handleUpgrade);

  // Watch for HTML screens, CSS, and JS. HTML changes trigger the
  // screen-added/screen-updated log events (used by /theme-builder to
  // track when Claude has written a new concept page); CSS and JS
  // changes only trigger a client reload — they're staged assets
  // (theme-preview.css, mockup-render.js, helper.js), and when we iterate
  // on them during a session a live reload is much nicer than "save,
  // wait, manually refresh, repeat."
  const RELOAD_EXTS = /\.(html|css|js|json)$/i;
  const watcher = fs.watch(CONTENT_DIR, (eventType, filename) => {
    if (!filename || !RELOAD_EXTS.test(filename)) return;

    if (debounceTimers.has(filename)) clearTimeout(debounceTimers.get(filename));
    debounceTimers.set(filename, setTimeout(() => {
      debounceTimers.delete(filename);
      const filePath = path.join(CONTENT_DIR, filename);

      if (!fs.existsSync(filePath)) return; // file was deleted
      touchActivity();

      if (filename.endsWith('.html')) {
        if (!knownFiles.has(filename)) {
          knownFiles.add(filename);
          const eventsFile = path.join(STATE_DIR, 'events');
          if (fs.existsSync(eventsFile)) fs.unlinkSync(eventsFile);
          console.log(JSON.stringify({ type: 'screen-added', file: filePath }));
        } else {
          console.log(JSON.stringify({ type: 'screen-updated', file: filePath }));
        }
      } else {
        console.log(JSON.stringify({ type: 'asset-updated', file: filePath }));
      }

      broadcast({ type: 'reload' });
    }, 100));
  });
  watcher.on('error', (err) => console.error('fs.watch error:', err.message));

  function shutdown(reason) {
    console.log(JSON.stringify({ type: 'server-stopped', reason }));
    // Never leave the user's app stranded on a half-finished theme.
    teardownPreview('server shutdown: ' + reason);
    const infoFile = path.join(STATE_DIR, 'server-info');
    if (fs.existsSync(infoFile)) fs.unlinkSync(infoFile);
    fs.writeFileSync(
      path.join(STATE_DIR, 'server-stopped'),
      JSON.stringify({ reason, timestamp: Date.now() }) + '\n'
    );
    watcher.close();
    clearInterval(lifecycleCheck);
    // Destroy live sockets, and hard-exit if close() still hasn't called back.
    // server.close() waits for every connection to drain, and an open browser
    // tab holds one indefinitely — observed 2026-07-19: the server logged its
    // shutdown on idle timeout but the process stayed resident, listening to
    // nothing, because a tab was still attached.
    for (const socket of clients) { try { socket.destroy(); } catch (e) { /* already gone */ } }
    clients.clear();
    const hardExit = setTimeout(() => process.exit(0), 2000);
    hardExit.unref();
    server.close(() => process.exit(0));
  }

  function ownerAlive() {
    if (!ownerPid) return true;
    try { process.kill(ownerPid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
  }

  // Signals must tear the preview down too. Without these the process dies
  // immediately on SIGTERM/SIGINT — shutdown() was only ever reachable from the
  // lifecycle interval below — and a killed server would leave the user's app
  // stranded on a half-finished theme with nothing left running to revert it.
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(sig, () => shutdown('signal ' + sig));
  }
  // Last-resort backstop for exit paths that bypass shutdown() entirely
  // (uncaught throw, explicit process.exit elsewhere). Only sync work runs in
  // an 'exit' handler, and unlinkSync qualifies.
  process.on('exit', () => teardownPreview('process exit'));

  // Check every 60s: exit if owner process died or idle for 30 minutes
  const lifecycleCheck = setInterval(() => {
    if (!ownerAlive()) shutdown('owner process exited');
    else if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) shutdown('idle timeout');
  }, 60 * 1000);
  lifecycleCheck.unref();

  // Validate owner PID at startup. If it's already dead, the PID resolution
  // was wrong (common on WSL, Tailscale SSH, and cross-user scenarios).
  // Disable monitoring and rely on the idle timeout instead.
  if (ownerPid) {
    try { process.kill(ownerPid, 0); }
    catch (e) {
      if (e.code !== 'EPERM') {
        console.log(JSON.stringify({ type: 'owner-pid-invalid', pid: ownerPid, reason: 'dead at startup' }));
        ownerPid = null;
      }
    }
  }

  server.listen(PORT, HOST, () => {
    const info = JSON.stringify({
      type: 'server-started', port: Number(PORT), host: HOST,
      url_host: URL_HOST, url: 'http://' + URL_HOST + ':' + PORT,
      screen_dir: CONTENT_DIR, state_dir: STATE_DIR
    });
    console.log(info);
    fs.writeFileSync(path.join(STATE_DIR, 'server-info'), info + '\n');
  });
}

if (require.main === module) {
  startServer();
}

module.exports = { computeAcceptKey, encodeFrame, decodeFrame, OPCODES };
