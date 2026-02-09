import { exec } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';
import { config } from '../config.js';
import { MaterialModel, RestaurantModel } from '../db/models/index.js';

/**
 * Convert restaurant name to URL-safe slug for Cloudflare project name
 * "Maria's Tacos Brooklyn" → "marias-tacos-brooklyn"
 */
function slugify(name) {
  return name
    .toLowerCase()
    .normalize('NFD')                    // Decompose accents
    .replace(/[\u0300-\u036f]/g, '')     // Remove accent marks
    .replace(/['']/g, '')                // Remove apostrophes
    .replace(/[^a-z0-9\s-]/g, '')        // Remove special chars
    .trim()
    .replace(/\s+/g, '-')                // Spaces to dashes
    .replace(/-+/g, '-')                 // Collapse multiple dashes
    .replace(/^-|-$/g, '')               // No leading/trailing dashes
    .slice(0, 58);                       // Max 63 chars, leave room for suffix
}

const execAsync = promisify(exec);

// Timeout for wrangler commands (2 minutes)
const WRANGLER_TIMEOUT_MS = 120000;

/**
 * Execute command with timeout
 */
async function execWithTimeout(command, options, timeoutMs = WRANGLER_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const result = await execAsync(command, {
      ...options,
      signal: controller.signal,
      maxBuffer: 10 * 1024 * 1024 // 10MB buffer for large outputs
    });
    return result;
  } catch (error) {
    if (error.name === 'AbortError' || error.killed) {
      throw new Error(`Command timed out after ${timeoutMs / 1000} seconds: ${command.substring(0, 50)}...`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Parse deployment URL from wrangler output
 * Handles multiple output formats from different wrangler versions
 */
function parseDeploymentUrl(stdout) {
  // Try multiple patterns that wrangler might output
  const patterns = [
    /https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.pages\.dev/i,  // subdomain.project.pages.dev
    /https:\/\/[a-z0-9-]+\.pages\.dev/i,              // project.pages.dev
    /Deployment URL:\s*(https:\/\/[^\s]+)/i,          // "Deployment URL: https://..."
    /Published to\s*(https:\/\/[^\s]+)/i,             // "Published to https://..."
    /https:\/\/[^\s]+cloudflare[^\s]*/i               // Any cloudflare URL
  ];

  for (const pattern of patterns) {
    const match = stdout.match(pattern);
    if (match) {
      // Return the URL (might be in capture group or full match)
      return match[1] || match[0];
    }
  }

  return null;
}

export class CloudflareDeployer {
  constructor() {
    this.accountId = config.cloudflareAccountId;
    this.apiToken = config.cloudflareApiToken;
  }

  /**
   * Deploy a restaurant's website to Cloudflare Pages
   */
  async deploy(restaurantId) {
    const websitePath = join(config.paths.websites, restaurantId);

    // Get restaurant name for pretty URL
    const restaurant = RestaurantModel.getById(restaurantId);
    const baseName = restaurant?.name ? slugify(restaurant.name) : `restaurant-${restaurantId.slice(0, 8)}`;

    // Add short ID suffix to avoid collisions (e.g., "marias-tacos-a1b2")
    const projectName = `${baseName}-${restaurantId.slice(0, 4)}`;

    try {
      // Ensure project exists — create if needed, ignore "already exists"
      try {
        await execWithTimeout(
          `npx wrangler pages project create "${projectName}" --production-branch=main`,
          {
            env: {
              ...process.env,
              CLOUDFLARE_ACCOUNT_ID: this.accountId,
              CLOUDFLARE_API_TOKEN: this.apiToken
            },
            cwd: config.paths.root
          }
        );
        console.log(`Created Cloudflare Pages project: ${projectName}`);
      } catch (createErr) {
        if (createErr.message?.includes('already exists') || createErr.stderr?.includes('already exists')) {
          // Project exists — good, proceed to deploy
        } else {
          throw createErr;
        }
      }

      // Deploy using wrangler (with timeout)
      console.log(`Deploying to Cloudflare Pages: ${projectName}`);
      const { stdout, stderr } = await execWithTimeout(
        `npx wrangler pages deploy "${websitePath}" --project-name="${projectName}" --commit-dirty=true`,
        {
          env: {
            ...process.env,
            CLOUDFLARE_ACCOUNT_ID: this.accountId,
            CLOUDFLARE_API_TOKEN: this.apiToken
          },
          cwd: config.paths.root
        }
      );

      // Parse the URL from wrangler output using improved parser
      const deployedUrl = parseDeploymentUrl(stdout);

      if (!deployedUrl) {
        console.error('Failed to parse deployment URL from wrangler output');
        console.error('Wrangler stdout:', stdout);
        console.error('Wrangler stderr:', stderr);
        throw new Error('Deployment completed but failed to retrieve deployment URL. Check Cloudflare dashboard for the URL.');
      }

      // Update material record with URL
      const material = MaterialModel.getLatestByType(restaurantId, 'website');
      if (material && deployedUrl) {
        MaterialModel.updateCloudflareUrl(material.id, deployedUrl);
      }

      return {
        success: true,
        url: deployedUrl,
        projectName,
        output: stdout
      };
    } catch (error) {
      console.error('Deployment error:', error);
      throw new Error(`Deployment failed: ${error.message}`);
    }
  }

  /**
   * Check if a project exists on Cloudflare Pages
   */
  async projectExists(projectName) {
    try {
      const { stdout } = await execWithTimeout(
        `npx wrangler pages project list --json`,
        {
          env: {
            ...process.env,
            CLOUDFLARE_ACCOUNT_ID: this.accountId,
            CLOUDFLARE_API_TOKEN: this.apiToken
          },
          cwd: config.paths.root
        },
        30000 // 30 second timeout for list operation
      );

      const projects = JSON.parse(stdout);
      return projects.some(p => p.name === projectName);
    } catch (error) {
      // Log the error but return false (project might not exist or API issue)
      console.warn('Could not check if project exists:', error.message);
      return false;
    }
  }

  /**
   * Get deployment status for a project
   */
  async getDeploymentStatus(projectName) {
    try {
      const { stdout } = await execWithTimeout(
        `npx wrangler pages deployment list --project-name="${projectName}" --json`,
        {
          env: {
            ...process.env,
            CLOUDFLARE_ACCOUNT_ID: this.accountId,
            CLOUDFLARE_API_TOKEN: this.apiToken
          },
          cwd: config.paths.root
        },
        30000 // 30 second timeout for list operation
      );

      const deployments = JSON.parse(stdout);
      return deployments[0] || null;
    } catch (error) {
      console.error('Failed to get deployment status:', error.message);
      return null;
    }
  }
}
