// ── Broadcast Manager — routes messages to sessions ──────

import { events } from '../events.js';
import { showToast } from '../notifications/toast.js';

export function initBroadcastManager() {
  events.on('broadcast:execute', ({ message, targetIds }) => {
    if (!message || !targetIds?.length) return;

    for (const id of targetIds) {
      window.api.pty.write(id, message + '\r');
    }

    showToast({
      title: 'Broadcast sent',
      message: `Sent to ${targetIds.length} session${targetIds.length !== 1 ? 's' : ''}`,
      icon: '&#128225;'
    });
  });
}
