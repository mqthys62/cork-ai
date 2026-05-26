<?php
/**
 * cork-ai telemetry endpoint — deploy on o2switch (or any PHP host)
 *
 * Setup:
 *   1. Create MySQL table: run scripts/telemetry-schema.sql
 *   2. Fill in DB credentials below (never commit this file with real credentials)
 *   3. Upload to your server, e.g. https://yourdomain.com/cork-ai-telemetry.php
 *   4. Set TELEMETRY_ENDPOINT in src/cli/index.ts to that URL
 *   5. Test: curl -X POST https://yourdomain.com/cork-ai-telemetry.php \
 *            -H 'Content-Type: application/json' \
 *            -d '{"v":"0.1.0","os":"linux","arch":"x64","savings_pct":63.2,"requests":1,"duration_min":0,"modules":{"hookReadCompressor":100}}'
 */

// ─── Database credentials (edit these) ───────────────────────────────────────
define('DB_HOST', 'localhost');
define('DB_NAME', 'YOUR_DB_NAME');
define('DB_USER', 'YOUR_DB_USER');
define('DB_PASS', 'YOUR_DB_PASSWORD');
// ─────────────────────────────────────────────────────────────────────────────

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'Method not allowed']);
    exit;
}

// ─── Parse body ──────────────────────────────────────────────────────────────

$body = file_get_contents('php://input');
if (!$body) {
    http_response_code(400);
    echo json_encode(['error' => 'Empty body']);
    exit;
}

$data = json_decode($body, true);
if (!$data || !isset($data['v'], $data['os'], $data['arch'], $data['savings_pct'])) {
    http_response_code(400);
    echo json_encode(['error' => 'Invalid payload']);
    exit;
}

// ─── Validate and sanitize ───────────────────────────────────────────────────

$version     = substr(preg_replace('/[^0-9a-z.\-]/', '', (string)($data['v'] ?? '')), 0, 20);
$os          = substr(preg_replace('/[^a-z0-9]/', '', (string)($data['os'] ?? '')), 0, 20);
$arch        = substr(preg_replace('/[^a-z0-9]/', '', (string)($data['arch'] ?? '')), 0, 20);
$savings_pct = min(100, max(0, (float)($data['savings_pct'] ?? 0)));
$requests    = min(10000, max(0, (int)($data['requests'] ?? 1)));
$duration    = min(1440, max(0, (int)($data['duration_min'] ?? 0)));
$modules_raw = $data['modules'] ?? [];

// Sanitize module keys and values (no file paths, just percentages)
$modules = [];
if (is_array($modules_raw)) {
    foreach ($modules_raw as $k => $v) {
        $clean_key = substr(preg_replace('/[^a-zA-Z0-9_]/', '', (string)$k), 0, 50);
        if ($clean_key) {
            $modules[$clean_key] = min(100, max(0, (float)$v));
        }
    }
}

if (!$version || !$os || !$arch) {
    http_response_code(400);
    echo json_encode(['error' => 'Missing required fields']);
    exit;
}

// ─── Insert (no IP stored) ───────────────────────────────────────────────────

try {
    $pdo = new PDO(
        "mysql:host=" . DB_HOST . ";dbname=" . DB_NAME . ";charset=utf8mb4",
        DB_USER,
        DB_PASS,
        [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
    );

    $stmt = $pdo->prepare("
        INSERT INTO telemetry_events
            (version, os, arch, savings_pct, requests, duration_min, modules)
        VALUES
            (:version, :os, :arch, :savings_pct, :requests, :duration_min, :modules)
    ");

    $stmt->execute([
        ':version'     => $version,
        ':os'          => $os,
        ':arch'        => $arch,
        ':savings_pct' => $savings_pct,
        ':requests'    => $requests,
        ':duration_min' => $duration,
        ':modules'     => json_encode($modules),
    ]);

    echo json_encode(['ok' => true]);

} catch (PDOException $e) {
    http_response_code(500);
    // Never expose DB details in the response
    echo json_encode(['error' => 'Database error']);
    error_log('[cork-ai telemetry] DB error: ' . $e->getMessage());
}
