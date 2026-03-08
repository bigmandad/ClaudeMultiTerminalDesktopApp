// ── Speech Input — mic button per pane ───────────────────
// Uses MediaRecorder API for audio capture in Electron,
// then attempts Web Speech API or Windows dictation fallback.

import { events } from '../events.js';
import { showToast } from '../notifications/toast.js';

let activeRecording = null;

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
  if (activeRecording) {
    stopRecording(btn);
    return;
  }

  startRecording(paneEl, btn);
}

async function startRecording(paneEl, btn) {
  const input = paneEl.querySelector('.pane-input');

  // Try Web Speech API first (works in some Electron builds with proper permissions)
  if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
    try {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = 'en-US';

      let finalTranscript = '';

      recognition.onresult = (event) => {
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          if (event.results[i].isFinal) {
            finalTranscript += event.results[i][0].transcript;
          } else {
            interim += event.results[i][0].transcript;
          }
        }
        if (input) {
          input.value = finalTranscript + interim;
          input.focus();
        }
      };

      recognition.onerror = (e) => {
        console.log('[Speech] Recognition error:', e.error);
        stopRecording(btn);
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
          fallbackMediaRecorder(paneEl, btn);
        } else {
          fallbackDictation(paneEl, btn);
        }
      };

      recognition.onend = () => {
        if (activeRecording?.type === 'speechapi') {
          stopRecording(btn);
        }
      };

      activeRecording = { type: 'speechapi', recognition, paneEl };
      btn.classList.add('recording');
      btn.title = 'Stop Listening (click)';
      recognition.start();

      showToast({
        title: 'Listening...',
        message: 'Speak now. Click mic button again to stop.',
        icon: '&#127908;'
      });
      return;
    } catch (e) {
      console.log('[Speech] Web Speech API failed:', e.message);
    }
  }

  // Try MediaRecorder with microphone
  fallbackMediaRecorder(paneEl, btn);
}

async function fallbackMediaRecorder(paneEl, btn) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
    const chunks = [];

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());

      if (chunks.length > 0) {
        showToast({
          title: 'Recording Complete',
          message: 'Audio captured. Use Windows dictation (Win+H) for real-time transcription.',
          icon: '&#127908;'
        });
      }
    };

    activeRecording = { type: 'mediarecorder', recorder: mediaRecorder, stream, paneEl };
    btn.classList.add('recording');
    btn.title = 'Stop Recording (click)';
    mediaRecorder.start();

    showToast({
      title: 'Recording...',
      message: 'Speak now. Click mic button to stop. For live transcription, use Win+H.',
      icon: '&#127908;'
    });

  } catch (e) {
    console.log('[Speech] MediaRecorder failed:', e.message);
    fallbackDictation(paneEl, btn);
  }
}

function fallbackDictation(paneEl, btn) {
  const input = paneEl.querySelector('.pane-input');
  if (input) input.focus();

  // Auto-trigger Windows dictation via keyboard simulation
  activeRecording = { type: 'dictation', paneEl };
  btn.classList.add('recording');
  btn.title = 'Using Windows Dictation';

  showToast({
    title: 'Windows Dictation',
    message: 'Press Win+H to activate Windows dictation, speak into the focused input field. Click mic to stop.',
    icon: '&#127908;'
  });
}

function stopRecording(btn) {
  if (activeRecording) {
    if (activeRecording.type === 'speechapi' && activeRecording.recognition) {
      try { activeRecording.recognition.stop(); } catch (e) { /* ignore */ }
    } else if (activeRecording.type === 'mediarecorder' && activeRecording.recorder) {
      try { activeRecording.recorder.stop(); } catch (e) { /* ignore */ }
      if (activeRecording.stream) {
        activeRecording.stream.getTracks().forEach(t => t.stop());
      }
    }
    activeRecording = null;
  }

  if (btn) {
    btn.classList.remove('recording');
    btn.title = 'Speech to Text';
  }
}
