-- cork-ai telemetry schema
-- Run once on your MySQL database (corktelemetry) before deploying telemetry-server.php

CREATE TABLE IF NOT EXISTS telemetry_events (
  id            INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  created_at    TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  version       VARCHAR(20)   NOT NULL,
  os            VARCHAR(20)   NOT NULL,
  arch          VARCHAR(20)   NOT NULL,
  savings_pct   DECIMAL(5,2)  NOT NULL,
  file_ext      VARCHAR(20)   NOT NULL DEFAULT '',   -- e.g. ".ts", ".py", ".json"
  compress_type VARCHAR(10)   NOT NULL DEFAULT '',   -- "code" | "json" | "text"
  skipped       TINYINT(1)    NOT NULL DEFAULT 0,    -- 1 = not compressed (too small or < 15% gain)

  INDEX idx_created_at   (created_at),
  INDEX idx_version      (version),
  INDEX idx_os           (os),
  INDEX idx_file_ext     (file_ext),
  INDEX idx_compress_type(compress_type),
  INDEX idx_skipped      (skipped)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
