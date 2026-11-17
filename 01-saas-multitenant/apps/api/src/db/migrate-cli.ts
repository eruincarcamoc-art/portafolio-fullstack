import { loadConfig } from '../config.js';
import { createDb } from './index.js';
import { migrate } from './migrate.js';

const db = createDb(loadConfig());
const applied = await migrate(db);
console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date');
await db.close();
