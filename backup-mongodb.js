#!/usr/bin/env node

const { MongoClient } = require("mongodb");
const { EJSON } = require("bson");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

// ANSI color codes for terminal output
const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
};

function log(message, color = "reset") {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function formatBytes(bytes) {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

/**
 * Load connection string from environment variable or .env file
 * Priority: MONGODB_URI env var > .env file > null
 */
function loadConnectionStringFromEnv() {
  // Check environment variable first
  if (process.env.MONGODB_URI) {
    return process.env.MONGODB_URI;
  }

  // Try loading from .env file in current directory
  const envPath = path.join(process.cwd(), ".env");
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, "utf8");
    const match = envContent.match(/^MONGODB_URI\s*=\s*(.+)$/m);
    if (match) {
      return match[1].trim().replace(/^["']|["']$/g, ""); // Strip quotes
    }
  }

  return null;
}

/**
 * Mask connection string for safe logging
 * mongodb+srv://user:password@cluster.mongodb.net -> mongodb+srv://user:****@cluster.mongodb.net
 */
function maskConnectionString(connectionString) {
  return connectionString.replace(
    /(mongodb(?:\+srv)?:\/\/[^:]+:)([^@]+)(@.*)/,
    "$1****$3",
  );
}

// MongoDB has a 38-byte limit for database names
const MAX_DB_NAME_LENGTH = 38;

/**
 * Shorten a database name to fit within MongoDB's 38-byte limit
 * Strategy: Keep prefix and suffix, replace middle with hash
 */
function shortenDbName(name) {
  if (name.length <= MAX_DB_NAME_LENGTH) return name;

  // Keep first 20 and last 14 chars (total 34 + "..." = 37, within 38-byte limit)
  const prefix = name.substring(0, 20);
  const suffix = name.substring(name.length - 14);
  return `${prefix}...${suffix}`;
}

function getTimestamp() {
  const now = new Date();
  return now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

/**
 * Extract cluster identifier from MongoDB connection string
 * Format: username-clustername
 * Examples:
 *   mongodb+srv://myuser:pass@cluster0.abc123.mongodb.net -> myuser-cluster0
 *   mongodb+srv://admin:pass@sahaldb.xyz789.mongodb.net -> admin-sahaldb
 */
function extractClusterName(connectionString) {
  try {
    // Extract username from connection string
    const userMatch = connectionString.match(/mongodb(?:\+srv)?:\/\/([^:]+):/);
    const username = userMatch ? userMatch[1] : "unknown";

    // Extract cluster name (first part before the dot after @)
    const clusterMatch = connectionString.match(/@([^.]+)\./);
    const clusterName = clusterMatch ? clusterMatch[1] : "cluster";

    // Sanitize for folder name (remove special chars)
    const sanitize = (str) => str.replace(/[^a-zA-Z0-9_-]/g, "_");

    return `${sanitize(username)}-${sanitize(clusterName)}`;
  } catch (err) {
    return "unknown-cluster";
  }
}

/**
 * Convert wildcard pattern to regex
 * Supports * (matches any characters) and ? (matches single character)
 */
function wildcardToRegex(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

/**
 * Check if a string matches a wildcard pattern
 */
function matchesPattern(str, pattern) {
  if (!pattern.includes("*") && !pattern.includes("?")) {
    return str.toLowerCase() === pattern.toLowerCase();
  }
  return wildcardToRegex(pattern).test(str);
}

/**
 * Parse user input for database selection
 * Supports: numbers (1,2,3), names (db1,db2), patterns (*sahal*), or mixed
 * Returns array of matched database names
 */
function parseDbSelection(input, databases) {
  const dbNames = databases.map((db) => db.name);
  const selections = input
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s);
  const matched = new Set();

  for (const sel of selections) {
    const num = parseInt(sel);
    if (!isNaN(num) && num >= 1 && num <= databases.length) {
      matched.add(dbNames[num - 1]);
      continue;
    }

    if (sel.includes("*") || sel.includes("?")) {
      for (const name of dbNames) {
        if (matchesPattern(name, sel)) {
          matched.add(name);
        }
      }
      continue;
    }

    const exactMatch = dbNames.find(
      (name) => name.toLowerCase() === sel.toLowerCase(),
    );
    if (exactMatch) {
      matched.add(exactMatch);
    }
  }

  return Array.from(matched);
}

function createReadlineInterface() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function prompt(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

async function connectToMongo(connectionString) {
  log(
    `\nConnecting to MongoDB (${maskConnectionString(connectionString)})...`,
    "cyan",
  );

  const client = new MongoClient(connectionString, {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
  });

  await client.connect();
  log("Connected successfully!", "green");

  return client;
}

async function listDatabases(client) {
  const adminDb = client.db().admin();
  const result = await adminDb.listDatabases();

  const userDatabases = result.databases.filter(
    (db) => !["admin", "local", "config"].includes(db.name),
  );

  return userDatabases;
}

// ============================================
// BACKUP FUNCTIONS
// ============================================

async function backupCollection(db, collectionName, outputDir) {
  const collection = db.collection(collectionName);
  const documents = await collection.find({}).toArray();

  const filePath = path.join(outputDir, `${collectionName}.json`);
  fs.writeFileSync(filePath, EJSON.stringify(documents, null, 2));

  return {
    name: collectionName,
    documentCount: documents.length,
    fileSize: fs.statSync(filePath).size,
  };
}

async function backupDatabase(client, dbName, baseOutputDir) {
  const db = client.db(dbName);
  const collections = await db.listCollections().toArray();

  if (collections.length === 0) {
    log(`  Skipping ${dbName} (no collections)`, "dim");
    return null;
  }

  const dbOutputDir = path.join(baseOutputDir, dbName);
  fs.mkdirSync(dbOutputDir, { recursive: true });

  log(`\n  Backing up database: ${dbName}`, "magenta");
  log(`  Collections: ${collections.length}`, "dim");

  const results = [];
  let totalDocs = 0;
  let totalSize = 0;

  for (const col of collections) {
    if (col.name.startsWith("system.")) continue;

    try {
      const result = await backupCollection(db, col.name, dbOutputDir);
      results.push(result);
      totalDocs += result.documentCount;
      totalSize += result.fileSize;

      log(
        `    ✓ ${col.name}: ${result.documentCount} documents (${formatBytes(result.fileSize)})`,
        "green",
      );
    } catch (err) {
      log(`    ✗ ${col.name}: ${err.message}`, "red");
    }
  }

  const metadata = {
    database: dbName,
    backupDate: new Date().toISOString(),
    collections: results,
    totalDocuments: totalDocs,
    totalSize: totalSize,
  };

  fs.writeFileSync(
    path.join(dbOutputDir, "_metadata.json"),
    JSON.stringify(metadata, null, 2),
  );

  return {
    database: dbName,
    collections: results.length,
    documents: totalDocs,
    size: totalSize,
  };
}

async function backupCluster(connectionString, outputDir) {
  const client = await connectToMongo(connectionString);

  try {
    const databases = await listDatabases(client);

    log("\n========================================", "blue");
    log("  Backing Up Entire Cluster", "blue");
    log("========================================", "blue");
    log(`\n  Found ${databases.length} user databases`, "cyan");

    const results = [];

    for (const dbInfo of databases) {
      const result = await backupDatabase(client, dbInfo.name, outputDir);
      if (result) results.push(result);
    }

    const clusterMetadata = {
      backupType: "cluster",
      backupDate: new Date().toISOString(),
      databases: results,
      totalDatabases: results.length,
      totalCollections: results.reduce((sum, r) => sum + r.collections, 0),
      totalDocuments: results.reduce((sum, r) => sum + r.documents, 0),
      totalSize: results.reduce((sum, r) => sum + r.size, 0),
    };

    fs.writeFileSync(
      path.join(outputDir, "_cluster_metadata.json"),
      JSON.stringify(clusterMetadata, null, 2),
    );

    return clusterMetadata;
  } finally {
    await client.close();
  }
}

async function backupSingleDatabase(connectionString, dbName, outputDir) {
  const client = await connectToMongo(connectionString);

  try {
    log("\n========================================", "blue");
    log(`  Backing Up Database: ${dbName}`, "blue");
    log("========================================", "blue");

    const result = await backupDatabase(client, dbName, outputDir);

    if (!result) {
      throw new Error(`Database "${dbName}" not found or has no collections`);
    }

    return result;
  } finally {
    await client.close();
  }
}

async function backupMultipleDatabases(connectionString, dbNames, outputDir) {
  const client = await connectToMongo(connectionString);

  try {
    log("\n========================================", "blue");
    log(`  Backing Up ${dbNames.length} Database(s)`, "blue");
    log("========================================", "blue");
    log(`  Databases: ${dbNames.join(", ")}`, "dim");

    const results = [];

    for (const dbName of dbNames) {
      const result = await backupDatabase(client, dbName, outputDir);
      if (result) results.push(result);
    }

    if (results.length === 0) {
      throw new Error("No databases were backed up");
    }

    const combinedMetadata = {
      backupType: "multiple-databases",
      backupDate: new Date().toISOString(),
      databases: results,
      totalDatabases: results.length,
      totalCollections: results.reduce((sum, r) => sum + r.collections, 0),
      totalDocuments: results.reduce((sum, r) => sum + r.documents, 0),
      totalSize: results.reduce((sum, r) => sum + r.size, 0),
    };

    fs.writeFileSync(
      path.join(outputDir, "_backup_metadata.json"),
      JSON.stringify(combinedMetadata, null, 2),
    );

    return combinedMetadata;
  } finally {
    await client.close();
  }
}

// ============================================
// RESTORE FUNCTIONS
// ============================================

async function restoreCollection(db, collectionName, filePath, options = {}) {
  const { dropExisting = false } = options;

  const fileContent = fs.readFileSync(filePath, "utf8");
  const documents = EJSON.parse(fileContent, { relaxed: false });

  if (documents.length === 0) {
    return { name: collectionName, inserted: 0, skipped: true };
  }

  const collection = db.collection(collectionName);

  if (dropExisting) {
    try {
      await collection.drop();
    } catch (err) {
      // Collection might not exist, ignore
    }
  }

  const batchSize = 1000;
  let totalInserted = 0;

  for (let i = 0; i < documents.length; i += batchSize) {
    const batch = documents.slice(i, i + batchSize);
    try {
      const result = await collection.insertMany(batch, { ordered: false });
      totalInserted += result.insertedCount;
    } catch (err) {
      if (err.code === 11000) {
        totalInserted += err.result?.nInserted || 0;
      } else {
        throw err;
      }
    }
  }

  return {
    name: collectionName,
    inserted: totalInserted,
    total: documents.length,
  };
}

async function restoreDatabase(client, dbName, backupDir, options = {}) {
  const { dropExisting = false, targetDbName = null } = options;
  let actualDbName = targetDbName || dbName;

  if (actualDbName.length > MAX_DB_NAME_LENGTH) {
    const shortened = shortenDbName(actualDbName);
    log(
      `\n  ⚠ Database name "${actualDbName}" exceeds 38-byte limit`,
      "yellow",
    );
    log(`    Auto-shortening to: "${shortened}"`, "yellow");
    actualDbName = shortened;
  }

  const db = client.db(actualDbName);

  const files = fs
    .readdirSync(backupDir)
    .filter((f) => f.endsWith(".json") && !f.startsWith("_"));

  if (files.length === 0) {
    log(`  No collections found in backup for ${dbName}`, "yellow");
    return null;
  }

  log(`\n  Restoring to database: ${actualDbName}`, "magenta");
  log(`  Collections: ${files.length}`, "dim");
  if (dropExisting) {
    log(`  Mode: Drop existing collections before restore`, "yellow");
  }

  const results = [];
  let totalInserted = 0;

  for (const file of files) {
    const collectionName = path.basename(file, ".json");
    const filePath = path.join(backupDir, file);

    try {
      const result = await restoreCollection(db, collectionName, filePath, {
        dropExisting,
      });
      results.push(result);
      totalInserted += result.inserted;

      if (result.skipped) {
        log(`    - ${collectionName}: skipped (empty)`, "dim");
      } else {
        log(
          `    ✓ ${collectionName}: ${result.inserted}/${result.total} documents restored`,
          "green",
        );
      }
    } catch (err) {
      log(`    ✗ ${collectionName}: ${err.message}`, "red");
      results.push({ name: collectionName, error: err.message });
    }
  }

  return {
    database: actualDbName,
    collections: results.length,
    documentsRestored: totalInserted,
  };
}

async function restoreCluster(connectionString, backupDir, options = {}) {
  const client = await connectToMongo(connectionString);

  try {
    const clusterMetaPath = path.join(backupDir, "_cluster_metadata.json");
    const multiDbMetaPath = path.join(backupDir, "_backup_metadata.json");

    let backupMeta;
    let backupType;

    if (fs.existsSync(clusterMetaPath)) {
      backupMeta = JSON.parse(fs.readFileSync(clusterMetaPath, "utf8"));
      backupType = "cluster";
    } else if (fs.existsSync(multiDbMetaPath)) {
      backupMeta = JSON.parse(fs.readFileSync(multiDbMetaPath, "utf8"));
      backupType = "multi-db";
    } else {
      throw new Error(
        "Invalid backup directory: no cluster or multi-database metadata found",
      );
    }

    log("\n========================================", "blue");
    log(
      `  Restoring ${backupType === "cluster" ? "Entire Cluster" : "Multiple Databases"}`,
      "blue",
    );
    log("========================================", "blue");
    log(`\n  Backup Date: ${backupMeta.backupDate}`, "dim");
    log(`  Databases to restore: ${backupMeta.totalDatabases}`, "cyan");

    const results = [];

    const dbDirs = fs.readdirSync(backupDir).filter((f) => {
      const fullPath = path.join(backupDir, f);
      return fs.statSync(fullPath).isDirectory();
    });

    for (const dbDir of dbDirs) {
      const dbBackupPath = path.join(backupDir, dbDir);
      const result = await restoreDatabase(
        client,
        dbDir,
        dbBackupPath,
        options,
      );
      if (result) results.push(result);
    }

    return {
      totalDatabases: results.length,
      totalCollections: results.reduce((sum, r) => sum + r.collections, 0),
      totalDocumentsRestored: results.reduce(
        (sum, r) => sum + r.documentsRestored,
        0,
      ),
    };
  } finally {
    await client.close();
  }
}

async function restoreSingleDatabase(
  connectionString,
  backupDir,
  dbName,
  options = {},
) {
  const client = await connectToMongo(connectionString);

  try {
    let dbBackupPath = backupDir;

    const metaPath = path.join(backupDir, "_metadata.json");
    const clusterMetaPath = path.join(backupDir, "_cluster_metadata.json");
    const multiDbMetaPath = path.join(backupDir, "_backup_metadata.json");

    if (fs.existsSync(metaPath)) {
      dbBackupPath = backupDir;
    } else if (
      fs.existsSync(clusterMetaPath) ||
      fs.existsSync(multiDbMetaPath)
    ) {
      const possiblePath = path.join(backupDir, dbName);
      if (fs.existsSync(possiblePath)) {
        dbBackupPath = possiblePath;
      } else {
        throw new Error(
          `Database "${dbName}" not found in backup at ${backupDir}`,
        );
      }
    } else {
      const possiblePath = path.join(backupDir, dbName);
      if (fs.existsSync(possiblePath)) {
        dbBackupPath = possiblePath;
      } else {
        throw new Error(`Database backup not found at ${backupDir}`);
      }
    }

    log("\n========================================", "blue");
    log(`  Restoring Database: ${options.targetDbName || dbName}`, "blue");
    log("========================================", "blue");

    const result = await restoreDatabase(client, dbName, dbBackupPath, options);

    if (!result) {
      throw new Error(`No data found in backup for "${dbName}"`);
    }

    return result;
  } finally {
    await client.close();
  }
}

async function restoreMultipleDatabases(
  connectionString,
  backupDir,
  dbNames,
  options = {},
) {
  const client = await connectToMongo(connectionString);

  try {
    log("\n========================================", "blue");
    log(`  Restoring ${dbNames.length} Database(s)`, "blue");
    log("========================================", "blue");
    log(`  Databases: ${dbNames.join(", ")}`, "dim");

    const results = [];

    for (const dbName of dbNames) {
      const dbBackupPath = path.join(backupDir, dbName);

      if (!fs.existsSync(dbBackupPath)) {
        log(`\n  Skipping ${dbName} (not found in backup)`, "yellow");
        continue;
      }

      const result = await restoreDatabase(
        client,
        dbName,
        dbBackupPath,
        options,
      );
      if (result) results.push(result);
    }

    if (results.length === 0) {
      throw new Error("No databases were restored");
    }

    return {
      totalDatabases: results.length,
      totalCollections: results.reduce((sum, r) => sum + r.collections, 0),
      totalDocumentsRestored: results.reduce(
        (sum, r) => sum + r.documentsRestored,
        0,
      ),
      databases: results,
    };
  } finally {
    await client.close();
  }
}

// ============================================
// INTERACTIVE MODE
// ============================================

async function selectBackupFolder() {
  const backupsDir = path.join(process.cwd(), "backups");

  if (!fs.existsSync(backupsDir)) {
    throw new Error("No backups directory found. Run a backup first.");
  }

  const clusterFolders = fs
    .readdirSync(backupsDir)
    .filter((f) => fs.statSync(path.join(backupsDir, f)).isDirectory());

  if (clusterFolders.length === 0) {
    throw new Error("No backups found in ./backups directory");
  }

  const allBackups = [];

  for (const cluster of clusterFolders) {
    const clusterPath = path.join(backupsDir, cluster);
    const contents = fs.readdirSync(clusterPath);
    const hasClusterMeta = fs.existsSync(
      path.join(clusterPath, "_cluster_metadata.json"),
    );
    const hasDbMeta = fs.existsSync(path.join(clusterPath, "_metadata.json"));
    const hasMultiDbMeta = fs.existsSync(
      path.join(clusterPath, "_backup_metadata.json"),
    );

    if (hasClusterMeta || hasDbMeta || hasMultiDbMeta) {
      let backupType = "database";
      if (hasClusterMeta) backupType = "cluster";
      else if (hasMultiDbMeta) backupType = "multi-db";

      allBackups.push({
        cluster: null,
        timestamp: cluster,
        path: clusterPath,
        backupType: backupType,
      });
    } else {
      const timestampFolders = contents.filter((f) =>
        fs.statSync(path.join(clusterPath, f)).isDirectory(),
      );

      for (const ts of timestampFolders) {
        const tsPath = path.join(clusterPath, ts);
        const isClusterBackup = fs.existsSync(
          path.join(tsPath, "_cluster_metadata.json"),
        );
        const isMultiDbBackup = fs.existsSync(
          path.join(tsPath, "_backup_metadata.json"),
        );

        let backupType = "database";
        if (isClusterBackup) backupType = "cluster";
        else if (isMultiDbBackup) backupType = "multi-db";

        allBackups.push({
          cluster: cluster,
          timestamp: ts,
          path: tsPath,
          backupType: backupType,
        });
      }
    }
  }

  if (allBackups.length === 0) {
    throw new Error("No backups found in ./backups directory");
  }

  allBackups.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  log("\n  Available Backups:", "cyan");
  allBackups.forEach((backup, index) => {
    const clusterInfo = backup.cluster ? `[${backup.cluster}] ` : "";
    log(
      `    ${index + 1}. ${clusterInfo}${backup.timestamp} (${backup.backupType})`,
      "reset",
    );
  });

  const rl = createReadlineInterface();
  const answer = await prompt(rl, "\n  Select backup (number): ");
  rl.close();

  const num = parseInt(answer);

  if (!isNaN(num) && num >= 1 && num <= allBackups.length) {
    return allBackups[num - 1].path;
  }

  throw new Error(`Invalid selection "${answer}"`);
}

function parseDbSelectionFromBackup(input, dbDirs) {
  const selections = input
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s);
  const matched = new Set();

  for (const sel of selections) {
    const num = parseInt(sel);
    if (!isNaN(num) && num >= 1 && num <= dbDirs.length) {
      matched.add(dbDirs[num - 1]);
      continue;
    }

    if (sel.includes("*") || sel.includes("?")) {
      for (const name of dbDirs) {
        if (matchesPattern(name, sel)) {
          matched.add(name);
        }
      }
      continue;
    }

    const exactMatch = dbDirs.find(
      (name) => name.toLowerCase() === sel.toLowerCase(),
    );
    if (exactMatch) {
      matched.add(exactMatch);
    }
  }

  return Array.from(matched);
}

async function selectDatabasesFromBackup(backupDir) {
  const clusterMetaPath = path.join(backupDir, "_cluster_metadata.json");
  const multiDbMetaPath = path.join(backupDir, "_backup_metadata.json");
  const singleDbMetaPath = path.join(backupDir, "_metadata.json");

  const dbDirs = fs.readdirSync(backupDir).filter((f) => {
    const fullPath = path.join(backupDir, f);
    return fs.statSync(fullPath).isDirectory();
  });

  if (fs.existsSync(clusterMetaPath) || fs.existsSync(multiDbMetaPath)) {
    if (dbDirs.length === 0) {
      throw new Error("No databases found in backup");
    }

    log("\n  Databases in backup:", "cyan");
    dbDirs.forEach((db, index) => {
      log(`    ${index + 1}. ${db}`, "reset");
    });

    log("\n  Selection Options:", "dim");
    log("    - Single: 1 or database_name", "dim");
    log("    - Multiple: 1,2,3 or db1,db2,db3", "dim");
    log("    - Pattern: *sahal* or sahal_*", "dim");
    log("    - Mixed: 1,2,*test*,prod_db", "dim");

    const rl = createReadlineInterface();
    const answer = await prompt(rl, "\n  Enter selection: ");
    rl.close();

    const selected = parseDbSelectionFromBackup(answer, dbDirs);

    if (selected.length === 0) {
      throw new Error(`No databases matched "${answer}"`);
    }

    return selected;
  } else if (fs.existsSync(singleDbMetaPath)) {
    const meta = JSON.parse(fs.readFileSync(singleDbMetaPath, "utf8"));
    return [meta.database];
  } else if (dbDirs.length > 0) {
    log("\n  Databases in backup:", "cyan");
    dbDirs.forEach((db, index) => {
      log(`    ${index + 1}. ${db}`, "reset");
    });

    log("\n  Selection Options:", "dim");
    log("    - Single: 1 or database_name", "dim");
    log("    - Multiple: 1,2,3 or db1,db2,db3", "dim");
    log("    - Pattern: *sahal* or sahal_*", "dim");
    log("    - Mixed: 1,2,*test*,prod_db", "dim");

    const rl = createReadlineInterface();
    const answer = await prompt(rl, "\n  Enter selection: ");
    rl.close();

    const selected = parseDbSelectionFromBackup(answer, dbDirs);

    if (selected.length === 0) {
      throw new Error(`No databases matched "${answer}"`);
    }

    return selected;
  } else {
    throw new Error("Invalid backup format: no databases or metadata found");
  }
}

async function selectDatabases(client) {
  const databases = await listDatabases(client);

  log("\n  Available Databases:", "cyan");
  databases.forEach((db, index) => {
    log(
      `    ${index + 1}. ${db.name} (${formatBytes(db.sizeOnDisk)})`,
      "reset",
    );
  });

  log("\n  Selection Options:", "dim");
  log("    - Single: 1 or database_name", "dim");
  log("    - Multiple: 1,2,3 or db1,db2,db3", "dim");
  log("    - Pattern: *sahal* or sahal_*", "dim");
  log("    - Mixed: 1,2,*test*,prod_db", "dim");

  const rl = createReadlineInterface();
  const answer = await prompt(rl, "\n  Enter selection: ");
  rl.close();

  const selected = parseDbSelection(answer, databases);

  if (selected.length === 0) {
    throw new Error(`No databases matched "${answer}"`);
  }

  return selected;
}

/**
 * Resolve connection string from multiple sources
 * Priority: explicit argument > MONGODB_URI env var > .env file > interactive prompt
 */
async function resolveConnectionString(explicitValue, rl) {
  if (explicitValue) return explicitValue;

  const fromEnv = loadConnectionStringFromEnv();
  if (fromEnv) {
    log(
      `  Using connection string from ${process.env.MONGODB_URI ? "MONGODB_URI env var" : ".env file"}`,
      "dim",
    );
    return fromEnv;
  }

  if (rl) {
    const value = await prompt(
      rl,
      "\nEnter MongoDB connection string (or set MONGODB_URI): ",
    );
    if (!value) {
      log("\nError: Connection string is required!", "red");
      log(
        "  Set MONGODB_URI environment variable, create a .env file, or pass it as an argument.",
        "dim",
      );
      process.exit(1);
    }
    return value;
  }

  log("\nError: Connection string is required!", "red");
  log(
    "  Set MONGODB_URI environment variable, create a .env file, or pass it as an argument.",
    "dim",
  );
  process.exit(1);
}

async function interactiveMode() {
  log("\n========================================", "blue");
  log("  MongoDB Backup & Restore Tool", "blue");
  log("========================================\n", "blue");

  const rl = createReadlineInterface();

  log("  Main Menu:", "cyan");
  log("    1. Backup", "reset");
  log("    2. Restore", "reset");

  const mainChoice = await prompt(rl, "\n  Select operation (1 or 2): ");

  if (mainChoice === "1") {
    const connectionString = await resolveConnectionString(null, rl);

    log("\n  Backup Options:", "cyan");
    log("    1. Backup entire cluster", "reset");
    log("    2. Backup specific database", "reset");

    const backupType = await prompt(rl, "\n  Select option (1 or 2): ");
    rl.close();

    const clusterFolder = extractClusterName(connectionString);
    const timestamp = getTimestamp();
    const baseOutputDir = path.join(
      process.cwd(),
      "backups",
      clusterFolder,
      timestamp,
    );
    fs.mkdirSync(baseOutputDir, { recursive: true });

    log(`\n  Cluster: ${clusterFolder}`, "dim");

    try {
      if (backupType === "1") {
        const result = await backupCluster(connectionString, baseOutputDir);

        log("\n========================================", "green");
        log("  Cluster Backup Complete!", "green");
        log("========================================", "green");
        log(`\n  Location: ${baseOutputDir}`, "cyan");
        log(`  Databases: ${result.totalDatabases}`, "reset");
        log(`  Collections: ${result.totalCollections}`, "reset");
        log(`  Documents: ${result.totalDocuments}`, "reset");
        log(`  Total Size: ${formatBytes(result.totalSize)}`, "reset");
      } else if (backupType === "2") {
        const client = await connectToMongo(connectionString);
        const dbNames = await selectDatabases(client);
        await client.close();

        log(
          `\n  Selected ${dbNames.length} database(s): ${dbNames.join(", ")}`,
          "cyan",
        );

        let result;
        if (dbNames.length === 1) {
          result = await backupSingleDatabase(
            connectionString,
            dbNames[0],
            baseOutputDir,
          );

          log("\n========================================", "green");
          log("  Database Backup Complete!", "green");
          log("========================================", "green");
          log(`\n  Location: ${baseOutputDir}`, "cyan");
          log(`  Database: ${result.database}`, "reset");
          log(`  Collections: ${result.collections}`, "reset");
          log(`  Documents: ${result.documents}`, "reset");
          log(`  Total Size: ${formatBytes(result.size)}`, "reset");
        } else {
          result = await backupMultipleDatabases(
            connectionString,
            dbNames,
            baseOutputDir,
          );

          log("\n========================================", "green");
          log("  Multiple Databases Backup Complete!", "green");
          log("========================================", "green");
          log(`\n  Location: ${baseOutputDir}`, "cyan");
          log(`  Databases: ${result.totalDatabases}`, "reset");
          log(`  Collections: ${result.totalCollections}`, "reset");
          log(`  Documents: ${result.totalDocuments}`, "reset");
          log(`  Total Size: ${formatBytes(result.totalSize)}`, "reset");
        }
      } else {
        throw new Error("Invalid option selected");
      }
    } catch (err) {
      log(`\nError: ${err.message}`, "red");
      if (fs.existsSync(baseOutputDir)) {
        try {
          fs.rmSync(baseOutputDir, { recursive: true });
        } catch {}
      }
      process.exit(1);
    }
  } else if (mainChoice === "2") {
    const connectionString = await resolveConnectionString(null, rl);

    log("\n  Restore Options:", "cyan");
    log("    1. Restore entire cluster backup", "reset");
    log("    2. Restore specific database", "reset");

    const restoreType = await prompt(rl, "\n  Select option (1 or 2): ");

    rl.close();
    const backupDir = await selectBackupFolder();

    const rl2 = createReadlineInterface();

    const dropAnswer = await prompt(
      rl2,
      "\n  Drop existing collections before restore? (y/N): ",
    );
    const dropExisting = dropAnswer.toLowerCase() === "y";

    try {
      if (restoreType === "1") {
        rl2.close();
        const result = await restoreCluster(connectionString, backupDir, {
          dropExisting,
        });

        log("\n========================================", "green");
        log("  Cluster Restore Complete!", "green");
        log("========================================", "green");
        log(`\n  Databases: ${result.totalDatabases}`, "reset");
        log(`  Collections: ${result.totalCollections}`, "reset");
        log(`  Documents Restored: ${result.totalDocumentsRestored}`, "reset");
      } else if (restoreType === "2") {
        rl2.close();
        const dbNames = await selectDatabasesFromBackup(backupDir);

        log(
          `\n  Selected ${dbNames.length} database(s): ${dbNames.join(", ")}`,
          "cyan",
        );

        if (dbNames.length === 1) {
          const rl3 = createReadlineInterface();
          const targetAnswer = await prompt(
            rl3,
            `\n  Target database name (Enter for "${dbNames[0]}"): `,
          );
          const targetDbName = targetAnswer || dbNames[0];
          rl3.close();

          const result = await restoreSingleDatabase(
            connectionString,
            backupDir,
            dbNames[0],
            {
              dropExisting,
              targetDbName,
            },
          );

          log("\n========================================", "green");
          log("  Database Restore Complete!", "green");
          log("========================================", "green");
          log(`\n  Database: ${result.database}`, "reset");
          log(`  Collections: ${result.collections}`, "reset");
          log(`  Documents Restored: ${result.documentsRestored}`, "reset");
        } else {
          const result = await restoreMultipleDatabases(
            connectionString,
            backupDir,
            dbNames,
            {
              dropExisting,
            },
          );

          log("\n========================================", "green");
          log("  Multiple Databases Restore Complete!", "green");
          log("========================================", "green");
          log(`\n  Databases: ${result.totalDatabases}`, "reset");
          log(`  Collections: ${result.totalCollections}`, "reset");
          log(
            `  Documents Restored: ${result.totalDocumentsRestored}`,
            "reset",
          );
        }
      } else {
        rl2.close();
        throw new Error("Invalid option selected");
      }
    } catch (err) {
      log(`\nError: ${err.message}`, "red");
      process.exit(1);
    }
  } else {
    rl.close();
    log("\nError: Invalid option selected!", "red");
    process.exit(1);
  }

  log("\n", "reset");
}

// ============================================
// CLI MODE
// ============================================

async function cliMode(args) {
  const operation = args[0];
  const connectionStringArg = args[1];
  const scope = args[2];
  const extra = args[3];

  if (!operation || !["backup", "restore"].includes(operation)) {
    log('\nError: First argument must be "backup" or "restore"!', "red");
    showUsage();
    process.exit(1);
  }

  // Resolve connection string: arg > env var > .env file
  const connectionString = await resolveConnectionString(
    connectionStringArg,
    null,
  );

  // If connection string came from env, shift args
  const argsFromEnv = !connectionStringArg || connectionStringArg === scope;
  const actualScope = argsFromEnv ? connectionStringArg : scope;
  const actualExtra = argsFromEnv ? scope : extra;

  const isCluster = actualScope === "cluster" || actualScope === "1";
  const isDatabase = actualScope === "database" || actualScope === "2";

  if (!isCluster && !isDatabase) {
    log('\nError: Scope must be "cluster" (1) or "database" (2)!', "red");
    showUsage();
    process.exit(1);
  }

  const dropExisting = args.includes("--drop");

  if (operation === "backup") {
    const clusterFolder = extractClusterName(connectionString);
    const timestamp = getTimestamp();
    const baseOutputDir = path.join(
      process.cwd(),
      "backups",
      clusterFolder,
      timestamp,
    );
    fs.mkdirSync(baseOutputDir, { recursive: true });

    log(`\n  Cluster: ${clusterFolder}`, "dim");

    try {
      if (isCluster) {
        const result = await backupCluster(connectionString, baseOutputDir);

        log("\n========================================", "green");
        log("  Cluster Backup Complete!", "green");
        log("========================================", "green");
        log(`\n  Location: ${baseOutputDir}`, "cyan");
        log(`  Databases: ${result.totalDatabases}`, "reset");
        log(`  Collections: ${result.totalCollections}`, "reset");
        log(`  Documents: ${result.totalDocuments}`, "reset");
        log(`  Total Size: ${formatBytes(result.totalSize)}`, "reset");
      } else {
        if (!actualExtra) {
          log(
            "\nError: Database name/pattern is required for database backup!",
            "red",
          );
          showUsage();
          process.exit(1);
        }

        const client = await connectToMongo(connectionString);
        const databases = await listDatabases(client);
        await client.close();

        const dbNames = parseDbSelection(actualExtra, databases);

        if (dbNames.length === 0) {
          throw new Error(`No databases matched "${actualExtra}"`);
        }

        log(
          `\n  Matched ${dbNames.length} database(s): ${dbNames.join(", ")}`,
          "cyan",
        );

        let result;
        if (dbNames.length === 1) {
          result = await backupSingleDatabase(
            connectionString,
            dbNames[0],
            baseOutputDir,
          );

          log("\n========================================", "green");
          log("  Database Backup Complete!", "green");
          log("========================================", "green");
          log(`\n  Location: ${baseOutputDir}`, "cyan");
          log(`  Database: ${result.database}`, "reset");
          log(`  Collections: ${result.collections}`, "reset");
          log(`  Documents: ${result.documents}`, "reset");
          log(`  Total Size: ${formatBytes(result.size)}`, "reset");
        } else {
          result = await backupMultipleDatabases(
            connectionString,
            dbNames,
            baseOutputDir,
          );

          log("\n========================================", "green");
          log("  Multiple Databases Backup Complete!", "green");
          log("========================================", "green");
          log(`\n  Location: ${baseOutputDir}`, "cyan");
          log(`  Databases: ${result.totalDatabases}`, "reset");
          log(`  Collections: ${result.totalCollections}`, "reset");
          log(`  Documents: ${result.totalDocuments}`, "reset");
          log(`  Total Size: ${formatBytes(result.totalSize)}`, "reset");
        }
      }
    } catch (err) {
      log(`\nError: ${err.message}`, "red");
      if (fs.existsSync(baseOutputDir)) {
        try {
          fs.rmSync(baseOutputDir, { recursive: true });
        } catch {}
      }
      process.exit(1);
    }
  } else {
    // RESTORE
    if (!actualExtra) {
      log("\nError: Backup path is required for restore!", "red");
      showUsage();
      process.exit(1);
    }

    const backupPath = path.isAbsolute(actualExtra)
      ? actualExtra
      : path.join(process.cwd(), actualExtra);

    if (!fs.existsSync(backupPath)) {
      log(`\nError: Backup path not found: ${backupPath}`, "red");
      process.exit(1);
    }

    try {
      if (isCluster) {
        const result = await restoreCluster(connectionString, backupPath, {
          dropExisting,
        });

        log("\n========================================", "green");
        log("  Cluster Restore Complete!", "green");
        log("========================================", "green");
        log(`\n  Databases: ${result.totalDatabases}`, "reset");
        log(`  Collections: ${result.totalCollections}`, "reset");
        log(`  Documents Restored: ${result.totalDocumentsRestored}`, "reset");
      } else {
        const targetDbArg = argsFromEnv ? args[3] : args[4];

        let dbName;
        const metaPath = path.join(backupPath, "_metadata.json");
        const parentClusterMeta = path.join(
          path.dirname(backupPath),
          "_cluster_metadata.json",
        );
        const parentMultiDbMeta = path.join(
          path.dirname(backupPath),
          "_backup_metadata.json",
        );

        if (fs.existsSync(metaPath)) {
          const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
          dbName = meta.database;
        } else if (
          fs.existsSync(parentClusterMeta) ||
          fs.existsSync(parentMultiDbMeta)
        ) {
          dbName = path.basename(backupPath);
        } else {
          log(
            "\nError: Could not determine database name from backup. Provide it as additional argument.",
            "red",
          );
          process.exit(1);
        }

        const result = await restoreSingleDatabase(
          connectionString,
          backupPath,
          dbName,
          {
            dropExisting,
            targetDbName: targetDbArg || dbName,
          },
        );

        log("\n========================================", "green");
        log("  Database Restore Complete!", "green");
        log("========================================", "green");
        log(`\n  Database: ${result.database}`, "reset");
        log(`  Collections: ${result.collections}`, "reset");
        log(`  Documents Restored: ${result.documentsRestored}`, "reset");
      }
    } catch (err) {
      log(`\nError: ${err.message}`, "red");
      process.exit(1);
    }
  }

  log("\n", "reset");
}

function showUsage() {
  log("\n========================================", "blue");
  log("  MongoDB Backup & Restore Tool", "blue");
  log("========================================\n", "blue");

  log("Interactive Mode:", "cyan");
  log("  mgdb\n", "reset");

  log("CLI Mode - Backup:", "cyan");
  log(
    "  mgdb backup <connection-string> <scope> [database-selection]",
    "reset",
  );
  log(
    "  mgdb backup <scope> [database-selection]  # uses MONGODB_URI env var\n",
    "reset",
  );

  log("CLI Mode - Restore:", "cyan");
  log(
    "  mgdb restore <connection-string> <scope> <backup-path> [target-db] [--drop]",
    "reset",
  );
  log(
    "  mgdb restore <scope> <backup-path> [target-db] [--drop]  # uses MONGODB_URI\n",
    "reset",
  );

  log("Connection String:", "cyan");
  log(
    "  Pass as argument, set MONGODB_URI env var, or create a .env file.",
    "reset",
  );
  log(
    "  Priority: argument > MONGODB_URI > .env file > interactive prompt\n",
    "reset",
  );

  log("Arguments:", "cyan");
  log("  <connection-string>   MongoDB connection URL", "reset");
  log('  <scope>               "cluster" or "1" for full cluster', "reset");
  log(
    '                        "database" or "2" for specific database(s)',
    "reset",
  );
  log(
    "  [database-selection]  Required for database backup (see below)",
    "reset",
  );
  log("  <backup-path>         Path to backup folder (for restore)", "reset");
  log(
    "  [target-db]           Target database name (for database restore)",
    "reset",
  );
  log(
    "  --drop                Drop existing collections before restore\n",
    "reset",
  );

  log("Database Selection (for backup):", "cyan");
  log("  Single database:      mydb", "reset");
  log("  Multiple databases:   db1,db2,db3", "reset");
  log(
    '  Wildcard pattern:     *sahal*  (matches any db containing "sahal")',
    "reset",
  );
  log(
    "                        sahal_*  (matches sahal_prod, sahal_dev, etc.)",
    "reset",
  );
  log(
    "                        *_prod   (matches all ending with _prod)",
    "reset",
  );
  log("  Mixed selection:      db1,*test*,prod_*\n", "reset");

  log("Examples:", "cyan");
  log("  # Interactive mode", "dim");
  log("  mgdb\n", "reset");

  log("  # Using env var (recommended)", "dim");
  log(
    '  export MONGODB_URI="mongodb+srv://user:pass@cluster.mongodb.net"',
    "reset",
  );
  log("  mgdb backup cluster", "reset");
  log("  mgdb backup database mydb\n", "reset");

  log("  # Passing connection string directly", "dim");
  log('  mgdb backup "mongodb+srv://..." cluster', "reset");
  log('  mgdb backup "mongodb+srv://..." database "*_prod"\n', "reset");

  log("  # Restore", "dim");
  log(
    "  mgdb restore cluster ./backups/user-cluster0/2024-01-15T10-30-00",
    "reset",
  );
  log(
    "  mgdb restore database ./backups/user-cluster0/2024-01-15/mydb",
    "reset",
  );
  log(
    "  mgdb restore cluster ./backups/user-cluster0/2024-01-15 --drop\n",
    "reset",
  );

  log("Output:", "cyan");
  log(
    "  Backups are saved to: ./backups/<username-cluster>/<timestamp>/",
    "reset",
  );
  log(
    "  Each database gets its own folder with JSON files per collection.\n",
    "reset",
  );
}

// Main entry point
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  showUsage();
  process.exit(0);
}

if (args.length === 0) {
  interactiveMode();
} else {
  cliMode(args);
}
