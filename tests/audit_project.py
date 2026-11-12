#!/usr/bin/env python3
"""Static sanity checks for Review Words. Run: python tests/audit_project.py"""
from pathlib import Path
from html.parser import HTMLParser
from collections import Counter
import json, subprocess, sys

ROOT = Path(__file__).resolve().parents[1]
class Parser(HTMLParser):
    def __init__(self):
        super().__init__(); self.ids=[]; self.refs=[]
    def handle_starttag(self, tag, attrs):
        attrs=dict(attrs)
        if attrs.get("id"): self.ids.append(attrs["id"])
        if tag in ("script","link"):
            ref=attrs.get("src") or attrs.get("href")
            if ref and not ref.startswith(("http://","https://","data:","#")):
                self.refs.append(ref.split("?")[0])

p=Parser(); p.feed((ROOT/"index.html").read_text(encoding="utf-8"))
dups=[k for k,v in Counter(p.ids).items() if v>1]
missing=[x for x in p.refs if not (ROOT/x).exists()]
bad_json=[]
for f in ROOT.rglob("*.json"):
    try: json.loads(f.read_text(encoding="utf-8"))
    except Exception as e: bad_json.append(f"{f}: {e}")
bad_js=[]
for f in ROOT.rglob("*.js"):
    r=subprocess.run(["node","--check",str(f)],capture_output=True,text=True)
    if r.returncode: bad_js.append(f"{f}: {r.stderr}")
for label, errors in [("duplicate HTML IDs",dups),("missing local assets",missing),("invalid JSON",bad_json),("JavaScript syntax errors",bad_js)]:
    print(f"{label}: {'PASS' if not errors else 'FAIL'}")
    for e in errors: print("  -",e)
sys.exit(1 if dups or missing or bad_json or bad_js else 0)
