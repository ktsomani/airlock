import { config, type Config } from './config.js';
import { openDB, type DB } from './db.js';
import { Engine } from './engine.js';
import { hash, type Paper } from './core.js';
import { loadAdapter, LivePaper, MockPaper } from './paper.js';
import { Schemas } from './schema.js';
export type Runtime = {
  cfg: Config;
  db: DB;
  paper: Paper;
  schemas: Schemas;
  engine: Engine;
  close(): Promise<void>;
};
export async function runtime(boot = false, cfg: Config = config()): Promise<Runtime> {
  const db = openDB(cfg.dataDir),
    paper = cfg.mode === 'mock' ? new MockPaper(db) : new LivePaper(cfg);
  const schemas = new Schemas(
    db,
    paper,
    cfg.mode,
    cfg.ttl,
    hash({ mode: cfg.mode, endpoint: cfg.endpoint, headers: cfg.headers }),
  );
  try {
    await schemas.refresh(!boot);
    const engine = new Engine(db, paper, schemas, await loadAdapter(cfg), cfg.secret);
    return {
      cfg,
      db,
      paper,
      schemas,
      engine,
      async close() {
        await paper.close();
        db.close();
      },
    };
  } catch (e) {
    await paper.close();
    db.close();
    throw e;
  }
}
