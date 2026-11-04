# Evaluation

The task is to recommend movies to a new user after seeing five of their ratings. A recommendation earns a hit if it appears among that user's later observed ratings of 4 stars or more.

On **52 eligible test users**, the personalized model returned an average of **2.65 known later favorites in ten suggestions**. The baseline selected using validation users returned **2.85**. At least one known favorite appeared for **78.8%** of test users.

| Method | Known favorites in top 10, average | Users with at least one hit |
|---|---:|---:|
| most rated | 2.85 | 80.8% |
| bayesian rating | 2.27 | 78.8% |
| Personalized model | 2.65 | 78.8% |

The paired bootstrap interval for the mean difference against the selected baseline is **-0.63 to 0.19** favorites per user. This is a small exploratory test, not a measure of how often a new person will enjoy a suggestion.

## Split and tuning

- Split users, not rating rows: 488 training users, 61 validation users, and 61 test users using seed 42. Test users contribute no ratings to the evaluation model.
- For each held-out user, take their five earliest ratings for supported movies as the profile. Later ratings of at least 4 stars become the hidden favorites. Users need at least ten supported ratings, one positive profile rating, and one eligible later favorite.
- Rank the full eligible catalog. Unknown movies receive no credit, but they are not treated as proven dislikes. Do not interpret this as a live A/B test.
- Tune only on validation users, using the average number of hits in the first ten results. Refit on training plus validation users before the final test.
- Once evaluation is complete, fit the downloadable app on all 610 users. The displayed evaluation numbers belong to the held-out experiment, not that final refit.

| Similarity shrinkage | Rating-quality weight | Validation hits in top 10 |
|---|---|---:|
| 10 | 0.0 | 1.84 |
| 10 | 0.1 | 2.02 |
| 10 | 0.25 | 2.02 |
| 25 | 0.0 | 1.96 |
| 25 | 0.1 | 2.04 |
| 25 | 0.25 | 2.32 |
| 50 | 0.0 | 2.11 |
| 50 | 0.1 | 2.14 |
| 50 | 0.25 | 2.43 |

## Model

SQL calculates movie counts and mean ratings. For each viewer, subtract their average rating to account for people who use the star scale differently. Compare movie rating patterns with adjusted cosine similarity. Reduce similarities based on few shared viewers, keep positive neighbors, and retain up to 120 neighbors per movie.

At recommendation time, ratings above 3 add support to related movies and ratings below 3 subtract it. A small rating-quality term supplies a fallback. Already rated or marked-seen movies are removed, and the genre filter is applied before choosing results. Explanations name the positively rated seed contributing the most support. Model scores order candidates; they are not calibrated probabilities.

## Data and limits

The pinned MovieLens small snapshot contains 100,836 ratings, 610 users, and 9,724 rated movies. Duplicate user/movie pairs removed: 0. The app supports 3,650 movies with at least five ratings; 2,269 have the ten ratings required to be recommended. Ratings end on 2018-09-24, so newer releases are absent.

There are few users, and viewers choose which films they rate. The evaluation favors well-observed movies and cannot establish satisfaction for every unknown title. The five-rating test profile is a simplification of real onboarding. Local browser ratings are not sent to a server.

Source: Harper and Konstan (2015), [The MovieLens Datasets: History and Context](https://doi.org/10.1145/2827872). See `DATA_LICENSE.txt` for the original dataset terms and `data/ml-latest-small.zip` for the pinned source snapshot.
