# Start Config Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-run configuration wizard to `run.js` so `start` can create `openai.json` from `openai.json.example` and then continue booting normally.

**Architecture:** Keep the new behavior local to `run.js`: detect a missing config file, run a small CLI wizard in TTY mode, persist the generated config, and then fall through to the existing startup path. Tests in `test/run.test.js` will drive the new behavior end-to-end by spawning the script with and without interactive stdin.

**Tech Stack:** Node.js CommonJS, `node:test`, `readline/promises`, `child_process.spawnSync`

---

## File Structure

- Modify: `run.js`
- Modify: `test/run.test.js`
- Modify: `README.md`

## Task 1: Lock the missing-config startup behavior with failing tests

**Files:**
- Modify: `test/run.test.js`
- Reference: `openai.json.example`

- [ ] **Step 1: Add a helper that can run `run.js start` with stdin text and TTY-like env**

Add a helper near the existing `runCommand()` in `test/run.test.js` that can pass `input`, omit `openai.json`, and override `stdin` handling via `spawnSync`.

- [ ] **Step 2: Write a failing test for creating config with custom proxy port and enabled apikey**

Add a test that:
- creates a temp workspace with `openai.js` but no `openai.json`
- copies `openai.json.example` into the temp workspace
- feeds answers like `y`, `8899`, `y`
- asserts `start` succeeds
- asserts the new `openai.json` contains `proxy_port: 8899`
- asserts `apikeys` contains exactly one generated entry

Run:

```bash
node --test test/run.test.js
```

Expected: FAIL because `run.js` still tries to read `openai.json` directly.

- [ ] **Step 3: Add a failing test for using the default proxy port when the port answer is blank**

Add a test that answers `y`, blank line, `n`, then asserts the created config contains `proxy_port: 7890` and `apikeys: []`.

Run:

```bash
node --test test/run.test.js
```

Expected: FAIL for the same missing-config path.

- [ ] **Step 4: Add a failing test for non-interactive startup**

Add a test that omits `openai.json`, does not pass stdin answers, and sets an env flag the implementation will use to disable interactive prompting in tests. Assert `start` exits non-zero with a message telling the user to initialize the config in an interactive terminal.

Run:

```bash
node --test test/run.test.js
```

Expected: FAIL until `run.js` handles the missing-config path explicitly.

## Task 2: Implement the minimal startup wizard in `run.js`

**Files:**
- Modify: `run.js`
- Test: `test/run.test.js`

- [ ] **Step 1: Add helpers for reading the example template and checking whether initialization is possible**

Implement small helpers in `run.js` for:
- `configExists()`
- `readExampleConfig()`
- `canPromptForConfig()`
- yes/no normalization
- proxy port normalization

- [ ] **Step 2: Implement an interactive `ensureConfigExists()` function**

The function should:
- return immediately if `openai.json` already exists
- throw a user-friendly error when config is missing in non-interactive mode
- prompt for proxy enablement, optional proxy port, and apikey enablement
- generate an apikey when requested
- write the resulting `openai.json`

- [ ] **Step 3: Call `ensureConfigExists()` at the top of `start()` before any config reads**

Keep the rest of the startup flow unchanged.

Run:

```bash
node --test test/run.test.js
```

Expected: the new missing-config tests pass and the existing startup tests stay green.

## Task 3: Document the new first-run flow

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Remove the mandatory manual copy step from the setup section**

Update the setup commands so the quick-start path is:

```bash
git clone git@github.com:ccq18/airouter.git
cd airouter
npm install
npm start
```

- [ ] **Step 2: Add a short note describing the first-run wizard prompts**

Document that the first startup will:
- create `openai.json` from `openai.json.example`
- optionally enable a local proxy port
- optionally generate an entrance apikey

Run:

```bash
node --test test/run.test.js
```

Expected: PASS

## Self-Review Notes

- Spec coverage: test coverage includes interactive creation, default proxy port, apikey generation, and non-interactive failure.
- No placeholders: each task names exact files and expected commands.
- Type consistency: the implementation is centered on `ensureConfigExists()` in `run.js`, and the tests verify persisted `proxy_port` and `apikeys`.
