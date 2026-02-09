#!/usr/bin/env node
const net = require("net");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const SOCKET_PATH = process.env.PI_ANNOTATE_SOCKET_PATH || "/tmp/pi-annotate.sock";
const TOKEN_PATH = process.env.PI_ANNOTATE_TOKEN_PATH || "/tmp/pi-annotate.token";
const CONFIG_PATH = resolveConfigPath();
const TRANSPORT = resolveTransport();
const DEFAULT_TCP_PORT = 17311;
const MAX_NATIVE_MESSAGE_BYTES = 8 * 1024 * 1024; // 8MB
const MAX_SOCKET_BUFFER = 8 * 1024 * 1024; // 8MB
const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5MB
const LOG_FILE = path.join(os.tmpdir(), "pi-annotate-host.log");
const IS_TCP = TRANSPORT === "tcp";

process.umask(0o077);

function resolveTransport() {
  const override = (process.env.PI_ANNOTATE_TRANSPORT || "").toLowerCase();
  if (override === "tcp" || override === "unix") return override;
  if (process.platform === "win32") return "tcp";
  return "unix";
}

function resolveConfigPath() {
  if (process.env.PI_ANNOTATE_CONFIG_PATH) return process.env.PI_ANNOTATE_CONFIG_PATH;
  if (process.platform === "win32") {
    return path.join(os.homedir(), "pi-annotate.json");
  }
  return path.join(os.tmpdir(), "pi-annotate.json");
}

function rotateLogIfNeeded() {
  try {
    const stats = fs.statSync(LOG_FILE);
    if (stats.size > MAX_LOG_BYTES) {
      fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    }
  } catch (err) {
    if (process.env.PI_ANNOTATE_DEBUG) {
      console.error("[pi-annotate] log rotation failed:", err.message);
    }
  }
}

const log = (msg) => {
  rotateLogIfNeeded();
  fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
};

function safeUnlink(filePath, label) {
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if (err?.code !== "ENOENT") {
      log(`Failed to remove ${label}: ${err.message}`);
    }
  }
}

log(`Host starting... (transport=${TRANSPORT})`);

// Clean up old socket/config
if (!IS_TCP) {
  safeUnlink(SOCKET_PATH, "socket");
  safeUnlink(TOKEN_PATH, "token");
}

// Store connected pi client
let piSocket = null;
let piAuthed = false;
let server = null;

function createToken() {
  try {
    return crypto.randomBytes(32).toString("hex");
  } catch (err) {
    log(`Failed to create token: ${err.message}`);
    return null;
  }
}

function writeTokenFile(token) {
  try {
    fs.writeFileSync(TOKEN_PATH, token, { mode: 0o600 });
  } catch (err) {
    log(`Failed to write token: ${err.message}`);
  }
}

function writeConfigFile(token, port) {
  const payload = JSON.stringify({ transport: "tcp", token, port }, null, 2);
  try {
    fs.writeFileSync(CONFIG_PATH, payload, { mode: 0o600 });
    log(`Wrote config to ${CONFIG_PATH}`);
  } catch (err) {
    log(`Failed to write config at ${CONFIG_PATH}: ${err.message}`);
  }
}

const AUTH_TOKEN = createToken();
if (!AUTH_TOKEN) {
  log("No auth token generated; exiting");
  process.exit(1);
}

if (!IS_TCP) {
  writeTokenFile(AUTH_TOKEN);
}

// Native messaging I/O
let inputBuffer = Buffer.alloc(0);

function writeMessage(msg) {
  const json = JSON.stringify(msg);
  const len = Buffer.alloc(4);
  len.writeUInt32LE(json.length);
  process.stdout.write(len);
  process.stdout.write(json);
}

function processInput() {
  while (inputBuffer.length >= 4) {
    const len = inputBuffer.readUInt32LE(0);
    if (len > MAX_NATIVE_MESSAGE_BYTES) {
      log(`Native message too large: ${len}`);
      inputBuffer = Buffer.alloc(0);
      return;
    }
    if (inputBuffer.length < 4 + len) break;

    const json = inputBuffer.slice(4, 4 + len).toString();
    inputBuffer = inputBuffer.slice(4 + len);

    try {
      const msg = JSON.parse(json);
      handleExtensionMessage(msg);
    } catch (e) {
      log(`Parse error: ${e.message}`);
    }
  }
}

