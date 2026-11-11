"""Rescore FLEURS Korean pilot reports with equivalent dates, units and scores."""
import json
import pathlib
import re
import sys
import unicodedata

DIGITS = dict(zip("영일이삼사오육칠팔구", range(10)))
UNITS = {"십": 10, "백": 100, "천": 1000, "만": 10000}


def value(words):
    total = part = 0
    for char in words.replace(" ", ""):
        if char in DIGITS:
            part = DIGITS[char]
        elif char == "만":
            total = (total + part or 1) * 10000
            part = 0
        else:
            total += (part or 1) * UNITS[char]
            part = 0
    return total + part


def normalize(text):
    text = unicodedata.normalize("NFKC", text).lower()
    text = re.sub(r"(?<=\d)\s*m(?=이며|이다|를|에|\b)", "미터", text)
    text = re.sub(r"(?<![가-힣])([영일이삼사오육칠팔구십백천만]+)\s*(?=년|월|미터|세트)",
                  lambda m: str(value(m[1])), text)
    text = re.sub(r"(\d+)\s*만\s*(?=년)", lambda m: str(int(m[1])*10000), text)
    text = re.sub(r"([일이삼사오육칠팔구0-9])\s*(?:대|:|-)\s*([일이삼사오육칠팔구0-9])(?=\s*이\s*된)",
                  lambda m: f"{DIGITS.get(m[1], m[1])}대{DIGITS.get(m[2], m[2])}", text)
    return "".join(c for c in text if c.isalnum())


def edit_distance(a, b):
    previous = list(range(len(b)+1))
    for i, x in enumerate(a, 1):
        row = [i]
        for j, y in enumerate(b, 1):
            row.append(min(previous[j]+1, row[j-1]+1, previous[j-1]+(x != y)))
        previous = row
    return previous[-1]


for name in sys.argv[1:]:
    path = pathlib.Path(name)
    report = json.loads(path.read_text())
    summary = report["summary"]
    groups = {}
    for row in report["rows"]:
        ref, actual = normalize(row["reference"]), normalize(row["transcript"])
        row["normalizedReferenceChars"] = len(ref)
        row["normalizedEdits"] = edit_distance(ref, actual)
        groups.setdefault(row["id"], []).append(row)
    for mode in summary:
        items = [r for r in report["rows"] if r["mode"] == mode]
        summary[mode]["normalizedCerPct"] = round(100 * sum(r["normalizedEdits"] for r in items)
                                                / sum(r["normalizedReferenceChars"] for r in items), 1)
    report["allModesNonExact"] = [key for key, rows in groups.items() if len(rows) == 3 and all(r["normalizedEdits"] for r in rows)]
    path.with_name("normalized.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps({"report": str(path), "summary": summary, "allModesNonExact": report["allModesNonExact"]}, ensure_ascii=False))
