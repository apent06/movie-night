"""Evaluate the recommender and export the same model used by the browser."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from zipfile import ZipFile

import numpy as np
import pandas as pd

from src.recommender import fit_model, load_data, make_metadata, rank


ROOT = Path(__file__).resolve().parent
SEED = 42
EXAMPLES = {
    "Sci-fi": {2571: 5, 79132: 5, 109487: 4, 72998: 2},
    "Comedy": {54503: 5, 60756: 4, 69122: 5},
    "Animation": {1: 5, 6377: 5, 8961: 4, 4306: 4},
}


def cases(ratings: pd.DataFrame, model) -> list[dict]:
    result = []
    for user_id, history in ratings.groupby("userId"):
        history = history[history.movieId.isin(model.lookup)].sort_values(["timestamp", "movieId"])
        if len(history) < 10:
            continue
        first = history.iloc[:5]
        if not (first.rating >= 4).any():
            continue
        preferences = {int(row.movieId): float(row.rating) for row in first.itertuples()}
        later = history.iloc[5:]
        favorites = {int(row.movieId) for row in later.itertuples()
                     if row.rating >= 4 and model.counts[model.lookup[int(row.movieId)]] >= 10}
        if favorites:
            result.append({"user_id": int(user_id), "preferences": preferences, "favorites": favorites})
    return result


def evaluate(model, evaluation_cases: list[dict], baseline: str | None = None) -> tuple[dict, list[float]]:
    hits, recalls = [], []
    for case in evaluation_cases:
        if baseline:
            values = model.counts if baseline == "most_rated" else model.quality
            candidates = [i for i, movie in enumerate(model.movie_ids)
                          if model.counts[i] >= 10 and int(movie) not in case["preferences"]]
            ordered = sorted(candidates, key=lambda i: (-values[i], int(model.movie_ids[i])))[:10]
            recommended = {int(model.movie_ids[i]) for i in ordered}
        else:
            recommended = {row["movie_id"] for row in rank(model, case["preferences"], limit=10)}
        count = len(recommended & case["favorites"])
        hits.append(float(count))
        recalls.append(count / len(case["favorites"]))
    return {
        "users": len(evaluation_cases),
        "mean_hidden_favorites_in_top_10": float(np.mean(hits)),
        "mean_recall_at_10": float(np.mean(recalls)),
        "share_of_users_with_a_hit": float(np.mean(np.array(hits) > 0)),
    }, hits


def run_evaluation(ratings: pd.DataFrame) -> dict:
    rng = np.random.default_rng(SEED)
    users = rng.permutation(np.sort(ratings.userId.unique()))
    test_users, validation_users, training_users = users[:61], users[61:122], users[122:]
    train = ratings[ratings.userId.isin(training_users)]
    validation = ratings[ratings.userId.isin(validation_users)]
    test = ratings[ratings.userId.isin(test_users)]
    trials = []
    baseline_validation = {}
    for shrinkage in (10, 25, 50):
        model = fit_model(train, shrinkage=shrinkage)
        validation_cases = cases(validation, model)
        if not baseline_validation:
            baseline_validation = {name: evaluate(model, validation_cases, name)[0]
                                   for name in ("most_rated", "bayesian_rating")}
        for quality_weight in (0.0, 0.1, 0.25):
            model.quality_weight = quality_weight
            metrics, _ = evaluate(model, validation_cases)
            trials.append({"shrinkage": shrinkage, "quality_weight": quality_weight, **metrics})
    selected = max(trials, key=lambda row: row["mean_hidden_favorites_in_top_10"])
    selected_baseline = max(baseline_validation, key=lambda name: baseline_validation[name]["mean_hidden_favorites_in_top_10"])
    # All test users remain unseen. Validation users may now contribute to the fit.
    train_validation = ratings[~ratings.userId.isin(test_users)]
    model = fit_model(train_validation, shrinkage=selected["shrinkage"], quality_weight=selected["quality_weight"])
    test_cases = cases(test, model)
    model_metrics, model_hits = evaluate(model, test_cases)
    baseline_metrics = {}
    baseline_hits = {}
    for name in ("most_rated", "bayesian_rating"):
        baseline_metrics[name], baseline_hits[name] = evaluate(model, test_cases, name)
    differences = np.array(model_hits) - np.array(baseline_hits[selected_baseline])
    bootstrap = [float(np.mean(rng.choice(differences, size=len(differences), replace=True))) for _ in range(2000)]
    return {
        "seed": SEED,
        "task": "Five earliest supported ratings from an unseen user; rank the full eligible catalog for their later observed favorites (rating >= 4).",
        "split_users": {"training": len(training_users), "validation": len(validation_users), "test": len(test_users)},
        "selected_parameters": {"shrinkage": selected["shrinkage"], "quality_weight": selected["quality_weight"], "neighbors": 120},
        "validation_trials": trials,
        "validation_baselines": baseline_validation,
        "selected_baseline": selected_baseline,
        "test_model": model_metrics,
        "test_baselines": baseline_metrics,
        "paired_mean_hit_difference_95ci": [float(value) for value in np.quantile(bootstrap, [0.025, 0.975])],
    }


def write_evaluation(result: dict, audit: dict, catalog_size: int, recommendation_count: int):
    test = result["test_model"]
    baseline_name = result["selected_baseline"]
    baseline = result["test_baselines"][baseline_name]
    trials = "\n".join(
        f"| {row['shrinkage']} | {row['quality_weight']} | {row['mean_hidden_favorites_in_top_10']:.2f} |"
        for row in result["validation_trials"]
    )
    baseline_rows = "\n".join(
        f"| {name.replace('_', ' ')} | {row['mean_hidden_favorites_in_top_10']:.2f} | {row['share_of_users_with_a_hit']:.1%} |"
        for name, row in result["test_baselines"].items()
    )
    text = f"""# Evaluation

