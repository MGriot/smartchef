# Submitting SmartChef to F-Droid

Everything here is prepared and checked against F-Droid's
[Submitting to F-Droid Quick Start Guide](https://f-droid.org/docs/Submitting_to_F-Droid_Quick_Start_Guide/).
The one step that cannot be done from this repository is the last one: the
merge request has to come from **your** GitLab account.

## What is already done

| Requirement | Status |
|---|---|
| Public source repository with real source | ✅ `github.com/MGriot/smartchef` |
| FOSS licence **file** in the repo | ✅ `LICENSE` (MIT) — added for this |
| No Firebase / GMS / proprietary libraries | ✅ no `google-services.json`, no Play Services in `frontend/android/app/build.gradle` |
| Author permission | ✅ you are the author |
| `fastlane/` metadata in the app's own repo | ✅ `fastlane/metadata/android/{en-US,it-IT}/` |
| Screenshots + icon | ✅ 5 phone screenshots per locale, 512×512 icon |
| Short description ≤ 80 chars, no trailing period | ✅ 77 (en) / 78 (it) |
| Changelog ≤ 500 chars, named for the versionCode | ✅ `changelogs/2.txt`, 444 / 416 |
| Git tag matching `versionName` | ✅ `v1.1.0` ↔ `versionName "1.1.0"` |
| Build recipe | ✅ `metadata/com.smartchef.app.yml` here, ready to copy |

## What you still have to do

### 1. Fill in the Node checksum

`metadata/com.smartchef.app.yml` downloads Node in `sudo:` and verifies it.
The placeholder has to become the real value or a reviewer will ask:

```bash
curl -s https://nodejs.org/dist/v20.18.1/SHASUMS256.txt | grep node-v20.18.1-linux-x64.tar.xz
```

Paste the hash over `REPLACE_WITH_SHA256`.

### 2. Fork fdroiddata and add the file

```bash
# fork https://gitlab.com/fdroid/fdroiddata in the GitLab UI first
git clone git@gitlab.com:<your-gitlab-user>/fdroiddata.git
cd fdroiddata
git checkout -b com.smartchef.app
cp /path/to/smartchef/fdroid/metadata/com.smartchef.app.yml metadata/
```

### 3. Check it locally before asking anyone to review it

This is optional in the guide and worth the time here, because the
Node-before-Gradle step is the part most likely to need adjusting:

```bash
fdroid lint com.smartchef.app
fdroid rewritemeta com.smartchef.app   # normalises field order/formatting
fdroid build com.smartchef.app         # runs the real build in their VM
```

`fdroid build` needs the F-Droid buildserver VM (vagrant + VirtualBox). If
setting that up is more than you want, skip it — the reviewers run it — but
expect one round of feedback on `subdir:`/`build:`.

### 4. Open the merge request

```bash
git add metadata/com.smartchef.app.yml
git commit -m "New App: com.smartchef.app"
git push origin com.smartchef.app
```

Then open a merge request against `fdroid/fdroiddata` with that branch as the
source. Title it `New App: com.smartchef.app`.

Expect roughly **24–48 hours** between the merge and the app appearing in the
main repository, plus however long review itself takes.

## Things a reviewer is likely to raise

- **`subdir:` and `build:`.** `gradlew` lives at `frontend/android/gradlew`
  while the Gradle module is `frontend/android/app`, which is a less common
  layout for fdroiddata. If the build cannot find the wrapper, the fix is
  usually to point `subdir:` at `frontend/android` and adjust the `cd`.
- **Anti-features.** `NonFreeNet` is declared for the optional cloud language
  models. If they ask about the map tiles (CARTO/Esri), the Nominatim
  geocoder or the Tesseract OCR model download, all three are free services
  or freely-licensed data fetched on demand.
- **Network during build.** `npm ci` needs it. F-Droid's build server allows
  it, and the committed `frontend/package-lock.json` is what makes the result
  deterministic.
- **Debug signing is not a problem here.** F-Droid builds from source and
  signs with its own key, so the debug keystore used for the GitHub release
  APK is irrelevant to this route. It *would* matter for your own F-Droid
  repository — see the README's
  [Publishing on F-Droid](../README.md#publishing-on-f-droid) section.

## Keeping it updated

`UpdateCheckMode: Tags` plus `AutoUpdateMode: Version` means F-Droid picks up
future releases on its own, as long as you keep doing what this release did:

1. bump `versionCode` **and** `versionName` in `frontend/android/app/build.gradle`,
2. add `fastlane/metadata/android/<locale>/changelogs/<versionCode>.txt`,
3. tag the commit `v<versionName>`.
