-- cork-ai analytics queries — run in phpMyAdmin on the corktelemetry database

-- Average compression ratio per version
SELECT version, ROUND(AVG(savings_pct), 1) AS avg_savings, COUNT(*) AS events
FROM telemetry_events WHERE skipped = 0
GROUP BY version ORDER BY version DESC;

-- Skip rate (files not worth compressing)
SELECT
  ROUND(SUM(skipped) / COUNT(*) * 100, 1) AS skip_rate_pct,
  COUNT(*) AS total_events
FROM telemetry_events;

-- Which file types compress best
SELECT file_ext, ROUND(AVG(savings_pct), 1) AS avg_savings, COUNT(*) AS events
FROM telemetry_events WHERE skipped = 0 AND file_ext != ''
GROUP BY file_ext ORDER BY avg_savings DESC;

-- Which file types are most read (including skipped)
SELECT file_ext, COUNT(*) AS total, SUM(skipped) AS skipped, ROUND(AVG(savings_pct), 1) AS avg_savings
FROM telemetry_events WHERE file_ext != ''
GROUP BY file_ext ORDER BY total DESC LIMIT 20;

-- Compression type distribution
SELECT compress_type, COUNT(*) AS events, ROUND(AVG(savings_pct), 1) AS avg_savings
FROM telemetry_events WHERE skipped = 0
GROUP BY compress_type ORDER BY events DESC;

-- OS/arch distribution
SELECT os, arch, COUNT(*) AS cnt
FROM telemetry_events GROUP BY os, arch ORDER BY cnt DESC;

-- Daily activity (proxy for active users)
SELECT DATE(created_at) AS day, COUNT(*) AS events, ROUND(AVG(savings_pct), 1) AS avg_savings
FROM telemetry_events WHERE skipped = 0
GROUP BY day ORDER BY day DESC LIMIT 30;

-- Savings distribution buckets
SELECT
  CASE
    WHEN savings_pct < 20 THEN '< 20%'
    WHEN savings_pct < 40 THEN '20–40%'
    WHEN savings_pct < 60 THEN '40–60%'
    WHEN savings_pct < 80 THEN '60–80%'
    ELSE '> 80%'
  END AS bucket,
  COUNT(*) AS cnt
FROM telemetry_events WHERE skipped = 0
GROUP BY bucket ORDER BY MIN(savings_pct);

-- Version adoption over time
SELECT DATE(created_at) AS day, version, COUNT(*) AS events
FROM telemetry_events
GROUP BY day, version ORDER BY day DESC, events DESC LIMIT 60;
