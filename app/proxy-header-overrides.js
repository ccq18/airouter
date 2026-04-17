const CODEX_TUI_USER_AGENT = 'codex-tui/0.120.0 (Mac OS 14.4.1; arm64) vscode/1.113.0 (codex-tui; 0.120.0)';
const CODEX_TUI_ORIGINATOR = 'codex-tui';

function applyForcedProxyHeaders(inputHeaders) {
    const headers = { ...inputHeaders };

    delete headers['User-Agent'];
    delete headers['Originator'];

    headers['user-agent'] = CODEX_TUI_USER_AGENT;
    headers.originator = CODEX_TUI_ORIGINATOR;

    return headers;
}

module.exports = {
    CODEX_TUI_USER_AGENT,
    CODEX_TUI_ORIGINATOR,
    applyForcedProxyHeaders
};
