import mysql from "mysql2/promise";

// The pool is created lazily on first query — NOT at module load. `next build`
// imports every route module to collect page data, and at build time
// DATABASE_URL is absent; eagerly calling createPool("") there throws
// "Invalid URL" and fails the whole image build.
let _pool: ReturnType<typeof mysql.createPool> | null = null;
function pool() {
  if (!_pool) _pool = createPoolFromEnv();
  return _pool!;
}

function createPoolFromEnv(): ReturnType<typeof mysql.createPool> {
  // Option A (recommended): discrete vars. Passwords with special characters
  // (@ : / ? # % …) need NO url-encoding this way.
  const host = process.env.MYSQL_HOST || process.env.DB_HOST;
  if (host) {
    return mysql.createPool({
      host,
      port: Number(process.env.MYSQL_PORT || process.env.DB_PORT || 3306),
      user: process.env.MYSQL_USER || process.env.DB_USER || "root",
      password: process.env.MYSQL_PASSWORD || process.env.DB_PASSWORD || "",
      database: process.env.MYSQL_DATABASE || process.env.DB_NAME,
    });
  }

  // Option B: a single connection URI, e.g. mysql://user:pass@host:3306/db
  const url = process.env.DATABASE_URL?.trim();
  if (url) {
    try {
      return mysql.createPool(url);
    } catch (e: any) {
      throw new Error(
        "DATABASE_URL 无法解析(最常见原因:密码里含 @ : / ? # % 等特殊字符,未做 URL 编码,导致连接串被截断)。" +
          "二选一修复:① 改用分开的环境变量 MYSQL_HOST / MYSQL_PORT / MYSQL_USER / MYSQL_PASSWORD / MYSQL_DATABASE(推荐,密码原样填,不用编码);" +
          "② 保留 DATABASE_URL,但把密码里的特殊字符做百分号编码(@→%40, :→%3A, /→%2F, #→%23, ?→%3F, %→%25)。" +
          "底层错误:" + (e?.message || String(e))
      );
    }
  }

  throw new Error(
    "数据库环境变量未配置。请设置 MYSQL_HOST / MYSQL_PORT / MYSQL_USER / MYSQL_PASSWORD / MYSQL_DATABASE,或设置 DATABASE_URL。"
  );
}

/**
 * Tagged-template SQL helper, e.g. `sql\`SELECT * FROM t WHERE id=${id}\``.
 * Returns plain rows for SELECT. For INSERT/UPDATE/DELETE it returns an
 * (empty) array with `.insertId` / `.affectedRows` attached, so call sites
 * that need the new auto-increment id can read `(await sql\`INSERT ...\`).insertId`.
 */
export async function sql(strings: TemplateStringsArray, ...values: unknown[]): Promise<any[]> {
  let text = strings[0];
  for (let i = 0; i < values.length; i++) text += "?" + strings[i + 1];
  // Use query() rather than execute(): execute() uses server-side prepared
  // statements, which (a) reject DDL like CREATE TABLE on some servers and
  // (b) fail on `LIMIT ?` with "Incorrect arguments to mysqld_stmt_execute".
  // query() still fully escapes the parameter array, so it's injection-safe.
  const [result] = await pool().query(text, values as any[]);
  if (Array.isArray(result)) return result as any[];
  // ResultSetHeader from INSERT/UPDATE/DELETE
  const arr: any[] = [];
  (arr as any).insertId = (result as any).insertId;
  (arr as any).affectedRows = (result as any).affectedRows;
  return arr;
}

/** ADD COLUMN that is safe to re-run: swallows MySQL error 1060 (duplicate column). */
async function ensureColumn(table: string, column: string, definition: string): Promise<void> {
  try {
    // Identifiers are hardcoded call-site constants, not user input — safe to inline.
    await pool().query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
  } catch (e: any) {
    if (e?.errno !== 1060) throw e; // 1060 = column already exists
  }
}

let initPromise: Promise<void> | null = null;

/** Idempotently create tables. Safe to call on every request (guarded + IF NOT EXISTS). */
export function ensureSchema(): Promise<void> {
  if (!initPromise) initPromise = init();
  return initPromise;
}

async function init(): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS competition (
    id INT AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    phase VARCHAR(16) NOT NULL DEFAULT 'nomination',
    target_size INT,
    groups_count INT,
    advance_per_group INT,
    champion_id INT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

  // Migration for databases created before `description` existed. MySQL has no
  // ADD COLUMN IF NOT EXISTS, so add it and ignore the "duplicate column" error (1060).
  await ensureColumn("competition", "description", "TEXT");

  await sql`CREATE TABLE IF NOT EXISTS candidate (
    id INT AUTO_INCREMENT PRIMARY KEY,
    competition_id INT NOT NULL,
    bgm_id VARCHAR(64) NOT NULL,
    name VARCHAR(255) NOT NULL,
    name_cn VARCHAR(255),
    image TEXT,
    group_no INT,
    seed INT,
    eliminated BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_candidate_comp_bgm (competition_id, bgm_id),
    CONSTRAINT fk_candidate_competition FOREIGN KEY (competition_id) REFERENCES competition(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

  await sql`CREATE TABLE IF NOT EXISTS nomination_vote (
    competition_id INT NOT NULL,
    candidate_id INT NOT NULL,
    voter_id VARCHAR(64) NOT NULL,
    UNIQUE KEY uq_nom_vote (competition_id, voter_id, candidate_id),
    CONSTRAINT fk_nom_competition FOREIGN KEY (competition_id) REFERENCES competition(id) ON DELETE CASCADE,
    CONSTRAINT fk_nom_candidate FOREIGN KEY (candidate_id) REFERENCES candidate(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

  await sql`CREATE TABLE IF NOT EXISTS matchup (
    id INT AUTO_INCREMENT PRIMARY KEY,
    competition_id INT NOT NULL,
    stage VARCHAR(16) NOT NULL,
    round_no INT NOT NULL DEFAULT 1,
    group_no INT,
    slot INT NOT NULL DEFAULT 0,
    a_id INT NOT NULL,
    b_id INT NOT NULL,
    winner_id INT,
    decided BOOLEAN NOT NULL DEFAULT FALSE,
    CONSTRAINT fk_matchup_competition FOREIGN KEY (competition_id) REFERENCES competition(id) ON DELETE CASCADE,
    CONSTRAINT fk_matchup_a FOREIGN KEY (a_id) REFERENCES candidate(id) ON DELETE CASCADE,
    CONSTRAINT fk_matchup_b FOREIGN KEY (b_id) REFERENCES candidate(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

  await sql`CREATE TABLE IF NOT EXISTS match_vote (
    matchup_id INT NOT NULL,
    voter_id VARCHAR(64) NOT NULL,
    choice_id INT NOT NULL,
    UNIQUE KEY uq_match_vote (matchup_id, voter_id),
    CONSTRAINT fk_mv_matchup FOREIGN KEY (matchup_id) REFERENCES matchup(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;
}
