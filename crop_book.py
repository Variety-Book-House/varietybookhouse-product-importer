#!/usr/bin/env python3
import cv2
import sys
import json
import numpy as np
from PIL import Image
from rembg import remove, new_session

MODEL_NAME = "isnet-general-use"

# isnet is a *salient object* segmenter, so on a busy cover it can return the
# cover artwork instead of the physical book. A book that fills less than this
# fraction of the frame is implausible on its own; below it we widen to the
# convex hull of all foreground, which recovers the printed features (title,
# blurb) that span the real book edges.
MIN_BOOK_FRACTION = 0.10


def crop_book(input_path, output_path, model_name=MODEL_NAME):
    img = Image.open(input_path).convert("RGB")
    arr = np.array(img)
    h, w = arr.shape[:2]
    total = w * h

    session = new_session(model_name)
    m = np.array(remove(img, session=session, only_mask=True))

    # Largest external blob: RETR_EXTERNAL already ignores interior holes, so a
    # barcode sticker punched out of the book does not split the contour.
    _, thresh = cv2.threshold(m, 127, 255, cv2.THRESH_BINARY)
    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        raise ValueError("No foreground found")

    c = max(contours, key=cv2.contourArea)
    area = cv2.contourArea(c)
    if area < total * 0.001:
        raise ValueError(f"Foreground too small ({area:.0f}px of {total}px)")

    # The hull has to be tried BEFORE giving up on a small mask: isnet returns the
    # salient artwork, so on a plain cover the largest blob alone is a fraction of
    # the frame while the hull of every blob spans the real book edges.
    if area < total * MIN_BOOK_FRACTION:
        floor = max(24.0, total * 0.00005)
        pieces = [x for x in contours if cv2.contourArea(x) >= floor]
        if len(pieces) > 1:
            c = cv2.convexHull(np.vstack(pieces))

    hull_area = cv2.contourArea(c)
    if hull_area < total * 0.02:
        raise ValueError(f"Book hull too small ({hull_area:.0f}px of {total}px)")

    # Axis-aligned bounding box only — NO rotation, NO perspective warp. These are
    # upright phone photos; the old deskew turned mask noise into a fake tilt and
    # visibly ROTATED the cover (back covers worst — the sticker strip poisons the
    # minAreaRect quad). A genuinely tilted book just keeps some background in the
    # corners instead of coming back rotated.
    x, y, bw, bh = cv2.boundingRect(c)
    x1, y1 = max(0, int(x)), max(0, int(y))
    x2, y2 = min(w, int(x + bw)), min(h, int(y + bh))
    if x2 - x1 < 2 or y2 - y1 < 2:
        raise ValueError("Degenerate bounding box crop")
    out = arr[y1:y2, x1:x2]

    # PNG so the Node side can re-encode to JPEG q90 without a second lossy pass
    Image.fromarray(out).save(output_path)
    return {"x": x1, "y": y1, "width": x2 - x1, "height": y2 - y1}


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python crop_book.py <input> <output> [model_name]")
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2]
    model_name = sys.argv[3] if len(sys.argv) > 3 else MODEL_NAME

    try:
        result = crop_book(input_path, output_path, model_name)
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)
