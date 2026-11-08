-- Paste into the Tiger Console SQL editor (values filled in; data/sql/spread.sql is the parameterised version).
-- Eaton Fire front speed from NASA FIRMS, bucketed hourly with TimescaleDB time_bucket().
-- Ignition: 2025-01-07 18:18 PST at 34.2011, -118.0817 (most upwind detection of the first satellite pass).
WITH ignition AS (
  SELECT 34.2011::float8 AS lat, -118.0817::float8 AS lon, TIMESTAMPTZ '2025-01-07 18:18:00-08' AS t0
),
d AS (
  SELECT
    f.time,
    f.frp,
    f.sensor,
    i.t0,
    2 * 6371 * asin(sqrt(
      power(sin(radians(f.lat - i.lat) / 2), 2) +
      cos(radians(i.lat)) * cos(radians(f.lat)) * power(sin(radians(f.lon - i.lon) / 2), 2)
    )) AS km
  FROM firms_detection f, ignition i
  WHERE f.time >= i.t0
    AND f.time <  i.t0 + INTERVAL '3 days'
    AND f.lat BETWEEN 34.10 AND 34.30
    AND f.lon BETWEEN -118.25 AND -117.95
)
SELECT
  time_bucket(INTERVAL '1 hour', time)                                                   AS bucket_utc,
  count(*)                                                                               AS detections,
  string_agg(DISTINCT sensor, ', ')                                                      AS sensors,
  round((extract(epoch FROM (to_timestamp(avg(extract(epoch FROM time))) - min(t0))) / 3600)::numeric, 2) AS hours_since_ignition,
  round(max(km)::numeric, 2)                                                             AS max_km_from_ignition,
  round((max(km) / nullif(extract(epoch FROM (to_timestamp(avg(extract(epoch FROM time))) - min(t0))) / 3600, 0))::numeric, 3) AS front_speed_kmh,
  round(sum(frp)::numeric, 1)                                                            AS total_frp_mw
FROM d
GROUP BY bucket_utc
ORDER BY bucket_utc;
