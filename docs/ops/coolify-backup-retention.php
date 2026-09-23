<?php
// Invoked by a host timer through Coolify artisan tinker. No credentials are copied into this file.
// Hard guards prevent this job from touching any other database or backup directory.
$backup = App\Models\ScheduledDatabaseBackup::findOrFail(1);
$databaseUuid = 'mrmdvlutycfbo7kl48u1o29k';
$prefix = '/data/coolify/backups/databases/root-team-0/postgresql-'.$databaseUuid.'/';
if ($backup->databases_to_backup !== 'clipforge' || $backup->description !== 'ClipForge daily backup'
    || $backup->database->uuid !== $databaseUuid || !$backup->s3
    || $backup->s3->bucket !== 'caa1f346709c-clanvelt') {
    throw new RuntimeException('Unexpected ClipForge backup target');
}
$server = $backup->database->destination->server;
$dryRun = getenv('CLIPFORGE_BACKUP_RETENTION_DRY_RUN') === '1';
$counts = ['local' => 0, 's3' => 0];
// Wall-clock cutoffs also apply when new backup creation has been failing.
foreach ($backup->executions()->where('status', '!=', 'running')->get() as $execution) {
    if (!$execution->filename) continue;
    if ($execution->database_name !== 'clipforge'
        || !preg_match('#^'.preg_quote($prefix, '#').'pg-dump-clipforge-[0-9]+\.dmp$#D', $execution->filename)) {
        throw new RuntimeException('Unexpected ClipForge backup filename');
    }
    if (!$execution->local_storage_deleted && $execution->created_at->lt(now()->subDays(3))) {
        $counts['local']++;
        if (!$dryRun) {
            deleteBackupsLocally([$execution->filename], $server, true);
            $execution->update(['local_storage_deleted' => true]);
        }
    }
    if (!$execution->s3_storage_deleted && $execution->created_at->lt(now()->subDays(5))) {
        $counts['s3']++;
        if (!$dryRun) {
            deleteBackupsS3([$execution->filename], $backup->s3);
            $execution->update(['s3_storage_deleted' => true]);
        }
    }
}
echo json_encode(['database' => 'clipforge', 'dryRun' => $dryRun, 'expired' => $counts, 'checkedAt' => now()->toIso8601String()]).PHP_EOL;
