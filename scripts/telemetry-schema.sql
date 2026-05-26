-- cork-ai telemetry schema
-- Run once on your MySQL database before deploying telemetry-server.php

CREATE TABLE IF NOT EXISTS telemetry_events (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  created_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  version       VARCHAR(20)  NOT NULL,
  os            VARCHAR(20)  NOT NULL,
  arch          VARCHAR(20)  NOT NULL,
  savings_pct   DECIMAL(5,2) NOT NULL,
  requests      SMALLINT     NOT NULL DEFAULT 1,
  duration_min  SMALLINT     NOT NULL DEFAULT 0,
  modules       JSON         NOT NULL,

  INDEX idx_created_at (created_at),
  INDEX idx_version    (version),
  INDEX idx_os         (os)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ─── Useful analytics queries ─────────────────────────────────────────────────

-- Average compression ratio per cork-ai version
-- SELECT version, ROUND(AVG(savings_pct), 1) AS avg_savings, COUNT(*) AS events
-- FROM telemetry_events GROUP BY version ORDER BY version DESC;

-- OS distribution
-- SELECT os, arch, COUNT(*) AS cnt
-- FROM telemetry_events GROUP BY os, arch ORDER BY cnt DESC;

-- Daily active installs (proxy: distinct days with events)
-- SELECT DATE(created_at) AS day, COUNT(*) AS events, ROUND(AVG(savings_pct), 1) AS avg_savings
-- FROM telemetry_events GROUP BY day ORDER BY day DESC LIMIT 30;

-- Most effective module (which module string appears most in the JSON)
-- SELECT JSON_KEYS(modules) AS module_keys, COUNT(*) AS cnt
-- FROM telemetry_events GROUP BY module_keys LIMIT 20;

-- Savings distribution buckets
-- SELECT
--   CASE
--     WHEN savings_pct < 20 THEN '< 20%'
--     WHEN savings_pct < 40 THEN '20-40%'
--     WHEN savings_pct < 60 THEN '40-60%'
--     WHEN savings_pct < 80 THEN '60-80%'
--     ELSE '> 80%'
--   END AS bucket,
--   COUNT(*) AS cnt
-- FROM telemetry_events GROUP BY bucket ORDER BY MIN(savings_pct);
