# Admin Test Response Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "测试请求" button to the admin page that sends a fixed `hello` request to `/v1/responses` and shows the result in the existing message area.

**Architecture:** Keep the admin page UI thin by moving the new request-building and response-summary logic into a dedicated browser script at `public/config-admin.js`. Protect that script with the existing `/admin` auth middleware, and cover the pure helper functions with Node's built-in test runner before wiring the button into the page.

**Tech Stack:** Node.js, Express, plain browser JavaScript, `node:test`, `node:assert/strict`

---

### Task 1: Extract Test-Request Helpers Into a Loadable Admin Script

**Files:**
- Create: `public/config-admin.js`
- Create: `test/config-admin.test.js`
- Modify: `openai.js`

- [ ] **Step 1: Write the failing test**

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildHelloTestRequest,
  getPreferredApiKey,
  extractResponseSummary,
} = require('../public/config-admin.js');

test('buildHelloTestRequest uses configured Claude Code model and fixed hello input', () => {
  const requestBody = buildHelloTestRequest({
    claude_code: {
      model: 'gpt-5-mini',
    },
  });

  assert.deepEqual(requestBody, {
    model: 'gpt-5-mini',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'hello',
          },
        ],
      },
    ],
  });
});

test('buildHelloTestRequest falls back to gpt-5.4 when no Claude Code model is configured', () => {
  assert.equal(buildHelloTestRequest({}).model, 'gpt-5.4');
});

test('getPreferredApiKey returns the first configured apikey', () => {
  assert.equal(getPreferredApiKey({
    apikeys: ['router-key', 'backup-key'],
  }), 'router-key');
});

test('extractResponseSummary prefers response.output_text when available', () => {
  assert.equal(extractResponseSummary({
    output_text: 'hello from upstream',
  }), 'hello from upstream');
});

test('extractResponseSummary falls back to nested output text content', () => {
  assert.equal(extractResponseSummary({
    output: [
      {
        content: [
          {
            type: 'output_text',
            text: 'nested hello',
          },
        ],
      },
    ],
  }), 'nested hello');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/config-admin.test.js`
Expected: FAIL with `Cannot find module '../public/config-admin.js'` or missing export errors.

- [ ] **Step 3: Write minimal implementation**

```js
(function attachConfigAdmin(globalScope) {
  function getPreferredApiKey(snapshot) {
    const apikeys = Array.isArray(snapshot && snapshot.apikeys) ? snapshot.apikeys : [];
    return typeof apikeys[0] === 'string' ? apikeys[0] : '';
  }

  function buildHelloTestRequest(snapshot) {
    const configuredModel = snapshot && snapshot.claude_code && typeof snapshot.claude_code.model === 'string'
      ? snapshot.claude_code.model.trim()
      : '';

    return {
      model: configuredModel || 'gpt-5.4',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'hello',
            },
          ],
        },
      ],
    };
  }

  function extractResponseSummary(payload) {
    if (payload && typeof payload.output_text === 'string' && payload.output_text.trim()) {
      return payload.output_text.trim();
    }

    const output = Array.isArray(payload && payload.output) ? payload.output : [];
    for (const item of output) {
      const content = Array.isArray(item && item.content) ? item.content : [];
      for (const entry of content) {
        if (entry && typeof entry.text === 'string' && entry.text.trim()) {
          return entry.text.trim();
        }
      }
    }

    return JSON.stringify(payload);
  }

  const exported = {
    getPreferredApiKey,
    buildHelloTestRequest,
    extractResponseSummary,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }

  globalScope.AirouterConfigAdmin = exported;
}(typeof globalThis !== 'undefined' ? globalThis : this));
```

In `openai.js`, add a protected admin-script route next to the existing admin page route:

```js
app.get('/admin/config-admin.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'config-admin.js'));
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/config-admin.test.js`
Expected: PASS with all tests green.

- [ ] **Step 5: Commit**

```bash
git add public/config-admin.js test/config-admin.test.js openai.js
git commit -m "test: cover admin hello request helpers"
```

### Task 2: Wire the Button Into the Admin Page

**Files:**
- Modify: `public/config-admin.html`
- Reuse: `public/config-admin.js`
- Verify: `test/config-admin.test.js`

- [ ] **Step 1: Write the failing test**

Extend `test/config-admin.test.js` with a focused regression test for summary fallback so the UI can always show something readable:

```js
test('extractResponseSummary falls back to compact JSON when no text is available', () => {
  assert.equal(
    extractResponseSummary({
      id: 'resp_123',
      status: 'completed',
    }),
    JSON.stringify({
      id: 'resp_123',
      status: 'completed',
    }),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/config-admin.test.js`
Expected: FAIL because the helper currently returns an unhelpful value or does not guarantee the compact JSON fallback.

- [ ] **Step 3: Write minimal implementation**

In `public/config-admin.js`, keep the JSON fallback compact and stable:

```js
return JSON.stringify(payload || {});
```

In `public/config-admin.html`:

- Add a protected script loader before the inline bootstrap script:

```html
<script>
  const adminAuthToken = new URLSearchParams(window.location.search).get('auth_token') || '';
  document.write(`<script src="${`/admin/config-admin.js?auth_token=${encodeURIComponent(adminAuthToken)}`}"><\/script>`);
</script>
```

- Add the new toolbar button:

```html
<button class="secondary" type="button" id="testResponseButton">测试请求</button>
```

- Replace direct inline request-shaping logic with the shared helpers:

```js
const {
  buildHelloTestRequest,
  extractResponseSummary,
  getPreferredApiKey,
} = window.AirouterConfigAdmin;
```

- Add the request action:

```js
const testResponseButton = document.getElementById('testResponseButton');

async function sendHelloTestRequest() {
  const preferredApiKey = getPreferredApiKey(snapshot);
  const payload = await requestJson('/v1/responses', {
    method: 'POST',
    headers: preferredApiKey ? {
      Authorization: `Bearer ${preferredApiKey}`,
    } : {},
    body: JSON.stringify(buildHelloTestRequest(snapshot || {})),
  });

  setMessage('info', `测试请求成功：${extractResponseSummary(payload)}`);
}
```

- Bind the button:

```js
testResponseButton.addEventListener('click', async () => {
  testResponseButton.disabled = true;
  try {
    await sendHelloTestRequest();
  } catch (error) {
    setMessage('error', error.message);
  } finally {
    testResponseButton.disabled = false;
  }
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/config-admin.test.js`
Expected: PASS with the helper regression test green.

- [ ] **Step 5: Run the broader verification**

Run: `npm test`
Expected: PASS with the full suite green.

- [ ] **Step 6: Manual verification**

Run the app, open the protected admin page, and verify:

- The toolbar shows `测试请求`.
- Clicking it sends a fixed `hello` request to `/v1/responses`.
- If `apikeys` are configured, the request succeeds without manually copying a key.
- The existing message area shows either `测试请求成功：...` or a clear error.

- [ ] **Step 7: Commit**

```bash
git add public/config-admin.html public/config-admin.js test/config-admin.test.js
git commit -m "feat: add admin hello test request button"
```
