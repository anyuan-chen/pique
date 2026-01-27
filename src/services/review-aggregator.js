import { config } from '../config.js';
import { ReviewModel, ReviewPlatformModel } from '../db/models/index.js';

export class ReviewAggregator {
  /**
   * Fetch reviews from all linked platforms for a restaurant
   */
  async fetchAll(restaurantId) {
    const platforms = ReviewPlatformModel.getByRestaurant(restaurantId);
    if (!platforms) {
      return { google: [], total: 0 };
    }

    const results = {
      google: [],
      total: 0,
      errors: []
    };

    // Fetch from Google Places
    if (platforms.googlePlaceId) {
      try {
        const googleReviews = await this.fetchGoogleReviews(restaurantId, platforms.googlePlaceId);
        results.google = googleReviews;
        results.total += googleReviews.length;
      } catch (error) {
        results.errors.push({ source: 'google', error: error.message });
      }
    }

    return results;
  }

  /**
   * Fetch reviews from Google Places API
   */
  async fetchGoogleReviews(restaurantId, placeId) {
    if (!config.google.mapsApiKey) {
      throw new Error('Google Maps API key not configured');
    }

    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=reviews&key=${config.google.mapsApiKey}`;

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Google API error: ${response.status}`);
    }

    const data = await response.json();

    if (data.status !== 'OK') {
      throw new Error(`Google Places API error: ${data.status}`);
    }

    const reviews = data.result?.reviews || [];
    const savedReviews = [];

    for (const review of reviews) {
      const saved = ReviewModel.upsert(restaurantId, {
        source: 'google',
        externalId: `google_${review.time}`,
        authorName: review.author_name,
        authorUrl: review.author_url,
        rating: review.rating,
        text: review.text,
        reviewDate: new Date(review.time * 1000).toISOString()
      });
      savedReviews.push(saved);
    }

    return savedReviews;
  }

  /**
   * Search for a place on Google
   */
  async searchGoogle(query) {
    if (!config.google.mapsApiKey) {
      throw new Error('Google Maps API key not configured');
    }

    const params = new URLSearchParams({
      input: query,
      inputtype: 'textquery',
      fields: 'place_id,name,formatted_address,rating,user_ratings_total',
      key: config.google.mapsApiKey
    });

    const url = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?${params}`;

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Google API error: ${response.status}`);
    }

    const data = await response.json();

    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      throw new Error(`Google Places API error: ${data.status}`);
    }

    return (data.candidates || []).map(place => ({
      placeId: place.place_id,
      name: place.name,
      address: place.formatted_address,
      rating: place.rating,
      reviewCount: place.user_ratings_total
    }));
  }
}

export const reviewAggregator = new ReviewAggregator();