function redactForLog(msg) {
  return JSON.stringify(msg, (key, value) => {
    if (key === "screenshot") return "[redacted]";
    if (key === "screenshots") return Array.isArray(value) ? `[${value.length} screenshots]` : "[redacted]";
    if (key === "dataUrl") return "[redacted]";
    return value;
  });
}

// Messages from Chrome extension → forward to Pi
function handleExtensionMessage(msg) {
  log(`From extension: ${redactForLog(msg)}`);

  // Health check - respond immediately without forwarding
  if (msg?.type === "PING") {
    writeMessage({ type: "PONG", timestamp: Date.now() });
    return;
  }

  if (piSocket && !piSocket.destroyed) {
    piSocket.write(JSON.stringify(msg) + "\n");
  } else {
    log("No pi client connected, message dropped");
  }
}

process.stdin.on("readable", () => {
  let chunk;
  while ((chunk = process.stdin.read()) !== null) {
    inputBuffer = Buffer.concat([inputBuffer, chunk]);
    processInput();
  }
});

process.stdin.on("end", () => {
  log("Extension disconnected");
  cleanup();
});

function cleanup() {
  if (server) {
    try {
      server.close();
    } catch (err) {
      log(`Server close failed: ${err.message}`);
    }
  }
  if (!IS_TCP) {
    safeUnlink(SOCKET_PATH, "socket");
    safeUnlink(TOKEN_PATH, "token");
  }
  process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
process.on("uncaughtException", (err) => {
  log(`Uncaught exception: ${err.message}`);
  cleanup();
});

// Unix socket / TCP server for Pi extension
const serverHandler = (socket) => {
  log("Pi client connected");

  // If another Pi client is already connected, replace it
  if (piSocket && !piSocket.destroyed) {
    if (piAuthed) {
      log("Replacing existing authenticated Pi client");
      try {
        piSocket.write(JSON.stringify({
          type: "SESSION_REPLACED",
          reason: "Another terminal started annotation",
        }) + "\n");
      } catch (e) {
        log(`Error notifying old client: ${e.message}`);
      }
    } else {
      log("Replacing existing unauthenticated Pi client");
    }
    piSocket.destroy();
  }

  piSocket = socket;
  piAuthed = false;

  let buffer = "";

  socket.on("data", (data) => {
    buffer += data.toString();
    if (buffer.length > MAX_SOCKET_BUFFER) {
      log("Pi socket buffer overflow, closing connection");
      socket.destroy();
      buffer = "";
      return;
    }
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (!piAuthed) {
          if (msg?.type === "AUTH" && msg.token === AUTH_TOKEN) {
            piAuthed = true;
            log("Pi client authenticated");
          } else {
            log("Pi client authentication failed");
            socket.destroy();
            return;
          }
        } else {
          // Forward to Chrome extension
          log(`From Pi: ${redactForLog(msg)}`);
          writeMessage(msg);
        }
      } catch (e) {
        log(`Pi parse error: ${e.message}`);
      }
    }
  });

  socket.on("close", () => {
    log("Pi client disconnected");
    // Only clear if this is still the active socket (handles takeover race)
    if (piSocket === socket) {
      piSocket = null;
      piAuthed = false;
    }
  });

  socket.on("error", (e) => log(`Socket error: ${e.message}`));
};

if (IS_TCP) {
  const portEnv = process.env.PI_ANNOTATE_PORT;
  const portValue = portEnv ? Number(portEnv) : DEFAULT_TCP_PORT;
  const port = Number.isFinite(portValue) ? portValue : DEFAULT_TCP_PORT;

  server = net.createServer(serverHandler);
  server.on("error", (err) => {
    if (err?.code === "EADDRINUSE") {
      log(`Port ${port} in use; exiting without updating config.`);
      process.exit(1);
    }
    log(`Server error: ${err.message}`);
    cleanup();
  });
  server.listen(port, "0.0.0.0", () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    writeConfigFile(AUTH_TOKEN, actualPort);
    log(`Listening on tcp://0.0.0.0:${actualPort}`);
  });
} else {
  server = net.createServer(serverHandler);
  server.listen(SOCKET_PATH, () => {
    log(`Listening on ${SOCKET_PATH}`);
    try {
      fs.chmodSync(SOCKET_PATH, 0o600);
    } catch (err) {
      log(`Socket chmod failed: ${err.message}`);
    }
  });
}
