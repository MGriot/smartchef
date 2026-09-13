# Submitting SmartChef to F-Droid

Everything here is prepared and checked against F-Droid's
[Submitting to F-Droid Quick Start Guide](https://f-droid.org/docs/Submitting_to_F-Droid_Quick_Start_Guide/).
The one step that cannot be done from this repository is the last one: the
merge request has to come from **your** GitLab account.

> **Looking for less work?** f-droid.org has no "point us at your repo"
> intake — building from source and signing with their own key is the whole
> trust model. [IzzyOnDroid](https://apt.izzysoft.de/fdroid/index/info) does
> exactly that instead: it re-serves the APK you attach to a GitHub release,
> so one request covers every future tag. It needs a release-signed APK
> (which this repo now builds) and the same `fastlane/` metadata, and asks
> for nothing else. See the README's
> [Publishing on F-Droid](../README.md#publishing-on-f-droid) section — the
> two are not exclusive.

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

### 1. Fork fdroiddata and add the file

```bash
# fork https://gitlab.com/fdroid/fdroiddata in the GitLab UI first
git clone git@gitlab.com:<your-gitlab-user>/fdroiddata.git
cd fdroiddata
git checkout -b com.smartchef.app
cp /path/to/smartchef/fdroid/metadata/com.smartchef.app.yml metadata/
```

### 2. Check it locally before asking anyone to review it

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

### 3. Open the merge request

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

## Appendix: the IzzyOnDroid request

If you take the IzzyOnDroid route instead (or as well), open an issue on
[codeberg.org/IzzyOnDroid/repodata](https://codeberg.org/IzzyOnDroid/repodata)
using their app-inclusion template. Everything it asks for is already true of
this repo; the body below is ready to paste once a **release-signed** APK is
attached to the GitHub release.

```text
App name: SmartChef
Package ID: com.smartchef.app
Source: https://github.com/MGriot/smartchef
Licence: MIT (LICENSE in the repo root)
Releases: https://github.com/MGriot/smartchef/releases
          APK attached to each tagged release, signed with our release key.

Summary: Offline-first recipe manager - nested recipes that scale together,
dynamic portions, on-device import (schema.org, PDF, photo OCR, optional
local LLM), and device-to-device sync with no central server.

- Fastlane metadata: fastlane/metadata/android/{en-US,it-IT}/ with short and
  full descriptions, icon and phone screenshots, plus per-versionCode
  changelogs.
- No trackers, no ads, no analytics, no Google Play Services and no
  google-services.json. Optional cloud LLM providers are opt-in and off by
  default (the default is a local Ollama); everything else works offline.
- Release-signed, not debug: android:debuggable and testOnly are both absent
  (verified with aapt dump badging and apksigner verify).
- versionCode increases with every release; tags are v<versionName>.
```

## Keeping it updated

`UpdateCheckMode: Tags` plus `AutoUpdateMode: Version` means F-Droid picks up
future releases on its own, as long as you keep doing what this release did:

1. bump `versionCode` **and** `versionName` in `frontend/android/app/build.gradle`,
2. add `fastlane/metadata/android/<locale>/changelogs/<versionCode>.txt`,
3. tag the commit `v<versionName>`.
