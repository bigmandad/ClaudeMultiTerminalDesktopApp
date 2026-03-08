// ── Toast Notification System ──────────────────────────────

const TOAST_DURATION = 5000;

export function showToast({ title, message, icon, onClick }) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = `
    ${icon ? `<span class="toast-icon">${icon}</span>` : ''}
    <div class="toast-body">
      <div class="toast-title">${escapeHtml(title)}</div>
      ${message ? `<div class="toast-message">${escapeHtml(message)}</div>` : ''}
    </div>
    <button class="toast-dismiss">&times;</button>
  `;

  const dismiss = () => {
    toast.classList.add('dismissing');
    setTimeout(() => toast.remove(), 200);
  };

  toast.querySelector('.toast-dismiss').addEventListener('click', (e) => {
    e.stopPropagation();
    dismiss();
  });

  if (onClick) {
    toast.addEventListener('click', () => {
      onClick();
      dismiss();
    });
  }

  container.appendChild(toast);

  // Auto-dismiss
  setTimeout(dismiss, TOAST_DURATION);

  return toast;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
