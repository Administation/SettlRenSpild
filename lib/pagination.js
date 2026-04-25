// Hjælpere til server-side paginering og søgning.
// Konvention for paginerede endpoints:
//   GET /api/...?offset=0&limit=50&q=...
//   → { rows: [...], total, offset, limit }

function parsePaging(query, defaults = {}) {
  const limit = Math.max(1, Math.min(500, parseInt(query.limit, 10) || defaults.limit || 50));
  const offset = Math.max(0, parseInt(query.offset, 10) || 0);
  return { limit, offset };
}

// Tag eksisterende WHERE-clauses + paramliste og kør en COUNT(*) parallelt
// med selve LIMIT/OFFSET-querien så frontend kan vise total.
async function paginatedQuery(pool, { selectSql, fromSql, whereSql = '', params = [], orderBy = '', limit, offset }) {
  const where = whereSql ? `WHERE ${whereSql}` : '';
  const order = orderBy ? `ORDER BY ${orderBy}` : '';
  const dataSql  = `SELECT ${selectSql} FROM ${fromSql} ${where} ${order} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  const countSql = `SELECT COUNT(*)::int AS total FROM ${fromSql} ${where}`;
  const [data, count] = await Promise.all([
    pool.query(dataSql, [...params, limit, offset]),
    pool.query(countSql, params),
  ]);
  return { rows: data.rows, total: count.rows[0].total, offset, limit };
}

module.exports = { parsePaging, paginatedQuery };
