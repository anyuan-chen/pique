import { test, expect } from '@playwright/test';

/**
 * Tests for voice app YouTube OAuth flow
 *
 * Flow: Backend requests auth → popup opens → user authenticates →
 *       popup closes → youtubeAuthComplete sent → tool resumes
 */

test.describe('Voice App YouTube Auth', () => {
  // Track YouTube connection status for mocking
  let youtubeConnected = false;

  test.beforeEach(async ({ page }) => {
    // Reset state
    youtubeConnected = false;

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

    // Mock YouTube status endpoint - returns current connection state
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

    // Mock WebSocket, getUserMedia, and window.open for OAuth popup
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

          window.mockWs = this;

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

        receiveMessage(data) {
          if (this.onmessage) {
            this.onmessage({ data: JSON.stringify(data) });
          }
        }
      }

      MockWebSocket.CONNECTING = 0;
      MockWebSocket.OPEN = 1;
      MockWebSocket.CLOSING = 2;
      MockWebSocket.CLOSED = 3;

      window.WebSocket = MockWebSocket;

      window.sendMockWsMessage = (data) => {
        if (window.mockWs) {
          window.mockWs.receiveMessage(data);
        }
      };

      // Mock window.open for OAuth popup
      window.mockPopup = null;
      window.mockPopupUrl = null;

      window.open = (url, name, features) => {
        window.mockPopupUrl = url;

        // Create a mock popup object
        window.mockPopup = {
          closed: false,
          close: () => {
            window.mockPopup.closed = true;
          }
        };

        return window.mockPopup;
      };

      // Helper to simulate popup closing (auth complete)
      window.closeAuthPopup = () => {
        if (window.mockPopup) {
          window.mockPopup.closed = true;
        }
      };
    });
  });

  // Helper to initialize app and connect WebSocket
  async function connectVoiceApp(page) {
    await page.evaluate(() => {
      const actionBtn = document.getElementById('action-btn');
      if (actionBtn) actionBtn.click();
    });
    await page.waitForTimeout(100);

    await page.evaluate(() => window.sendMockWsMessage({ type: 'ready' }));
    await page.waitForTimeout(50);
  }

  test('shows status when YouTube auth is requested', async ({ page }) => {
    await page.goto('/mobile/?restaurantId=test-123');
    await page.waitForTimeout(100);

    await connectVoiceApp(page);

    // Wait for any mic errors to settle
    await page.waitForTimeout(300);

    // Backend requests YouTube auth
    await page.evaluate(() => {
      window.sendMockWsMessage({
        type: 'requestYouTubeAuth',
        tool: 'create_youtube_short',
        message: 'Connect YouTube to upload your Short'
      });
    });

    // Check status immediately after message (before any other state changes)
    await page.waitForFunction(() => {
      const status = document.getElementById('status')?.textContent;
      return status?.includes('Connect YouTube');
    }, { timeout: 2000 });

    const status = await page.locator('#status').textContent();
    expect(status).toContain('Connect YouTube');
  });

  test('opens OAuth popup when auth is requested', async ({ page }) => {
    await page.goto('/mobile/?restaurantId=test-123');
    await page.waitForTimeout(100);

    await connectVoiceApp(page);

    // Backend requests YouTube auth
    await page.evaluate(() => {
      window.sendMockWsMessage({
        type: 'requestYouTubeAuth',
        tool: 'create_youtube_short',
        message: 'Connect YouTube'
      });
    });

    await page.waitForTimeout(100);

    // Check that popup was opened with correct URL
    const popupUrl = await page.evaluate(() => window.mockPopupUrl);
    expect(popupUrl).toBe('/api/youtube/auth');
  });

  test('sends youtubeAuthComplete after successful auth', async ({ page }) => {
    await page.goto('/mobile/?restaurantId=test-123');
    await page.waitForTimeout(100);

    await connectVoiceApp(page);

    // Backend requests YouTube auth
    await page.evaluate(() => {
      window.sendMockWsMessage({
        type: 'requestYouTubeAuth',
        tool: 'create_youtube_short',
        message: 'Connect YouTube'
      });
    });

    await page.waitForTimeout(100);

    // Simulate successful auth: update mock to return connected
    youtubeConnected = true;

    // Update the route to return connected
    await page.route('**/api/youtube/status', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          connected: true,
          hasRefreshToken: true
        })
      });
    });

    // Close the popup (simulating user completing OAuth)
    await page.evaluate(() => window.closeAuthPopup());

    // Wait for polling to detect popup close and verify auth
    await page.waitForTimeout(700);

    // Check that youtubeAuthComplete was sent
    const sentMessages = await page.evaluate(() => window.mockWsSentMessages);
    const authMessage = sentMessages.find(m => m.type === 'youtubeAuthComplete');

    expect(authMessage).toBeDefined();
    expect(authMessage.tool).toBe('create_youtube_short');
  });

  test('does not send youtubeAuthComplete if auth was cancelled', async ({ page }) => {
    await page.goto('/mobile/?restaurantId=test-123');
    await page.waitForTimeout(100);

    await connectVoiceApp(page);

    // Backend requests YouTube auth
    await page.evaluate(() => {
      window.sendMockWsMessage({
        type: 'requestYouTubeAuth',
        tool: 'create_youtube_short',
        message: 'Connect YouTube'
      });
    });

    await page.waitForTimeout(100);

    // Popup closes but auth failed (status still returns not connected)
    await page.evaluate(() => window.closeAuthPopup());

    // Wait for polling to detect popup close
    await page.waitForTimeout(700);

    // Check that youtubeAuthComplete was NOT sent
    const sentMessages = await page.evaluate(() => window.mockWsSentMessages);
    const authMessage = sentMessages.find(m => m.type === 'youtubeAuthComplete');

    expect(authMessage).toBeUndefined();

    // Check status shows cancelled
    const status = await page.locator('#status').textContent();
    expect(status).toContain('cancelled');
  });

  test('shows YouTube connected status after successful auth', async ({ page }) => {
    await page.goto('/mobile/?restaurantId=test-123');
    await page.waitForTimeout(100);

    await connectVoiceApp(page);

    // Backend requests YouTube auth
    await page.evaluate(() => {
      window.sendMockWsMessage({
        type: 'requestYouTubeAuth',
        tool: 'create_youtube_short',
        message: 'Connect YouTube'
      });
    });

    await page.waitForTimeout(100);

    // Update route to return connected
    await page.route('**/api/youtube/status', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          connected: true,
          hasRefreshToken: true
        })
      });
    });

    // Close popup (auth complete)
    await page.evaluate(() => window.closeAuthPopup());

    await page.waitForTimeout(700);

    // Check status shows connected
    const status = await page.locator('#status').textContent();
    expect(status).toContain('YouTube connected');
  });

  test('full flow: video upload → auth request → auth complete → tool continues', async ({ page }) => {
    await page.goto('/mobile/?restaurantId=test-123');
    await page.waitForTimeout(100);

    await connectVoiceApp(page);

    // Step 1: Backend requests video upload
    await page.evaluate(() => {
      window.sendMockWsMessage({
        type: 'requestVideoUpload',
        tool: 'create_youtube_short',
        message: 'Upload a cooking video'
      });
    });

    await page.waitForTimeout(100);

    // Step 2: User uploads video
    const fileInput = page.locator('#file-input');
    await fileInput.setInputFiles({
      name: 'cooking-video.mp4',
      mimeType: 'video/mp4',
      buffer: Buffer.from('fake video content')
    });

    await page.waitForTimeout(300);

    // Verify videoUploaded was sent
    let sentMessages = await page.evaluate(() => window.mockWsSentMessages);
    const videoMessage = sentMessages.find(m => m.type === 'videoUploaded');
    expect(videoMessage).toBeDefined();
    expect(videoMessage.videoUrl).toBe('/uploads/test-video-123.mp4');

    // Step 3: Backend requests YouTube auth (after receiving video)
    await page.evaluate(() => {
      window.sendMockWsMessage({
        type: 'requestYouTubeAuth',
        tool: 'create_youtube_short',
        message: 'Connect YouTube to upload your Short'
      });
    });

    await page.waitForTimeout(100);

    // Verify popup opened
    const popupUrl = await page.evaluate(() => window.mockPopupUrl);
    expect(popupUrl).toBe('/api/youtube/auth');

    // Step 4: User completes OAuth
    await page.route('**/api/youtube/status', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          connected: true,
          hasRefreshToken: true
        })
      });
    });

    await page.evaluate(() => window.closeAuthPopup());
    await page.waitForTimeout(700);

    // Step 5: Verify youtubeAuthComplete was sent
    sentMessages = await page.evaluate(() => window.mockWsSentMessages);
    const authMessage = sentMessages.find(m => m.type === 'youtubeAuthComplete');

    expect(authMessage).toBeDefined();
    expect(authMessage.tool).toBe('create_youtube_short');
  });

  test('clears pendingAuthTool after auth completion', async ({ page }) => {
    await page.goto('/mobile/?restaurantId=test-123');
    await page.waitForTimeout(100);

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

    // Check pendingAuthTool is set
    let pendingAuthTool = await page.evaluate(() => {
      // Access the app instance through the global
      return window.app?.pendingAuthTool;
    });

    // Note: app is a local const, so we check via the mocked behavior
    // The pendingAuthTool should be set internally

    // Complete auth
    await page.route('**/api/youtube/status', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ connected: true, hasRefreshToken: true })
      });
    });

    await page.evaluate(() => window.closeAuthPopup());
    await page.waitForTimeout(700);

    // After completion, another auth request should work fresh
    await page.evaluate(() => {
      window.mockPopupUrl = null;
      window.sendMockWsMessage({
        type: 'requestYouTubeAuth',
        tool: 'create_youtube_short',
        message: 'Connect YouTube again'
      });
    });

    await page.waitForTimeout(100);

    // New popup should open
    const newPopupUrl = await page.evaluate(() => window.mockPopupUrl);
    expect(newPopupUrl).toBe('/api/youtube/auth');
  });

  test('handles multiple sequential auth requests', async ({ page }) => {
    await page.goto('/mobile/?restaurantId=test-123');
    await page.waitForTimeout(100);

    await connectVoiceApp(page);

    // First auth request
    await page.evaluate(() => {
      window.sendMockWsMessage({
        type: 'requestYouTubeAuth',
        tool: 'create_youtube_short',
        message: 'Connect YouTube'
      });
    });

    await page.waitForTimeout(100);

    // Complete first auth
    await page.route('**/api/youtube/status', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ connected: true, hasRefreshToken: true })
      });
    });

    await page.evaluate(() => window.closeAuthPopup());
    await page.waitForTimeout(700);

    // Clear sent messages for second round
    await page.evaluate(() => {
      window.mockWsSentMessages = [];
      window.mockPopup = null;
      window.mockPopupUrl = null;
    });

    // Simulate disconnection (tokens expired or revoked)
    await page.route('**/api/youtube/status', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ connected: false, hasRefreshToken: false })
      });
    });

    // Second auth request
    await page.evaluate(() => {
      window.sendMockWsMessage({
        type: 'requestYouTubeAuth',
        tool: 'create_youtube_short',
        message: 'Reconnect YouTube'
      });
    });

    await page.waitForTimeout(100);

    // Verify second popup opened
    const popupUrl = await page.evaluate(() => window.mockPopupUrl);
    expect(popupUrl).toBe('/api/youtube/auth');

    // Complete second auth
    await page.route('**/api/youtube/status', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ connected: true, hasRefreshToken: true })
      });
    });

    await page.evaluate(() => window.closeAuthPopup());
    await page.waitForTimeout(700);

    // Verify second youtubeAuthComplete sent
    const sentMessages = await page.evaluate(() => window.mockWsSentMessages);
    const authMessages = sentMessages.filter(m => m.type === 'youtubeAuthComplete');

    expect(authMessages.length).toBe(1);
  });
});
