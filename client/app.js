(() => {
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const statusDetail = document.getElementById('status-detail');
  const authPanel = document.getElementById('auth-panel');
  const authReason = document.getElementById('auth-reason');
  const authForm = document.getElementById('auth-form');
  const authCodeInput = document.getElementById('auth-code');
  const authFeedback = document.getElementById('auth-feedback');
  const messagesList = document.getElementById('messages');
  const emptyState = document.getElementById('empty-state');

  const STATE_CLASS = {
    idle: 'warn',
    starting: 'warn',
    logging_in: 'warn',
    awaiting_code: 'warn',
    authorized: 'ok',
    error: 'err',
  };

  function setStatus(state, detail) {
    statusDot.className = `dot ${STATE_CLASS[state] ?? ''}`;
    statusText.textContent = state;
    statusDetail.textContent = detail ? `— ${detail}` : '';
  }

  function showAuth(reason) {
    authReason.textContent = reason ?? '';
    authPanel.classList.remove('hidden');
    authCodeInput.value = '';
    authCodeInput.focus();
    authFeedback.textContent = '';
  }

  function hideAuth() {
    authPanel.classList.add('hidden');
  }

  function appendMessage(message) {
    if (emptyState) emptyState.remove();
    const li = document.createElement('li');
    const meta = document.createElement('div');
    meta.className = 'meta';
    const left = document.createElement('span');
    left.textContent = message.authorName || 'Рушан';
    const right = document.createElement('span');
    right.textContent = new Date(message.createdAt).toLocaleString();
    meta.append(left, right);
    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = message.text;
    li.append(meta, body);
    messagesList.prepend(li);
  }

  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = authCodeInput.value.trim();
    if (!code) return;
    authFeedback.textContent = 'Submitting…';
    try {
      const res = await fetch('/auth/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        authFeedback.textContent = data.message ?? `Error: ${res.status}`;
        return;
      }
      authFeedback.textContent = 'Submitted, waiting for Avito…';
    } catch (err) {
      authFeedback.textContent = `Network error: ${err.message}`;
    }
  });

  const socket = io({ path: '/socket.io', transports: ['websocket', 'polling'] });

  socket.on('connect', () => setStatus('idle', 'connected to relay'));
  socket.on('disconnect', () => setStatus('error', 'disconnected from relay'));

  socket.on('status:change', (payload) => {
    setStatus(payload.state, payload.detail);
    if (payload.state !== 'awaiting_code') hideAuth();
  });

  socket.on('auth:needs_code', (payload) => showAuth(payload.reason));
  socket.on('auth:code_accepted', () => {
    authFeedback.textContent = 'Code accepted';
    setTimeout(hideAuth, 800);
  });

  socket.on('message:new', (message) => appendMessage(message));
})();