The task is to recommend movies to a new user after seeing five of their ratings. A recommendation earns a hit if it appears among that user's later observed ratings of 4 stars or more.

On **{test['users']} eligible test users**, the personalized model returned an average of **{test['mean_hidden_favorites_in_top_10']:.2f} known later favorites in ten suggestions**. The baseline selected using validation users returned **{baseline['mean_hidden_favorites_in_top_10']:.2f}**. At least one known favorite appeared for **{test['share_of_users_with_a_hit']:.1%}** of test users.

| Method | Known favorites in top 10, average | Users with at least one hit |
|---|---:|---:|
{baseline_rows}
| Personalized model | {test['mean_hidden_favorites_in_top_10']:.2f} | {test['share_of_users_with_a_hit']:.1%} |

The paired bootstrap interval for the mean difference against the selected baseline is **{result['paired_mean_hit_difference_95ci'][0]:.2f} to {result['paired_mean_hit_difference_95ci'][1]:.2f}** favorites per user. This is a small exploratory test, not a measure of how often a new person will enjoy a suggestion.

## Split and tuning

- Split users, not rating rows: 488 training users, 61 validation users, and 61 test users using seed 42. Test users contribute no ratings to the evaluation model.
- For each held-out user, take their five earliest ratings for supported movies as the profile. Later ratings of at least 4 stars become the hidden favorites. Users need at least ten supported ratings, one positive profile rating, and one eligible later favorite.
- Rank the full eligible catalog. Unknown movies receive no credit, but they are not treated as proven dislikes. Do not interpret this as a live A/B test.
- Tune only on validation users, using the average number of hits in the first ten results. Refit on training plus validation users before the final test.
- Once evaluation is complete, fit the downloadable app on all {audit['users']} users. The displayed evaluation numbers belong to the held-out experiment, not that final refit.

| Similarity shrinkage | Rating-quality weight | Validation hits in top 10 |
|---|---|---:|
{trials}

## Model

SQL calculates movie counts and mean ratings. For each viewer, subtract their average rating to account for people who use the star scale differently. Compare movie rating patterns with adjusted cosine similarity. Reduce similarities based on few shared viewers, keep positive neighbors, and retain up to 120 neighbors per movie.

