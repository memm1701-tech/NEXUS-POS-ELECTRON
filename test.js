const db = require('better-sqlite3')(':memory:');
console.log(db.prepare("SELECT datetime('2026-10-04T10:22:36.599Z', '-4 hours') as caracas").get());
