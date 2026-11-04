from hashlib import sha256
from pathlib import Path
from urllib.request import urlopen

URL = "https://files.grouplens.org/datasets/movielens/ml-latest-small.zip"
SHA256 = "696d65a3dfceac7c45750ad32df2c259311949efec81f0f144fdfb91ebc9e436"
DEST = Path(__file__).resolve().parent / "data" / "ml-latest-small.zip"


def main():
    DEST.parent.mkdir(exist_ok=True)
    if DEST.exists():
        content = DEST.read_bytes()
    else:
        with urlopen(URL, timeout=180) as response:
            content = response.read()
    if sha256(content).hexdigest() != SHA256:
        raise SystemExit("The dataset differs from the verified snapshot. Review the new release before rebuilding.")
    DEST.write_bytes(content)
    print(f"Dataset ready: {DEST}")


if __name__ == "__main__":
    main()
