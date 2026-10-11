"""Generate test .apkg/.colpkg fixtures with the real Anki library.

    python -m venv .venv && .venv/bin/pip install anki
    .venv/bin/python scripts/make_fixtures.py tests/fixtures
"""
import base64
import os
import sys
import tempfile

from anki.collection import Collection, ExportAnkiPackageOptions

# 1x1 transparent PNG
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)


def build(path: str) -> Collection:
    col = Collection(path)
    deck_id = col.decks.id("Math::Algebra")
    col.media.write_data("dot.png", PNG)

    basic = col.models.by_name("Basic")
    note = col.new_note(basic)
    note["Front"] = r"Solve \(x^2 = 4\)"
    note["Back"] = r'\[x = \pm 2\] <img src="dot.png">'
    note.tags = ["algebra", "quadratic"]
    col.add_note(note, deck_id)

    reversed_ = col.models.by_name("Basic (and reversed card)")
    note = col.new_note(reversed_)
    note["Front"] = "Euler's identity"
    note["Back"] = r"\(e^{i\pi} + 1 = 0\)"
    col.add_note(note, deck_id)

    cloze = col.models.by_name("Cloze")
    note = col.new_note(cloze)
    note["Text"] = r"The derivative of {{c1::\(x^n\)}} is {{c2::\(n x^{n-1}\)::power rule}}"
    note["Back Extra"] = "Calculus"
    col.add_note(note, col.decks.id("Math::Calculus"))

    # Give the first card a review history so scheduling import can be tested.
    card = col.get_card(col.find_cards("tag:algebra")[0])
    card.type = card.queue = 2
    card.ivl = 10
    card.due = col.sched.today + 5
    card.factor = 2500
    card.reps = 3
    col.update_card(card)
    return col


def main(out_dir: str) -> None:
    os.makedirs(out_dir, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        col = build(os.path.join(tmp, "collection.anki2"))
        for legacy, name in [(False, "math.apkg"), (True, "math-legacy.apkg")]:
            col.export_anki_package(
                out_path=os.path.abspath(os.path.join(out_dir, name)),
                options=ExportAnkiPackageOptions(
                    with_scheduling=True, with_deck_configs=False,
                    with_media=True, legacy=legacy,
                ),
                limit=None,
            )
        col.export_collection_package(
            os.path.abspath(os.path.join(out_dir, "math.colpkg")),
            include_media=True, legacy=False,
        )
        col.close()


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "tests/fixtures")
