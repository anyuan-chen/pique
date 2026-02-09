import { test, expect } from '@playwright/test';

/**
 * Tests for voice app tool execution UI feedback
 *
 * Tests that the UI properly responds to tool lifecycle events:
 * toolStarted, toolCompleted, toolError
 */

test.describe('Voice App Tool Execution', () => {

  test.beforeEach(async ({ page }) => {
    // Mock endpoints
    await page.route('**/api/upload/video/raw', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          videoUrl: '/uploads/test-video.mp4',
          filename: 'test-video.mp4'
        })
      });
    });

    await page.route('**/api/youtube/status', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ connected: true, hasRefreshToken: true })
      });
    });

    // Mock WebSocket and getUserMedia
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = async () => ({
        getTracks: () => [{ stop: () => {}, kind: 'audio' }]
      });

      window.mockWsSentMessages = [];

      class MockWebSocket {
        constructor(url) {
          this.url = url;
          this.readyState = MockWebSocket.OPEN;
          window.mockWs = this;
          setTimeout(() => this.onopen?.({ target: this }), 10);
        }
        send(data) { window.mockWsSentMessages.push(JSON.parse(data)); }
        close() {
          this.readyState = MockWebSocket.CLOSED;
          this.onclose?.({ target: this });
        }
        receiveMessage(data) {
          this.onmessage?.({ data: JSON.stringify(data) });
        }
      }

      MockWebSocket.CONNECTING = 0;
      MockWebSocket.OPEN = 1;
      MockWebSocket.CLOSING = 2;
      MockWebSocket.CLOSED = 3;

      window.WebSocket = MockWebSocket;
      window.sendMockWsMessage = (data) => window.mockWs?.receiveMessage(data);
    });
  });

  async function connectVoiceApp(page) {
    await page.evaluate(() => {
      document.getElementById('action-btn')?.click();
    });
    await page.waitForTimeout(100);
    await page.evaluate(() => window.sendMockWsMessage({ type: 'ready' }));
    await page.waitForTimeout(50);
  }

  test.describe('toolStarted events', () => {

    test('shows "Processing video..." for create_restaurant', async ({ page }) => {
      await page.goto('/mobile/?restaurantId=test-123');
      await connectVoiceApp(page);
      await page.waitForTimeout(200);

      await page.evaluate(() => {
        window.sendMockWsMessage({
          type: 'toolStarted',
          tool: 'create_restaurant',
          args: { videoUrl: '/uploads/test.mp4' }
        });
      });

      await page.waitForTimeout(100);
      const status = await page.locator('#status').textContent();
      expect(status).toBe('Processing video...');
    });

    test('shows "Generating website..." for create_website', async ({ page }) => {
      await page.goto('/mobile/?restaurantId=test-123');
      await connectVoiceApp(page);
      await page.waitForTimeout(200);

      await page.evaluate(() => {
        window.sendMockWsMessage({
          type: 'toolStarted',
          tool: 'create_website',
          args: { restaurantId: 'test-123' }
        });
      });

      await page.waitForTimeout(100);
      const status = await page.locator('#status').textContent();
      expect(status).toBe('Generating website...');
    });

    test('shows "Creating short..." for create_youtube_short', async ({ page }) => {
      await page.goto('/mobile/?restaurantId=test-123');
      await connectVoiceApp(page);
      await page.waitForTimeout(200);

      await page.evaluate(() => {
        window.sendMockWsMessage({
          type: 'toolStarted',
          tool: 'create_youtube_short',
          args: { videoUrl: '/uploads/test.mp4' }
        });
      });

      await page.waitForTimeout(100);
      const status = await page.locator('#status').textContent();
      expect(status).toBe('Creating short...');
    });

    test('shows "Generating..." for generate_graphic', async ({ page }) => {
      await page.goto('/mobile/?restaurantId=test-123');
      await connectVoiceApp(page);
      await page.waitForTimeout(200);

      await page.evaluate(() => {
        window.sendMockWsMessage({
          type: 'toolStarted',
          tool: 'generate_graphic',
          args: { prompt: 'pizza promo' }
        });
      });

      await page.waitForTimeout(100);
      const status = await page.locator('#status').textContent();
      expect(status).toBe('Generating...');
    });

    test('shows "Updating..." for modify_website', async ({ page }) => {
      await page.goto('/mobile/?restaurantId=test-123');
      await connectVoiceApp(page);
      await page.waitForTimeout(200);

      await page.evaluate(() => {
        window.sendMockWsMessage({
          type: 'toolStarted',
          tool: 'modify_website',
          args: { prompt: 'change price to $20' }
        });
      });

      await page.waitForTimeout(100);
      const status = await page.locator('#status').textContent();
      expect(status).toBe('Updating...');
    });

    test('shows "Working..." for unknown tools', async ({ page }) => {
      await page.goto('/mobile/?restaurantId=test-123');
      await connectVoiceApp(page);
      await page.waitForTimeout(200);

      await page.evaluate(() => {
        window.sendMockWsMessage({
          type: 'toolStarted',
          tool: 'some_unknown_tool',
          args: {}
        });
      });

      await page.waitForTimeout(100);
      const status = await page.locator('#status').textContent();
      expect(status).toBe('Working...');
    });

    test('activates waveform animation when tool starts', async ({ page }) => {
      await page.goto('/mobile/?restaurantId=test-123');
      await connectVoiceApp(page);
      await page.waitForTimeout(200);

      // Initially not active
      let hasActive = await page.evaluate(() =>
        document.getElementById('waveform')?.classList.contains('active')
      );
      expect(hasActive).toBe(false);

      await page.evaluate(() => {
        window.sendMockWsMessage({
          type: 'toolStarted',
          tool: 'create_website',
          args: {}
        });
      });

      await page.waitForTimeout(100);

      hasActive = await page.evaluate(() =>
        document.getElementById('waveform')?.classList.contains('active')
      );
      expect(hasActive).toBe(true);
    });
  });

  test.describe('toolCompleted events', () => {

    test('shows "Done" status when tool completes', async ({ page }) => {
      await page.goto('/mobile/?restaurantId=test-123');
      await connectVoiceApp(page);
      await page.waitForTimeout(200);

      await page.evaluate(() => {
        window.sendMockWsMessage({ type: 'toolStarted', tool: 'create_website', args: {} });
      });
      await page.waitForTimeout(50);

      await page.evaluate(() => {
        window.sendMockWsMessage({
          type: 'toolCompleted',
          tool: 'create_website',
          result: { websiteUrl: 'https://example.com' }
        });
      });

      await page.waitForTimeout(100);
      const status = await page.locator('#status').textContent();
      expect(status).toBe('Done');
    });

    test('deactivates waveform when tool completes', async ({ page }) => {
      await page.goto('/mobile/?restaurantId=test-123');
      await connectVoiceApp(page);
      await page.waitForTimeout(200);

      await page.evaluate(() => {
        window.sendMockWsMessage({ type: 'toolStarted', tool: 'create_website', args: {} });
      });
      await page.waitForTimeout(50);

      let hasActive = await page.evaluate(() =>
        document.getElementById('waveform')?.classList.contains('active')
      );
      expect(hasActive).toBe(true);

      await page.evaluate(() => {
        window.sendMockWsMessage({ type: 'toolCompleted', tool: 'create_website', result: {} });
      });

      await page.waitForTimeout(100);

      hasActive = await page.evaluate(() =>
        document.getElementById('waveform')?.classList.contains('active')
      );
      expect(hasActive).toBe(false);
    });

    test('displays websiteUrl as message when present', async ({ page }) => {
      await page.goto('/mobile/?restaurantId=test-123');
      await connectVoiceApp(page);
      await page.waitForTimeout(200);

      await page.evaluate(() => {
        window.sendMockWsMessage({
          type: 'toolCompleted',
          tool: 'create_website',
          result: { websiteUrl: 'https://myrestaurant.pages.dev' }
        });
      });

      await page.waitForTimeout(100);

      const messages = await page.locator('#messages').innerHTML();
      expect(messages).toContain('https://myrestaurant.pages.dev');
    });

    test('displays youtubeUrl as message when present', async ({ page }) => {
      await page.goto('/mobile/?restaurantId=test-123');
      await connectVoiceApp(page);
      await page.waitForTimeout(200);

      await page.evaluate(() => {
        window.sendMockWsMessage({
          type: 'toolCompleted',
          tool: 'create_youtube_short',
          result: { youtubeUrl: 'https://youtube.com/shorts/abc123' }
        });
      });

      await page.waitForTimeout(100);

      const messages = await page.locator('#messages').innerHTML();
      expect(messages).toContain('https://youtube.com/shorts/abc123');
    });

    test('displays imageUrl when present', async ({ page }) => {
      await page.goto('/mobile/?restaurantId=test-123');
      await connectVoiceApp(page);
      await page.waitForTimeout(200);

      // First add a message so showImage has something to append to
      await page.evaluate(() => {
        window.sendMockWsMessage({ type: 'text', text: 'Here is your graphic: https://example.com' });
      });
      await page.waitForTimeout(50);

      await page.evaluate(() => {
        window.sendMockWsMessage({
          type: 'toolCompleted',
          tool: 'generate_graphic',
          result: { imageUrl: '/generated/promo-123.png' }
        });
      });

      await page.waitForTimeout(100);

      const messages = await page.locator('#messages').innerHTML();
      // Check that image is present (format may vary based on formatText)
      expect(messages).toContain('/generated/promo-123.png');
      expect(messages).toContain('img');
    });

    test('handles result with no special URLs gracefully', async ({ page }) => {
      await page.goto('/mobile/?restaurantId=test-123');
      await connectVoiceApp(page);
      await page.waitForTimeout(200);

      await page.evaluate(() => {
        window.sendMockWsMessage({
          type: 'toolCompleted',
          tool: 'find_restaurant',
          result: { restaurants: [{ id: '123', name: 'Test' }] }
        });
      });

      await page.waitForTimeout(100);
      const status = await page.locator('#status').textContent();
      expect(status).toBe('Done');
    });
  });

  test.describe('toolError events', () => {

    test('shows "Error" status when tool fails', async ({ page }) => {
      await page.goto('/mobile/?restaurantId=test-123');
      await connectVoiceApp(page);
      await page.waitForTimeout(200);

      await page.evaluate(() => {
        window.sendMockWsMessage({ type: 'toolStarted', tool: 'create_website', args: {} });
      });
      await page.waitForTimeout(50);

      await page.evaluate(() => {
        window.sendMockWsMessage({
          type: 'toolError',
          tool: 'create_website',
          error: 'Failed to generate website'
        });
      });

      await page.waitForTimeout(100);
      const status = await page.locator('#status').textContent();
      expect(status).toBe('Error');
    });

    test('deactivates waveform when tool errors', async ({ page }) => {
      await page.goto('/mobile/?restaurantId=test-123');
      await connectVoiceApp(page);
      await page.waitForTimeout(200);

      await page.evaluate(() => {
        window.sendMockWsMessage({ type: 'toolStarted', tool: 'create_website', args: {} });
      });
      await page.waitForTimeout(50);

      await page.evaluate(() => {
        window.sendMockWsMessage({ type: 'toolError', tool: 'create_website', error: 'fail' });
      });

      await page.waitForTimeout(100);

      const hasActive = await page.evaluate(() =>
        document.getElementById('waveform')?.classList.contains('active')
      );
      expect(hasActive).toBe(false);
    });
  });

  test.describe('sequential tool calls', () => {

    test('handles multiple tools in sequence', async ({ page }) => {
      await page.goto('/mobile/?restaurantId=test-123');
      await connectVoiceApp(page);
      await page.waitForTimeout(200);

      // First tool: create_restaurant
      await page.evaluate(() => {
        window.sendMockWsMessage({ type: 'toolStarted', tool: 'create_restaurant', args: {} });
      });
      await page.waitForTimeout(50);

      let status = await page.locator('#status').textContent();
      expect(status).toBe('Processing video...');

      await page.evaluate(() => {
        window.sendMockWsMessage({
          type: 'toolCompleted',
          tool: 'create_restaurant',
          result: { restaurantId: 'new-123' }
        });
      });
      await page.waitForTimeout(50);

      status = await page.locator('#status').textContent();
      expect(status).toBe('Done');

      // Second tool: create_website
      await page.evaluate(() => {
        window.sendMockWsMessage({ type: 'toolStarted', tool: 'create_website', args: {} });
      });
      await page.waitForTimeout(50);

      status = await page.locator('#status').textContent();
      expect(status).toBe('Generating website...');

      await page.evaluate(() => {
        window.sendMockWsMessage({
          type: 'toolCompleted',
          tool: 'create_website',
          result: { websiteUrl: 'https://new.pages.dev' }
        });
      });
      await page.waitForTimeout(50);

      status = await page.locator('#status').textContent();
      expect(status).toBe('Done');

      // Verify URL was added to messages
      const messages = await page.locator('#messages').innerHTML();
      expect(messages).toContain('https://new.pages.dev');
    });

    test('recovers from error and handles next tool', async ({ page }) => {
      await page.goto('/mobile/?restaurantId=test-123');
      await connectVoiceApp(page);
      await page.waitForTimeout(200);

      // First tool fails
      await page.evaluate(() => {
        window.sendMockWsMessage({ type: 'toolStarted', tool: 'create_website', args: {} });
      });
      await page.waitForTimeout(50);

      await page.evaluate(() => {
        window.sendMockWsMessage({ type: 'toolError', tool: 'create_website', error: 'fail' });
      });
      await page.waitForTimeout(50);

      let status = await page.locator('#status').textContent();
      expect(status).toBe('Error');

      // Second tool succeeds
      await page.evaluate(() => {
        window.sendMockWsMessage({ type: 'toolStarted', tool: 'generate_graphic', args: {} });
      });
      await page.waitForTimeout(50);

      status = await page.locator('#status').textContent();
      expect(status).toBe('Generating...');

      await page.evaluate(() => {
        window.sendMockWsMessage({ type: 'toolCompleted', tool: 'generate_graphic', result: {} });
      });
      await page.waitForTimeout(50);

      status = await page.locator('#status').textContent();
      expect(status).toBe('Done');
    });
  });
});
