"""Exercise the untouched Python reference against portable fixture repositories."""
import sys
sys.dont_write_bytecode = True

import json
from pathlib import Path

project = Path(__file__).resolve().parents[2]
reference = project / "tests" / "reference" / "python"
sys.path.insert(0, str(reference))
import board

repo = Path(sys.argv[1])
mode = sys.argv[2]
if mode == "build":
    result = board.build(repo, with_git=sys.argv[3] == "git")
elif mode == "detail":
    snapshot = board.build(repo, with_git=sys.argv[3] == "git")
    result = board.detail(repo, snapshot, sys.argv[4])
elif mode == "readme":
    readme = board.parse_readme(sys.stdin.read())
    result = {
        "lanes": [{**lane.__dict__, "items": [item.as_dict() for item in lane.items]} for lane in readme.lanes],
        "owner_actions": readme.owner_actions,
        "links": sorted(readme.links),
    }
elif mode == "spec":
    spec = board.parse_spec(sys.stdin.read())
    result = {**spec.__dict__, "has_report": spec.has_report}
elif mode == "roadmap":
    result = board.roadmap(board.parse_readme(sys.stdin.read()).lanes)
elif mode == "helpers":
    values = json.loads(sys.stdin.read())
    result = {
        "plain": [board.plain(value) for value in values["plain"]],
        "classify": [board.classify(value) for value in values["classify"]],
        "split_row": [board.split_row(value) for value in values["split_row"]],
        "short_status": [board.short_status(value) for value in values["short_status"]],
        "split_heading": [board.split_heading(value) for value in values["split_heading"]],
        "slug": [board.slug(value) for value in values["slug"]],
    }
else:
    raise ValueError(f"Unknown mode: {mode}")
print(json.dumps(result, ensure_ascii=False))
