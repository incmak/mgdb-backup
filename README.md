# mgdb-backup

A lightweight CLI tool to **backup and restore MongoDB databases** without needing `mongodump` or `mongorestore`. Works with **MongoDB Atlas**, replica sets, and self-hosted instances.

> **Disclaimer:** This is an independent, community-built tool. It is not affiliated with, endorsed by, or sponsored by MongoDB, Inc. MongoDB® is a registered trademark of MongoDB, Inc.

## Why mgdb?

- **No MongoDB Database Tools required** — unlike `mongodump`/`mongorestore`, this tool uses the native Node.js MongoDB driver. Just `npm install` and go.
- **Full cluster backup** — back up every database in one command
- **Selective backup** — pick databases by name, number, or wildcard pattern (`*prod*`, `api_?`)
- **EJSON format** — preserves BSON types (ObjectId, Date, Decimal128, Binary, etc.)
- **Interactive & CLI modes** — menu-driven or fully scriptable
- **Restore anywhere** — restore to same or different cluster, rename databases on the fly

## Prerequisites

- **Node.js >= 16** — [Download here](https://nodejs.org/)
- **A running MongoDB instance** — either [MongoDB Atlas](https://www.mongodb.com/cloud/atlas) (cloud), a local MongoDB server, or any MongoDB-compatible host. You need a connection string (`mongodb://` or `mongodb+srv://`).

> **Note:** This tool does **not** install or include MongoDB itself. You need an existing MongoDB server to connect to. The `npm install` only installs the Node.js driver used to communicate with your database.

## Installation

```bash
# Install globally (recommended for CLI usage)
npm install -g mgdb-backup

# Or run directly without installing
npx mgdb-backup
```

After installation, the `mgdb` command will be available globally.

## Quick Start

```bash
# Set your connection string (recommended over passing it as an argument)
export MONGODB_URI="mongodb+srv://user:password@cluster0.abc123.mongodb.net"

# Interactive mode — guided menu for backup/restore
mgdb

# Backup entire cluster
mgdb backup cluster

# Backup a specific database
mgdb backup database mydb

# Backup all databases matching a pattern
mgdb backup database "*_prod"

# Restore a cluster backup
mgdb restore cluster ./backups/user-cluster0/2024-01-15T10-30-00
```

## Connection String

The tool looks for your MongoDB connection string in this order:

1. **CLI argument** — passed directly in the command
2. **`MONGODB_URI` env var** — `export MONGODB_URI="mongodb+srv://..."`
3. **`.env` file** — a `MONGODB_URI=...` line in `.env` in the current directory
4. **Interactive prompt** — asked at runtime if none of the above are set

> **Security tip:** Prefer the env var or `.env` file over passing the connection string as a CLI argument, since CLI arguments are visible in process listings (`ps aux`).

## Usage

### Backup

```bash
# With MONGODB_URI env var set:
mgdb backup cluster                      # Full cluster
mgdb backup database mydb                # Single database
mgdb backup database "db1,db2,db3"       # Multiple databases
mgdb backup database "*_prod"            # Wildcard pattern

# With explicit connection string:
mgdb backup "mongodb+srv://user:pass@cluster.mongodb.net" cluster
mgdb backup "mongodb+srv://..." database mydb
```

### Database Selection

When backing up specific databases, you can use:

| Format         | Example          | Matches                  |
| -------------- | ---------------- | ------------------------ |
| Exact name     | `mydb`           | `mydb`                   |
| Multiple names | `db1,db2,db3`    | `db1`, `db2`, `db3`      |
| Wildcard `*`   | `*_prod`         | `api_prod`, `web_prod`   |
| Wildcard `?`   | `db_?`           | `db_1`, `db_a`           |
| Mixed          | `main,*_staging` | `main` + all `*_staging` |

### Restore

```bash
# Restore entire cluster backup
mgdb restore cluster ./backups/user-cluster0/2024-01-15T10-30-00

# Restore single database
mgdb restore database ./backups/user-cluster0/2024-01-15/mydb

# Drop existing collections before restoring (clean restore)
mgdb restore cluster ./backups/user-cluster0/2024-01-15 --drop

# Restore to a different database name
mgdb restore database ./backups/user-cluster0/2024-01-15/mydb newdb_name
```

### Interactive Mode

Run `mgdb` with no arguments for a guided menu that walks you through backup or restore step by step.

## Output Structure

```
backups/
  └── user-cluster0/              # <username>-<cluster>
      └── 2024-01-15T10-30-00/    # timestamp
          ├── _cluster_metadata.json
          ├── database1/
          │   ├── _metadata.json
          │   ├── users.json
          │   └── orders.json
          └── database2/
              ├── _metadata.json
              └── products.json
```

Each collection is stored as a JSON file using MongoDB Extended JSON (EJSON), so types like `ObjectId`, `Date`, `Decimal128`, and `Binary` are preserved exactly on restore.

## How It Works

This tool connects to your MongoDB server using the official [Node.js MongoDB driver](https://www.npmjs.com/package/mongodb), reads documents from each collection, and writes them as EJSON files. On restore, it reads those files and inserts documents back. No `mongodump`, `mongorestore`, or MongoDB Database Tools installation needed.

**What gets installed when you run `npm install -g mgdb-backup`:**

| Package   | What it is                                                                 |
| --------- | -------------------------------------------------------------------------- |
| `mongodb` | The official Node.js driver — lets this tool _talk to_ your MongoDB server |
| `bson`    | EJSON serializer — preserves MongoDB data types in backup files            |

These are Node.js libraries, **not** the MongoDB database server itself. You need a MongoDB server already running somewhere (Atlas, Docker, local install, etc.).

## Limitations

This tool is designed for **small-to-medium MongoDB databases** (collections that fit comfortably in memory). Keep these constraints in mind:

- **No streaming** — entire collections are loaded into RAM during backup and restore. Collections larger than available memory will cause out-of-memory crashes.
- **No backup compression or encryption** — backup files are plain JSON on disk. Sensitive data is not encrypted at rest.
- **No graceful shutdown** — interrupting a backup mid-operation (Ctrl+C, SIGTERM) may leave partial files without cleanup.
- **Indexes and views are not backed up** — only document data is exported. Custom indexes must be recreated manually.
- **Connection-string auth only** — X.509, LDAP, and Kerberos authentication mechanisms are not supported.
- **Sequential processing** — databases and collections are processed one at a time, not in parallel.

For large production databases (collections > 1GB), scheduled CI/CD backups, or compliance-sensitive environments, consider `mongodump`/`mongorestore` or a managed backup solution like MongoDB Atlas Backup.

See [ROADMAP.md](ROADMAP.md) for planned improvements targeting enterprise use cases.

## FAQ

**Q: Does this install MongoDB on my machine?**
No. This installs a Node.js CLI tool that _connects to_ an existing MongoDB server. You need MongoDB running separately (Atlas, Docker, local install, etc.).

**Q: How is this different from mongodump/mongorestore?**
`mongodump` requires installing MongoDB Database Tools separately. This tool only needs Node.js and works via the standard MongoDB driver. Output is human-readable JSON instead of BSON binary dumps.

**Q: Can I use this with MongoDB Atlas?**
Yes. Just use your Atlas connection string (`mongodb+srv://...`).

**Q: Are indexes backed up?**
Currently this backs up document data only. Index definitions are not included. Indexes will be recreated by MongoDB automatically for `_id`, but custom indexes need to be recreated manually.

## License

MIT

---

MongoDB® is a registered trademark of MongoDB, Inc. This project is not affiliated with MongoDB, Inc.
