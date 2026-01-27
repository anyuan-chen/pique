import { Router } from 'express';
import { RestaurantModel, ReviewModel, ReviewPlatformModel, ReviewDigestModel } from '../db/models/index.js';
import { reviewAggregator } from '../services/review-aggregator.js';
import { digestGenerator } from '../services/digest-generator.js';
import db from '../db/database.js';

const router = Router();

/**
 * GET /api/reviews/:restaurantId
 * List reviews with filters
 */
router.get('/:restaurantId', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { source, sentiment, startDate, endDate, limit = 50, offset = 0 } = req.query;

    const restaurant = RestaurantModel.getById(restaurantId);
    if (!restaurant) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const reviews = ReviewModel.getByRestaurant(restaurantId, {
      source,
      sentiment,
      startDate,
      endDate,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });

    const stats = ReviewModel.getStats(restaurantId, { source, startDate, endDate });

    res.json({
      reviews,
      stats: {
        total: stats.total_reviews || 0,
        avgRating: stats.avg_rating ? parseFloat(stats.avg_rating.toFixed(2)) : null,
        sentiment: {
          positive: stats.positive_count || 0,
          negative: stats.negative_count || 0,
          neutral: stats.neutral_count || 0,
          mixed: stats.mixed_count || 0
        }
      }
    });
  } catch (error) {
    console.error('Get reviews error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/reviews/:restaurantId/fetch
 * Pull latest reviews from linked platforms
 */
router.post('/:restaurantId/fetch', async (req, res) => {
  try {
    const { restaurantId } = req.params;

    const restaurant = RestaurantModel.getById(restaurantId);
    if (!restaurant) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    if (!restaurant.reviews_enabled) {
      return res.status(400).json({ error: 'Review aggregation not enabled for this restaurant' });
    }

    const results = await reviewAggregator.fetchAll(restaurantId);

    res.json({
      fetched: results.total,
      google: results.google.length,
      errors: results.errors
    });
  } catch (error) {
    console.error('Fetch reviews error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/reviews/:restaurantId/platforms
 * List linked platforms
 */
router.get('/:restaurantId/platforms', async (req, res) => {
  try {
    const { restaurantId } = req.params;

    const restaurant = RestaurantModel.getById(restaurantId);
    if (!restaurant) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const platforms = ReviewPlatformModel.getByRestaurant(restaurantId);

    res.json({
      reviewsEnabled: restaurant.reviews_enabled === 1,
      platforms: platforms || { googlePlaceId: null }
    });
  } catch (error) {
    console.error('Get platforms error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/reviews/:restaurantId/link-google
 * Link Google Place ID
 */
router.post('/:restaurantId/link-google', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { placeId } = req.body;

    if (!placeId) {
      return res.status(400).json({ error: 'placeId is required' });
    }

    const restaurant = RestaurantModel.getById(restaurantId);
    if (!restaurant) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const platforms = ReviewPlatformModel.linkGoogle(restaurantId, placeId);

    res.json({
      success: true,
      platforms
    });
  } catch (error) {
    console.error('Link Google error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/reviews/:restaurantId/search-google
 * Search Google Places for business
 */
router.post('/:restaurantId/search-google', async (req, res) => {
  try {
    const { query } = req.body;

    if (!query) {
      return res.status(400).json({ error: 'query is required' });
    }

    const results = await reviewAggregator.searchGoogle(query);

    res.json({ results });
  } catch (error) {
    console.error('Search Google error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/reviews/:restaurantId/digests
 * List past digests
 */
router.get('/:restaurantId/digests', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { limit = 10 } = req.query;

    const restaurant = RestaurantModel.getById(restaurantId);
    if (!restaurant) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const digests = ReviewDigestModel.getByRestaurant(restaurantId, parseInt(limit));

    res.json({ digests });
  } catch (error) {
    console.error('Get digests error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/reviews/:restaurantId/digests/latest
 * Get most recent digest
 */
router.get('/:restaurantId/digests/latest', async (req, res) => {
  try {
    const { restaurantId } = req.params;

    const restaurant = RestaurantModel.getById(restaurantId);
    if (!restaurant) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const digest = ReviewDigestModel.getLatest(restaurantId);

    if (!digest) {
      return res.status(404).json({ error: 'No digests found' });
    }

    res.json(digest);
  } catch (error) {
    console.error('Get latest digest error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/reviews/:restaurantId/digests/generate
 * Generate digest manually
 */
router.post('/:restaurantId/digests/generate', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { periodStart, periodEnd } = req.body;

    const restaurant = RestaurantModel.getById(restaurantId);
    if (!restaurant) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const digest = await digestGenerator.generateDigest(restaurantId, {
      periodStart,
      periodEnd
    });

    res.json(digest);
  } catch (error) {
    console.error('Generate digest error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/reviews/:restaurantId/analyze
 * Run sentiment analysis on unanalyzed reviews
 */
router.post('/:restaurantId/analyze', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { limit = 50 } = req.body;

    const restaurant = RestaurantModel.getById(restaurantId);
    if (!restaurant) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const unanalyzed = ReviewModel.getUnanalyzed(restaurantId, limit);

    if (unanalyzed.length === 0) {
      return res.json({ analyzed: 0, message: 'All reviews already analyzed' });
    }

    const results = await digestGenerator.analyzeSentiment(unanalyzed);

    res.json({
      analyzed: results.length,
      results
    });
  } catch (error) {
    console.error('Analyze reviews error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/reviews/:restaurantId/insights
 * Get review insights without generating digest
 */
router.get('/:restaurantId/insights', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { days = 30 } = req.query;

    const restaurant = RestaurantModel.getById(restaurantId);
    if (!restaurant) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const insights = await digestGenerator.getInsights(restaurantId, {
      days: parseInt(days)
    });

    res.json(insights);
  } catch (error) {
    console.error('Get insights error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/reviews/:restaurantId/enable
 * Enable review aggregation
 */
router.post('/:restaurantId/enable', async (req, res) => {
  try {
    const { restaurantId } = req.params;

    const restaurant = RestaurantModel.getById(restaurantId);
    if (!restaurant) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const stmt = db.prepare('UPDATE restaurants SET reviews_enabled = 1 WHERE id = ?');
    stmt.run(restaurantId);

    res.json({ success: true, reviewsEnabled: true });
  } catch (error) {
    console.error('Enable reviews error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/reviews/:restaurantId/disable
 * Disable review aggregation
 */
router.post('/:restaurantId/disable', async (req, res) => {
  try {
    const { restaurantId } = req.params;

    const restaurant = RestaurantModel.getById(restaurantId);
    if (!restaurant) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const stmt = db.prepare('UPDATE restaurants SET reviews_enabled = 0 WHERE id = ?');
    stmt.run(restaurantId);

    res.json({ success: true, reviewsEnabled: false });
  } catch (error) {
    console.error('Disable reviews error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
