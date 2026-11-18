# Releasing and updating

How a release is made, what is in it, how the app updates itself from it, and what is and is not verified.

## Making a release

1. Bump `version` in `app/package.json` (and `app/package-lock.json`: `npm version <x.y.z> --no-git-tag-version` does both) and add an entry for that version at the top of `CHANGELOG` in `app/src/renderer/src/lib/versions.ts`. The entry is the release notes and the app's "What's new"; a unit test fails when the current version has no entry, and the release stops at its first step without one.
2. Merge to `main`. The **Release** workflow (`.github/workflows/release.yml`) runs because `app/package.json` changed, creates the tag `v<version>` together with the GitHub release, and attaches the files.

Other ways in: push a tag `v<version>` yourself (it must match `package.json`, or the workflow stops), or run the workflow by hand (Actions > Release > Run workflow). By hand, **publish** is off by default: everything is built and the files stay as workflow artifacts without making a release. A push to `main` that touches `app/package.json` without changing the version (a dependency, say) finds the release already exists and does nothing, so published files are never silently replaced. To replace the files of an existing release, push its tag again or run the workflow by hand with publish on: it uploads with `--clobber`.

A version with a hyphen (`1.2.0-beta.1`) is published as a pre-release; the app's update check ignores pre-releases (it asks for the latest full release).

## What the workflow does

| Job | What |
|---|---|
| plan | reads the version, checks a pushed tag matches it, decides whether to skip (version unchanged on `main`), writes the release notes from the CHANGELOG |
| checks | typecheck and unit tests |
| icons | makes `build/icon.png` and `icon.ico` from the brand emblem with ImageMagick (`build/` is not committed) |
| build (4 jobs) | Windows (NSIS installer), Linux (tar.gz), macOS Apple silicon (zip), macOS Intel (zip); each runs `npm run package` on its own system |
| smoke (inside the Linux build) | starts the packaged Linux app and checks window title, version, the preload bridge and a running sim; then runs the self-update test (below) |
| publish | `SHA256SUMS.txt`, its signature when a key is set up, then `gh release create` (or `gh release upload --clobber` for an existing release) |

Only the publish job has write permission. Nothing is published when any earlier job fails.

### The files

| File | Contents |
|---|---|
| `BALTA-Crucible-Setup-<version>.exe` | NSIS installer: the app on its own Electron runtime, shortcuts, the robot integration tool, English and Turkish. Silent install: `/S`, optional `/ROBOT=<project> /PATCH=1 /D=<folder>` |
| `BALTA-Crucible-<version>-linux-x64.tar.gz` | A folder with the Electron runtime, the app, a launcher (`BALTA-Crucible`), a `.desktop` file, the icon and the robot integration tool |
| `BALTA-Crucible-<version>-mac-arm64.zip` / `-mac-x64.zip` | `BALTA Crucible.app` (signed ad hoc) |
| `SHA256SUMS.txt` (+ `.sig`) | SHA-256 of every file above |

All three are built from the Electron runtime in `node_modules`, so the packaged app runs on exactly the Electron the tests ran on. `npm run package` does the same locally for the system you are on (output in `app/dist-release/`).

### What is not covered

- The installer and the apps are **not code-signed** (no Windows Authenticode, no Apple Developer ID, no notarisation). Windows SmartScreen and macOS Gatekeeper will warn on first start; the macOS app carries an ad-hoc signature, which Apple silicon needs to run at all.
- Linux is the only system on which the packaging, the packaged app and the self-update are tested in CI. The Windows and macOS packaging and swap code are written and reviewed but have never been run on those systems: treat the first Windows and macOS releases as the real test, and check them by hand.
- Icons: unless you commit real ones (`git add -f app/build/icon.png app/build/icon.ico`), they are made from the emblem in the brand assets.

## Self-update

The app asks `https://api.github.com/repos/krotom/crucible/releases/latest` (nothing about the user is sent) at start, at most once a day, and when you press **Check for updates** in About. Switch the start-up check off in Preferences. The check only tells you; **Install the update** does the work:

1. Downloads the file for this platform and `SHA256SUMS.txt` (and `SHA256SUMS.txt.sig` when signing is set up) to the app's settings folder. Only `https` addresses are accepted (and `http` on this computer, for the test server), downloads are capped at 700 MB.
2. Checks the signature (when the app carries a public key), then the file's SHA-256 against `SHA256SUMS.txt`. Anything wrong stops the update with a message and changes nothing.
3. Unpacks next to the installed copy (Linux, macOS) and starts a small detached script that waits for the app to exit, swaps the folder or bundle, deletes the old copy, and starts the new version. If the swap fails the old version is put back and started. Windows runs the downloaded installer silently (`/S`, it upgrades in place and asks Windows for permission) and starts the app afterwards; if you decline the permission prompt the old version starts again.
4. The app quits just before the swap; leftovers of an interrupted update are cleaned at the next start.

When it cannot update itself it says why and offers the release page: a development run, a folder it cannot write to (an install under `/Applications` by a non-admin, `Program Files` is fine because Windows asks for permission), or a copy that is not in the layout the packages use.

### Signing releases (recommended)

Without signing, the checksum protects against a damaged or incomplete download but not against someone who can replace the release files (the checksum file lives next to them). Signing closes that: installed copies refuse a release whose `SHA256SUMS.txt` is not signed by your key.

1. `cd app && npm run update-keys`. It writes the public key into `src/main/update-key.ts` (commit it) and the private key to `app/update-private-key.pem` (git-ignored; keep it safe, a lost key means installed copies refuse every future release until they are replaced by hand).
2. `gh secret set UPDATE_SIGNING_KEY < app/update-private-key.pem`
3. Release as usual. The publish job signs `SHA256SUMS.txt`; **it refuses to publish** when the app carries a public key but the secret is missing, because installed copies would reject the release.

Apps built before a key was added keep checking checksums only. After adding a key, the first signed release must be installed by hand on machines that have an older unsigned version (an unsigned app cannot know to demand a signature).

### Testing the update flow without publishing

`CRUCIBLE_UPDATE_URL=http://127.0.0.1:<port>/latest` points the app at a local server that answers like GitHub's releases API (only `127.0.0.1` / `localhost` are accepted). `app/e2e/update-packaged.mjs <linux tar.gz>` does exactly that with a real packaged Linux app: it offers a fake version 9.0.0, checks that a damaged download is refused and nothing on disk changes, then that the real one installs, the old process exits, the folder holds the new version, nothing is left behind and the new copy is running. The release workflow runs it before publishing.

## Troubleshooting

- **The workflow stops at "Release notes":** the version has no entry in `CHANGELOG` (`versions.ts`).
- **"the tag … does not match the version":** push the tag `v<version in package.json>`.
- **"the app carries a public update key but the UPDATE_SIGNING_KEY secret is not set":** do step 2 above, or remove the key from `update-key.ts` (installed copies then check checksums only).
- **A UI test fails on the runner with `spawn …/electron ENOENT`:** the Electron binary was not downloaded; the workflows run `node node_modules/electron/install.js` for that.
- **No release appears after merging:** the workflow only runs when `app/package.json` changed on `main` and the release for that version did not exist yet.
