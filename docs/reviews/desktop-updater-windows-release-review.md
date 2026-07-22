# Desktop Updater Windows Release Code Review Report

> **Review Date**: 2026-07-22
> **Task**: N/A — Windows updater release asset collection repair
> **Scope**: airouter，6 files，Windows updater Release workflow and metadata generation
> **Reviewers**: 2 parallel reviewers (correctness-reviewer and quality-reviewer)

---

## 1. Review Scope

### Changed files

1. `.github/workflows/release.yml` — collect the signed Windows `.exe` updater artifact instead of a nonexistent `.zip`.
2. `desktop/scripts/generate-latest-json.mjs` — recognize signed Windows `.exe` updater artifacts while retaining `.exe.zip` compatibility.
3. `test/desktop-updater-release.test.js` — execute the generator against a temporary signed Windows artifact directory.
4. `test/release-workflow.test.js` — assert that the workflow copies the signature and no longer uses the zip collector.
5. `desktop/README.md` — document the actual Windows Release assets and optional signing-key password.
6. `CHANGELOG.md` — record the 0.5.9 release repair.

### Related documents

- Spec: N/A — minimal correction for a confirmed GitHub Actions failure.
- Tasks: N/A — no project task baseline exists for this repair.

### Key decision

The signed `Airouter_<version>_x64-setup.exe` emitted by Tauri is both the Windows installer and updater artifact. Its matching `.sig` must be published and referenced by `latest.json`.

## 2. Round 1: Findings

### 2.1 Performance

None.

### 2.2 Robustness

None.

### 2.3 Standards

**F-1** (P2) — the initial tests did not execute the `.exe` and `.sig` collection path.

- **Location**: `test/desktop-updater-release.test.js`
- **Evidence**: Existing tests passed artifacts directly to `buildLatestJson` and could not detect a regression in `collectUpdaterArtifacts`.

### 2.4 Contract

None.

### 2.5 Spec compliance

None.

## 3. Round 1 Fixes

| ID | Priority | Issue | Fix | Cause |
|----|----------|-------|-----|-------|
| F-1 | P2 | Real artifact collection was not covered. | Added an isolated CLI integration test that writes a signed Windows `.exe` and `.sig`, runs the generator, and verifies the copied artifacts and `latest.json`. | Execution omission |

## 4. Round 2: Re-review

- Both reviewers rechecked the generator integration test and workflow signature-copy assertion.
- No new findings.
- **Conclusion: PASS**

## 5. Disposition

| ID | Dimension | Original priority | Disposition | Rationale |
|----|-----------|-------------------|-------------|-----------|
| F-1 | standards | P2 | fixed | The test now invokes the actual generator CLI and asserts the `.exe` URL, signature content, and output artifacts. |

## 6. Overall Conclusion: PASS

The repair preserves legacy `.exe.zip` parsing while publishing the Tauri-generated signed `.exe` updater artifact required by Windows clients.

## 7. Formal Issues

None.

## 8. Follow-up Items

None.

## 9. Review Summary

- **Review rounds**: 2
- **P0 fixed**: 0
- **P1 fixed**: 0
- **P2 fixed**: 1
- **Follow-up**: 0
- **Final conclusion**: PASS
