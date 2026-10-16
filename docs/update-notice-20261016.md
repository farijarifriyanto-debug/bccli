# BCCLI update notification, 2026-10-16

## Scope
Owner requested that BCCLI users know when a new CLI release exists, similar to the Switchboard v0.4.4 notification. BCCLI is an **Ink terminal UI**, not a browser app; native adaptation is a yellow informational line immediately under the existing BCCLI header, ahead of chat transcript, with `bccli update` as an instruction. This is additive; existing prompts, permissions and command routing are unchanged.

Existing baseline: BCCLI already contacted official npm dist-tags at startup but printed to **stderr before Ink mounted**, where the notice could disappear during screen rendering. It ran on every launch for the same cached version. Installed operator laptop BCCLI v0.4.0-beta.50, registry `next` v0.4.0-beta.52; no upgrade to the user's global executable performed.

## Implementation
- Existing `src/update.ts` registry check and 24h cache reused (not replaced). `update-check.json` gains optional `notified`; message emitted and marked **once per newer semver version**. A later new release can notify independently. Old files with only `checkedAt` and `latest` remain compatible.
- Registry/cache-provided version is bounded and validated before being inserted into terminal text; invalid or control-byte-bearing versions are ignored.
- Existing `updateCheck: 'off'` and `BCCLI_NO_UPDATE_CHECK` opt-outs unchanged; prerelease uses official npm `next`, release uses `latest`.
- `src/cli.ts` passes message to Ink instead of printing pre-mount stderr. `src/ui/index.tsx` forwards it to `src/ui/App.tsx`. App inserts it as a warning-colored notice after the header. No auto-download, restart, background process or extra keybinding.
- Shell command `bccli update` remains the existing npm update mechanism, run by the user at their own time.

## Evidence
- Focused Vitest: update logic, Ink App rendering and startInteractive **42 passed**.
- Full candidate: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` **PASS**, with **869 tests passed / 2 skipped**, full test run on Windows laptop, latest beta.52 source.
- Real npm registry checked: `next` beta.52, global currently beta.50. No actual package publish/global npm modification.
- Ink testing-library renders real App and confirms banner under BCCLI header while prompt stays usable; this is **TUI component integration**, not manually photographed Windows Terminal session.
- New tests: cached one-time display, new version re-notification, malformed metadata, startup layout.

## Reference comparison
| Behavior | Switchboard browser update notice | BCCLI TUI | Evidence | Assessment |
|--|--|--|--|--|
| Visible release announcement | Small notice top right | Yellow text under terminal header | Ink App rendering test | Adapted to terminal |
| Once per new release | Version-scoped localStorage dismiss | `update-check.json.notified` | New cache tests | Adapted (no separate dismiss key) |
| Update action | Opens Settings install controls | Shows preexisting `bccli update` command | App test + existing command | Adapted |
| Safe workflow | No forced restart or download | No auto-install/restart | Code + tests | Match |
| Channel and source | npmjs stable | npmjs `next` for beta / `latest` for stable | Registry check + code | Match release channels |
| Offline behavior | Quiet | Quiet; never blocks agent startup beyond existing timeout | Existing tests | Match |

## Release status
Changes exist only in local candidate checkout `C:\Users\farij\bccli-update-notice-20261016`. **No push, merge, release or upgrade of live beta.50** under this request. Future publication and/or upgrading installed BCCLI requires separate owner authorization.
