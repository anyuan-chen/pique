import { Router } from 'express';
import { YouTubeUploader } from '../services/youtube-uploader.js';
import { config } from '../config.js';
import db from '../db/database.js';

const router = Router();
const youtubeUploader = new YouTubeUploader();

// Ensure youtube_tokens table exists
db.exec(`
  CREATE TABLE IF NOT EXISTS youtube_tokens (
    id INTEGER PRIMARY KEY,
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    expiry_date INTEGER,
    scope TEXT,
    token_type TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

// Helper to get stored tokens
function getStoredTokens() {
  return db.prepare('SELECT * FROM youtube_tokens ORDER BY id DESC LIMIT 1').get();
}

// Helper to store tokens
function storeTokens(tokens) {
  const existing = getStoredTokens();
  if (existing) {
    db.prepare(`
      UPDATE youtube_tokens SET
        access_token = ?, refresh_token = COALESCE(?, refresh_token),
        expiry_date = ?, scope = ?, token_type = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(tokens.access_token, tokens.refresh_token, tokens.expiry_date, tokens.scope, tokens.token_type, existing.id);
  } else {
    db.prepare(`
      INSERT INTO youtube_tokens (access_token, refresh_token, expiry_date, scope, token_type)
      VALUES (?, ?, ?, ?, ?)
    `).run(tokens.access_token, tokens.refresh_token, tokens.expiry_date, tokens.scope, tokens.token_type);
  }
}

/**
 * GET /api/youtube/auth
 * Start OAuth flow - redirects to Google auth page (supports popup flow)
 */
router.get('/auth', (req, res) => {
  try {
    // Check if YouTube credentials are configured
    if (!config.youtube.clientId || !config.youtube.clientSecret) {
      return res.status(500).send(`
        <!DOCTYPE html>
        <html>
          <body style="font-family: system-ui; text-align: center; padding: 40px;">
            <h2>YouTube Not Configured</h2>
            <p>Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET in .env</p>
          </body>
        </html>
      `);
    }

    const authUrl = youtubeUploader.getAuthUrl();
    res.redirect(authUrl);
  } catch (error) {
    console.error('YouTube auth error:', error);
    res.status(500).send(`
      <!DOCTYPE html>
      <html>
        <body style="font-family: system-ui; text-align: center; padding: 40px;">
          <h2>Error</h2>
          <p>${error.message}</p>
        </body>
      </html>
    `);
  }
});

/**
 * GET /api/youtube/callback
 * OAuth callback - exchanges code for tokens and stores them server-side
 * Supports popup flow (auto-closes) and redirect flow (goes to shorts.html)
 */
router.get('/callback', async (req, res) => {
  console.log('YouTube callback received:', req.query);

  try {
    const { code, error } = req.query;

    if (error) {
      console.error('YouTube OAuth error:', error);
      // Show error in popup-friendly way
      return res.send(`
        <!DOCTYPE html>
        <html>
          <body style="font-family: system-ui; text-align: center; padding: 40px;">
            <h2>Authentication Failed</h2>
            <p>${error}</p>
            <p><a href="/api/youtube/auth">Try again</a></p>
          </body>
        </html>
      `);
    }

    if (!code) {
      console.error('No code in callback');
      return res.send(`
        <!DOCTYPE html>
        <html>
          <body style="font-family: system-ui; text-align: center; padding: 40px;">
            <h2>Authentication Failed</h2>
            <p>No authorization code received</p>
            <p><a href="/api/youtube/auth">Try again</a></p>
          </body>
        </html>
      `);
    }

    console.log('Exchanging code for tokens...');
    const tokens = await youtubeUploader.getTokensFromCode(code);
    console.log('Got tokens:', { ...tokens, access_token: '***', refresh_token: tokens.refresh_token ? '***' : null });

    // Store tokens server-side
    storeTokens(tokens);
    console.log('Tokens stored in database');

    // Popup-friendly response that auto-closes
    res.send(`
      <!DOCTYPE html>
      <html>
        <body style="font-family: system-ui; text-align: center; padding: 40px;">
          <h2>YouTube Connected!</h2>
          <p>You can close this window.</p>
          <script>
            if (window.opener) {
              window.close();
            }
          </script>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('YouTube callback error:', error);
    res.send(`
      <!DOCTYPE html>
      <html>
        <body style="font-family: system-ui; text-align: center; padding: 40px;">
          <h2>Authentication Failed</h2>
          <p>${error.message}</p>
          <p><a href="/api/youtube/auth">Try again</a></p>
        </body>
      </html>
    `);
  }
});

/**
 * GET /api/youtube/status
 * Check if YouTube is connected (tokens stored)
 */
router.get('/status', (req, res) => {
  const tokens = getStoredTokens();
  res.json({
    connected: !!tokens,
    hasRefreshToken: !!(tokens?.refresh_token)
  });
});

/**
 * POST /api/youtube/refresh
 * Refresh access token
 */
router.post('/refresh', async (req, res) => {
  try {
    const { tokens } = req.body;

    if (!tokens || !tokens.refresh_token) {
      return res.status(400).json({ error: 'No refresh token provided' });
    }

    const freshTokens = await youtubeUploader.refreshTokenIfNeeded(tokens);
    res.json({ tokens: freshTokens });
  } catch (error) {
    console.error('Token refresh error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/youtube/channel
 * Get connected YouTube channel info
 */
router.get('/channel', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No tokens provided' });
    }

    const tokens = JSON.parse(Buffer.from(authHeader.slice(7), 'base64').toString());
    const channelInfo = await youtubeUploader.getChannelInfo(tokens);
    res.json(channelInfo);
  } catch (error) {
    console.error('Channel info error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/youtube/disconnect
 * Disconnect YouTube account (client-side token removal)
 * This endpoint just confirms the action; actual token removal is client-side
 */
router.post('/disconnect', (req, res) => {
  // Client handles token removal from localStorage
  res.json({ success: true, message: 'Disconnected' });
});

export default router;
export { getStoredTokens, storeTokens };
