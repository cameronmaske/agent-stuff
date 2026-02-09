// Pi Annotate - Popup Script

const extId = chrome.runtime.id;
const platform = navigator.platform.toUpperCase();
const isMac = platform.includes('MAC');
const isWindows = platform.includes('WIN');
const installCmd = isWindows
  ? `powershell -ExecutionPolicy Bypass -File install.ps1 ${extId}`
  : `./install.sh ${extId}`;

// Elements
const extIdInput = document.getElementById('ext-id');
const installCmdInput = document.getElementById('install-cmd');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const setupSection = document.getElementById('setup-section');
const readySection = document.getElementById('ready-section');
const troubleSection = document.getElementById('trouble-section');

// Populate fields
extIdInput.value = extId;
installCmdInput.value = installCmd;

// Platform-aware displays
const shortcutEl = document.getElementById('shortcut-key');
if (shortcutEl) {
  shortcutEl.textContent = isMac ? '⌘ Shift P' : 'Ctrl+Shift+P';
}
const quitTipEl = document.getElementById('quit-tip');
if (quitTipEl) {
  // Mac has ⌘Q, Windows/Linux don't have a universal quit shortcut
  quitTipEl.textContent = isMac 
    ? 'Fully quit Chrome (⌘Q) and reopen' 
    : 'Fully quit Chrome (menu → Exit) and reopen';
}

// Copy functionality
function copyToClipboard(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    const original = btn.textContent;
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove('copied');
    }, 1500);
  }).catch(() => {
    // Fallback: select the input text
    const input = btn.previousElementSibling;
    if (input?.select) {
      input.select();
      btn.textContent = 'Select All';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    }
  });
}

document.getElementById('copy-id').addEventListener('click', (e) => {
  copyToClipboard(extId, e.target);
});

document.getElementById('copy-cmd').addEventListener('click', (e) => {
  copyToClipboard(installCmd, e.target);
});

// Start annotation button — routes through background script which handles injection
document.getElementById('start-btn')?.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: "TOGGLE_PICKER" });
  window.close();
});

// Retry button
document.getElementById('retry-btn')?.addEventListener('click', () => {
  checkConnection();
});

// Update UI based on connection state
function setConnected() {
  statusDot.className = 'status-dot connected';
  statusText.textContent = 'Connected';
  setupSection.style.display = 'none';
  readySection.style.display = 'block';
  troubleSection.style.display = 'none';
}

function setNotInstalled(detail) {
  statusDot.className = 'status-dot';
  statusText.textContent = detail || 'Not installed';
  setupSection.style.display = 'block';
  readySection.style.display = 'none';
  troubleSection.style.display = 'none';
}

function setTrouble(error) {
  statusDot.className = 'status-dot trouble';
  statusText.textContent = 'Connection issue';
  setupSection.style.display = 'block';
  readySection.style.display = 'none';
  troubleSection.style.display = 'block';
  document.getElementById('trouble-detail').textContent = error || 'Unknown error';
}

function setChecking() {
  statusDot.className = 'status-dot checking';
  statusText.textContent = 'Checking...';
  // Reset sections to initial state (setup visible, others hidden)
  setupSection.style.display = 'block';
  readySection.style.display = 'none';
  troubleSection.style.display = 'none';
}

// Check connection using PING/PONG
function checkConnection() {
  setChecking();
  
  chrome.runtime.sendMessage({ type: 'CHECK_NATIVE' }, (response) => {
    if (chrome.runtime.lastError) {
      setTrouble(chrome.runtime.lastError.message || 'Failed to reach background');
      return;
    }
    if (!response) {
      setTrouble('No response from background');
      return;
    }
    if (response.connected) {
      setConnected();
      return;
    }
    if (response.error) {
      const error = response.error || '';
      if (error.includes('not found')) {
        setNotInstalled('Native host not found');
      } else if (error.includes('forbidden')) {
        setNotInstalled('Extension ID mismatch - reinstall native host');
      } else {
        setTrouble(error);
      }
      return;
    }
    setNotInstalled('Native host not connected');
  });
}

// Check on load
checkConnection();
