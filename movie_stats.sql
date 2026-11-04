SELECT
    movieId,
    COUNT(*) AS n,
    AVG(rating) AS mean_rating
FROM ratings
GROUP BY movieId
ORDER BY movieId;
