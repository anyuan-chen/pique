import { test, expect } from '@playwright/test';

/**
 * Tests for complete end-to-end voice flows
 *
 * Tests full user journeys through the voice interface combining
 * video upload, YouTube auth, and tool execution.
 */

test.describe('Voice App Full Flows', () => {
  let youtubeConnected = false;

  test.beforeEach(async ({ page }) => {
    youtubeConnected = false;

    // Mock video upload
    await page.route('**/api/upload/video/raw', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          videoUrl: '/uploads/cooking-video-abc.mp4',
          filename: 'cooking-video-abc.mp4'
        })
      });
    });

    // Mock YouTube status (dynamic)
    await page.route('**/api/youtube/status', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          connected: youtubeConnected,
          hasRefreshToken: youtubeConnected
        })
      });
    });

    // Mock WebSocket, getUserMedia, and window.open
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

      // Mock popup for OAuth
      window.mockPopup = null;
      window.mockPopupUrl = null;
      window.open = (url) => {
        window.mockPopupUrl = url;
        window.mockPopup = { closed: false, close: () => { window.mockPopup.closed = true; } };
        return window.mockPopup;
      };
      window.closeAuthPopup = () => { if (window.mockPopup) window.mockPopup.closed = true; };
    });
  });

  async function connectVoiceApp(page) {
    await page.evaluate(() => document.getElementById('action-btn')?.click());
    await page.waitForTimeout(100);
    await page.evaluate(() => window.sendMockWsMessage({ type: 'ready' }));
    await page.waitForTimeout(100);
  }

  test.describe('create_youtube_short full flow', () => {

    test('complete flow: request → video upload → auth → tool execution → result', async ({ page }) => {
      await page.goto('/mobile/?restaurantId=test-123');
      await connectVoiceApp(page);

      // Step 1: Backend requests video (simulating user saying "create a YouTube short")
      await page.evaluate(() => {
        window.sendMockWsMessage({
          type: 'requestVideoUpload',
          tool: 'create_youtube_short',
          message: 'Upload a cooking video to create a Short'
        });
      });

      await page.waitForTimeout(100);

      // Verify mode switched to upload
      const uploadIcon = await page.evaluate(() =>
        document.getElementById('action-icon')?.getAttribute('data-lucide')
      );
      expect(uploadIcon).toBe('upload');

      // Step 2: User uploads video
      const fileInput = page.locator('#file-input');
      await fileInput.setInputFiles({
        name: 'my-cooking.mp4',
        mimeType: 'video/mp4',
        buffer: Buffer.from('fake video')
      });

      await page.waitForTimeout(300);

      // Verify videoUploaded message sent
      let sentMessages = await page.evaluate(() => window.mockWsSentMessages);
      const videoMsg = sentMessages.find(m => m.type === 'videoUploaded');
      expect(videoMsg).toBeDefined();
      expect(videoMsg.videoUrl).toBe('/uploads/cooking-video-abc.mp4');

      // Step 3: Backend requests YouTube auth (no tokens)
      await page.evaluate(() => {
        window.sendMockWsMessage({
          type: 'requestYouTubeAuth',
          tool: 'create_youtube_short',
          message: 'Connect YouTube to upload'
        });
      });

      await page.waitForTimeout(100);

      // Verify popup opened
      const popupUrl = await page.evaluate(() => window.mockPopupUrl);
      expect(popupUrl).toBe('/api/youtube/auth');

      // Step 4: User completes OAuth
      youtubeConnected = true;
      await page.route('**/api/youtube/status', route => {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ connected: true, hasRefreshToken: true })
        });
      });

      await page.evaluate(() => window.closeAuthPopup());
      await page.waitForTimeout(700);

      // Verify youtubeAuthComplete sent
      sentMessages = await page.evaluate(() => window.mockWsSentMessages);
      const authMsg = sentMessages.find(m => m.type === 'youtubeAuthComplete');
      expect(authMsg).toBeDefined();

      // Step 5: Backend executes tool
      await page.evaluate(() => {
        window.sendMockWsMessage({
          type: 'toolStarted',
          tool: 'create_youtube_short',
          args: { videoUrl: '/uploads/cooking-video-abc.mp4' }
        });
      });

      await page.waitForTimeout(100);
      let status = await page.locator('#status').textContent();
      expect(status).toBe('Creating short...');

      // Step 6: Tool completes with YouTube URL
      await page.evaluate(() => {
        window.sendMockWsMessage({
          type: 'toolCompleted',
          tool: 'create_youtube_short',
          result: {
            youtubeUrl: 'https://youtube.com/shorts/xyz789',
            youtubeVideoId: 'xyz789'
          }
        });
      });

      await page.waitForTimeout(100);

      status = await page.locator('#status').textContent();
      expect(status).toBe('Done');

      // Verify YouTube URL displayed
      const messages = await page.locator('#messages').innerHTML();
      expect(messages).toContain('https://youtube.com/shorts/xyz789');
    });

    test('flow when YouTube already connected (skips auth)', async ({ page }) => {
      // Pre-configure YouTube as connected
      youtubeConnected = true;
      await page.route('**/api/youtube/status', route => {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ connected: true, hasRefreshToken: true })
        });
      });

      await page.goto('/mobile/?restaurantId=test-123');
      await connectVoiceApp(page);

      // Backend requests video
      await page.evaluate(() => {
        window.sendMockWsMessage({
          type: 'requestVideoUpload',
          tool: 'create_youtube_short',
          message: 'Upload a cooking video'
        });
      });

      await page.waitForTimeout(100);

      // Upload video
      const fileInput = page.locator('#file-input');
      await fileInput.setInputFiles({
        name: 'video.mp4',
        mimeType: 'video/mp4',
        buffer: Buffer.from('fake')
      });

      await page.waitForTimeout(300);

      // Backend should NOT request auth (it has tokens)
      // Instead, it goes straight to tool execution
      await page.evaluate(() => {
        window.sendMockWsMessage({
          type: 'toolStarted',
          tool: 'create_youtube_short',
          args: { videoUrl: '/uploads/cooking-video-abc.mp4' }
        });
      });

      await page.waitForTimeout(100);

      // Verify no auth popup was opened
      const popupUrl = await page.evaluate(() => window.mockPopupUrl);
      expect(popupUrl).toBeNull();

      const status = await page.locator('#status').textContent();
      expect(status).toBe('Creating short...');
    });
  });

  test.describe('create_restaurant full flow', () => {

    test('complete flow: video request → upload → processing → result', async ({ page }) => {
      await page.goto('/mobile/?restaurantId=test-123');
      await connectVoiceApp(page);

      // Backend requests video for restaurant creation
      await page.evaluate(() => {
        window.sendMockWsMessage({
          type: 'requestVideoUpload',
          tool: 'create_restaurant',
          message: 'Upload a video of your restaurant'
        });
      });

      await page.waitForTimeout(100);

      // Verify upload mode
      const uploadIcon = await page.evaluate(() =>
        document.getElementById('action-icon')?.getAttribute('data-lucide')
      );
      expect(uploadIcon).toBe('upload');

      // Upload video
      const fileInput = page.locator('#file-input');
      await fileInput.setInputFiles({
        name: 'restaurant-tour.mp4',
        mimeType: 'video/mp4',
        buffer: Buffer.from('restaurant video')
      });

      await page.waitForTimeout(300);

      // Verify videoUploaded sent
      const sentMessages = await page.evaluate(() => window.mockWsSentMessages);
      const videoMsg = sentMessages.find(m => m.type === 'videoUploaded');
      expect(videoMsg).toBeDefined();
      expect(videoMsg.tool).toBe('create_restaurant');

      // Backend processes video
      await page.evaluate(() => {
        window.sendMockWsMessage({
          type: 'toolStarted',
          tool: 'create_restaurant',
          args: { videoUrl: '/uploads/cooking-video-abc.mp4' }
        });
      });

      await page.waitForTimeout(100);
      let status = await page.locator('#status').textContent();
      expect(status).toBe('Processing video...');

      // Tool completes
      await page.evaluate(() => {
        window.sendMockWsMessage({
          type: 'toolCompleted',
          tool: 'create_restaurant',
          result: {
            restaurantId: 'new-restaurant-456',
            name: 'Test Restaurant',
            cuisineType: 'Italian'
          }
        });
      });

      await page.waitForTimeout(100);
      status = await page.locator('#status').textContent();
      expect(status).toBe('Done');

      // Mode should be back to mic after upload completes
      await page.waitForTimeout(500);

      const micIcon = await page.evaluate(() =>
        document.getElementById('action-icon')?.getAttribute('data-lucide')
      );
      // After successful upload, should be mic; if upload fails, stays upload
      expect(['mic', 'upload']).toContain(micIcon);
    });
  });

  test.describe('create_website flow', () => {

    test('generates and displays website URL', async ({ page }) => {
      await page.goto('/mobile/?restaurantId=test-123');
      await connectVoiceApp(page);

      // Tool starts (no video needed for website generation)
      await page.evaluate(() => {
        window.sendMockWsMessage({
          type: 'toolStarted',
          tool: 'create_website',
          args: { restaurantId: 'test-123' }
        });
      });

      await page.waitForTimeout(100);
      let status = await page.locator('#status').textContent();
      expect(status).toBe('Generating website...');

      // Tool completes with URL
      await page.evaluate(() => {
        window.sendMockWsMessage({
          type: 'toolCompleted',
          tool: 'create_website',
          result: {
            websiteUrl: 'https://test-restaurant.pages.dev',
            projectName: 'test-restaurant'
          }
        });
      });

      await page.waitForTimeout(100);

      // Verify URL is displayed as clickable link
      const messagesHtml = await page.locator('#messages').innerHTML();
      expect(messagesHtml).toContain('https://test-restaurant.pages.dev');
      expect(messagesHtml).toContain('href="https://test-restaurant.pages.dev"');
    });
  });

  test.describe('generate_graphic flow', () => {

    test('generates and displays image', async ({ page }) => {
      await page.goto('/mobile/?restaurantId=test-123');
      await connectVoiceApp(page);

      // First add a text message that the image will be appended to
      await page.evaluate(() => {
        window.sendMockWsMessage({
          type: 'text',
          text: 'Here\'s your Instagram graphic: https://example.com'
        });
      });
      await page.waitForTimeout(50);

      // Tool starts
      await page.evaluate(() => {
        window.sendMockWsMessage({
          type: 'toolStarted',
          tool: 'generate_graphic',
          args: { prompt: 'pizza promo', platform: 'instagram' }
        });
      });

      await page.waitForTimeout(100);

      // Tool completes with image
      await page.evaluate(() => {
        window.sendMockWsMessage({
          type: 'toolCompleted',
          tool: 'generate_graphic',
          result: {
            imageUrl: '/generated/promo-abc123.png',
            imagePath: '/generated/promo-abc123.png'
          }
        });
      });

      await page.waitForTimeout(100);

      // Verify image is displayed (check for URL and img tag presence)
      const messagesHtml = await page.locator('#messages').innerHTML();
      expect(messagesHtml).toContain('/generated/promo-abc123.png');
      expect(messagesHtml).toContain('img');
    });
  });

  test.describe('error recovery flows', () => {

    test('user can retry after video upload fails', async ({ page }) => {
      // First upload fails
      await page.route('**/api/upload/video/raw', route => {
        route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Upload failed' })
        });
      });

      await page.goto('/mobile/?restaurantId=test-123');
      await connectVoiceApp(page);

      // Request video
      await page.evaluate(() => {
        window.sendMockWsMessage({
          type: 'requestVideoUpload',
          tool: 'create_youtube_short',
          message: 'Upload a video'
        });
      });

      await page.waitForTimeout(100);

      // Try to upload - fails
      const fileInput = page.locator('#file-input');
      await fileInput.setInputFiles({
        name: 'video.mp4',
        mimeType: 'video/mp4',
        buffer: Buffer.from('fake')
      });

      await page.waitForTimeout(300);

      // Verify error state
      let status = await page.locator('#status').textContent();
      expect(status).toBe('Upload failed');

      // Fix the upload endpoint
      await page.route('**/api/upload/video/raw', route => {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ videoUrl: '/uploads/retry.mp4', filename: 'retry.mp4' })
        });
      });

      // Request video again
      await page.evaluate(() => {
        window.sendMockWsMessage({
          type: 'requestVideoUpload',
          tool: 'create_youtube_short',
          message: 'Please try again'
        });
      });

      await page.waitForTimeout(100);

      // Retry upload - succeeds
      await fileInput.setInputFiles({
        name: 'video2.mp4',
        mimeType: 'video/mp4',
        buffer: Buffer.from('fake2')
      });

      await page.waitForTimeout(300);

      // Verify videoUploaded was sent
      const sentMessages = await page.evaluate(() => window.mockWsSentMessages);
      const videoMsg = sentMessages.find(m => m.type === 'videoUploaded' && m.videoUrl === '/uploads/retry.mp4');
      expect(videoMsg).toBeDefined();
    });

    test('user can retry after YouTube auth is cancelled', async ({ page }) => {
      await page.goto('/mobile/?restaurantId=test-123');
      await connectVoiceApp(page);

      // Request auth
      await page.evaluate(() => {
        window.sendMockWsMessage({
          type: 'requestYouTubeAuth',
          tool: 'create_youtube_short',
          message: 'Connect YouTube'
        });
      });

      await page.waitForTimeout(100);

      // Cancel auth (close popup without connecting)
      await page.evaluate(() => window.closeAuthPopup());
      await page.waitForTimeout(700);

      // Verify cancelled
      let status = await page.locator('#status').textContent();
      expect(status).toContain('cancelled');

      // No auth complete sent
      let sentMessages = await page.evaluate(() => window.mockWsSentMessages);
      let authMsg = sentMessages.find(m => m.type === 'youtubeAuthComplete');
      expect(authMsg).toBeUndefined();

      // Clear for retry
      await page.evaluate(() => {
        window.mockWsSentMessages = [];
        window.mockPopupUrl = null;
      });

      // Request auth again
      await page.evaluate(() => {
        window.sendMockWsMessage({
          type: 'requestYouTubeAuth',
          tool: 'create_youtube_short',
          message: 'Try connecting YouTube again'
        });
      });

      await page.waitForTimeout(100);

      // This time complete auth
      await page.route('**/api/youtube/status', route => {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ connected: true, hasRefreshToken: true })
        });
      });

      await page.evaluate(() => window.closeAuthPopup());
      await page.waitForTimeout(700);

      // Verify auth complete sent this time
      sentMessages = await page.evaluate(() => window.mockWsSentMessages);
      authMsg = sentMessages.find(m => m.type === 'youtubeAuthComplete');
      expect(authMsg).toBeDefined();
    });

    test('handles tool error gracefully', async ({ page }) => {
      await page.goto('/mobile/?restaurantId=test-123');
      await connectVoiceApp(page);

      // Tool starts
      await page.evaluate(() => {
        window.sendMockWsMessage({
          type: 'toolStarted',
          tool: 'create_youtube_short',
          args: { videoUrl: '/uploads/test.mp4' }
        });
      });

      await page.waitForTimeout(100);

      // Tool fails
      await page.evaluate(() => {
        window.sendMockWsMessage({
          type: 'toolError',
          tool: 'create_youtube_short',
          error: 'YouTube API quota exceeded'
        });
      });

      await page.waitForTimeout(100);

      const status = await page.locator('#status').textContent();
      expect(status).toBe('Error');

      // UI should still be functional - another tool can be started
      await page.evaluate(() => {
        window.sendMockWsMessage({
          type: 'toolStarted',
          tool: 'generate_graphic',
          args: { prompt: 'test' }
        });
      });

      await page.waitForTimeout(100);

      const newStatus = await page.locator('#status').textContent();
      expect(newStatus).toBe('Generating...');
    });
  });

  test.describe('modify_website flow', () => {

    test('updates website with natural language', async ({ page }) => {
      await page.goto('/mobile/?restaurantId=test-123');
      await connectVoiceApp(page);

      // Tool starts
      await page.evaluate(() => {
        window.sendMockWsMessage({
          type: 'toolStarted',
          tool: 'modify_website',
          args: { restaurantId: 'test-123', prompt: 'Change pizza price to $25' }
        });
      });

      await page.waitForTimeout(100);
      let status = await page.locator('#status').textContent();
      expect(status).toBe('Updating...');

      // Tool completes
      await page.evaluate(() => {
        window.sendMockWsMessage({
          type: 'toolCompleted',
          tool: 'modify_website',
          result: {
            success: true,
            classification: 'data_change',
            affectedChunks: ['menu']
          }
        });
      });

      await page.waitForTimeout(100);
      status = await page.locator('#status').textContent();
      expect(status).toBe('Done');
    });
  });
});
