import { ReviewPlatformModel, DigestPreferencesModel } from '../db/models/index.js';
import { reviewAggregator } from '../services/review-aggregator.js';
import { digestGenerator } from '../services/digest-generator.js';
import db from '../db/database.js';

const FETCH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const CHECK_DIGEST_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

let fetchIntervalId = null;
let digestIntervalId = null;

/**
 * Fetch reviews for all enabled restaurants
 */
async function fetchAllReviews() {
  console.log('[DigestScheduler] Starting scheduled review fetch...');

  try {
    // Get all restaurants with reviews enabled and linked platforms
    const stmt = db.prepare(`
      SELECT r.id, r.name, rpt.google_place_id
      FROM restaurants r
      JOIN review_platform_tokens rpt ON rpt.restaurant_id = r.id
      WHERE r.reviews_enabled = 1
        AND rpt.google_place_id IS NOT NULL
    `);
    const restaurants = stmt.all();

    console.log(`[DigestScheduler] Found ${restaurants.length} restaurants with reviews enabled`);

    for (const restaurant of restaurants) {
      try {
        const results = await reviewAggregator.fetchAll(restaurant.id);
        console.log(`[DigestScheduler] Fetched ${results.total} reviews for ${restaurant.name}`);
      } catch (error) {
        console.error(`[DigestScheduler] Error fetching reviews for ${restaurant.name}:`, error.message);
      }

      // Small delay between restaurants to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    console.log('[DigestScheduler] Review fetch complete');
  } catch (error) {
    console.error('[DigestScheduler] Error in fetchAllReviews:', error);
  }
}

/**
 * Check and generate digests for restaurants that need them
 */
async function checkAndGenerateDigests() {
  console.log('[DigestScheduler] Checking for digest generation...');

  try {
    const now = new Date();
    const currentDay = now.getDay(); // 0 = Sunday
    const currentHour = now.getHours();

    // Get all restaurants with digest preferences
    const stmt = db.prepare(`
      SELECT r.id, r.name, dp.frequency, dp.day_of_week, dp.hour_of_day
      FROM restaurants r
      JOIN digest_preferences dp ON dp.restaurant_id = r.id
      WHERE r.reviews_enabled = 1
    `);
    const restaurants = stmt.all();

    for (const restaurant of restaurants) {
      const prefs = {
        frequency: restaurant.frequency || 'weekly',
        dayOfWeek: restaurant.day_of_week ?? 1,
        hourOfDay: restaurant.hour_of_day ?? 9
      };

      // Check if it's time to generate
      let shouldGenerate = false;

      if (prefs.frequency === 'daily' && currentHour === prefs.hourOfDay) {
        shouldGenerate = true;
      } else if (prefs.frequency === 'weekly' &&
                 currentDay === prefs.dayOfWeek &&
                 currentHour === prefs.hourOfDay) {
        shouldGenerate = true;
      } else if (prefs.frequency === 'monthly' &&
                 now.getDate() === 1 &&
                 currentHour === prefs.hourOfDay) {
        shouldGenerate = true;
      }

      if (shouldGenerate) {
        try {
          // Calculate period based on frequency
          const periodEnd = now.toISOString();
          const periodStart = new Date();

          if (prefs.frequency === 'daily') {
            periodStart.setDate(periodStart.getDate() - 1);
          } else if (prefs.frequency === 'weekly') {
            periodStart.setDate(periodStart.getDate() - 7);
          } else if (prefs.frequency === 'monthly') {
            periodStart.setMonth(periodStart.getMonth() - 1);
          }

          console.log(`[DigestScheduler] Generating ${prefs.frequency} digest for ${restaurant.name}`);

          const digest = await digestGenerator.generateDigest(restaurant.id, {
            periodStart: periodStart.toISOString(),
            periodEnd
          });

          console.log(`[DigestScheduler] Generated digest ${digest.id} with ${digest.reviewCount} reviews`);

          // Future: Send email notification here
          // if (prefs.emailEnabled && prefs.emailAddress) {
          //   await sendDigestEmail(prefs.emailAddress, digest);
          // }
        } catch (error) {
          console.error(`[DigestScheduler] Error generating digest for ${restaurant.name}:`, error.message);
        }
      }
    }
  } catch (error) {
    console.error('[DigestScheduler] Error in checkAndGenerateDigests:', error);
  }
}

/**
 * Start the scheduler
 */
export function startDigestScheduler() {
  console.log('[DigestScheduler] Starting scheduler...');
  console.log(`[DigestScheduler] Review fetch interval: ${FETCH_INTERVAL_MS / 1000 / 60 / 60} hours`);
  console.log(`[DigestScheduler] Digest check interval: ${CHECK_DIGEST_INTERVAL_MS / 1000 / 60} minutes`);

  // Run initial fetch after a short delay
  setTimeout(() => {
    fetchAllReviews();
  }, 10000);

  // Schedule periodic review fetching
  fetchIntervalId = setInterval(fetchAllReviews, FETCH_INTERVAL_MS);

  // Schedule digest generation checks
  digestIntervalId = setInterval(checkAndGenerateDigests, CHECK_DIGEST_INTERVAL_MS);

  return {
    stop: stopDigestScheduler
  };
}

/**
 * Stop the scheduler
 */
export function stopDigestScheduler() {
  console.log('[DigestScheduler] Stopping scheduler...');

  if (fetchIntervalId) {
    clearInterval(fetchIntervalId);
    fetchIntervalId = null;
  }

  if (digestIntervalId) {
    clearInterval(digestIntervalId);
    digestIntervalId = null;
  }
}

/**
 * Manually trigger a review fetch for testing
 */
export async function triggerFetch() {
  return fetchAllReviews();
}

/**
 * Manually trigger digest check for testing
 */
export async function triggerDigestCheck() {
  return checkAndGenerateDigests();
}
