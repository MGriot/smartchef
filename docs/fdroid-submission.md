The app complies with the [inclusion criteria](https://f-droid.org/wiki/page/Inclusion_Policy)

* [x] The app is not already listed in the repo or issue tracker.
* [x] The original app author has been notified (and does not oppose the inclusion). I am the author.
* [ ] [Donated](https://f-droid.org/donate/) to support the maintenance of this app in F-Droid.

---

## Link to the source code

https://github.com/MGriot/smartchef

---

## Link to app in another app store

None. It is distributed through [GitHub Releases](https://github.com/MGriot/smartchef/releases) and a self-hosted F-Droid repository (`fdroid/README.md` in the source tree). It is not on Google Play.

---

## License used

MIT

---

## Category

Sports & Health

F-Droid has no "Kitchen" or "Food" category. Sports & Health is the closest fit: SmartChef covers meal planning, nutrition figures and a pantry.

---

## Summary

Offline recipe manager with nested recipes, scaling and device-to-device sync

---

## Description

SmartChef is a self-hosted recipe manager that works with no server at all. Everything (your recipes, your ingredient library, your shopping lists, your meal plans) lives in a database on the device, and nothing is sent anywhere unless you set that up yourself. No account, no telemetry, no cloud.

### Recipes inside recipes

A recipe can be used as an ingredient of another one. A lasagne is pasta, ragù and béchamel, each a recipe in its own right with its own ingredients and steps. Change the portions of the lasagne and every sub-recipe scales with it, down through as many levels as you like. The shopping list, the nutrition figures and the pantry matcher all resolve the whole tree rather than the top layer.

### Written the way you cook

* Step text can point at the recipe's own ingredients, tools and techniques.
* A reference prints the amount that step uses (500 g of the 620 g of flour, not the total) and can be re-labelled, so a step reads "sift the flour" while still pointing at "Type 00 wheat flour".
* An ingredient can be marked as an alternative to another one, and is then left off the shopping list rather than bought twice.
* Portions can be scaled, with units converted and quantities rounded to something you can actually measure.

### In the kitchen

* Full-screen cooking mode, including a variant that interleaves a sub-recipe's steps with the main recipe's.
* Each step lists its ingredients as a checklist showing what it takes and what is left.
* Timers survive leaving the screen, and the screen stays awake.

### Getting recipes in

* Paste a URL and the schema.org data on the page is read directly.
* Import from Paprika, Mealie, Crouton, Mela, Nextcloud Cookbook or CopyMeThat.
* Read a PDF's text layer, or a photo of a cookbook page with on-device OCR.
* An optional language model can parse anything else, matched against the ingredients your library already knows so you don't end up with four spellings of "tomato". It can be a local Ollama, so that stays offline too. Anthropic, Gemini and OpenAI are available if you prefer, and are off by default.

### Planning and shopping

* Weekly planner, with meals in a day as an option.
* Shopping lists grouped by aisle.
* A pantry that answers "what can I cook right now?".
* A map of where your recipes come from, and a cooking log.

### Your data stays yours

* Sync between your own devices over a folder your file-sync tool already mirrors (Syncthing, Dropbox, a USB stick) or a git remote you control.
* Field-level merging, with genuine conflicts surfaced rather than silently resolved.
* Full backup export and restore as plain JSON.
* API keys never leave the device they were typed on and never enter a backup or a sync history.
* Interface and content in English, Italian, French and Spanish.

---

## Extra details for reviewers

* Application ID: `com.smartchef.app`, current release v1.11.2 (versionCode 34), tagged `v1.11.2`.
* Build recipe: [`fdroid/metadata/com.smartchef.app.yml`](../fdroid/metadata/com.smartchef.app.yml). The APK is a Capacitor shell around a Vite build, so Node (checksum-verified) is installed in `sudo:` and the web build runs in `build:`.
* Fastlane metadata (title, descriptions, screenshots, changelogs in en-US and it-IT) is in `fastlane/metadata/android/`.
* Anti-feature: `NonFreeNet`. The optional cloud language models are off by default; the default is a local Ollama.
