# herdr-mods

My Herdr layout, mods and keys, in the folder shape herdr.dev uses for a shared layout.
`RECIPE.md` describes what's here; `preview.png` is the screenshot.

## Auto-sync

`scripts/sync.py` mirrors `~/.config/herdr-app` into this folder:

- `mods/<name>/`: every mod Herdr didn't ship (Herdr lists its own in `installed.json`), minus files Herdr writes into a mod (`jsconfig.json`, `*.d.ts`, hidden files, `node_modules`)
- `layouts/`: every layout except `main`, `terminals` and `win98`
- `keys.json`: only the bindings that differ from `scripts/keys.default.json`

A mod or layout deleted in Herdr is deleted here too. It never commits or pushes.

A launchd agent (`dev.herdr-mods.sync`) runs it when `mods/`, `layouts/` or `keys.json` change and every 30 s (launchd doesn't see edits nested inside a mod folder, so the interval catches those). Log: `~/Library/Logs/herdr-mods-sync.log`.

```sh
scripts/install-sync.sh              # install or reinstall
scripts/install-sync.sh --uninstall  # remove
python3 -I scripts/sync.py           # sync once by hand
```

If a new default binding ships in Herdr, `keys.json` here will list it until you refresh `scripts/keys.default.json`.

## Installing on another machine

Copy `layouts/*.json` to `~/.config/herdr-app/layouts/` and each `mods/<name>/` to `~/.config/herdr-app/mods/` (create each folder's `mod.json` first, then move the folder in, so Herdr doesn't dock it at the window edge). Merge `keys.json` into `~/.config/herdr-app/keys.json`. Run `herdr-app check` on each mod, then `herdr-app do layout.switch '{"name":"my-main"}'`.
