import db from '../database.js';
import { v4 as uuidv4 } from 'uuid';

export const ReviewDigestModel = {
  /**
   * Create a new digest
   */
  create(restaurantId, data) {
    const id = uuidv4();
    const stmt = db.prepare(`
      INSERT INTO review_digests (
        id, restaurant_id, period_start, period_end, review_count,
        avg_rating, summary, complaints_json, praise_json, actions_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      restaurantId,
      data.periodStart,
      data.periodEnd,
      data.reviewCount || 0,
      data.avgRating || null,
      data.summary || null,
      data.complaints ? JSON.stringify(data.complaints) : null,
      data.praise ? JSON.stringify(data.praise) : null,
      data.actions ? JSON.stringify(data.actions) : null
    );

    return this.getById(id);
  },

  /**
   * Get digest by ID
   */
  getById(id) {
    const stmt = db.prepare('SELECT * FROM review_digests WHERE id = ?');
    const row = stmt.get(id);
    if (!row) return null;

    return this.formatDigest(row);
  },

  /**
   * Get latest digest for a restaurant
   */
  getLatest(restaurantId) {
    const stmt = db.prepare(`
      SELECT * FROM review_digests
      WHERE restaurant_id = ?
      ORDER BY period_end DESC
      LIMIT 1
    `);
    const row = stmt.get(restaurantId);
    if (!row) return null;

    return this.formatDigest(row);
  },

  /**
   * Get all digests for a restaurant
   */
  getByRestaurant(restaurantId, limit = 10) {
    const stmt = db.prepare(`
      SELECT * FROM review_digests
      WHERE restaurant_id = ?
      ORDER BY period_end DESC
      LIMIT ?
    `);
    return stmt.all(restaurantId, limit).map(row => this.formatDigest(row));
  },

  /**
   * Check if digest exists for a period
   */
  existsForPeriod(restaurantId, periodStart, periodEnd) {
    const stmt = db.prepare(`
      SELECT id FROM review_digests
      WHERE restaurant_id = ? AND period_start = ? AND period_end = ?
    `);
    return stmt.get(restaurantId, periodStart, periodEnd) !== undefined;
  },

  /**
   * Get digest by period
   */
  getByPeriod(restaurantId, periodStart, periodEnd) {
    const stmt = db.prepare(`
      SELECT * FROM review_digests
      WHERE restaurant_id = ? AND period_start = ? AND period_end = ?
    `);
    const row = stmt.get(restaurantId, periodStart, periodEnd);
    if (!row) return null;

    return this.formatDigest(row);
  },

  /**
   * Update existing digest
   */
  update(id, data) {
    const fields = [];
    const values = [];

    const fieldMap = {
      reviewCount: 'review_count',
      avgRating: 'avg_rating',
      summary: 'summary',
      complaints: 'complaints_json',
      praise: 'praise_json',
      actions: 'actions_json'
    };

    for (const [key, dbField] of Object.entries(fieldMap)) {
      if (data[key] !== undefined) {
        fields.push(`${dbField} = ?`);
        const value = ['complaints', 'praise', 'actions'].includes(key)
          ? JSON.stringify(data[key])
          : data[key];
        values.push(value);
      }
    }

    if (fields.length === 0) return this.getById(id);

    values.push(id);
    const stmt = db.prepare(`UPDATE review_digests SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...values);

    return this.getById(id);
  },

  /**
   * Delete digest
   */
  delete(id) {
    const stmt = db.prepare('DELETE FROM review_digests WHERE id = ?');
    return stmt.run(id);
  },

  /**
   * Format database row to API response
   */
  formatDigest(row) {
    return {
      id: row.id,
      restaurantId: row.restaurant_id,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      reviewCount: row.review_count,
      avgRating: row.avg_rating,
      sentimentSummary: row.summary,
      commonComplaints: row.complaints_json ? JSON.parse(row.complaints_json) : [],
      praiseThemes: row.praise_json ? JSON.parse(row.praise_json) : [],
      suggestedActions: row.actions_json ? JSON.parse(row.actions_json) : [],
      createdAt: row.created_at
    };
  }
};
