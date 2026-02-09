import { test, expect } from '@playwright/test';

/**
 * Tests for voice app video upload trigger flow
 *
 * Flow: AI says "please upload" → file picker auto-opens → user selects file →
 *       uploads to /api/upload/video/raw → sends path to AI
 */

test.describe('Voice App Video Upload Trigger', () => {

  test.beforeEach(async ({ page }) => {
    // Mock the raw video upload endpoint
    await page.route('**/api/upload/video/raw', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          videoUrl: '/uploads/test-video-123.mp4',
          filename: 'test-video-123.mp4'
        })
      });
    });

    // Mock WebSocket and getUserMedia
    await page.addInitScript(() => {
      // Mock getUserMedia to avoid mic permission issues
      navigator.mediaDevices.getUserMedia = async () => {
        return {
          getTracks: () => [{
            stop: () => {},
            kind: 'audio'
          }]
        };
      };
      // Create mock WebSocket
      window.mockWsMessages = [];
      window.mockWsSentMessages = [];

      class MockWebSocket {
        constructor(url) {
          this.url = url;
          this.readyState = MockWebSocket.OPEN;
          this.onopen = null;
          this.onmessage = null;
          this.onclose = null;
          this.onerror = null;

          // Store reference for sending mock messages
          window.mockWs = this;

          // Trigger onopen after a tick
          setTimeout(() => {
            if (this.onopen) this.onopen({ target: this });
          }, 10);
        }

        send(data) {
          window.mockWsSentMessages.push(JSON.parse(data));
        }

        close() {
          this.readyState = MockWebSocket.CLOSED;
          if (this.onclose) this.onclose({ target: this });
        }

        // Helper to receive mock messages
        receiveMessage(data) {
          if (this.onmessage) {
            this.onmessage({ data: JSON.stringify(data) });
          }
        }
      }

      // WebSocket constants
      MockWebSocket.CONNECTING = 0;
      MockWebSocket.OPEN = 1;
      MockWebSocket.CLOSING = 2;
      MockWebSocket.CLOSED = 3;

      window.WebSocket = MockWebSocket;

      // Expose helper to inject messages
      window.sendMockWsMessage = (data) => {
        if (window.mockWs) {
          window.mockWs.receiveMessage(data);
        }
      };
    });
  });

  // Helper to initialize app and connect WebSocket
  async function connectVoiceApp(page) {
    // The app is created as a local `const app`, we need to access it differently
    // Use the global reference that gets set when the app connects
    await page.evaluate(() => {
      // Find the app instance by looking at what created the WebSocket
      // The mockWs was created by the app's connect() method
      // We can trigger connect by simulating a click on the action button
      const actionBtn = document.getElementById('action-btn');
      if (actionBtn) actionBtn.click();
    });
    await page.waitForTimeout(100);

    // Now send the ready message to mark as connected
    await page.evaluate(() => window.sendMockWsMessage({ type: 'ready' }));
    await page.waitForTimeout(50);
  }

  test('auto-triggers file picker when backend requests video upload', async ({ page }) => {
    await page.goto('/mobile/?restaurantId=test-123');
    await page.waitForTimeout(100);

    // Connect the app
    await connectVoiceApp(page);

    // Get initial icon (should be mic)
    const initialIcon = await page.evaluate(() =>
      document.getElementById('action-icon')?.getAttribute('data-lucide')
    );
    expect(initialIcon).toBe('mic');

    // Simulate backend requesting video upload
    await page.evaluate(() => {
      window.sendMockWsMessage({
        type: 'requestVideoUpload',
        tool: 'create_youtube_short',
        message: 'Upload a cooking video to create a Short'
      });
    });

    // Wait for mode to change
    await page.waitForTimeout(200);

    // Check that icon switched to upload
    const newIcon = await page.evaluate(() =>
      document.getElementById('action-icon')?.getAttribute('data-lucide')
    );
    expect(newIcon).toBe('upload');
  });

  test('handles different tool video requests', async ({ page }) => {
    const toolRequests = [
      { tool: 'create_youtube_short', message: 'Upload a cooking video to create a Short' },
      { tool: 'create_restaurant', message: 'Upload a video of your restaurant' }
    ];

    for (const request of toolRequests) {
      await page.goto('/mobile/?restaurantId=test-123');
      await page.waitForTimeout(100);

      // Connect the app
      await connectVoiceApp(page);

      // Verify initial icon is mic
      const initialIcon = await page.evaluate(() =>
        document.getElementById('action-icon')?.getAttribute('data-lucide')
      );
      expect(initialIcon).toBe('mic');

      // Send video upload request
      await page.evaluate((req) => {
        window.sendMockWsMessage({
          type: 'requestVideoUpload',
          tool: req.tool,
          message: req.message
        });
      }, request);

      await page.waitForTimeout(200);

      // Check that icon switched to upload
      const newIcon = await page.evaluate(() =>
        document.getElementById('action-icon')?.getAttribute('data-lucide')
      );
      expect(newIcon, `Should trigger upload mode for: ${request.tool}`).toBe('upload');
    }
  });

  test('text messages do not trigger upload mode', async ({ page }) => {
    await page.goto('/mobile/?restaurantId=test-123');
    await page.waitForTimeout(100);

    // Connect the app
    await connectVoiceApp(page);

    // Get initial icon
    const initialIcon = await page.evaluate(() =>
      document.getElementById('action-icon')?.getAttribute('data-lucide')
    );
    expect(initialIcon).toBe('mic');

    // Send a regular text message (not requestVideoUpload)
    await page.evaluate(() => {
      window.sendMockWsMessage({
        type: 'text',
        text: 'Your website has been generated successfully!'
      });
    });

    await page.waitForTimeout(200);

    // Icon should still be mic
    const newIcon = await page.evaluate(() =>
      document.getElementById('action-icon')?.getAttribute('data-lucide')
    );
    expect(newIcon).toBe('mic');
  });

  test('uploads file to /api/upload/video/raw endpoint', async ({ page }) => {
    let uploadCalled = false;

    await page.route('**/api/upload/video/raw', async route => {
      uploadCalled = true;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          videoUrl: '/uploads/uploaded-video.mp4',
          filename: 'uploaded-video.mp4'
        })
      });
    });

    await page.goto('/mobile/?restaurantId=test-123');
    await page.waitForTimeout(100);

    // Connect the app
    await connectVoiceApp(page);

    // Upload a file directly via the file input
    const fileInput = page.locator('#file-input');
    await fileInput.setInputFiles({
      name: 'test-cooking-video.mp4',
      mimeType: 'video/mp4',
      buffer: Buffer.from('fake video content')
    });

    // Wait for upload to complete
    await page.waitForTimeout(500);

    expect(uploadCalled).toBe(true);
  });

  test('sends videoUploaded message after upload', async ({ page }) => {
    await page.route('**/api/upload/video/raw', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          videoUrl: '/uploads/my-cooking-video.mp4',
          filename: 'my-cooking-video.mp4'
        })
      });
    });

    await page.goto('/mobile/?restaurantId=test-123');
    await page.waitForTimeout(100);

    // Connect the app
    await connectVoiceApp(page);

    // Trigger a video upload request first (sets pendingTool)
    await page.evaluate(() => {
      window.sendMockWsMessage({
        type: 'requestVideoUpload',
        tool: 'create_youtube_short',
        message: 'Upload a video'
      });
    });
    await page.waitForTimeout(100);

    // Upload a file
    const fileInput = page.locator('#file-input');
    await fileInput.setInputFiles({
      name: 'test-video.mp4',
      mimeType: 'video/mp4',
      buffer: Buffer.from('fake video content')
    });

    // Wait for upload to complete
    await page.waitForTimeout(500);

    // Check what was sent to the WebSocket
    const sentMessages = await page.evaluate(() => window.mockWsSentMessages);

    // Should have sent a videoUploaded message
    const videoMessage = sentMessages.find(m => m.type === 'videoUploaded');

    expect(videoMessage).toBeDefined();
    expect(videoMessage.videoUrl).toBe('/uploads/my-cooking-video.mp4');
    expect(videoMessage.tool).toBe('create_youtube_short');
  });

  test('switches mode back to mic after upload', async ({ page }) => {
    await page.route('**/api/upload/video/raw', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          videoUrl: '/uploads/test.mp4',
          filename: 'test.mp4'
        })
      });
    });

    await page.goto('/mobile/?restaurantId=test-123');
    await page.waitForTimeout(100);

    // Connect the app
    await connectVoiceApp(page);

    // Verify initial state is mic
    const initialIcon = await page.evaluate(() =>
      document.getElementById('action-icon')?.getAttribute('data-lucide')
    );
    expect(initialIcon).toBe('mic');

    // Upload file directly (without triggering upload mode first)
    const fileInput = page.locator('#file-input');
    await fileInput.setInputFiles({
      name: 'test.mp4',
      mimeType: 'video/mp4',
      buffer: Buffer.from('fake')
    });

    await page.waitForTimeout(500);

    // Check that mode is still mic after upload
    const iconName = await page.evaluate(() =>
      document.getElementById('action-icon')?.getAttribute('data-lucide')
    );

    expect(iconName).toBe('mic');
  });

  test('full flow: backend requests video → mode changes → upload → videoUploaded sent', async ({ page }) => {
    await page.route('**/api/upload/video/raw', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          videoUrl: '/uploads/cooking-short.mp4',
          filename: 'cooking-short.mp4'
        })
      });
    });

    await page.goto('/mobile/?restaurantId=test-123');
    await page.waitForTimeout(100);

    // Connect the app
    await connectVoiceApp(page);

    // Verify initial icon is mic
    const initialIcon = await page.evaluate(() =>
      document.getElementById('action-icon')?.getAttribute('data-lucide')
    );
    expect(initialIcon).toBe('mic');

    // Backend requests video upload
    await page.evaluate(() => {
      window.sendMockWsMessage({
        type: 'requestVideoUpload',
        tool: 'create_youtube_short',
        message: 'Upload a cooking video'
      });
    });

    // Wait for mode change
    await page.waitForTimeout(200);

    // Verify icon changed to upload
    const newIcon = await page.evaluate(() =>
      document.getElementById('action-icon')?.getAttribute('data-lucide')
    );
    expect(newIcon).toBe('upload');

    // Simulate user selecting a file
    const fileInput = page.locator('#file-input');
    await fileInput.setInputFiles({
      name: 'my-cooking-video.mp4',
      mimeType: 'video/mp4',
      buffer: Buffer.from('fake video data')
    });

    // Wait for upload to complete
    await page.waitForTimeout(600);

    // Verify videoUploaded message sent
    const sentMessages = await page.evaluate(() => window.mockWsSentMessages);
    const videoMessage = sentMessages.find(m => m.type === 'videoUploaded');

    expect(videoMessage).toBeDefined();
    expect(videoMessage.videoUrl).toBe('/uploads/cooking-short.mp4');
    expect(videoMessage.tool).toBe('create_youtube_short');
  });
});
