"""Skills a Claude Code session loaded, read from its transcript.

Usage: python3 -I scan.py <claude pid> '<offsets json>'
Prints {"session", "offsets", "events"}; only lines past each file's offset are read,
so polling a long transcript stays cheap. A load is the meta message Claude Code adds
when a skill's SKILL.md is injected ("Base directory for this skill: <dir>"); it covers
both the Skill tool and a typed /slash command.
"""
import glob
import json
import os
import re
import sys

MARK = "Base directory for this skill: "
PATH_TOOLS = {"Bash", "Read"}
SKILL_PATH = re.compile(r"((?:~|[^\s\"'=:;|&()<>]*)(?:\.agents|\.claude)(?:/plugins/[^\s\"']*?)?/skills/([A-Za-z0-9_.-]+))")
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


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text")
    return ""


def scan(path, offset, sub, events, agent=None):
    try:
        size = os.path.getsize(path)
    except OSError:
        return offset
    if offset > size:
        offset = 0
    with open(path, "rb") as f:
        f.seek(offset)
        data = f.read()
    end = data.rfind(b"\n")
    if end < 0:
        return offset
    for raw in data[: end + 1].splitlines():
        if b"Base directory for this skill" not in raw and b'"Skill"' not in raw and b"<command-name>" not in raw \
                and not (sub and b"skills/" in raw):
            continue
        try:
            d = json.loads(raw)
        except ValueError:
            continue
        msg = d.get("message") or {}
        ts = d.get("timestamp")
        if d.get("type") == "assistant" and isinstance(msg.get("content"), list):
            for c in msg["content"]:
                if isinstance(c, dict) and c.get("type") == "tool_use" and c.get("name") == "Skill":
                    inp = c.get("input") or {}
                    events.append({"kind": "call", "id": c.get("id"), "skill": inp.get("skill"), "args": inp.get("args") or "", "ts": ts, "sub": sub, "agent": agent})
                elif sub and isinstance(c, dict) and c.get("type") == "tool_use" and c.get("name") in PATH_TOOLS:
                    # Sub-agents rarely call the Skill tool: they run a skill's scripts or read its
                    # files by path, as the skill that dispatched them says to.
                    inp = c.get("input") or {}
                    text = " ".join(str(inp.get(k) or "") for k in ("command", "file_path", "path"))
                    for folder, name in dict.fromkeys(SKILL_PATH.findall(text)):
                        events.append({"kind": "path", "skill": name, "folder": folder.replace("~", HOME, 1),
                                       "tool": c.get("name"), "ts": ts, "sub": sub, "agent": agent})
        elif d.get("type") == "user":
            s = text_of(msg.get("content"))
            if d.get("isMeta") and s.startswith(MARK):
                folder = s[len(MARK):].split("\n", 1)[0].strip()
                events.append({"kind": "load", "folder": folder, "skill": os.path.basename(folder), "id": d.get("sourceToolUseID"), "ts": ts, "sub": sub, "agent": agent})
            elif "<command-name>" in s:
                name = re.search(r"<command-name>/?([^<]*)</command-name>", s)
                args = re.search(r"<command-args>(.*?)</command-args>", s, re.S)
                if name:
                    events.append({"kind": "slash", "skill": name.group(1), "args": (args.group(1).strip() if args else ""), "ts": ts, "sub": sub, "agent": agent})
    return offset + end + 1


def main():
    pid = sys.argv[1]
    offsets = json.loads(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2] else {}
    try:
        with open(session_file(pid) or "") as f:
            info = json.load(f)
    except (OSError, ValueError):
        print(json.dumps({"session": None}))
        return
    sid, cwd = info.get("sessionId"), info.get("cwd") or ""
    projects = os.path.join(HOME, ".claude", "projects")
    main_path = os.path.join(projects, re.sub(r"[^A-Za-z0-9]", "-", cwd), f"{sid}.jsonl")
    if not os.path.exists(main_path):
        found = glob.glob(os.path.join(projects, "*", f"{sid}.jsonl"))
        main_path = found[0] if found else main_path
    events, out = [], {}
    out[main_path] = scan(main_path, offsets.get(main_path, 0), False, events)
    agents = {}
    for p in sorted(glob.glob(os.path.join(main_path[:-6], "subagents", "**", "*.jsonl"), recursive=True)):
        aid = os.path.basename(p)[:-6]
        try:
            with open(p[:-6] + ".meta.json") as f:
                meta = json.load(f)
        except (OSError, ValueError):
            meta = {}
        desc = meta.get("description") or True
        out[p] = scan(p, offsets.get(p, 0), desc, events, aid)
        # What the agent switcher needs to name the agent it shows: type and start time.
        agents[aid] = {"type": meta.get("agentType"), "description": meta.get("description"),
                       "finished": bool(meta.get("finished")), "start": first_ts(p)}
    print(json.dumps({"session": sid, "name": info.get("name"), "transcript": main_path, "offsets": out, "events": events, "agents": agents}))


def first_ts(path):
    try:
        with open(path, "rb") as f:
            for _ in range(20):
                raw = f.readline()
                if not raw:
                    break
                m = re.search(rb'"timestamp":"([^"]+)"', raw)
                if m:
                    return m.group(1).decode()
    except OSError:
        pass
    return None


if __name__ == "__main__":
    main()
