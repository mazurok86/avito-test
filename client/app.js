(() => {
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const statusDetail = document.getElementById('status-detail');
  const startPanel = document.getElementById('start-panel');
  const startButton = document.getElementById('start-button');
  const startFeedback = document.getElementById('start-feedback');
  const resetButton = document.getElementById('reset-button');
  const resetFeedback = document.getElementById('reset-feedback');
  const credentialsPanel = document.getElementById('credentials-panel');
  const credentialsReason = document.getElementById('credentials-reason');
  const credentialsForm = document.getElementById('credentials-form');
  const credentialsLoginInput = document.getElementById('credentials-login');
  const credentialsPasswordInput = document.getElementById('credentials-password');
  const credentialsFeedback = document.getElementById('credentials-feedback');
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
    awaiting_credentials: 'warn',
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

  function showCredentials(reason) {
    credentialsReason.textContent = reason ?? '';
    credentialsPanel.classList.remove('hidden');
    credentialsLoginInput.value = '';
    credentialsPasswordInput.value = '';
    credentialsLoginInput.focus();
    credentialsFeedback.textContent = '';
  }

  function hideCredentials() {
    credentialsPanel.classList.add('hidden');
    // Don't keep the password sitting in the DOM after the form is dismissed.
    credentialsPasswordInput.value = '';
  }

  function showStart() {
    startPanel.classList.remove('hidden');
    startButton.disabled = false;
    startFeedback.textContent = '';
  }

  function hideStart() {
    startPanel.classList.add('hidden');
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

  resetButton.addEventListener('click', async () => {
    const ok = confirm(
      'Полный сброс: будут закрыты Chrome и стёрт его профиль (куки, ' +
        'логин-данные, история). Действие необратимо. Продолжить?',
    );
    if (!ok) return;
    resetButton.disabled = true;
    resetFeedback.textContent = 'Resetting…';
    try {
      const res = await fetch('/control/reset', { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        resetFeedback.textContent = data.message ?? `Error: ${res.status}`;
        return;
      }
      resetFeedback.textContent = 'Сброс выполнен';
      setTimeout(() => { resetFeedback.textContent = ''; }, 4000);
      // status:change → idle will make the Start panel reappear.
    } catch (err) {
      resetFeedback.textContent = `Network error: ${err.message}`;
    } finally {
      resetButton.disabled = false;
    }
  });

  startButton.addEventListener('click', async () => {
    startButton.disabled = true;
    startFeedback.textContent = 'Starting…';
    try {
      const res = await fetch('/control/start', { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        startFeedback.textContent = data.message ?? `Error: ${res.status}`;
        startButton.disabled = false;
        return;
      }
      startFeedback.textContent = 'Запуск…';
      // Panel will be hidden by the next status:change event leaving `idle`.
    } catch (err) {
      startFeedback.textContent = `Network error: ${err.message}`;
      startButton.disabled = false;
    }
  });

  credentialsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const login = credentialsLoginInput.value.trim();
    const password = credentialsPasswordInput.value;
    if (!login || !password) return;
    credentialsFeedback.textContent = 'Submitting…';
    try {
      const res = await fetch('/auth/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login, password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        credentialsFeedback.textContent = data.message ?? `Error: ${res.status}`;
        return;
      }
      credentialsFeedback.textContent = 'Submitted, attempting login…';
      // Drop the password from the DOM as soon as it's accepted.
      credentialsPasswordInput.value = '';
    } catch (err) {
      credentialsFeedback.textContent = `Network error: ${err.message}`;
    }
  });

  const socket = io({ path: '/socket.io', transports: ['websocket', 'polling'] });

  socket.on('connect', () => setStatus('idle', 'connected to relay'));
  socket.on('disconnect', () => setStatus('error', 'disconnected from relay'));

  socket.on('status:change', (payload) => {
    setStatus(payload.state, payload.detail);
    // Start panel is the entry point for both the first start (state=idle)
    // and any retry after a fatal failure (state=error).
    if (payload.state === 'idle' || payload.state === 'error') {
      showStart();
    } else {
      hideStart();
    }
    if (payload.state !== 'awaiting_code') hideAuth();
    if (payload.state !== 'awaiting_credentials') hideCredentials();
  });

  socket.on('auth:needs_code', (payload) => showAuth(payload.reason));
  socket.on('auth:code_accepted', () => {
    authFeedback.textContent = 'Code accepted';
    setTimeout(hideAuth, 800);
  });

  socket.on('auth:needs_credentials', (payload) => showCredentials(payload.reason));

  socket.on('message:new', (message) => appendMessage(message));
})();
