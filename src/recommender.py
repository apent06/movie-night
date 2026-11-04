from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
import re
import sqlite3
from zipfile import ZipFile

import numpy as np
import pandas as pd


@dataclass
class Model:
    movie_ids: np.ndarray
    counts: np.ndarray
    means: np.ndarray
    quality: np.ndarray
    neighbors: np.ndarray
    similarities: np.ndarray
    quality_weight: float

    def __post_init__(self):
        self.lookup = {int(movie_id): index for index, movie_id in enumerate(self.movie_ids)}


def load_data(archive: Path) -> tuple[pd.DataFrame, pd.DataFrame, dict]:
    with ZipFile(archive) as source:
        ratings = pd.read_csv(BytesIO(source.read("ml-latest-small/ratings.csv")))
        movies = pd.read_csv(BytesIO(source.read("ml-latest-small/movies.csv")))
    raw_count = len(ratings)
    ratings = ratings[ratings.rating.between(0.5, 5)].copy()
    duplicate_count = int(ratings.duplicated(["userId", "movieId"]).sum())
    ratings = ratings.sort_values(["timestamp", "movieId"]).drop_duplicates(["userId", "movieId"], keep="last")
    ratings = ratings[ratings.movieId.isin(movies.movieId)].reset_index(drop=True)
    def title(value):
        match = re.match(r"^(.*), (The|A|An) (\(\d{4}\))$", value)
        return f"{match[2]} {match[1]} {match[3]}" if match else value
    movies["title"] = movies.title.map(title)
    audit = {
        "raw_ratings": raw_count,
        "ratings": len(ratings),
        "users": int(ratings.userId.nunique()),
        "movies": int(ratings.movieId.nunique()),
        "duplicate_pairs_removed": duplicate_count,
        "rating_date_end": str(pd.to_datetime(ratings.timestamp.max(), unit="s", utc=True).date()),
    }
    return ratings, movies, audit


def fit_model(ratings: pd.DataFrame, shrinkage: float = 25, quality_weight: float = 0.1,
              minimum_ratings: int = 5, neighbors: int = 120) -> Model:
    """Adjusted cosine between movies, reduced when few viewers rated both."""
    with sqlite3.connect(":memory:") as connection:
        ratings.to_sql("ratings", connection, index=False)
        query = (Path(__file__).resolve().parents[1] / "movie_stats.sql").read_text(encoding="utf-8")
        statistics = pd.read_sql_query(query, connection).set_index("movieId")
    statistics = statistics[statistics.n >= minimum_ratings]
    movie_ids = statistics.index.to_numpy(dtype=int)
    users = np.sort(ratings.userId.unique())
    user_lookup = {int(user): index for index, user in enumerate(users)}
    movie_lookup = {int(movie): index for index, movie in enumerate(movie_ids)}
    subset = ratings[ratings.movieId.isin(movie_ids)]
    rows = subset.movieId.map(movie_lookup).to_numpy(dtype=int)
    columns = subset.userId.map(user_lookup).to_numpy(dtype=int)
    user_means = ratings.groupby("userId").rating.mean()
    centered = (subset.rating - subset.userId.map(user_means)).to_numpy(dtype=np.float32)
    matrix = np.zeros((len(movie_ids), len(users)), dtype=np.float32)
    observed = np.zeros_like(matrix)
    matrix[rows, columns] = centered
    observed[rows, columns] = 1
    norms = np.sqrt(np.sum(matrix * matrix, axis=1))
    denominator = norms[:, None] * norms[None, :]
    similarity = matrix @ matrix.T
    np.divide(similarity, denominator, out=similarity, where=denominator > 0)
    similarity[denominator == 0] = 0
    overlap = observed @ observed.T
    similarity *= overlap / (overlap + shrinkage)
    similarity[overlap < 3] = 0
    similarity = np.maximum(similarity, 0)
    np.fill_diagonal(similarity, 0)
    k = min(neighbors, max(1, len(movie_ids) - 1))
    indices = np.argpartition(similarity, -k, axis=1)[:, -k:]
    values = np.take_along_axis(similarity, indices, axis=1)
    order = np.argsort(-values, axis=1, kind="stable")
    indices = np.take_along_axis(indices, order, axis=1)
    values = np.take_along_axis(values, order, axis=1)
    global_mean = float(ratings.rating.mean())
    bayesian_mean = (statistics.n * statistics.mean_rating + 20 * global_mean) / (statistics.n + 20)
    quality = (bayesian_mean.to_numpy() - 0.5) / 4.5
    return Model(movie_ids, statistics.n.to_numpy(dtype=int), statistics.mean_rating.to_numpy(), quality,
                 indices, values, quality_weight)


def rank(model: Model, preferences: dict[int, float], limit: int = 10,
         excluded: set[int] | None = None, genre: str | None = None,
         metadata: dict[int, dict] | None = None) -> list[dict]:
    affinity = np.zeros(len(model.movie_ids), dtype=np.float64)
    evidence = np.zeros(len(model.movie_ids), dtype=np.float64)
    reasons = np.full(len(model.movie_ids), -1, dtype=int)
    weight_sum = 0.0
    for movie_id, rating in preferences.items():
        if movie_id not in model.lookup:
            continue
        index = model.lookup[movie_id]
        weight = (float(rating) - 3.0) / 2.0
        weight_sum += abs(weight)
        contribution = weight * model.similarities[index]
        np.add.at(affinity, model.neighbors[index], contribution)
        if weight > 0:
            for neighbor, value in zip(model.neighbors[index], contribution):
                if value > evidence[neighbor]:
                    evidence[neighbor] = value
                    reasons[neighbor] = movie_id
    if weight_sum:
        affinity /= weight_sum
    scores = affinity + model.quality_weight * model.quality
    seen = set(preferences) | (excluded or set())
    valid = model.counts >= 10
    for movie_id in seen:
        if movie_id in model.lookup:
            valid[model.lookup[movie_id]] = False
    if genre and metadata:
        valid &= np.array([genre in metadata[int(movie_id)]["genres"] for movie_id in model.movie_ids])
    candidates = np.flatnonzero(valid)
    # A stable movie-ID tie break is also used by the browser implementation.
    ordered = sorted(candidates, key=lambda i: (-scores[i], int(model.movie_ids[i])))[:limit]
    return [{"movie_id": int(model.movie_ids[i]), "score": float(scores[i]),
             "reason_id": int(reasons[i]) if evidence[i] > 0 else None,
             "personalized": bool(evidence[i] > 0)} for i in ordered]


def make_metadata(model: Model, movies: pd.DataFrame) -> dict[int, dict]:
    lookup = movies.set_index("movieId")
    result = {}
    for movie_id, count in zip(model.movie_ids, model.counts):
        row = lookup.loc[int(movie_id)]
        year_match = re.search(r"\((\d{4})\)$", row.title)
        result[int(movie_id)] = {
            "id": int(movie_id), "title": row.title,
            "year": int(year_match[1]) if year_match else None,
            "genres": [genre for genre in row.genres.split("|") if genre != "(no genres listed)"],
            "ratingCount": int(count),
        }
    return result
