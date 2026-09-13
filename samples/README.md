# Sample library

`smartchef-sample-library.json` is a real SmartChef backup — the same file
**Account → Backup & Restore → Export** produces — so a fresh install can be
filled with something to look at in about a minute instead of starting from
an empty gallery.

What is in it:

| | |
|---|---|
| Recipes | 46 |
| Ingredients | 239 |
| Tags | 38 |
| Kitchen tools | 27 |
| Techniques | 20 |
| Ingredient categories | 12 |

Mostly Italian home cooking, written in Italian with translations attached,
including a few recipes used as ingredients of others so the nested-recipe
scaling has something to demonstrate.

Cover images are referenced by URL rather than embedded, which is why the
file is under a megabyte — they load when you are online, and the app falls
back to a placeholder when you are not. (An export made with **Include
images** inlines them instead and is many times larger.)

## Importing it

The same steps on Windows, Android and in a browser:

1. Open **Account** (your avatar, top right).
2. Scroll to **Backup & Restore**.
3. Press **Restore from Backup** and pick this file.

On Android, download the file to the device first — the picker reads from
the device's own storage, not from a URL.

## What restoring actually does

It is a merge, not a replace. Nothing you have is deleted, and the import is
safe to run twice.

- **Recipes, ingredients, tools and techniques** are matched by id. An id
  you do not have is created; an id you *do* have is overwritten with the
  file's version — "newest wins", which is what makes re-importing a
  corrected export actually take effect. Ids are UUIDs generated per
  library, so a file from someone else will not collide with your recipes.
- **Categories and tags** are matched by id *or by name*, and are only ever
  created, never overwritten — that is what makes an imported catalog and
  the starter catalog resolve to the same rows instead of duplicating
  "Vegetables" twice.
- **Units are not imported at all.** Ingredient lines reference a unit by
  symbol (`g`, `ml`, `tsp`), and the app's own starter seed is expected to
  have them. A symbol with no local match leaves that one line's unit blank
  rather than failing the import.

## Before you import it into a library you care about

Export your own backup first (**Account → Backup & Restore → Export**) so
you have a point to restore back to. There is no "remove everything that
came from this file" button, and — worth knowing — switching **Profile**
does *not* give you a separate library to test in: in standalone mode
profiles are people sharing one library, not separate libraries.

## Making your own

Any export works the same way, so this file is also a reasonable template
if you want to prepare a library to hand to someone else. The format is
`formatVersion: 1`; the exporter documents itself in
`frontend/src/services/backup.local.ts`.
