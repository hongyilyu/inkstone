#!/usr/bin/env python3
"""Regenerate the deep-review knowledge base from rules.json.

Single source of truth: learnings/rules.json
Outputs (overwritten):     learnings/INDEX.md, learnings/by-category/<cat>.md

Used both for the initial bootstrap and by /deep-review-learn after new rules land,
so the human-readable catalog never drifts from the machine-readable rules.

Usage: python3 build_kb.py
"""
import json, os, collections, sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "learnings")
RULES = os.path.join(ROOT, "rules.json")
BYCAT = os.path.join(ROOT, "by-category")

CATEGORY_TITLES = {
    "correctness": "Correctness & logic",
    "concurrency-async": "Concurrency & async",
    "error-handling": "Error handling",
    "security": "Security",
    "resource-leak": "Resource leaks",
    "api-compat": "API & compatibility",
    "performance": "Performance",
    "data-persistence": "Data & persistence",
    "code-quality": "Code quality & drift",
    "testing": "Testing",
    "types": "Types",
    "ui-react": "UI (React/Solid)",
}
SEV_ORDER = {"blocking": 0, "important": 1, "nit": 2}


def load():
    with open(RULES) as f:
        data = json.load(f)
    return data.get("rules", data) if isinstance(data, dict) else data


def write_category_files(rules):
    os.makedirs(BYCAT, exist_ok=True)
    by_cat = collections.defaultdict(list)
    for r in rules:
        by_cat[r["category"]].append(r)
    # clear stale category files
    for fn in os.listdir(BYCAT):
        if fn.endswith(".md"):
            os.remove(os.path.join(BYCAT, fn))
    for cat, rs in by_cat.items():
        rs.sort(key=lambda r: (SEV_ORDER.get(r.get("severity"), 9),
                               -r.get("support_count", 0)))
        title = CATEGORY_TITLES.get(cat, cat)
        lines = [f"# Learned rules — {title} (`{cat}`)", "",
                 f"_{len(rs)} rules. Loaded by the `dr-{cat}` specialist. "
                 "Generated from rules.json — do not edit by hand; run build_kb.py._", ""]
        for r in rs:
            prs = ", ".join(f"#{p}" for p in r.get("example_prs", [])[:6])
            lines += [
                f"## {r['title']}  ·  `{r['id']}`",
                f"- **Severity:** {r.get('severity','?')}  ·  **Support:** {r.get('support_count','?')}"
                + (f"  ·  **Seen in:** {prs}" if prs else ""),
                f"- **Rule:** {r['rule']}",
                f"- **Detect:** {r['detection_hint']}",
                "",
            ]
        with open(os.path.join(BYCAT, f"{cat}.md"), "w") as f:
            f.write("\n".join(lines))
    return by_cat


def write_index(rules, by_cat):
    total = len(rules)
    sev = collections.Counter(r.get("severity") for r in rules)
    lines = [
        "# deep-review learned rules — INDEX", "",
        f"**{total} canonical rules** across **{len(by_cat)} categories** "
        f"({sev.get('blocking',0)} blocking · {sev.get('important',0)} important · {sev.get('nit',0)} nit).",
        "",
        "Distilled from real PR review history. Every `/deep-review` loads these; "
        "`/deep-review-learn` adds to them. Machine-readable source: `rules.json`.",
        "",
        "| Category | Rules | File |",
        "|---|---|---|",
    ]
    for cat in sorted(by_cat, key=lambda c: -len(by_cat[c])):
        title = CATEGORY_TITLES.get(cat, cat)
        lines.append(f"| {title} (`{cat}`) | {len(by_cat[cat])} | `by-category/{cat}.md` |")
    lines += ["", "## All rules (by category)", ""]
    for cat in sorted(by_cat, key=lambda c: -len(by_cat[c])):
        lines.append(f"### {CATEGORY_TITLES.get(cat, cat)}")
        for r in sorted(by_cat[cat], key=lambda r: (SEV_ORDER.get(r.get('severity'),9), -r.get('support_count',0))):
            lines.append(f"- `{r['id']}` ({r.get('severity','?')}): {r['rule']}")
        lines.append("")
    with open(os.path.join(ROOT, "INDEX.md"), "w") as f:
        f.write("\n".join(lines))


def main():
    if not os.path.exists(RULES):
        print(f"no rules.json at {RULES}", file=sys.stderr)
        sys.exit(1)
    rules = load()
    by_cat = write_category_files(rules)
    write_index(rules, by_cat)
    print(f"KB rebuilt: {len(rules)} rules, {len(by_cat)} categories -> INDEX.md + by-category/")


if __name__ == "__main__":
    main()