At recommendation time, ratings above 3 add support to related movies and ratings below 3 subtract it. A small rating-quality term supplies a fallback. Already rated or marked-seen movies are removed, and the genre filter is applied before choosing results. Explanations name the positively rated seed contributing the most support. Model scores order candidates; they are not calibrated probabilities.

## Data and limits

The pinned MovieLens small snapshot contains {audit['ratings']:,} ratings, {audit['users']} users, and {audit['movies']:,} rated movies. Duplicate user/movie pairs removed: {audit['duplicate_pairs_removed']}. The app supports {catalog_size:,} movies with at least five ratings; {recommendation_count:,} have the ten ratings required to be recommended. Ratings end on {audit['rating_date_end']}, so newer releases are absent.

There are few users, and viewers choose which films they rate. The evaluation favors well-observed movies and cannot establish satisfaction for every unknown title. The five-rating test profile is a simplification of real onboarding. Local browser ratings are not sent to a server.

Source: Harper and Konstan (2015), [The MovieLens Datasets: History and Context](https://doi.org/10.1145/2827872). See `DATA_LICENSE.txt` for the original dataset terms and `data/ml-latest-small.zip` for the pinned source snapshot.
"""
    (ROOT / "EVALUATION.md").write_text(text, encoding="utf-8")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-evaluation", action="store_true")
    args = parser.parse_args()
    archive = ROOT / "data" / "ml-latest-small.zip"
    if not archive.exists():
        raise SystemExit("Run python download_data.py first.")
    ratings, movies, audit = load_data(archive)
    (ROOT / "results").mkdir(exist_ok=True)
    evaluation_path = ROOT / "results" / "evaluation.json"
    if args.skip_evaluation and evaluation_path.exists():
        evaluation = json.loads(evaluation_path.read_text(encoding="utf-8"))
    else:
        evaluation = run_evaluation(ratings)
        evaluation_path.write_text(json.dumps(evaluation, indent=2), encoding="utf-8")
    params = evaluation["selected_parameters"]
    model = fit_model(ratings, shrinkage=params["shrinkage"], quality_weight=params["quality_weight"])
    metadata = make_metadata(model, movies)
    items = []
    for index, movie_id in enumerate(model.movie_ids):
        item = {**metadata[int(movie_id)], "quality": round(float(model.quality[index]), 8)}
        item["neighbors"] = [[int(neighbor), round(float(value), 8)]
                             for neighbor, value in zip(model.neighbors[index], model.similarities[index]) if value > 0]
        items.append(item)
    payload = {
        "version": 1, "qualityWeight": params["quality_weight"],
        "catalogDate": audit["rating_date_end"], "movies": items,
        "examples": [{"name": name, "ratings": [{"id": movie, "rating": rating} for movie, rating in profile.items()]}
                     for name, profile in EXAMPLES.items()],
    }
    (ROOT / "web" / "data.js").write_text("window.MOVIE_NIGHT = " + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n", encoding="utf-8")
    golden = {name: {"ratings": [{"id": movie, "rating": rating} for movie, rating in profile.items()],
                     "top10": [row["movie_id"] for row in rank(model, profile, limit=10)]}
              for name, profile in EXAMPLES.items()}
    (ROOT / "results" / "browser_parity.json").write_text(json.dumps(golden, indent=2), encoding="utf-8")
    with ZipFile(archive) as source:
        (ROOT / "DATA_LICENSE.txt").write_bytes(source.read("ml-latest-small/README.txt"))
    write_evaluation(evaluation, audit, len(model.movie_ids), int(np.sum(model.counts >= 10)))
    print(json.dumps({"parameters": params, "test": evaluation["test_model"],
                      "baselines": evaluation["test_baselines"], "catalog": len(model.movie_ids),
                      "data_js_bytes": (ROOT / "web" / "data.js").stat().st_size}, indent=2))


if __name__ == "__main__":
    main()
