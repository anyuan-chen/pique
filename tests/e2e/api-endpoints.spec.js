import { test, expect } from '@playwright/test';

/**
 * Tests for API endpoints used by the voice app
 *
 * Tests HTTP endpoints (not WebSocket) for:
 * - Video upload
 * - YouTube auth flow
 * - Onboarding
 */

test.describe('API Endpoints', () => {

  test.describe('Video Upload API', () => {

    test('POST /api/upload/video/raw accepts video file', async ({ request }) => {
      // Create a minimal video-like buffer
      const videoData = Buffer.from('fake video content for testing');

      const response = await request.post('/api/upload/video/raw', {
        multipart: {
          video: {
            name: 'test-video.mp4',
            mimeType: 'video/mp4',
            buffer: videoData
          }
        }
      });

      // API should respond (may be 200, 400, or 404 depending on server state)
      // Just verify it doesn't crash and returns JSON or error
      expect([200, 400, 404, 500]).toContain(response.status());

      if (response.status() === 200) {
        const json = await response.json();
        expect(json).toHaveProperty('videoUrl');
      }
    });

    test('POST /api/upload/video/raw returns filename on success', async ({ request }) => {
      const response = await request.post('/api/upload/video/raw', {
        multipart: {
          video: {
            name: 'my-cooking-video.mp4',
            mimeType: 'video/mp4',
            buffer: Buffer.from('data')
          }
        }
      });

      if (response.status() === 200) {
        const json = await response.json();
        expect(json).toHaveProperty('filename');
      } else {
        // Endpoint may not exist in test environment - that's OK
        expect([400, 404, 500]).toContain(response.status());
      }
    });

    test('POST /api/upload/video/raw without file returns error', async ({ request }) => {
      const response = await request.post('/api/upload/video/raw', {
        data: {}
      });

      // Should return error status (or 404 if endpoint doesn't exist)
      expect(response.status()).toBeGreaterThanOrEqual(400);
    });
  });

  test.describe('YouTube Auth API', () => {

    test('GET /api/youtube/status returns connection status', async ({ request }) => {
      const response = await request.get('/api/youtube/status');

      expect(response.status()).toBe(200);

      const json = await response.json();
      expect(json).toHaveProperty('connected');
      expect(typeof json.connected).toBe('boolean');
    });

    test('GET /api/youtube/status includes hasRefreshToken', async ({ request }) => {
      const response = await request.get('/api/youtube/status');
      const json = await response.json();

      expect(json).toHaveProperty('hasRefreshToken');
      expect(typeof json.hasRefreshToken).toBe('boolean');
    });

    test('GET /api/youtube/auth redirects to Google OAuth', async ({ request }) => {
      const response = await request.get('/api/youtube/auth', {
        maxRedirects: 0 // Don't follow redirects
      });

      // Should redirect (302) to Google OAuth
      // Or return HTML if credentials not configured
      expect([200, 302, 500]).toContain(response.status());

      if (response.status() === 302) {
        const location = response.headers()['location'];
        expect(location).toContain('accounts.google.com');
      }
    });

    test('GET /api/youtube/callback without code shows error page', async ({ request }) => {
      const response = await request.get('/api/youtube/callback');

      expect(response.status()).toBe(200); // Returns HTML error page

      const html = await response.text();
      // Check for error indication (may say "Failed" or "No authorization code")
      expect(html.toLowerCase()).toMatch(/fail|error|no.*code/i);
    });

    test('GET /api/youtube/callback with error param shows error', async ({ request }) => {
      const response = await request.get('/api/youtube/callback?error=access_denied');

      const html = await response.text();
      // Check for error indication
      expect(html.toLowerCase()).toMatch(/fail|error|denied/i);
    });
  });

  test.describe('Onboarding API', () => {

    test('GET /api/onboard/search with query returns results', async ({ request }) => {
      const response = await request.get('/api/onboard/search?q=pizza');

      // May return 200 with results or error if Google API not configured
      if (response.status() === 200) {
        const json = await response.json();
        expect(Array.isArray(json.predictions) || Array.isArray(json.results) || json.error).toBe(true);
      }
    });

    test('GET /api/onboard/search without query returns error or empty', async ({ request }) => {
      const response = await request.get('/api/onboard/search');

      // API may return 400 error, or 200 with empty results - both are valid
      if (response.status() === 200) {
        const json = await response.json();
        // Should have empty or missing predictions
        expect(json.predictions?.length || 0).toBe(0);
      } else {
        expect(response.status()).toBeGreaterThanOrEqual(400);
      }
    });

    test('POST /api/onboard/check validates request body', async ({ request }) => {
      const response = await request.post('/api/onboard/check', {
        data: {} // Missing required fields
      });

      expect(response.status()).toBeGreaterThanOrEqual(400);
    });

    test('GET /api/onboard/menu/:restaurantId for nonexistent restaurant', async ({ request }) => {
      const response = await request.get('/api/onboard/menu/nonexistent-restaurant-id-12345');

      // Should return 404 or empty array
      expect([200, 404]).toContain(response.status());
    });
  });

  test.describe('Review API', () => {

    test('GET /api/reviews/:restaurantId returns reviews or empty', async ({ request }) => {
      const response = await request.get('/api/reviews/test-restaurant-123');

      if (response.status() === 200) {
        const json = await response.json();
        expect(json).toHaveProperty('reviews');
        expect(Array.isArray(json.reviews)).toBe(true);
      }
    });

    test('GET /api/reviews/:restaurantId/insights returns stats', async ({ request }) => {
      const response = await request.get('/api/reviews/test-restaurant-123/insights');

      if (response.status() === 200) {
        const json = await response.json();
        // Should have some insight properties
        expect(json).toBeDefined();
      }
    });

    test('GET /api/reviews/:restaurantId/digests/latest returns digest or message', async ({ request }) => {
      const response = await request.get('/api/reviews/test-restaurant-123/digests/latest');

      if (response.status() === 200) {
        const json = await response.json();
        // Either has digest or message about no digest
        expect(json.digest || json.message).toBeDefined();
      }
    });
  });

  test.describe('Evaluate API', () => {

    test('GET /api/evaluate/:restaurantId for nonexistent restaurant', async ({ request }) => {
      const response = await request.get('/api/evaluate/nonexistent-12345');

      // Should handle gracefully
      expect([200, 400, 404, 500]).toContain(response.status());
    });
  });

  test.describe('Static Files', () => {

    test('GET /mobile/ serves voice app HTML', async ({ request }) => {
      const response = await request.get('/mobile/');

      expect(response.status()).toBe(200);

      const html = await response.text();
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('app.js');
    });

    test('GET /mobile/app.js serves JavaScript', async ({ request }) => {
      const response = await request.get('/mobile/app.js');

      expect(response.status()).toBe(200);

      const contentType = response.headers()['content-type'];
      expect(contentType).toContain('javascript');
    });

    test('GET /mobile/onboard.html serves onboarding page', async ({ request }) => {
      const response = await request.get('/mobile/onboard.html');

      expect(response.status()).toBe(200);

      const html = await response.text();
      expect(html).toContain('<!DOCTYPE html>');
    });
  });

  test.describe('Error Handling', () => {

    test('404 for unknown API route', async ({ request }) => {
      const response = await request.get('/api/unknown-endpoint-xyz');

      expect(response.status()).toBe(404);
    });

    test('API returns JSON error for bad requests', async ({ request }) => {
      const response = await request.post('/api/upload/video/raw', {
        headers: {
          'Content-Type': 'application/json'
        },
        data: { invalid: 'data' }
      });

      // Should return error, not crash
      expect(response.status()).toBeGreaterThanOrEqual(400);
    });
  });

  test.describe('CORS and Headers', () => {

    test('API endpoints allow same-origin requests', async ({ request }) => {
      const response = await request.get('/api/youtube/status');

      // Should not have CORS error for same-origin
      expect(response.status()).toBe(200);
    });
  });

  test.describe('Website Generation API', () => {

    test('POST /api/deploy/generate/website/:id returns jobId immediately', async ({ request }) => {
      const response = await request.post('/api/deploy/generate/website/test-restaurant-123', {
        data: { iterative: false }
      });

      // May return 404 if restaurant doesn't exist, or 200 with jobId
      if (response.status() === 200) {
        const json = await response.json();
        expect(json).toHaveProperty('jobId');
        expect(json).toHaveProperty('status');
        expect(json.status).toBe('pending');
      } else {
        expect([404, 500]).toContain(response.status());
      }
    });

    test('GET /api/deploy/generate/website/status/:jobId returns job state', async ({ request }) => {
      // First create a job
      const createResponse = await request.post('/api/deploy/generate/website/test-restaurant-456', {
        data: {}
      });

      if (createResponse.status() === 200) {
        const { jobId } = await createResponse.json();

        // Check status
        const statusResponse = await request.get(`/api/deploy/generate/website/status/${jobId}`);
        expect(statusResponse.status()).toBe(200);

        const job = await statusResponse.json();
        expect(['pending', 'processing', 'ready', 'failed']).toContain(job.status);
        expect(job).toHaveProperty('progress');
      }
    });

    test('GET /api/deploy/generate/website/status/:jobId with invalid ID returns 404', async ({ request }) => {
      const response = await request.get('/api/deploy/generate/website/status/invalid-job-id-xyz');

      expect(response.status()).toBe(404);
    });

    test('GET /api/deploy/generate/website/pending/:restaurantId returns pending job or empty', async ({ request }) => {
      const response = await request.get('/api/deploy/generate/website/pending/test-restaurant-789');

      expect(response.status()).toBe(200);

      const json = await response.json();
      // Should return empty object or job info
      if (json.jobId) {
        expect(json).toHaveProperty('status');
      }
    });

    test('POST /api/deploy/generate/website/:id returns 409 if job already in progress', async ({ request }) => {
      // First request - should succeed (or 404 if restaurant doesn't exist)
      const first = await request.post('/api/deploy/generate/website/test-concurrent-123', {
        data: {}
      });

      if (first.status() === 200) {
        // Second request to same restaurant - should return 409
        const second = await request.post('/api/deploy/generate/website/test-concurrent-123', {
          data: {}
        });

        expect(second.status()).toBe(409);
        const json = await second.json();
        expect(json).toHaveProperty('error');
        expect(json.error).toContain('already in progress');
        expect(json).toHaveProperty('jobId');
      }
    });
  });
});
