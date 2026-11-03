"""The last tool a Claude Code session called, from the end of its transcript.

Usage: python3 -I lasttool.py <claude pid> [n]
  n omitted: {"verb": "Ran", "detail": "...", "ts": "..."} or {}
  n given:   {"tools": [up to n of those, oldest first], "path": "<transcript>"}
Reads back from the end only as far as it needs (256 KB, growing to at most 8 MB), so it is cheap to poll.
"""
import json, os, re, sys

HOME = os.path.expanduser("~")


def session_file(pid):
    """~/.claude/sessions/<pid>.json for pid, or for a descendant when claude runs under a
    wrapper (varlock run -- claude, npx, a shell script): the wrapper is the foreground process."""
    import subprocess
    todo, seen = [str(pid)], set()
    while todo:
        p = todo.pop(0)
        if p in seen:
            continue
        seen.add(p)
        path = os.path.join(os.path.expanduser("~"), ".claude", "sessions", f"{p}.json")
        if os.path.exists(path):
            return path
        if len(seen) > 40:
            break
        try:
            todo += subprocess.run(["pgrep", "-P", p], capture_output=True, text=True, timeout=3).stdout.split()
        except Exception:
            pass
    return None
VERB = {"Bash": "Ran", "Read": "Read", "Edit": "Edited", "Write": "Wrote", "Grep": "Searched", "Glob": "Listed",
        "Skill": "Loaded skill", "Agent": "Started agent", "WebSearch": "Searched the web", "WebFetch": "Fetched",
        "ToolSearch": "Loaded tools", "TodoWrite": "Updated todos", "AskUserQuestion": "Asked you"}


def detail(inp):
    for k in ("description", "command", "file_path", "pattern", "skill", "query", "url", "prompt"):
        v = (inp or {}).get(k)
        if v:
            v = str(v).replace("\n", " ").strip()
            if k == "file_path":  # the end of a path is the part that says which file
                parts = v.rstrip("/").split("/")
                v = "/".join(parts[-2:]) if len(parts) > 2 else v.replace(HOME, "~")
            return v[:200]
    return ""


def main():
    try:
        info = json.load(open(session_file(sys.argv[1]) or ""))
        path = f"{HOME}/.claude/projects/{re.sub(r'[^A-Za-z0-9]', '-', info.get('cwd', ''))}/{info['sessionId']}.jsonl"
        size = os.path.getsize(path)
    except Exception:
        print("{}"); return
    want = int(sys.argv[2]) if len(sys.argv) > 2 else None
    # Read back from the end in growing chunks until enough tool calls are in view: big tool
    # results (screenshots) can push the last few calls far from the end. At most 8 MB.
    span, lines = 262144, []
    with open(path, "rb") as f:
        while True:
            f.seek(max(0, size - span))
            lines = f.read().splitlines()
            if span >= size or span >= 8 << 20 or sum(b'"type":"tool_use"' in l for l in lines) >= (want or 1) + 2:
                break
            span *= 4
    found = []
    for raw in reversed(lines):
        if b'"tool_use"' not in raw:
            continue
        try:
            d = json.loads(raw)
        except ValueError:
            continue
        if d.get("type") != "assistant" or d.get("isSidechain"):
            continue
        for c in reversed((d.get("message") or {}).get("content") or []):
            if isinstance(c, dict) and c.get("type") == "tool_use":
                name = c.get("name") or ""
                pretty = " ".join(name.split("__")[1:]).replace("_", " ") if name.startswith("mcp__") else name
                found.append({"verb": VERB.get(name, pretty), "detail": detail(c.get("input")), "ts": d.get("timestamp")})
                if want is None:
                    print(json.dumps(found[0])); return
                if len(found) >= want:
                    print(json.dumps({"tools": found[::-1], "path": path})); return
    print(json.dumps({"tools": found[::-1], "path": path}) if want is not None else "{}")


main()
