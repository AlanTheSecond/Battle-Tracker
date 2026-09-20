// pairing.js
//
// The transport for pairing with Initiative Tracker. See Initiative
// Tracker's pairing.js for the fuller explanation of the design - the
// short version: IT listens, BT connects, newline-delimited JSON,
// handshake only for now. This file is the client half.
//
// Battle Tracker retries on a timer whenever it isn't connected,
// since there's no way to know when IT will be launched relative to
// BT - the DM might open either one first, or restart one mid-session.

const net = require('net');

const PAIRING_PORT = 47932;
const PAIRING_HOST = '127.0.0.1';
const APP_ID = 'battle-tracker';
const EXPECTED_PEER_ID = 'initiative-tracker';
const RETRY_DELAY_MS = 3000;

let socket = null;
let connected = false;
let connecting = false;
let retryTimer = null;
let sendStatus = () => {}; // wired up by startPairing
let getVersion = () => '0.0.0';
let onPeerMessage = () => {}; // wired up by startPairing - anything past hello-ack

function setConnected(value) {
  if (connected === value) return;
  connected = value;
  sendStatus(connected);
}

function attachLineParser(sock, onMessage) {
  let buffer = '';
  sock.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (!line.trim()) continue;
      try {
        onMessage(JSON.parse(line));
      } catch (err) {
        // Malformed line - ignore rather than crash the connection.
      }
    }
  });
}

function writeMessage(sock, obj) {
  sock.write(JSON.stringify(obj) + '\n');
}

function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    attemptConnect();
  }, RETRY_DELAY_MS);
}

function attemptConnect() {
  if (connecting || connected) return;
  connecting = true;

  socket = net.createConnection({ host: PAIRING_HOST, port: PAIRING_PORT });

  socket.on('connect', () => {
    writeMessage(socket, { type: 'hello', app: APP_ID, version: getVersion() });
  });

  attachLineParser(socket, (msg) => {
    if (msg.type === 'hello-ack' && msg.app === EXPECTED_PEER_ID) {
      connecting = false;
      setConnected(true);
      return;
    }
    // Everything past the handshake - Initiative Tracker's Bestiary
    // pushing itself over (bestiary-sync) or reporting that BT should
    // take focus back (remote-menu-closed). Only meaningful once
    // actually connected, but a stray message before that shouldn't be
    // possible given IT only starts sending after its own hello-ack.
    onPeerMessage(msg);
  });

  socket.on('close', () => {
    connecting = false;
    socket = null;
    setConnected(false);
    scheduleRetry();
  });

  // Almost always ECONNREFUSED because Initiative Tracker isn't
  // running (or hasn't started listening yet) - completely expected
  // in normal use, not worth logging on every retry tick. 'close'
  // fires right after this and is what actually schedules the retry.
  socket.on('error', () => {});
}

function startPairing(getAppVersion, onStatusChange, onMessage) {
  sendStatus = onStatusChange;
  getVersion = getAppVersion;
  onPeerMessage = onMessage || (() => {});
  attemptConnect();
}

function getConnectionStatus() {
  return { connected };
}

// A no-op whenever not actually connected - callers don't need their
// own "am I paired" guard before using this.
function sendToPeer(obj) {
  if (connected && socket) writeMessage(socket, obj);
}

function stopPairing() {
  if (retryTimer) clearTimeout(retryTimer);
  if (socket) socket.destroy();
}

module.exports = { startPairing, stopPairing, getConnectionStatus, sendToPeer };
