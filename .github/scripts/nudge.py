"""Unblock Jules sessions that stopped to ask a question.

Lists recent sessions, and for each one in AWAITING_USER_FEEDBACK sends a fixed reply telling the
agent to decide on its own and finish. Needs JULES_API_KEY in the environment.

usage: python -I nudge.py [hours]   (default 24: only sessions created within the last N hours)
"""
import datetime as dt
import json
import os
import sys
import urllib.request

API = "https://jules.googleapis.com/v1alpha"
REPLY = (
    "No human is reading this session. Do not wait for an answer and do not ask again. "
    "Decide yourself using the priority order in your instructions: pick ONE defect that you can fix "
    "safely in under 100 lines, fix it, run the tests, and open the pull request. "
    "If no fix qualifies, finish without changes and without a pull request. "
    "Write the question you had, and the answer you chose, under \"Assumptions\" in the pull request body."
)
# INFO : a session that stops a second time gets one terse order to wrap up; after that it is left alone,
#   so an agent that keeps asking ends the run instead of looping forever
FINAL = (
    "Finish now. If you have a working fix, commit it and open the pull request as it is; "
    "otherwise end this session with no changes. Do not send another message."
)
REPLIES = (REPLY, FINAL)


def api(path: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        f"{API}/{path}", data=data,
        headers={"X-Goog-Api-Key": os.environ["JULES_API_KEY"], "Content-Type": "application/json"},
        method="POST" if body is not None else "GET",
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        raw = r.read()
        return json.loads(raw) if raw else {}


def main() -> None:
    hours = float(sys.argv[1]) if len(sys.argv) > 1 else 24
    since = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=hours)
    nudged = 0
    token = None
    while True:
        page = api("sessions?pageSize=100" + (f"&pageToken={token}" if token else ""))
        for s in page.get("sessions", []):
            if dt.datetime.fromisoformat(s["createTime"].replace("Z", "+00:00")) < since:
                print(f"nudged {nudged}")
                return
            if s["state"] != "AWAITING_USER_FEEDBACK":
                continue
            acts = api(f"{s['name']}/activities?pageSize=100").get("activities", [])
            sent = sum(1 for a in acts if a.get("userMessaged", {}).get("userMessage", "") in REPLIES)
            if sent >= len(REPLIES):
                print(f"skip  {s['id']} (already nudged {sent}x)")
                continue
            api(f"{s['name']}:sendMessage", {"prompt": REPLIES[sent]})
            nudged += 1
            print(f"nudge {s['id']} #{sent + 1} {s.get('title', '')[:40]}")
        token = page.get("nextPageToken")
        if not token:
            print(f"nudged {nudged}")
            return


if __name__ == "__main__":
    main()
