-- Eaton Fire front speed from FIRMS, bucketed hourly with time_bucket().
-- Same method as data/firms_spread.py: distance from the ignition point to the farthest detection in
-- each 1-hour bucket, divided by hours since ignition.
-- Parameters (psycopg): %(lat)s, %(lon)s = ignition point; %(t0)s = ignition time.
WITH d AS (
  SELECT
    time,
    frp,
    sensor,
    2 * 6371 * asin(sqrt(
      power(sin(radians(lat - %(lat)s) / 2), 2) +
      cos(radians(%(lat)s)) * cos(radians(lat)) * power(sin(radians(lon - %(lon)s) / 2), 2)
    )) AS km
  FROM firms_detection
  WHERE time >= %(t0)s::timestamptz
    AND time <  %(t0)s::timestamptz + INTERVAL '3 days'
    AND lat BETWEEN 34.10 AND 34.30
    AND lon BETWEEN -118.25 AND -117.95
)
SELECT
  time_bucket(INTERVAL '1 hour', time)                                          AS bucket,
  count(*)                                                                      AS detections,
  string_agg(DISTINCT sensor, ', ')                                             AS sensors,
  round((extract(epoch FROM (to_timestamp(avg(extract(epoch FROM time))) - %(t0)s::timestamptz)) / 3600)::numeric, 2) AS hours_since_ignition,
  round(max(km)::numeric, 2)                                                    AS max_km_from_ignition,
  round((max(km) / nullif(extract(epoch FROM (to_timestamp(avg(extract(epoch FROM time))) - %(t0)s::timestamptz)) / 3600, 0))::numeric, 3) AS front_speed_kmh,
  round(sum(frp)::numeric, 1)                                                   AS total_frp_mw
FROM d
GROUP BY bucket
ORDER BY bucket;
