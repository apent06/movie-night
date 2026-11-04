# Movie Night

Rate a few movies and get suggestions for what to watch next. The watched list keeps track of films you've finished and leaves them out of future picks.

![Movie Night](preview.png)

## Try it

Download and extract the project, then open **web/index.html**. The catalog and model are included; the browser demo needs no installation.

1. Search for films you've seen and rate at least three, including one you liked.
2. Choose a genre and ask for five or ten suggestions.
3. Click **Mark watched** to save a film. Open **Watched** to search, rate, or remove entries.

Sample profiles let you try the picker without adding films to your log. Your own entries stay in the same browser and page location. Export CSV for a backup; clearing browser data removes the saved list. You can add missing films manually, but those entries are only used by the log.

## How it works

Python compares movie-rating patterns from MovieLens viewers. High ratings support related titles, while low ratings reduce that support. SQL calculates movie-level rating summaries, and JavaScript runs the exported model in the browser. Each suggestion names the liked movie contributing the most support.

The data ends in September 2018, so recent releases are missing from the recommendation catalog.

## Evaluation

On 52 held-out test users, the model returned **2.65 known later favorites in ten suggestions**, compared with **2.85** for the most-rated baseline. It did not beat that baseline in this test. [Evaluation notes](EVALUATION.md) explain the split, tuning, and limits.

## Rebuild and test

The model was built with Python 3.12. Install the dependencies in a virtual environment, then run:

```bash
python -m pip install -r requirements.txt
python -m unittest discover -s tests -v
python build_model.py --skip-evaluation
```

Run `python build_model.py` to repeat the full evaluation. The included dataset is checked against a pinned checksum.

Browser checks use Node.js and Playwright:

```bash
npm install
npx playwright install chromium
npm run test:browser
```

## Data

The MovieLens small snapshot contains 100,836 ratings from 610 users. Source: Harper and Konstan (2015), [The MovieLens Datasets: History and Context](https://doi.org/10.1145/2827872), and the [GroupLens dataset page](https://grouplens.org/datasets/movielens/latest/).

The data and derived model are provided under the research terms in [DATA_LICENSE.txt](DATA_LICENSE.txt), including attribution and permission for commercial use. This project is independent of GroupLens.
