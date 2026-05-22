const crypto = require('node:crypto');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createId(prefix) {
  return `${prefix}_${crypto.randomBytes(16).toString('hex')}`;
}

function createCcxSessionStore(options = {}) {
  const maxAgeMs = options.maxAgeMs ?? 24 * 60 * 60 * 1000;
  const maxMessages = options.maxMessages ?? 100;
  const maxTokens = options.maxTokens ?? 100000;
  const cleanupIntervalMs = options.cleanupIntervalMs ?? 5 * 60 * 1000;
  const sessions = new Map();
  const responseMapping = new Map();
  let cleanupTimer = null;

  function cleanup() {
    const now = Date.now();
    for (const [sessionId, session] of sessions.entries()) {
      if (
        now - session.lastAccessAt > maxAgeMs ||
        session.messages.length > maxMessages ||
        session.totalTokens > maxTokens
      ) {
        sessions.delete(sessionId);
      }
    }
    for (const [responseId, sessionId] of responseMapping.entries()) {
      if (!sessions.has(sessionId)) {
        responseMapping.delete(responseId);
      }
    }
  }

  if (cleanupIntervalMs > 0) {
    cleanupTimer = setInterval(cleanup, cleanupIntervalMs);
    if (typeof cleanupTimer.unref === 'function') {
      cleanupTimer.unref();
    }
  }

  function createSession(initialMessages = [], totalTokens = 0) {
    const session = {
      id: createId('sess'),
      messages: clone(initialMessages),
      lastResponseId: '',
      createdAt: Date.now(),
      lastAccessAt: Date.now(),
      totalTokens,
    };
    sessions.set(session.id, session);
    return session;
  }

  function getOrCreateSession(previousResponseId = '') {
    if (previousResponseId) {
      const sessionId = responseMapping.get(previousResponseId);
      const session = sessionId ? sessions.get(sessionId) : null;
      if (!session) {
        throw new Error(`无效的 previous_response_id: ${previousResponseId}`);
      }
      session.lastAccessAt = Date.now();
      return session;
    }
    return createSession();
  }

  function getSessionByResponseId(responseId) {
    const sessionId = responseMapping.get(responseId);
    const session = sessionId ? sessions.get(sessionId) : null;
    if (!session) {
      throw new Error(`未找到 previous_response_id 对应的本地 session: ${responseId}`);
    }
    session.lastAccessAt = Date.now();
    return {
      ...session,
      messages: clone(session.messages),
    };
  }

  function recordResponseMapping(responseId, sessionId) {
    if (!responseId || !sessionId || !sessions.has(sessionId)) {
      return;
    }
    responseMapping.set(responseId, sessionId);
    sessions.get(sessionId).lastResponseId = responseId;
  }

  function appendMessage(sessionId, item, tokensUsed = 0) {
    const session = sessions.get(sessionId);
    if (!session) {
      throw new Error(`会话不存在: ${sessionId}`);
    }
    session.messages.push(clone(item));
    session.totalTokens += Number(tokensUsed || 0);
    session.lastAccessAt = Date.now();
  }

  function createCompactedSession(responseId, messages, totalTokens = 0) {
    const session = createSession(messages, totalTokens);
    session.lastResponseId = responseId;
    if (responseId) {
      responseMapping.set(responseId, session.id);
    }
    return responseId;
  }

  function stop() {
    if (cleanupTimer) {
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    }
  }

  return {
    appendMessage,
    cleanup,
    createCompactedSession,
    getOrCreateSession,
    getSessionByResponseId,
    recordResponseMapping,
    stop,
    stats() {
      return {
        totalSessions: sessions.size,
        totalMappings: responseMapping.size,
      };
    },
  };
}

module.exports = {
  createCcxSessionStore,
};
