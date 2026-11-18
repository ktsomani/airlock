from __future__ import annotations

import html
import io
import json
import os
from pathlib import Path
import subprocess
import zipfile

VIEWPORTS = {"mobile": 390, "tablet": 768, "desktop": 1440}
MARKER = "<!-- airlock-visual-ci -->"


def api(endpoint: str, *args: str, body: dict | None = None) -> bytes:
    command = ["gh", "api", endpoint, *args]
    if body is not None:
        command += ["--input", "-"]
    return subprocess.run(command, input=None if body is None else json.dumps(body).encode(),
                          capture_output=True, check=True, timeout=45).stdout


def get(endpoint: str, *args: str):
    return json.loads(api(endpoint, *args))


def safe_label(value: object) -> str:
    if not isinstance(value, str) or len(value) > 150:
        raise ValueError("Invalid button label")
    label = html.escape(" ".join(value.split()))
    return label.translate(str.maketrans({
        char: f"&#{ord(char)};" for char in "`[]()!@*_~|"
    }))


def format_comment(summary: dict, report_url: str, commit: str) -> str:
    if summary.get("component") != "merge-toolbar":
        raise ValueError("Unexpected component")
    entries = summary.get("viewports")
    if not isinstance(entries, list) or len(entries) != len(VIEWPORTS):
        raise ValueError("Invalid viewport results")
    seen = set()
    changes = []
    for row in entries:
        key, width = row["viewport"], row["width"]
        if key not in VIEWPORTS or width != VIEWPORTS[key] or key in seen:
            raise ValueError("Unexpected viewport")
        seen.add(key)
        changed, total = row["changed_pixels"], row["compared_pixels"]
        if type(changed) is not int or type(total) is not int or not 0 <= changed <= total <= width * 1024 or total == 0:
            raise ValueError("Invalid pixel counts")
        if any(type(row[k]) is not bool for k in ("label_changed", "button_removed", "new_clipping")):
            raise ValueError("Invalid element checks")
        details = []
        if changed:
            details.append(f"{changed:,} pixels changed ({100 * changed / total:.2f}%)")
        if row["button_removed"]:
            details.append("Merge button removed")
        if row["new_clipping"]:
            details.append("Merge button now clips")
        if row["label_changed"]:
            details.append(f"Merge button label: <code>{safe_label(row['before_label'])}</code> → <code>{safe_label(row['after_label'])}</code>")
        if details:
            changes.append(f"- **{key.title()} ({width}px)** — " + "; ".join(details))
    return "\n".join([
        MARKER, "### Airlock visual review · Merge toolbar", "", *(
            changes or ["No changes detected at the three viewport widths."]
        ), "", f"[Download before, after, and red diff screenshots]({report_url})", "",
        f"Compared against the PR base at head `{commit[:12]}`.",
    ])


def main():
    payload = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text(encoding="utf-8"))
    run = payload["workflow_run"]
    repo = os.environ["GITHUB_REPOSITORY"]
    source = run["head_repository"]["full_name"]
    sha = run["head_sha"]
    if run["event"] != "pull_request" or run["conclusion"] != "success":
        return
    refs = run.get("pull_requests", [])
    if refs:
        numbers = [int(ref["number"]) for ref in refs]
        possible = [get(f"repos/{repo}/pulls/{number}") for number in numbers]
    else:
        possible = get(f"repos/{repo}/pulls", "-X", "GET", "-f",
                       "state=open", "-f", f"head={source.split('/')[0]}:{run['head_branch']}")
    matching = [pr for pr in possible if pr["state"] == "open"
                and pr["head"]["sha"] == sha and pr["head"]["repo"]["full_name"] == source
                and pr["base"]["repo"]["full_name"] == repo]
    if len(matching) != 1:
        print("No unique open PR matches this run and head. Skipping comment.")
        return
    number = int(matching[0]["number"])
    run_id = int(run["id"])
    artifacts = get(f"repos/{repo}/actions/runs/{run_id}/artifacts")["artifacts"]
    def find(name: str) -> dict:
        matches = [item for item in artifacts if item["name"] == name and not item["expired"]]
        if len(matches) != 1:
            raise ValueError(f"Missing or duplicate {name} artifact")
        return matches[0]
    summary = find("airlock-visual-summary")
    images = find("airlock-visual-screenshots")
    if not 0 < summary["size_in_bytes"] <= 128_000:
        raise ValueError("Unexpected summary artifact size")
    archive = api(f"repos/{repo}/actions/artifacts/{int(summary['id'])}/zip")
    with zipfile.ZipFile(io.BytesIO(archive)) as zipped:
        if zipped.namelist() != ["summary.json"] or zipped.getinfo("summary.json").file_size > 32_000:
            raise ValueError("Unexpected summary archive contents")
        report = json.loads(zipped.read("summary.json").decode("utf-8-sig"))
    url = f"https://github.com/{repo}/actions/runs/{run_id}/artifacts/{int(images['id'])}"
    message = format_comment(report, url, sha)
    endpoint = f"repos/{repo}/issues/{number}/comments"
    pages = get(endpoint, "--paginate", "--slurp")
    existing = next((comment for page in pages for comment in page
                     if comment["user"]["login"] == "github-actions[bot]" and comment["body"].startswith(MARKER)), None)
    # Recheck immediately before writing so an older run does not normally overwrite the latest review.
    current = get(f"repos/{repo}/pulls/{number}")
    if current["state"] != "open" or current["head"]["sha"] != sha:
        return
    if existing:
        api(f"repos/{repo}/issues/comments/{int(existing['id'])}", "-X", "PATCH", body={"body": message})
    else:
        api(endpoint, "-X", "POST", body={"body": message})


if __name__ == "__main__":
    main()
