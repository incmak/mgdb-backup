# Roadmap

Planned improvements for mgdb-backup v2.0, focused on enterprise readiness.

## Performance

- [ ] Cursor-based streaming instead of `find({}).toArray()` — eliminate memory limits
- [ ] Parallel collection and database processing
- [ ] Configurable batch sizes for backup and restore

## Reliability

- [ ] Signal handling (`SIGINT`/`SIGTERM`) with graceful shutdown and cleanup
- [ ] Atomic writes — write to temp file, rename on completion
- [ ] Post-backup verification (document count comparison, checksums)
- [ ] Retry logic with exponential backoff for transient network failures
- [ ] Checkpoint/resume for interrupted backups

## Logging & Output

- [ ] Structured JSON output mode (`--json`)
- [ ] Quiet mode (`--quiet`) and no-color mode (`--no-color`)
- [ ] Log levels (debug, info, warn, error)
- [ ] Errors written to stderr, output to stdout
- [ ] Progress bars and elapsed time reporting

## Security

- [ ] Backup encryption (AES-256) with `--encrypt` flag
- [ ] Restrictive file permissions on backup files (0600)
- [ ] Integrity checksums (SHA-256) in backup metadata
- [ ] Audit log for backup/restore operations

## Configuration

- [ ] `--output` / `-o` flag for custom backup directory
- [ ] `--exclude` flag for excluding databases or collections
- [ ] Configurable connection and operation timeouts
- [ ] Config file support (`.mgdbrc` or `mgdb.config.json`)
- [ ] Configurable MongoDB connection options (read preference, pool size)

## Compression

- [ ] gzip compression for backup files (`--compress`)
- [ ] Optional zstd compression for better ratio
- [ ] Network compression via MongoDB driver `compressors` option

## Compatibility

- [ ] X.509, LDAP, and Kerberos authentication support
- [ ] Read preference configuration (read from secondaries for backup)
- [ ] Sharded cluster awareness
- [ ] Views and time-series collection handling
- [ ] Explicit MongoDB server version compatibility matrix

## CI/CD & Automation

- [ ] Programmatic API — `require('mgdb-backup')` for use in scripts
- [ ] `--dry-run` mode to preview operations without executing
- [ ] Granular exit codes (auth failure, network error, partial failure, invalid args)
- [ ] `mgdb test-connection` command for health checks
- [ ] `--latest` flag for restore to auto-select most recent backup

## Observability

- [ ] Metrics export (Prometheus, StatsD)
- [ ] Webhook notifications on backup completion/failure
- [ ] Backup manifest with per-file checksums

## Testing

- [ ] Unit tests for core functions
- [ ] Integration tests against a real MongoDB instance
- [ ] 80%+ code coverage target
- [ ] CI pipeline with automated test runs
