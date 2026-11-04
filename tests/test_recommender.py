import unittest

import numpy as np

from src.recommender import Model, rank


def fixture():
    return Model(
        movie_ids=np.array([10, 20, 30, 40]),
        counts=np.array([20, 20, 20, 20]),
        means=np.array([4, 4, 4, 4]),
        quality=np.zeros(4),
        neighbors=np.array([[2, 3, 1], [2, 3, 0], [0, 1, 3], [0, 1, 2]]),
        similarities=np.array([[0.8, 0.4, 0], [0.9, 0, 0], [0.8, 0.9, 0], [0.4, 0, 0]]),
        quality_weight=0,
    )


class RecommendationTests(unittest.TestCase):
    def test_rated_and_seen_movies_are_excluded(self):
        result = rank(fixture(), {10: 5}, excluded={30})
        ids = [row["movie_id"] for row in result]
        self.assertNotIn(10, ids)
        self.assertNotIn(30, ids)
        self.assertEqual(ids[0], 40)

    def test_dislike_reduces_related_movie_support(self):
        model = fixture()
        self.assertEqual(rank(model, {10: 5})[0]["movie_id"], 30)
        self.assertEqual(rank(model, {10: 5, 20: 1})[0]["movie_id"], 40)

    def test_genre_filter_is_applied_before_results(self):
        metadata = {movie: {"genres": ["Comedy" if movie == 30 else "Drama"]} for movie in (10, 20, 30, 40)}
        result = rank(fixture(), {10: 5}, genre="Comedy", metadata=metadata)
        self.assertEqual([row["movie_id"] for row in result], [30])

    def test_explanation_names_a_positive_contributing_seed(self):
        result = rank(fixture(), {10: 5, 20: 1})
        self.assertEqual(result[0]["reason_id"], 10)
        self.assertTrue(result[0]["personalized"])


if __name__ == "__main__":
    unittest.main()
