import json
from pathlib import Path

STORE_PATH = Path("/data/store.json")
USERNAME = "jodyrutter"
AVATAR = {
    "kind": "uploaded",
    "file": "dRNDFJjomzWfkUskcP3Ws.jpg",
    "updatedAt": "2026-04-24T02:54:19.000Z",
}


def main() -> None:
    data = json.loads(STORE_PATH.read_text(encoding="utf-8"))
    for user in data.get("security", {}).get("users", []):
        if user.get("username") == USERNAME:
            user["avatar"] = AVATAR
            user["updatedAt"] = AVATAR["updatedAt"]
            break
    STORE_PATH.write_text(json.dumps(data), encoding="utf-8")
    print("patched")


if __name__ == "__main__":
    main()
