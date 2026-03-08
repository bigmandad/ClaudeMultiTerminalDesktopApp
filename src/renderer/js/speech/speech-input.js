// ── Speech Input — mic button per pane ───────────────────
// Web Speech API doesn't work in Electron.
// Uses Windows dictation (Win+H) as primary fallback,
// with clipboard monitoring as secondary approach.

import { events } from '../events.js';
import { showToast } from '../notifications/toast.js';

let activePane = null;

export function initSpeechInput() {
  // Delegate mic button clicks
  document.addEventListener('click', (e) => {
    const micBtn = e.target.closest('.mic-btn');
    if (!micBtn) return;

    const pane = micBtn.closest('.terminal-pane');
    if (!pane) return;

    toggleSpeech(pane, micBtn);
  });
}

function toggleSpeech(paneEl, btn) {
  if (activePane) {
    stopSpeech(btn);
    return;
  }

  startSpeech(paneEl, btn);
}

async function startSpeech(paneEl, btn) {
  // Try Web Speech API first (may work in some Electron builds)
  if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
    try {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      const recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.lang = 'en-US';

      recognition.onresult = (event) => {
        const text = event.results[0][0].transcript;
        const input = paneEl.querySelector('.pane-input');
        if (input) {
          input.value += text;
          input.focus();
        }
        stopSpeech(btn);
      };

      recognition.onerror = () => {
        stopSpeech(btn);
        fallbackDictation(paneEl);
      };

      recognition.onend = () => {
        stopSpeech(btn);
      };

      activePane = { recognition, paneEl };
      btn.classList.add('active');
      btn.title = 'Stop Listening';
      recognition.start();
      return;
    } catch (e) {
      // Fall through to fallback
    }
  }

  fallbackDictation(paneEl);
}

function fallbackDictation(paneEl) {
  const input = paneEl.querySelector('.pane-input');
  if (input) input.focus();

  showToast({
    title: 'Speech Input',
    message: 'Press Win+H to use Windows dictation, then speak into the input field.',
    icon: '&#127908;'
  });
}

function stopSpeech(btn) {
  if (activePane?.recognition) {
    try {
      activePane.recognition.stop();
    } catch (e) { /* ignore */ }
  }
  activePane = null;

  if (btn) {
    btn.classList.remove('active');
    btn.title = 'Speech to Text';
  }
}
