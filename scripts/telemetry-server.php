<?php
/**
 * cork-ai telemetry endpoint — deploy on o2switch
 *
 * Setup:
 *   1. Create MySQL table: run scripts/telemetry-schema.sql in phpMyAdmin
 *   2. Fill in DB credentials below
 *   3. Upload this file to the corktelemetry.essenly.fr subdomain folder
 *   4. Test: curl -X POST https://corktelemetry.essenly.fr/telemetry-server.php \
 *            -H 'Content-Type: application/json' \
 *            -d '{"v":"0.1.0","os":"linux","arch":"x64","savings_pct":63.2,"file_ext":".ts","compress_type":"code","skipped":false}'
 */

// ─── Database credentials ─────────────────────────────────────────────────────
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

// ─── Validate and sanitize ────────────────────────────────────────────────────

$version      = substr(preg_replace('/[^0-9a-z.\-]/', '', (string)($data['v'] ?? '')), 0, 20);
$os           = substr(preg_replace('/[^a-z0-9]/', '', (string)($data['os'] ?? '')), 0, 20);
$arch         = substr(preg_replace('/[^a-z0-9]/', '', (string)($data['arch'] ?? '')), 0, 20);
$savings_pct  = min(100, max(0, (float)($data['savings_pct'] ?? 0)));
$file_ext     = substr(preg_replace('/[^a-z0-9.]/', '', strtolower((string)($data['file_ext'] ?? ''))), 0, 20);
$compress_type = substr(preg_replace('/[^a-z]/', '', (string)($data['compress_type'] ?? '')), 0, 10);
$skipped      = !empty($data['skipped']) ? 1 : 0;

if (!$version || !$os || !$arch) {
    http_response_code(400);
    echo json_encode(['error' => 'Missing required fields']);
    exit;
}

// ─── Insert (no IP stored) ────────────────────────────────────────────────────

try {
    $pdo = new PDO(
        "mysql:host=" . DB_HOST . ";dbname=" . DB_NAME . ";charset=utf8mb4",
        DB_USER,
        DB_PASS,
        [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
    );

    $stmt = $pdo->prepare("
        INSERT INTO telemetry_events
            (version, os, arch, savings_pct, file_ext, compress_type, skipped)
        VALUES
            (:version, :os, :arch, :savings_pct, :file_ext, :compress_type, :skipped)
    ");

    $stmt->execute([
        ':version'       => $version,
        ':os'            => $os,
        ':arch'          => $arch,
        ':savings_pct'   => $savings_pct,
        ':file_ext'      => $file_ext,
        ':compress_type' => $compress_type,
        ':skipped'       => $skipped,
    ]);

    echo json_encode(['ok' => true]);

} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode(['error' => 'Database error']);
    error_log('[cork-ai telemetry] DB error: ' . $e->getMessage());
}
