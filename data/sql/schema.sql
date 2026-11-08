-- Lantern data on Tiger Data (managed TimescaleDB / Postgres).
-- Loaded by data/tiger_load.py. Safe to re-run.

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- NASA FIRMS active-fire detections (VIIRS S-NPP 375 m + MODIS 1 km), all of the US, 2025.
CREATE TABLE IF NOT EXISTS firms_detection (
  time        timestamptz      NOT NULL,
  lat         double precision NOT NULL,
  lon         double precision NOT NULL,
  frp         double precision,           -- fire radiative power, MW
  confidence  text,
  sensor      text             NOT NULL,  -- 'VIIRS S-NPP' | 'MODIS'
  daynight    text
);
SELECT create_hypertable('firms_detection', 'time', chunk_time_interval => INTERVAL '1 day', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS firms_detection_lat_lon_time ON firms_detection (lat, lon, time DESC);

-- Hourly wind (IEM ASOS), also a hypertable so the replay can be queried next to the detections.
CREATE TABLE IF NOT EXISTS wind_obs (
  time      timestamptz NOT NULL,
  station   text        NOT NULL,
  knots     double precision,
  dir_from  double precision,
  gust_kt   double precision
);
SELECT create_hypertable('wind_obs', 'time', chunk_time_interval => INTERVAL '1 day', if_not_exists => TRUE);

-- CAL FIRE Damage Inspection (DINS): every inspected structure in CA wildfires since 2013 (~130k).
CREATE TABLE IF NOT EXISTS dins_structure (
  objectid          bigint PRIMARY KEY,
  damage            text,
  structure_type    text,
  structure_category text,
  incident_name     text,
  incident_start    timestamptz,
  roof              text,
  eaves             text,
  vent_screen       text,
  exterior_siding   text,
  window_pane       text,
  deck_on_grade     text,
  deck_elevated     text,
  patio_cover       text,
  fence_attached    text,
  year_built        integer,
  fire_started_from text,
  assessed_value    double precision,
  lat               double precision,
  lon               double precision
);
CREATE INDEX IF NOT EXISTS dins_structure_incident ON dins_structure (incident_name);
