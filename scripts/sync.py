"""Mirror your own Herdr mods, layouts and keys from ~/.config/herdr-app into this repo.

Run by the launchd agent in scripts/ (on change, and every 30 s); safe to run by hand:
    python3 -I scripts/sync.py

- mods/<name>/   every mod Herdr didn't ship (shipped ones are listed in installed.json),
                 minus the files Herdr writes into each mod (jsconfig.json, *.d.ts, hidden, node_modules)
- layouts/       every layout except Herdr's own (main, terminals, win98), with its .svg/.png preview
- keys.json      only the bindings that differ from scripts/keys.default.json, in the
                 "keys it expects" form herdr.dev recipes use
A mod or layout you delete in Herdr is deleted here too.

With --commit (the launchd agent passes it), synced changes are committed once they have
sat unchanged for QUIET seconds, so one editing session becomes one commit. Only mods/,
layouts/ and keys.json are staged; your own work elsewhere in the repo is left alone.
It never pushes.
"""
import filecmp
import json
import os
import shutil
import subprocess
import sys
import time

HOME = os.environ.get("HERDR_APP_HOME") or os.path.expanduser("~/.config/herdr-app")
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHIPPED_LAYOUTS = {"main", "terminals", "win98"}
LAYOUT_ASSETS = (".json", ".svg", ".png")
SYNCED = ["mods", "layouts", "keys.json"]
QUIET = 120


def app_written(name):
    return name.startswith(".") or name == "jsconfig.json" or name.endswith(".d.ts") or name == "node_modules" or name.endswith(".error")


def mirror_dir(src, dst, changed):
    """Make dst hold exactly src's files (minus app-written ones). Returns nothing; logs to changed."""
    os.makedirs(dst, exist_ok=True)
    want = {n for n in os.listdir(src) if not app_written(n)}
    for n in os.listdir(dst):
        if n not in want:
            p = os.path.join(dst, n)
            shutil.rmtree(p) if os.path.isdir(p) else os.remove(p)
            changed.append(f"- {os.path.relpath(p, REPO)}")
    for n in want:
        s, d = os.path.join(src, n), os.path.join(dst, n)
        if os.path.isdir(s):
            mirror_dir(s, d, changed)
        elif not os.path.exists(d) or not filecmp.cmp(s, d, shallow=False):
            shutil.copy2(s, d)
            changed.append(f"+ {os.path.relpath(d, REPO)}")


def sync_mods(changed):
    shipped = set(json.load(open(os.path.join(HOME, "installed.json"))))
    src_root, dst_root = os.path.join(HOME, "mods"), os.path.join(REPO, "mods")
    os.makedirs(dst_root, exist_ok=True)
    mine = {n for n in os.listdir(src_root) if os.path.isdir(os.path.join(src_root, n)) and n not in shipped and not n.startswith(".")}
    for n in os.listdir(dst_root):
        if n not in mine and os.path.isdir(os.path.join(dst_root, n)):
            shutil.rmtree(os.path.join(dst_root, n))
            changed.append(f"- mods/{n}/")
    for n in sorted(mine):
        mirror_dir(os.path.join(src_root, n), os.path.join(dst_root, n), changed)


def sync_layouts(changed):
    src, dst = os.path.join(HOME, "layouts"), os.path.join(REPO, "layouts")
    os.makedirs(dst, exist_ok=True)
    want = {n for n in os.listdir(src) if n.endswith(LAYOUT_ASSETS) and os.path.splitext(n)[0] not in SHIPPED_LAYOUTS and not app_written(n)}
    for n in os.listdir(dst):
        if n not in want:
            os.remove(os.path.join(dst, n)); changed.append(f"- layouts/{n}")
    for n in want:
        s, d = os.path.join(src, n), os.path.join(dst, n)
        if not os.path.exists(d) or not filecmp.cmp(s, d, shallow=False):
            shutil.copy2(s, d); changed.append(f"+ layouts/{n}")


def sync_keys(changed):
    try:
        keys = json.load(open(os.path.join(HOME, "keys.json")))
    except (OSError, ValueError):
        return  # mid-save or invalid: Herdr keeps the old one too; try next run
    base = json.load(open(os.path.join(REPO, "scripts", "keys.default.json")))
    extra = {}
    for section, binds in keys.items():
        diff = {k: v for k, v in binds.items() if base.get(section, {}).get(k) != v}
        if diff:
            extra[section] = diff
    path, text = os.path.join(REPO, "keys.json"), json.dumps(extra, indent=2) + "\n"
    old = open(path).read() if os.path.exists(path) else None
    if not extra:
        if old is not None:
            os.remove(path); changed.append("- keys.json")
    elif old != text:
        open(path, "w").write(text); changed.append("+ keys.json")


def git(*args):
    return subprocess.run(["git", "-C", REPO, *args], capture_output=True, text=True)


def auto_commit():
    """Commit the synced paths once nothing in them has changed for QUIET seconds."""
    g = os.path.join(REPO, ".git")
    if any(os.path.exists(os.path.join(g, x)) for x in ("MERGE_HEAD", "REBASE_HEAD", "rebase-merge", "rebase-apply", "index.lock")):
        return
    if git("symbolic-ref", "-q", "HEAD").returncode != 0:  # detached HEAD: leave it to you
        return
    status = git("status", "--porcelain=v1", "-z", "--untracked-files=all", "--", *SYNCED).stdout
    paths = [e[3:] for e in status.split("\0") if len(e) > 3]
    if not paths:
        return
    newest = max((os.path.getmtime(os.path.join(REPO, p)) for p in paths if os.path.exists(os.path.join(REPO, p))), default=0)
    if time.time() - newest < QUIET:
        return  # still being edited; a later run commits
    names = sorted({p.split("/")[1] if p.count("/") >= 1 and p.split("/")[0] in ("mods", "layouts") else p for p in paths})
    git("add", "-A", "--", *SYNCED)
    msg = f"Auto-sync: {', '.join(names[:6])}{' and more' if len(names) > 6 else ''}"
    r = git("commit", "-q", "-m", msg, "--", *SYNCED)
    print(msg if r.returncode == 0 else f"auto-commit failed: {r.stderr.strip()}")


def main():
    changed = []
    sync_mods(changed)
    sync_layouts(changed)
    sync_keys(changed)
    for line in changed:
        print(line)
    if "--commit" in sys.argv[1:]:
        auto_commit()
    return 0


sys.exit(main())
